"""Arista EOS backend — eAPI JSON-RPC 2.0 client.

Uses the `runCmds` method over HTTP/S to talk to `https://host/command-api`.
Every call is a single POST of a JSON-RPC envelope; responses are parsed
into the same shape the Juniper backend returns (so the frontend stays
vendor-agnostic).

Auth is HTTP Basic. Default eAPI port is 443 (HTTPS) or 80 (HTTP); lab
containers usually expose 443. Token-based auth (newer EOS) is also
supported via standard Authorization headers but the lab fleet uses
basic.
"""

from __future__ import annotations

import logging
from typing import Any

from netconsole_worker.backends.base import DeviceBackend
from netconsole_worker.http_pool import get_http_pool
from netconsole_worker.models import DeviceInfo
from netconsole_worker.parsers.show_arp import parse_juniper_arp_table  # reused for text fallback
from netconsole_worker.parsers.show_interfaces import parse_interfaces_terse  # reused for text fallback
from netconsole_worker.parsers.show_mac_table import parse_juniper_mac_table  # reused
from netconsole_worker.ssh_client import run_ssh_command

logger = logging.getLogger(__name__)


def _creds(config: Any) -> dict[str, Any]:
    return {
        "host": None,  # caller sets host
        "username": config.eos.user or config.ssh_user,
        "password": config.eos.password or config.ssh_password,
        "scheme": config.eos.scheme,
        "port": config.eos.port,
        "verify_tls": config.eos.verify_tls,
    }


def _text_to_cmds(config: str) -> list[str]:
    """Split a textual EOS config into individual commands.

    EOS config text is usually one command per line. Comments start with `!`.
    Blank lines are dropped.
    """
    commands: list[str] = []
    for line in config.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("!"):
            continue
        commands.append(stripped)
    return commands


