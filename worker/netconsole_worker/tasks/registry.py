from __future__ import annotations

from typing import Any

from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.tasks.base import BaseTask


class ConnectTestTask(BaseTask):
    job_type = "CONNECT_TEST"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        # TODO lab: dùng aionet mở session tới device.ip
        return {
            **self.stub_result(job, device),
            "connected": False,
            "protocol": "ssh",
        }


class GetConfigTask(BaseTask):
    job_type = "GET_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import fetch_configuration
        from netconsole_worker.parsers.configuration_rpc import (
            parse_configuration_set,
            parse_identity_from_set_config,
        )
        from netconsole_worker.ssh_client import run_ssh_command

        rest_error: str | None = None

        if settings.junos_rest_enabled:
            username = settings.junos_rest_user or settings.lab_ssh_user
            password = settings.junos_rest_password or settings.lab_ssh_password
            rest_result = fetch_configuration(
                device.ip,
                username=username,
                password=password,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                verify_tls=settings.junos_rest_verify_tls,
            )
            if rest_result["ok"]:
                config = parse_configuration_set(rest_result["payload"] or rest_result["raw"])
                if not config and rest_result.get("raw"):
                    config = parse_configuration_set(rest_result["raw"])
                if config:
                    identity = parse_identity_from_set_config(config)
                    return {
                        "implemented": True,
                        "source": "junos-rest",
                        "config": config,
                        "hostname": identity.get("hostname") or "",
                        "version": identity.get("version") or "",
                        "command": "get-configuration format=set",
                        "message": f"Collected running config from {device.name}",
                    }
                rest_error = "Junos REST returned empty configuration"
            else:
                rest_error = rest_result["error"] or "Junos REST get-configuration failed"

        if settings.lab_ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command="show configuration | display set",
            )
            if not ssh_result["sshOk"]:
                raise RuntimeError(ssh_result["error"] or rest_error or "SSH get-config failed")

            identity = parse_identity_from_set_config(ssh_result["output"] or "")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "config": ssh_result["output"] or "",
                "hostname": identity.get("hostname") or "",
                "version": identity.get("version") or "",
                "message": f"Collected running config from {device.name}",
                "restError": rest_error,
            }

        raise RuntimeError(rest_error or "GET_CONFIG requires JUNOS_REST or LAB_SSH")


def _set_commands(config: str) -> list[str]:
    commands: list[str] = []
    for line in config.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("!"):
            continue
        commands.append(stripped)
    return commands


def _rest_creds(settings: Any) -> dict[str, Any] | None:
    if not settings.junos_rest_enabled:
        return None
    return {
        "username": settings.junos_rest_user or settings.lab_ssh_user,
        "password": settings.junos_rest_password or settings.lab_ssh_password,
        "scheme": settings.junos_rest_scheme,
        "port": settings.junos_rest_port,
        "verify_tls": settings.junos_rest_verify_tls,
    }


class ApplyConfigTask(BaseTask):
    job_type = "APPLY_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import apply_set_configuration, compact_raw
        from netconsole_worker.ssh_client import run_ssh_command

        payload = job.payload or {}
        config = str(payload.get("config") or "").strip()
        if not config:
            raise RuntimeError("APPLY_CONFIG payload.config is empty")

        commands = _set_commands(config)
        if not commands:
            raise RuntimeError("APPLY_CONFIG has no set/delete commands")

        rest_error: str | None = None
        creds = _rest_creds(settings)
        if creds:
            previous = str(payload.get("previous") or "")
            applied = apply_set_configuration(
                device.ip,
                commands,
                log=f"NetConsole APPLY_CONFIG {device.name}",
                timeout=60.0,
                **creds,
            )
            if applied["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "previous": previous,
                    "config": config,
                    "commands": commands,
                    "loadMs": applied.get("loadMs"),
                    "commitMs": applied.get("commitMs"),
                    "message": f"Committed config to {device.name}",
                    "raw": compact_raw(applied.get("raw") or ""),
                }
            rest_error = applied.get("error") or "Junos REST load/commit failed"

        if settings.lab_ssh_enabled:
            previous = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command="show configuration | display set",
            )
            if not previous["sshOk"]:
                raise RuntimeError(previous["error"] or rest_error or "Failed to snapshot running config")

            applied = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command="configure exclusive; " + " ; ".join(commands) + "; commit and-quit",
                timeout=45,
            )
            if not applied["sshOk"]:
                raise RuntimeError(applied["error"] or rest_error or "Failed to commit config")
            output = (applied["output"] or "").lower()
            if "error:" in output:
                raise RuntimeError(applied["output"].strip())

            return {
                "implemented": True,
                "source": "ssh-cli",
                "previous": previous["output"] or "",
                "config": config,
                "output": applied["output"] or "",
                "message": f"Committed config to {device.name}",
                "restError": rest_error,
            }

        raise RuntimeError(rest_error or "APPLY_CONFIG requires JUNOS_REST or LAB_SSH")


