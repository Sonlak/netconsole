"""Juniper Junos backend — wraps the existing `junos_rest.py` RPCs.

This is the battle-tested path used by all 4 lab Juniper sims. The
other backends (EOS / IOS-XE / NX-OS) mirror this surface but with
their own RPC shapes.
"""

from __future__ import annotations

import logging
from typing import Any

from netconsole_worker.backends.base import DeviceBackend
from netconsole_worker.junos_rest import (
    apply_set_configuration as rest_apply_set_configuration,
    compact_raw,
    fetch_arp_table,
    fetch_configuration,
    fetch_ethernet_switching_table,
    fetch_interface_configuration,
    fetch_interface_information,
    fetch_interfaces_set_config,
    fetch_log_information,
    fetch_vlan_information,
    probe_device_identity,
    rollback_configuration as rest_rollback_configuration,
)
from netconsole_worker.junos_netconf import (
    apply_set_configuration as nc_apply_set_configuration,
    rollback_configuration as nc_rollback_configuration,
)
from netconsole_worker.models import DeviceInfo
from netconsole_worker.parsers.arp_table_rpc import parse_arp_table_rpc
from netconsole_worker.parsers.configuration_rpc import (
    parse_configuration_set,
    parse_identity_from_set_config,
)
from netconsole_worker.parsers.interface_set import (
    apply_interface_descriptions,
    apply_switching_modes,
    commands_for_action,
    filter_interface_set_lines,
    is_protected_interface,
    parse_interface_descriptions_from_set,
    parse_switching_mode_from_set,
    validate_interface_name,
)
from netconsole_worker.parsers.mac_table_rpc import parse_mac_table_rpc
from netconsole_worker.parsers.show_arp import parse_juniper_arp_table
from netconsole_worker.parsers.show_interfaces import (
    parse_interface_information_rpc,
    parse_interfaces_terse,
)
from netconsole_worker.parsers.show_mac_table import parse_juniper_mac_table
from netconsole_worker.parsers.syslog_rpc import parse_log_payload
from netconsole_worker.parsers.vlan_rpc import (
    apply_vlan_membership,
    parse_vlan_information_rpc,
)
from netconsole_worker.ssh_client import run_junos_commands, run_ssh_command

logger = logging.getLogger(__name__)


def _rest_creds(config: Any) -> dict[str, Any]:
    return {
        "username": config.juniper.user or config.ssh_user,
        "password": config.juniper.password or config.ssh_password,
        "scheme": config.juniper.scheme,
        "port": config.juniper.port,
        "verify_tls": config.juniper.verify_tls,
    }


def _set_commands(config: str) -> list[str]:
    """Turn a free-form config string into Junos `set` / `delete` lines.

    Junos only accepts lines that start with `set`, `delete`, `deactivate`,
    `activate`, `protect`, `unprotect`, `edit`, `top`, `up`, `exit`,
    `commit`, `rollback`, `show`, `load`, `save`, `rename`, `copy`, `set`
    (alias), or `configure`. Anything else (HTML comments `<!-- ... -->`,
    C-style `/* ... */`, leading `!`, blank lines, plain prose) is
    stripped before sending to the device. C-style comments in particular
    reach the Junos parser as a literal "unknown command: /*" error and
    leave the candidate database in a modified state, which the next
    commit then fails on.
    """
    commands: list[str] = []
    in_block_comment = False
    for line in config.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#") or stripped.startswith("!"):
            continue
        # Handle /* ... */ block comments
        if in_block_comment:
            end = stripped.find("*/")
            if end < 0:
                continue
            stripped = stripped[end + 2 :].strip()
            in_block_comment = False
            if not stripped:
                continue
        if stripped.startswith("/*"):
            end = stripped.find("*/", 2)
            if end < 0:
                # Block comment continues to the next line
                in_block_comment = True
                continue
            stripped = stripped[end + 2 :].strip()
            if not stripped:
                continue
        # Drop inline /* ... */ too — Junos can't ignore them mid-line
        if "/*" in stripped and "*/" in stripped:
            stripped = stripped[: stripped.find("/*")] + stripped[stripped.find("*/") + 2 :]
            stripped = stripped.strip()
            if not stripped:
                continue
        # Junos "set" commands must start with a known verb. Anything
        # else (HTML `<!--`, plain text, leftover prose from a copy/paste)
        # is dropped to avoid polluting the candidate database.
        verb = stripped.split(None, 1)[0].lower()
        if verb not in {
            "set",
            "delete",
            "deactivate",
            "activate",
            "protect",
            "unprotect",
            "edit",
            "top",
            "up",
            "exit",
            "commit",
            "rollback",
            "show",
            "load",
            "save",
            "rename",
            "copy",
            "configure",
        }:
            continue
        commands.append(stripped)
    return commands