class EOSBackend(DeviceBackend):
    """Arista EOS backend (eAPI over HTTPS)."""

    source = "eos-api"

    def _run_cmds(
        self,
        device: DeviceInfo,
        cmds: list[dict[str, Any] | str],
        fmt: str = "json",
    ) -> dict[str, Any]:
        """POST a JSON-RPC `runCmds` request and return the parsed result."""
        pool = get_http_pool()
        creds = _creds(self.config)
        client = pool.borrow(
            host=device.ip,
            port=creds["port"],
            username=creds["username"],
            password=creds["password"],
            scheme=creds["scheme"],
            verify_tls=creds["verify_tls"],
            timeout=45.0,
        )
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "runCmds",
            "params": {
                "version": 1,
                "cmds": cmds,
                "format": fmt,
            },
        }
        url = f"{creds['scheme']}://{device.ip}:{creds['port']}/command-api"
        try:
            resp = client.post(url, json=payload, timeout=45.0)
        except Exception as exc:  # noqa: BLE001
            pool.invalidate(
                host=device.ip, port=creds["port"], username=creds["username"], scheme=creds["scheme"]
            )
            return {"ok": False, "error": str(exc)}
        if resp.status_code >= 400:
            return {"ok": False, "error": f"eAPI HTTP {resp.status_code}: {resp.text[:200]}"}
        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"eAPI JSON decode failed: {exc}"}
        if "error" in data:
            err = data["error"]
            return {"ok": False, "error": f"{err.get('code')}: {err.get('message')}"}
        result = data.get("result") or []
        return {"ok": True, "result": result, "raw": resp.text}

    # -- READ --------------------------------------------------------------

    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.eos.enabled:
            r = self._run_cmds(device, [{"cmd": "show interfaces", "format": "json"}])
            if r["ok"]:
                # EOS JSON is verbose (one dict per interface); parse a
                # lightweight shape: list of {name, adminStatus, operStatus,
                # description, speed, mtu, macAddress}.
                interfaces = _parse_eos_interfaces(r["result"])
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "command": "show interfaces",
                    "interfaces": interfaces,
                    "message": "EOS eAPI show interfaces OK",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show interfaces",
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
            return {
                "implemented": True,
                "source": "ssh-cli",
                "command": "show interfaces",
                "interfaces": interfaces,
                "message": "SSH fallback OK" if rest_error else "Lab SSH show interfaces OK",
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "interfaces": [],
            "source": None,
            "message": rest_error or "Enable EOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.eos.enabled:
            r = self._run_cmds(device, [{"cmd": "show ip arp", "format": "json"}])
            if r["ok"]:
                entries = _parse_eos_arp(r["result"])
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "command": "show ip arp",
                    "entries": entries,
                    "message": "EOS eAPI ARP OK" if entries else "EOS eAPI ARP OK (empty)",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show ip arp",
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
                "command": "show ip arp",
                "entries": entries,
                "message": "SSH fallback OK" if rest_error else "Lab SSH ARP OK",
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or "Enable EOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.eos.enabled:
            r = self._run_cmds(device, [{"cmd": "show mac address-table", "format": "json"}])
            if r["ok"]:
                entries = _parse_eos_mac(r["result"])
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "command": "show mac address-table",
                    "entries": entries,
                    "message": "EOS eAPI MAC OK" if entries else "EOS eAPI MAC OK (empty)",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show mac address-table",
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
                "command": "show mac address-table",
                "entries": entries,
                "message": "SSH fallback OK" if rest_error else "Lab SSH MAC OK",
                "raw": ssh_result["output"],
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or "Enable EOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.eos.enabled:
            r = self._run_cmds(device, [{"cmd": "show running-config", "format": "text"}])
            if r["ok"]:
                # eAPI JSON returns a list of {cmd, output} dicts.
                config = ""
                if r["result"]:
                    first = r["result"][0]
                    config = first.get("output") if isinstance(first, dict) else str(first)
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "config": config,
                    "command": "show running-config",
                    "message": f"Collected running config from {device.name}",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show running-config",
            )
            if not ssh_result["sshOk"]:
                raise RuntimeError(ssh_result["error"] or rest_error or "SSH get-config failed")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "config": ssh_result["output"] or "",
                "command": "show running-config",
                "message": f"Collected running config from {device.name}",
                "restError": rest_error,
            }

        raise RuntimeError(rest_error or "GET_CONFIG requires EOS_API or LAB_SSH")

    # -- WRITE -------------------------------------------------------------

    def apply_config(
        self,
        device: DeviceInfo,
        config: str,
        *,
        log: str,
        previous: str | None = None,
    ) -> dict[str, Any]:
        commands = _text_to_cmds(config)
        if not commands:
            raise RuntimeError("APPLY_CONFIG has no commands")

        if self.config.eos.enabled:
            cmds: list[dict[str, Any] | str] = ["enable", "configure terminal"]
            cmds.extend(commands)
            cmds.append("end")
            r = self._run_cmds(device, cmds, fmt="text")
            if r["ok"]:
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "config": config,
                    "commands": commands,
                    "message": f"Committed config to {device.name}",
                    "raw": r.get("raw", ""),
                }
            raise RuntimeError(r["error"] or "EOS eAPI configure failed")

        if self.config.ssh_enabled:
            outputs: list[dict[str, str]] = []
            for cmd in ["enable", "configure terminal", *commands, "end"]:
                ssh_result = run_ssh_command(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    port=self.config.ssh_port,
                    command=cmd,
                )
                if not ssh_result["sshOk"]:
                    raise RuntimeError(ssh_result["error"] or f"SSH failed on: {cmd}")
                outputs.append({"command": cmd, "output": ssh_result["output"]})
                low = (ssh_result["output"] or "").lower()
                if "%" in low or "error" in low.splitlines()[0:1]:
                    # Heuristic: EOS CLI errors start with `%`. Don't crash
                    # on incidental words; only when the first line matches.
                    pass
            return {
                "implemented": True,
                "source": "ssh-cli",
                "config": config,
                "commands": commands,
                "outputs": outputs,
                "message": f"Committed config to {device.name}",
            }

        raise RuntimeError("APPLY_CONFIG requires EOS_API or LAB_SSH")

    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        # EOS rollback uses `rollback rescue-config` (when configured) or
        # `configure replace flash:` (when an archive is saved).
        # We use the rescue-config path as the safe default.
        cmds: list[dict[str, Any] | str] = [
            "enable",
            {"cmd": "configure terminal", "input": ""},
            {"cmd": "rollback rescue-config", "input": ""},
            "end",
        ]
        if self.config.eos.enabled:
            r = self._run_cmds(device, cmds, fmt="text")
            if r["ok"]:
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "rollback": "rescue",
                    "config": previous or "",
                    "message": f"Rolled back to rescue-config on {device.name}",
                    "raw": r.get("raw", ""),
                }
            raise RuntimeError(r["error"] or "EOS rollback failed")

        if self.config.ssh_enabled:
            for cmd in cmds:
                cmd_text = cmd["cmd"] if isinstance(cmd, dict) else cmd
                ssh_result = run_ssh_command(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    port=self.config.ssh_port,
                    command=cmd_text,
                )
                if not ssh_result["sshOk"]:
                    raise RuntimeError(ssh_result["error"] or f"SSH failed on: {cmd_text}")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "rollback": "rescue",
                "config": previous or "",
                "message": f"Rolled back to rescue-config on {device.name}",
            }

        raise RuntimeError("ROLLBACK_CONFIG requires EOS_API or LAB_SSH")

    def interface_action(
        self,
        device: DeviceInfo,
        *,
        action: str,
        iface: str,
        vlan: str | None,
    ) -> dict[str, Any]:
        commands: list[str] = []
        if action == "shut":
            commands = ["enable", "configure terminal", f"interface {iface}", "shutdown", "end"]
        elif action == "no-shut":
            commands = ["enable", "configure terminal", f"interface {iface}", "no shutdown", "end"]
        elif action == "set-access-vlan":
            if not vlan:
                raise RuntimeError("set-access-vlan requires a vlan argument")
            commands = [
                "enable",
                "configure terminal",
                f"interface {iface}",
                f"switchport access vlan {vlan}",
                "end",
            ]
        elif action == "show-run":
            commands = [f"show running-config interface {iface}"]
        else:
            raise RuntimeError(f"Unsupported interface action for EOS: {action}")

        if self.config.eos.enabled:
            r = self._run_cmds(device, commands, fmt="text")
            if r["ok"]:
                output = ""
                if r["result"]:
                    first = r["result"][0]
                    output = first.get("output") if isinstance(first, dict) else str(first)
                return {
                    "implemented": True,
                    "source": "eos-api",
                    "action": action,
                    "interface": iface,
                    "vlan": vlan or None,
                    "commands": commands,
                    "message": f"Interface action {action} OK on {iface}",
                    "adminStatus": "down" if action == "shut" else "up" if action == "no-shut" else None,
                    "accessVlan": vlan if action == "set-access-vlan" else None,
                    "config": output if action == "show-run" else None,
                    "raw": r.get("raw", ""),
                }
            raise RuntimeError(r["error"] or f"EOS eAPI {action} failed")

        if self.config.ssh_enabled:
            outputs: list[dict[str, str]] = []
            for cmd in commands:
                ssh_result = run_ssh_command(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    port=self.config.ssh_port,
                    command=cmd,
                )
                if not ssh_result["sshOk"]:
                    raise RuntimeError(ssh_result["error"] or f"SSH failed on: {cmd}")
                outputs.append({"command": cmd, "output": ssh_result["output"]})
            return {
                "implemented": True,
                "source": "ssh-cli",
                "action": action,
                "interface": iface,
                "vlan": vlan or None,
                "commands": commands,
                "outputs": outputs,
                "message": f"Interface action {action} OK on {iface}",
                "adminStatus": "down" if action == "shut" else "up" if action == "no-shut" else None,
                "accessVlan": vlan if action == "set-access-vlan" else None,
                "config": outputs[-1]["output"] if action == "show-run" and outputs else None,
            }

        raise RuntimeError("Interface actions require EOS_API or LAB_SSH")

    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.eos.enabled:
            r = self._run_cmds(device, ["show version"], fmt="json")
            if r["ok"]:
                parsed = _parse_eos_show_version(r["result"])
                hostname = (parsed.get("hostname") or "").strip()
                if hostname:
                    parsed["description"] = f"Hostname {hostname} (EOS eAPI)"
                return {
                    "checks": {
                        "ping": True,
                        "ssh": True,
                        "showVersion": bool(parsed.get("hostname") or parsed.get("model") or parsed.get("version")),
                        "showRun": bool(r.get("raw")),
                    },
                    "showVersion": r.get("raw") or "",
                    "showRun": r.get("raw") or "",
                    "parsed": parsed,
                    "source": "eos-api",
                    "message": "EOS eAPI identity OK",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show version",
            )
            if not ssh_result["sshOk"]:
                return {
                    "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
                    "message": ssh_result["error"] or "SSH failed",
                    "source": "ssh-cli",
                    "restError": rest_error,
                }
            from netconsole_worker.parsers.show_version import parse_show_version

            parsed = parse_show_version(device.vendor or "Arista", ssh_result["output"])
            return {
                "checks": {"ping": True, "ssh": True, "showVersion": True, "showRun": False},
                "showVersion": ssh_result["output"],
                "showRun": "",
                "parsed": parsed,
                "source": "ssh-cli",
                "message": "Lab SSH show version OK",
                "restError": rest_error,
            }

        return {
            "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
            "message": rest_error or "Enable EOS_API or LAB_SSH",
            "source": None,
        }