class RollbackConfigTask(BaseTask):
    job_type = "ROLLBACK_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import compact_raw, rollback_configuration
        from netconsole_worker.ssh_client import run_ssh_command

        payload = job.payload or {}
        rollback_index = payload.get("rollback")
        try:
            rollback = int(rollback_index) if rollback_index is not None else 1
        except (TypeError, ValueError):
            rollback = 1

        rest_error: str | None = None
        creds = _rest_creds(settings)
        if creds:
            rolled = rollback_configuration(device.ip, rollback=rollback, timeout=60.0, **creds)
            if rolled["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "rollback": rollback,
                    "config": str(payload.get("previous") or ""),
                    "message": f"Rolled back config on {device.name}",
                    "raw": compact_raw(rolled.get("raw") or ""),
                }
            rest_error = rolled.get("error") or "Junos REST rollback failed"

        if settings.lab_ssh_enabled:
            rolled = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command=f"configure exclusive; rollback {rollback}; commit and-quit",
                timeout=45,
            )
            if not rolled["sshOk"]:
                raise RuntimeError(rolled["error"] or rest_error or "Rollback SSH failed")
            output = (rolled["output"] or "").lower()
            if "error:" in output:
                raise RuntimeError(rolled["output"].strip())

            current = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command="show configuration | display set",
            )
            if not current["sshOk"]:
                raise RuntimeError(current["error"] or rest_error or "Failed to read config after rollback")

            return {
                "implemented": True,
                "source": "ssh-cli",
                "output": rolled["output"] or "",
                "config": current["output"] or "",
                "message": f"Rolled back config on {device.name}",
                "restError": rest_error,
            }

        raise RuntimeError(rest_error or "ROLLBACK_CONFIG requires JUNOS_REST or LAB_SSH")