class JuniperBackend(DeviceBackend):
    """Juniper Junos backend (RESTCONF + SSH fallback)."""

    source = "junos-rest"

    # -- READ --------------------------------------------------------------

    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        rest_error: str | None = None
        creds = _rest_creds(self.config)

        if self.config.juniper.enabled:
            rest_result = fetch_interface_information(
                device.ip,
                **creds,
            )
            if rest_result["ok"]:
                interfaces = parse_interface_information_rpc(rest_result["payload"] or rest_result["raw"])
                if not interfaces and rest_result.get("raw"):
                    interfaces = parse_interface_information_rpc(rest_result["raw"])
                if interfaces:
                    vlan_result = fetch_vlan_information(device.ip, **creds)
                    if vlan_result["ok"]:
                        apply_vlan_membership(
                            interfaces,
                            parse_vlan_information_rpc(vlan_result["payload"] or vlan_result["raw"]),
                        )
                    set_result = fetch_interfaces_set_config(device.ip, **creds)
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
                rest_error = "Junos REST returned no interfaces (parser empty)"
            else:
                rest_error = rest_result["error"] or "Junos REST request failed"

        if self.config.ssh_enabled and rest_error:
            command = "show interfaces terse"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command=command,
            )
            if not ssh_result["sshOk"]:
                return {
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
            "implemented": False,
            "interfaces": [],
            "source": None,
            "message": rest_error or "Interface collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        rest_error: str | None = None
        creds = _rest_creds(self.config)

        if self.config.juniper.enabled:
            rest_result = fetch_arp_table(device.ip, **creds)
            if rest_result["ok"]:
                entries = parse_arp_table_rpc(rest_result["payload"] or rest_result["raw"])
                if not entries and rest_result.get("raw"):
                    entries = parse_arp_table_rpc(rest_result["raw"])
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "message": "Junos REST ARP table OK" if entries else "Junos REST ARP table OK (empty)",
                    "command": "get-arp-table-information",
                    "entries": entries,
                    "raw": compact_raw(rest_result["raw"]),
                }
            rest_error = rest_result["error"] or "Junos REST request failed"

        if self.config.ssh_enabled and rest_error:
            command = "show arp"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command=command,
            )
            if not ssh_result["sshOk"]:
                return {
                    "implemented": False,
                    "source": "ssh-cli",
                    "entries": [],
                    "message": ssh_result["error"] or "SSH failed",
                    "restError": rest_error,
                }
            entries = parse_juniper_arp_table(ssh_result["output"])
            return {
                "implemented": True,
                "source": "ssh-cli",
                "message": "SSH fallback OK" if rest_error else "Lab SSH ARP table OK",
                "command": command,
                "entries": entries,
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or "ARP collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        rest_error: str | None = None
        creds = _rest_creds(self.config)

        if self.config.juniper.enabled:
            rest_result = fetch_ethernet_switching_table(device.ip, **creds)
            if rest_result["ok"]:
                entries = parse_mac_table_rpc(rest_result["payload"] or rest_result["raw"])
                if not entries and rest_result.get("raw"):
                    entries = parse_mac_table_rpc(rest_result["raw"])
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "message": "Junos REST MAC table OK" if entries else "Junos REST MAC table OK (empty)",
                    "command": "get-ethernet-switching-table-information",
                    "entries": entries,
                    "raw": compact_raw(rest_result["raw"]),
                }
            rest_error = rest_result["error"] or "Junos REST request failed"

        if self.config.ssh_enabled and rest_error:
            command = "show ethernet-switching table"
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command=command,
            )
            if not ssh_result["sshOk"]:
                return {
                    "implemented": False,
                    "source": "ssh-cli",
                    "entries": [],
                    "message": ssh_result["error"] or "SSH failed",
                    "restError": rest_error,
                }
            entries = parse_juniper_mac_table(ssh_result["output"])
            return {
                "implemented": True,
                "source": "ssh-cli",
                "message": "SSH fallback OK" if rest_error else "Lab SSH MAC table OK",
                "command": command,
                "entries": entries,
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or "MAC collection disabled (enable JUNOS_REST or LAB_SSH)",
            "restError": rest_error,
        }

    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        rest_error: str | None = None
        creds = _rest_creds(self.config)

        if self.config.juniper.enabled:
            rest_result = fetch_configuration(device.ip, **creds)
            if rest_result["ok"]:
                config = parse_configuration_set(rest_result["payload"] or rest_result["raw"])
                if not config and rest_result.get("raw"):
                    config = parse_configuration_set(rest_result["raw"])
                identity = parse_identity_from_set_config(config)
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "config": config,
                    "hostname": identity.get("hostname") or "",
                    "version": identity.get("version") or "",
                    "command": "get-configuration format=set",
                    "message": (
                        f"Collected running config from {device.name}"
                        if config
                        else f"Collected running config from {device.name} (empty)"
                    ),
                }
            rest_error = rest_result["error"] or "Junos REST get-configuration failed"

        if self.config.ssh_enabled and rest_error:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
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

    # -- WRITE -------------------------------------------------------------

    def apply_config(
        self,
        device: DeviceInfo,
        config: str,
        *,
        log: str,
        previous: str | None = None,
    ) -> dict[str, Any]:
        if not config.strip():
            raise RuntimeError("APPLY_CONFIG payload.config is empty")

        commands = _set_commands(config)
        if not commands:
            raise RuntimeError("APPLY_CONFIG has no set/delete commands")

        rest_error: str | None = None

        # --- NETCONF-over-SSH (primary) ---
        if self.config.junos_netconf_ssh:
            nc_user = self.config.ssh_user
            nc_pass = self.config.ssh_password
            nc_port = self.config.junos_netconf_ssh_port
            applied = nc_apply_set_configuration(
                device.ip,
                commands,
                log=log,
                username=nc_user,
                password=nc_pass,
                port=nc_port,
                timeout=90.0,
            )
            if applied["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-netconf-ssh",
                    "previous": previous or "",
                    "config": config,
                    "commands": commands,
                    "loadMs": applied.get("loadMs"),
                    "commitMs": applied.get("commitMs"),
                    "message": f"Committed config to {device.name} via NETCONF SSH",
                    "raw": compact_raw(applied.get("raw") or ""),
                }
            rest_error = applied.get("error") or "NETCONF SSH load/commit failed"

        # --- RESTCONF (fallback) ---
        if self.config.juniper.enabled:
            creds = _rest_creds(self.config)
            applied = rest_apply_set_configuration(
                device.ip,
                commands,
                log=log,
                timeout=90.0,
                **creds,
            )
            if applied["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "previous": previous or "",
                    "config": config,
                    "commands": commands,
                    "loadMs": applied.get("loadMs"),
                    "commitMs": applied.get("commitMs"),
                    "message": f"Committed config to {device.name}",
                    "raw": compact_raw(applied.get("raw") or ""),
                }
            rest_error = applied.get("error") or "Junos REST load/commit failed"

        raise RuntimeError(
            rest_error
            or "APPLY_CONFIG requires JUNOS_NETCONF_SSH or JUNOS_REST enabled"
        )

    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        try:
            rollback = int(rollback_index) if rollback_index is not None else 1
        except (TypeError, ValueError):
            rollback = 1

        rest_error: str | None = None

        # --- NETCONF-over-SSH (primary) ---
        if self.config.junos_netconf_ssh:
            nc_user = self.config.ssh_user
            nc_pass = self.config.ssh_password
            nc_port = self.config.junos_netconf_ssh_port
            rolled = nc_rollback_configuration(
                device.ip,
                rollback=rollback,
                username=nc_user,
                password=nc_pass,
                port=nc_port,
                timeout=90.0,
            )
            if rolled["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-netconf-ssh",
                    "rollback": rollback,
                    "config": previous or "",
                    "message": f"Rolled back config on {device.name} via NETCONF SSH",
                    "raw": compact_raw(rolled.get("raw") or ""),
                }
            rest_error = rolled.get("error") or "NETCONF SSH rollback failed"

        # --- RESTCONF (fallback) ---
        if self.config.juniper.enabled:
            creds = _rest_creds(self.config)
            rolled = rest_rollback_configuration(
                device.ip,
                rollback=rollback,
                timeout=60.0,
                **creds,
            )
            if rolled["ok"]:
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "rollback": rollback,
                    "config": previous or "",
                    "message": f"Rolled back config on {device.name}",
                    "raw": compact_raw(rolled.get("raw") or ""),
                }
            rest_error = rolled.get("error") or "Junos REST rollback failed"

        raise RuntimeError(
            rest_error
            or "ROLLBACK_CONFIG requires JUNOS_NETCONF_SSH or JUNOS_REST enabled"
        )

    def interface_action(
        self,
        device: DeviceInfo,
        *,
        action: str,
        iface: str,
        vlan: str | None,
    ) -> dict[str, Any]:
        if not action or not iface:
            return {
                "implemented": False,
                "message": "Missing action or interface in job payload",
            }

        try:
            iface = validate_interface_name(iface)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc

        if action in {"shut", "set-access-vlan"} and is_protected_interface(iface):
            raise RuntimeError(f"Refusing {action} on management/internal interface {iface}")

        rest_error: str | None = None
        creds = _rest_creds(self.config)

        if action == "show-run":
            filtered = fetch_interface_configuration(device.ip, iface, **creds)
            config = ""
            if filtered["ok"]:
                config = parse_configuration_set(filtered["payload"] or filtered["raw"])
            if not config:
                full = fetch_configuration(device.ip, **creds)
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

        if action in {"shut", "no-shut", "set-access-vlan"}:
            try:
                commands = commands_for_action(action, iface, vlan or "")
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc

            applied = apply_set_configuration(
                device.ip,
                commands,
                log=f"NetConsole {action} {iface}",
                **creds,
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

        if not self.config.ssh_enabled:
            raise RuntimeError(rest_error or "Interface actions require JUNOS_REST or LAB_SSH")

        commands: list[str] = []
        if action == "shut" or action == "no-shut":
            commands = commands_for_action(action, iface)
        elif action == "show-run":
            commands = [f"show configuration interfaces {iface}"]
        elif action == "set-access-vlan":
            commands = commands_for_action(action, iface, vlan or "")
        else:
            raise RuntimeError(f"Unsupported interface action: {action}")

        outputs: list[dict[str, str]] = []
        for command in commands:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command=command,
            )
            if not ssh_result["sshOk"]:
                raise RuntimeError(ssh_result["error"] or rest_error or f"SSH failed on: {command}")

            output = ssh_result["output"] or ""
            outputs.append({"command": command, "output": output})
            lowered = output.lower().strip()
            if action != "show-run" and (
                lowered.startswith(("error:", "unknown command"))
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

    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        creds = _rest_creds(self.config)
        if self.config.juniper.enabled:
            rest = probe_device_identity(device.ip, **creds)
            if rest["ok"]:
                parsed = rest["fields"]
                hostname = (parsed.get("hostname") or "").strip()
                if hostname:
                    parsed["description"] = f"Hostname {hostname} (Junos REST)"
                return {
                    "checks": {
                        "ping": True,
                        "ssh": True,
                        "showVersion": bool(parsed.get("hostname") or parsed.get("model") or parsed.get("version")),
                        "showRun": bool(rest.get("raw")),
                    },
                    "showVersion": rest.get("raw") or "",
                    "showRun": rest.get("raw") or "",
                    "parsed": parsed,
                    "source": "junos-rest",
                    "message": "Junos REST identity OK",
                }
            rest_error = rest.get("error") or "Junos REST identity failed"
            if not self.config.ssh_enabled:
                return {
                    "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
                    "message": rest_error,
                    "source": "junos-rest",
                }

        if self.config.ssh_enabled:
            ssh_result = run_junos_commands(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
            )
            if ssh_result["sshOk"]:
                from netconsole_worker.parsers.show_version import parse_show_version

                parsed = parse_show_version(device.vendor or "Juniper", ssh_result["showVersion"])
                return {
                    "checks": {
                        "ping": True,
                        "ssh": True,
                        "showVersion": bool(ssh_result["showVersion"].strip()),
                        "showRun": bool(ssh_result["showRun"].strip()),
                    },
                    "showVersion": ssh_result["showVersion"],
                    "showRun": ssh_result["showRun"],
                    "parsed": parsed,
                    "source": "ssh-cli",
                    "message": "Lab SSH probe OK",
                }
            return {
                "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
                "message": ssh_result["error"] or "Lab SSH failed",
                "source": "ssh-cli",
            }

        return {
            "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
            "message": "Enable EOS_API/IOSXE_API/NXOS_API/JUNOS_REST or LAB_SSH to probe the device",
        }

    def get_logs(self, device: DeviceInfo, filename: str | None) -> dict[str, Any]:
        """Junos RESTCONF `get-log-information` on-demand pull.

        Most log ingestion happens via syslog UDP push on the backend.
        This path is for ad-hoc pulls (e.g. when an operator wants the
        full historical buffer of a single device).
        """
        if not self.config.juniper.enabled:
            return {
                "implemented": False,
                "entries": [],
                "hostname": device.name,
                "source": None,
                "message": (
                    "Log collection disabled: JUNOS_REST=false. "
                    "Logs are streamed via syslog UDP on the backend."
                ),
            }
        creds = _rest_creds(self.config)
        rest_result = fetch_log_information(
            device.ip,
            filename=filename,
            **creds,
        )
        if rest_result["ok"]:
            raw_payload = rest_result["payload"] or rest_result["raw"]
            entries = parse_log_payload(raw_payload)
            if not entries and rest_result.get("raw"):
                entries = parse_log_payload(rest_result["raw"])
            if entries:
                hostname = entries[0].get("hostname") or device.name
                return {
                    "implemented": True,
                    "source": "junos-rest",
                    "message": f"Junos REST log OK ({len(entries)} entries)",
                    "command": "get-log-information" + (f"?filename={filename}" if filename else ""),
                    "hostname": hostname,
                    "entries": entries,
                    "raw": compact_raw(rest_result["raw"]),
                }
            rest_error = "Junos REST returned no log entries"
        else:
            rest_error = rest_result["error"] or "Junos REST request failed"
        return {
            "implemented": False,
            "entries": [],
            "hostname": device.name,
            "source": None,
            "message": (
                f"Junos REST get-log-information not supported by this device "
                f"({rest_error}). View live logs on the Logs page; rows are "
                f"streamed via syslog UDP."
            ),
            "restError": rest_error,
        }