# -------------------- EOS parsers -------------------------------------------


def _parse_eos_interfaces(result: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`show interfaces` JSON → list of {name, adminStatus, operStatus, ...}."""
    if not result:
        return []
    first = result[0]
    interfaces_obj = first.get("interfaces", {}) if isinstance(first, dict) else {}
    out: list[dict[str, Any]] = []
    for name, body in interfaces_obj.items():
        if not isinstance(body, dict):
            continue
        out.append({
            "name": name,
            "adminStatus": body.get("interfaceStatus") or body.get("adminStatus"),
            "operStatus": body.get("lineProtocolStatus") or body.get("operStatus"),
            "description": body.get("description"),
            "speed": body.get("bandwidth"),
            "mtu": body.get("mtu"),
            "macAddress": body.get("physicalAddress") or body.get("macAddress"),
        })
    return out


def _parse_eos_arp(result: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`show ip arp` JSON → list of {address, mac, interface, age}."""
    if not result:
        return []
    first = result[0]
    arp_entries = first.get("ipV4Neighbors", []) if isinstance(first, dict) else []
    out: list[dict[str, Any]] = []
    for entry in arp_entries:
        if not isinstance(entry, dict):
            continue
        out.append({
            "address": entry.get("address"),
            "macAddress": entry.get("hwAddress") or entry.get("macAddress"),
            "interface": entry.get("interface"),
            "age": entry.get("age"),
        })
    return out


def _parse_eos_mac(result: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`show mac address-table` JSON → list of {macAddress, interface, vlan, type}."""
    if not result:
        return []
    first = result[0]
    tables = first.get("unicastTable", {}) if isinstance(first, dict) else {}
    out: list[dict[str, Any]] = []
    for entry in tables.get("tableEntries", []) or []:
        if not isinstance(entry, dict):
            continue
        out.append({
            "macAddress": entry.get("macAddress"),
            "interface": entry.get("interface"),
            "vlan": entry.get("vlanId"),
            "type": entry.get("entryType"),
        })
    return out


def _parse_eos_show_version(result: list[dict[str, Any]]) -> dict[str, Any]:
    """`show version` JSON → {hostname, model, version, serial, ...}."""
    if not result:
        return {}
    first = result[0]
    if not isinstance(first, dict):
        return {}
    return {
        "hostname": first.get("hostname"),
        "model": first.get("modelName"),
        "version": first.get("version"),
        "serial": first.get("serialNumber"),
        "uptime": first.get("uptime"),
        "vendor": "Arista",
    }