class GetArpTask(BaseTask):
    job_type = "GET_ARP"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import compact_raw, fetch_arp_table
        from netconsole_worker.parsers.arp_table_rpc import parse_arp_table_rpc
        from netconsole_worker.parsers.show_arp import parse_juniper_arp_table
        from netconsole_worker.ssh_client import run_ssh_command

        rest_error: str | None = None

        if settings.junos_rest_enabled:
            username = settings.junos_rest_user or settings.lab_ssh_user
            password = settings.junos_rest_password or settings.lab_ssh_password
            rest_result = fetch_arp_table(
                device.ip,
                username=username,
                password=password,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                verify_tls=settings.junos_rest_verify_tls,
            )

            if rest_result["ok"]:
                entries = parse_arp_table_rpc(rest_result["payload"] or rest_result["raw"])
                if not entries and rest_result.get("raw"):
                    entries = parse_arp_table_rpc(rest_result["raw"])
                if entries:
                    return {
                        "implemented": True,
                        "source": "junos-rest",
                        "message": "Junos REST ARP table OK",
                        "command": "get-arp-table-information",
                        "entries": entries,
                        "raw": compact_raw(rest_result["raw"]),
                    }
                rest_error = "Junos REST returned no ARP entries"
            else:
                rest_error = rest_result["error"] or "Junos REST request failed"

        if settings.lab_ssh_enabled:
            command = "show arp"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command=command,
            )

            if not ssh_result["sshOk"]:
                return {
                    **self.stub_result(job, device),
                    "implemented": False,
                    "source": "ssh-cli",
                    "entries": [],
                    "message": ssh_result["error"] or "SSH failed",
                    "restError": rest_error,
                }

            entries = parse_juniper_arp_table(ssh_result["output"])
            message = "Lab SSH ARP table OK"
            if rest_error:
                message = f"SSH fallback OK (REST: {rest_error})"

            return {
                "implemented": True,
                "source": "ssh-cli",
                "message": message,
                "command": command,
                "entries": entries,
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            **self.stub_result(job, device),
            "entries": [],
            "source": None,
            "message": rest_error or "ARP collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }


class GetMacTask(BaseTask):
    job_type = "GET_MAC"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import compact_raw, fetch_ethernet_switching_table
        from netconsole_worker.parsers.mac_table_rpc import parse_mac_table_rpc
        from netconsole_worker.parsers.show_mac_table import parse_juniper_mac_table
        from netconsole_worker.ssh_client import run_ssh_command

        rest_error: str | None = None

        if settings.junos_rest_enabled:
            username = settings.junos_rest_user or settings.lab_ssh_user
            password = settings.junos_rest_password or settings.lab_ssh_password
            rest_result = fetch_ethernet_switching_table(
                device.ip,
                username=username,
                password=password,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                verify_tls=settings.junos_rest_verify_tls,
            )

            if rest_result["ok"]:
                entries = parse_mac_table_rpc(rest_result["payload"] or rest_result["raw"])
                if not entries and rest_result.get("raw"):
                    entries = parse_mac_table_rpc(rest_result["raw"])
                if entries:
                    return {
                        "implemented": True,
                        "source": "junos-rest",
                        "message": "Junos REST MAC table OK",
                        "command": "get-ethernet-switching-table-information",
                        "entries": entries,
                        "raw": compact_raw(rest_result["raw"]),
                    }
                rest_error = "Junos REST returned no MAC entries"
            else:
                rest_error = rest_result["error"] or "Junos REST request failed"

        if settings.lab_ssh_enabled:
            command = "show ethernet-switching table"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command=command,
            )

            if not ssh_result["sshOk"]:
                return {
                    **self.stub_result(job, device),
                    "implemented": False,
                    "source": "ssh-cli",
                    "entries": [],
                    "message": ssh_result["error"] or "SSH failed",
                    "restError": rest_error,
                }

            entries = parse_juniper_mac_table(ssh_result["output"])
            message = "Lab SSH MAC table OK"
            if rest_error:
                message = f"SSH fallback OK (REST: {rest_error})"

            return {
                "implemented": True,
                "source": "ssh-cli",
                "message": message,
                "command": command,
                "entries": entries,
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            **self.stub_result(job, device),
            "entries": [],
            "source": None,
            "message": rest_error or "MAC collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }


class GetInterfacesTask(BaseTask):
    job_type = "GET_INTERFACES"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import (
            compact_raw,
            fetch_interface_information,
            fetch_interfaces_set_config,
            fetch_vlan_information,
        )
        from netconsole_worker.parsers.configuration_rpc import parse_configuration_set
        from netconsole_worker.parsers.interface_set import (
            apply_interface_descriptions,
            apply_switching_modes,
            parse_interface_descriptions_from_set,
            parse_switching_mode_from_set,
        )
        from netconsole_worker.parsers.show_interfaces import (
            parse_interface_information_rpc,
            parse_interfaces_terse,
        )
        from netconsole_worker.parsers.vlan_rpc import apply_vlan_membership, parse_vlan_information_rpc
        from netconsole_worker.ssh_client import run_ssh_command

        rest_error: str | None = None

        if settings.junos_rest_enabled:
            username = settings.junos_rest_user or settings.lab_ssh_user
            password = settings.junos_rest_password or settings.lab_ssh_password
            rest_result = fetch_interface_information(
                device.ip,
                username=username,
                password=password,
                scheme=settings.junos_rest_scheme,
                port=settings.junos_rest_port,
                verify_tls=settings.junos_rest_verify_tls,
            )

            if rest_result["ok"]:
                interfaces = parse_interface_information_rpc(rest_result["payload"] or rest_result["raw"])
                if not interfaces and rest_result.get("raw"):
                    interfaces = parse_interface_information_rpc(rest_result["raw"])
                if interfaces:
                    vlan_result = fetch_vlan_information(
                        device.ip,
                        username=username,
                        password=password,
                        scheme=settings.junos_rest_scheme,
                        port=settings.junos_rest_port,
                        verify_tls=settings.junos_rest_verify_tls,
                    )
                    if vlan_result["ok"]:
                        apply_vlan_membership(
                            interfaces,
                            parse_vlan_information_rpc(vlan_result["payload"] or vlan_result["raw"]),
                        )
                    set_result = fetch_interfaces_set_config(
                        device.ip,
                        username=username,
                        password=password,
                        scheme=settings.junos_rest_scheme,
                        port=settings.junos_rest_port,
                        verify_tls=settings.junos_rest_verify_tls,
                    )
                    if set_result["ok"]:
                        set_text = parse_configuration_set(set_result["payload"] or set_result["raw"])
                        if not set_text:
                            raw_set = str(set_result.get("payload") or set_result.get("raw") or "")
                            if any(token in raw_set for token in ("interface-mode", "port-mode", " description ")):
                                set_text = raw_set
                        apply_switching_modes(interfaces, parse_switching_mode_from_set(set_text))
                        apply_interface_descriptions(interfaces, parse_interface_descriptions_from_set(set_text))
                    return {
                        "implemented": True,
                        "source": "junos-rest",
                        "message": "Junos REST interface information OK",
                        "command": "get-interface-information?terse + get-vlan-information + get-configuration interfaces",
                        "interfaces": interfaces,
                        "raw": compact_raw(rest_result["raw"]),
                    }
                rest_error = "Junos REST returned no interfaces"
            else:
                rest_error = rest_result["error"] or "Junos REST request failed"

        if settings.lab_ssh_enabled:
            command = "show interfaces terse"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command=command,
            )

            if not ssh_result["sshOk"]:
                return {
                    **self.stub_result(job, device),
                    "implemented": False,
                    "source": "ssh-cli",
                    "interfaces": [],
                    "message": ssh_result["error"] or "SSH failed",
                    "restError": rest_error,
                }

            interfaces = parse_interfaces_terse(ssh_result["output"])
            message = "Lab SSH interfaces OK"
            if rest_error:
                message = f"SSH fallback OK (REST: {rest_error})"

            return {
                "implemented": True,
                "source": "ssh-cli",
                "message": message,
                "command": command,
                "interfaces": interfaces,
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            **self.stub_result(job, device),
            "interfaces": [],
            "source": None,
            "message": rest_error or "Interface collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }


class InterfaceActionTask(BaseTask):
    job_type = "INTERFACE_ACTION"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        from netconsole_worker.config import settings
        from netconsole_worker.junos_rest import (
            apply_set_configuration,
            compact_raw,
            fetch_configuration,
            fetch_interface_configuration,
        )
        from netconsole_worker.parsers.configuration_rpc import parse_configuration_set
        from netconsole_worker.parsers.interface_set import (
            commands_for_action,
            filter_interface_set_lines,
            is_protected_interface,
            validate_interface_name,
        )
        from netconsole_worker.ssh_client import run_ssh_command

        payload = job.payload or {}
        action = str(payload.get("action") or "").strip()
        iface = str(payload.get("interface") or "").strip()
        vlan = str(payload.get("vlan") or "").strip()

        if not action or not iface:
            return {
                **self.stub_result(job, device),
                "implemented": False,
                "message": "Missing action or interface in job payload",
                "payload": payload,
            }

        try:
            iface = validate_interface_name(iface)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc

        if action in {"shut", "set-access-vlan"} and is_protected_interface(iface):
            raise RuntimeError(f"Refusing {action} on management/internal interface {iface}")

        rest_error: str | None = None
        rest_creds = None
        if settings.junos_rest_enabled:
            rest_creds = {
                "username": settings.junos_rest_user or settings.lab_ssh_user,
                "password": settings.junos_rest_password or settings.lab_ssh_password,
                "scheme": settings.junos_rest_scheme,
                "port": settings.junos_rest_port,
                "verify_tls": settings.junos_rest_verify_tls,
            }

        if rest_creds and action == "show-run":
            filtered = fetch_interface_configuration(device.ip, iface, **rest_creds)
            config = ""
            if filtered["ok"]:
                config = parse_configuration_set(filtered["payload"] or filtered["raw"])
            if not config:
                full = fetch_configuration(device.ip, **rest_creds)
                if full["ok"]:
                    config = filter_interface_set_lines(
                        parse_configuration_set(full["payload"] or full["raw"]),
                        iface,
                    )
                elif not filtered["ok"]:
                    rest_error = filtered["error"] or full["error"]
            if config or filtered["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "action": action,
                    "interface": iface,
                    "config": config or f"# No configuration for {iface} (defaults)",
                    "message": (
                        f"Interface {iface} running config"
                        if config
                        else f"No configuration for {iface} (defaults)"
                    ),
                    "raw": compact_raw(filtered.get("raw") or ""),
                }

        if rest_creds and action in {"shut", "no-shut", "set-access-vlan"}:
            try:
                commands = commands_for_action(action, iface, vlan)
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc

            applied = apply_set_configuration(
                device.ip,
                commands,
                log=f"NetConsole {action} {iface}",
                **rest_creds,
            )
            if applied["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "action": action,
                    "interface": iface,
                    "vlan": vlan or None,
                    "commands": commands,
                    "message": f"Interface action {action} OK on {iface}",
                    "adminStatus": "down" if action == "shut" else "up" if action == "no-shut" else None,
                    "accessVlan": vlan if action == "set-access-vlan" else None,
                    "raw": compact_raw(applied.get("raw") or ""),
                }
            rest_error = applied.get("error") or "Junos REST configure failed"

        if not settings.lab_ssh_enabled:
            raise RuntimeError(rest_error or "Interface actions require JUNOS_REST or LAB_SSH")

        commands: list[str] = []
        if action == "shut":
            commands = commands_for_action(action, iface)
        elif action == "no-shut":
            commands = commands_for_action(action, iface)
        elif action == "show-run":
            commands = [f"show configuration interfaces {iface}"]
        elif action == "set-access-vlan":
            commands = commands_for_action(action, iface, vlan)
        else:
            raise RuntimeError(f"Unsupported interface action: {action}")

        outputs: list[dict[str, str]] = []
        for command in commands:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=settings.lab_ssh_user,
                password=settings.lab_ssh_password,
                port=settings.lab_ssh_port,
                command=command,
            )
            if not ssh_result["sshOk"]:
                raise RuntimeError(ssh_result["error"] or rest_error or f"SSH failed on: {command}")

            output = ssh_result["output"] or ""
            outputs.append({"command": command, "output": output})
            lowered = output.lower().strip()
            if action != "show-run" and (
                lowered.startswith("error:")
                or lowered.startswith("unknown command")
                or "traceback (most recent call last)" in lowered
            ):
                raise RuntimeError(output.strip() or f"Command failed: {command}")

        return {
            "implemented": True,
            "source": "ssh-cli",
            "action": action,
            "interface": iface,
            "vlan": vlan or None,
            "commands": commands,
            "outputs": outputs,
            "config": outputs[-1]["output"] if action == "show-run" and outputs else None,
            "message": f"Interface action {action} OK on {iface}",
            "adminStatus": "down" if action == "shut" else "up" if action == "no-shut" else None,
            "accessVlan": vlan if action == "set-access-vlan" else None,
            "restError": rest_error,
        }


from netconsole_worker.tasks.managed_check import ManagedCheckTask

TASK_REGISTRY = {
    task.job_type: task
    for task in [
        ConnectTestTask(),
        GetConfigTask(),
        ApplyConfigTask(),
        RollbackConfigTask(),
        GetArpTask(),
        GetMacTask(),
        GetInterfacesTask(),
        InterfaceActionTask(),
        ManagedCheckTask(),
    ]
}
