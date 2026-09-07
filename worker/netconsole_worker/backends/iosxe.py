"""Cisco IOS-XE backend — RESTCONF + SSH CLI fallback.

IOS-XE supports RESTCONF on port 443 with the same YANG models as
Catalyst 9000 / ASR 1000 / ISR 4000. Coverage is patchy for ARP/MAC,
so we SSH-fallback for those (mirrors the Juniper approach).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from netconsole_worker.backends.base import DeviceBackend
from netconsole_worker.http_pool import get_http_pool
from netconsole_worker.models import DeviceInfo
from netconsole_worker.parsers.show_arp import parse_juniper_arp_table  # reused for SSH fallback
from netconsole_worker.parsers.show_interfaces import parse_interfaces_terse  # reused for SSH fallback
from netconsole_worker.parsers.show_mac_table import parse_juniper_mac_table  # reused
from netconsole_worker.ssh_client import run_ssh_command

logger = logging.getLogger(__name__)


def _creds(config: Any) -> dict[str, Any]:
    return {
        "host": None,  # caller sets host
        "username": config.iosxe.user or config.ssh_user,
        "password": config.iosxe.password or config.ssh_password,
        "scheme": config.iosxe.scheme,
        "port": config.iosxe.port,
        "verify_tls": config.iosxe.verify_tls,
    }


# IOS interface name validation — different rules from Juniper.
# Examples: GigabitEthernet0/0/1, TenGigabitEthernet1/1/1, FastEthernet0/1.
_IFACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9/.:-]{0,63}$")
_PROTECTED_PREFIXES = ("Loopback", "Tunnel", "Port-channel", "Vlan", "BDI")


def _validate_iface(iface: str) -> str:
    if not _IFACE_RE.match(iface):
        raise ValueError(f"Invalid IOS-XE interface name: {iface!r}")
    if iface.startswith(_PROTECTED_PREFIXES):
        raise ValueError(f"Refusing to act on protected interface {iface}")
    return iface


class IOSxeBackend(DeviceBackend):
    """Cisco IOS-XE backend (RESTCONF + SSH CLI)."""

    source = "iosxe-rest"

    BASE = "/restconf/data"

    def _rc_get(
        self,
        device: DeviceInfo,
        path: str,
    ) -> dict[str, Any]:
        """RESTCONF GET. Returns `{ok, payload, raw, error}`."""
        pool = get_http_pool()
        creds = _creds(self.config)
        client = pool.borrow(
            host=device.ip,
            port=creds["port"],
            username=creds["username"],
            password=creds["password"],
            scheme=creds["scheme"],
            verify_tls=creds["verify_tls"],
            timeout=30.0,
        )
        try:
            resp = client.get(
                f"{self.BASE}{path}",
                headers={"Accept": "application/yang-data+json"},
                timeout=30.0,
            )
        except Exception as exc:  # noqa: BLE001
            pool.invalidate(
                host=device.ip, port=creds["port"], username=creds["username"], scheme=creds["scheme"]
            )
            return {"ok": False, "error": str(exc)}
        if resp.status_code == 404 or resp.status_code == 501:
            return {"ok": False, "error": f"RESTCONF HTTP {resp.status_code}"}
        if resp.status_code >= 400:
            return {"ok": False, "error": f"RESTCONF HTTP {resp.status_code}: {resp.text[:200]}"}
        try:
            return {"ok": True, "payload": resp.json(), "raw": resp.text}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"RESTCONF JSON decode failed: {exc}"}

    def _ssh_fallback(
        self,
        device: DeviceInfo,
        command: str,
        parser=None,
    ) -> dict[str, Any]:
        ssh_result = run_ssh_command(
            host=device.ip,
            username=self.config.ssh_user,
            password=self.config.ssh_password,
            port=self.config.ssh_port,
            command=command,
        )
        if not ssh_result["sshOk"]:
            return {"ok": False, "error": ssh_result["error"] or "SSH failed"}
        output = ssh_result["output"]
        parsed = parser(output) if parser else None
        return {"ok": True, "output": output, "parsed": parsed}

    # -- READ --------------------------------------------------------------

    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.iosxe.enabled:
            r = self._rc_get(device, "/ietf-interfaces:interfaces")
            if r["ok"]:
                interfaces = _parse_iosxe_interfaces(r["payload"])
                if interfaces:
                    return {
                        "implemented": True,
                        "source": "iosxe-rest",
                        "command": "ietf-interfaces:interfaces",
                        "interfaces": interfaces,
                        "message": "IOS-XE RESTCONF interfaces OK",
                    }
                rest_error = "RESTCONF returned no interfaces"
            else:
                rest_error = r["error"]
        else:
            rest_error = None

        # SSH fallback to `show ip interface brief` (parse with Juniper's
        # `parse_interfaces_terse` — it's vendor-agnostic enough for our
        # purposes; a tighter IOS-XE parser can land later).
        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show ip interface brief", parse_interfaces_terse)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show ip interface brief",
                    "interfaces": fb["parsed"] or [],
                    "message": "SSH fallback OK" if rest_error else "Lab SSH interfaces OK",
                    "raw": fb["output"],
                    "restError": rest_error,
                }
            return {
                "implemented": False,
                "source": "ssh-cli",
                "interfaces": [],
                "message": fb["error"] or "SSH failed",
                "restError": rest_error,
            }
        return {
            "implemented": False,
            "interfaces": [],
            "source": None,
            "message": rest_error or "Enable IOSXE_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        # IOS-XE YANG ARP coverage is patchy. Try RESTCONF first; fall
        # back to SSH immediately if 404.
        rest_error: str | None = None
        if self.config.iosxe.enabled:
            r = self._rc_get(device, "/Cisco-IOS-XE-arp-oper:arp-data")
            if r["ok"]:
                entries = _parse_iosxe_arp(r["payload"])
                return {
                    "implemented": True,
                    "source": "iosxe-rest",
                    "command": "Cisco-IOS-XE-arp-oper:arp-data",
                    "entries": entries,
                    "message": "IOS-XE RESTCONF ARP OK" if entries else "IOS-XE RESTCONF ARP OK (empty)",
                }
            rest_error = r["error"]

        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show ip arp", parse_juniper_arp_table)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show ip arp",
                    "entries": fb["parsed"] or [],
                    "message": "SSH fallback OK" if rest_error else "Lab SSH ARP OK",
                    "raw": fb["output"],
                    "restError": rest_error,
                }
            return {
                "implemented": False,
                "source": "ssh-cli",
                "entries": [],
                "message": fb["error"] or "SSH failed",
                "restError": rest_error,
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or "Enable IOSXE_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        # No stable IOS-XE YANG MAC table — SSH only.
        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show mac address-table", parse_juniper_mac_table)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show mac address-table",
                    "entries": fb["parsed"] or [],
                    "message": "Lab SSH MAC OK",
                    "raw": fb["output"],
                }
            return {
                "implemented": False,
                "source": "ssh-cli",
                "entries": [],
                "message": fb["error"] or "SSH failed",
            }

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": "Enable LAB_SSH for IOS-XE MAC table (no RESTCONF YANG)",
        }

    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.iosxe.enabled:
            r = self._rc_get(device, "/Cisco-IOS-XE-native:native?depth=unbounded")
            if r["ok"]:
                return {
                    "implemented": True,
                    "source": "iosxe-rest",
                    "config": _dump_json(r["payload"]),
                    "command": "Cisco-IOS-XE-native:native",
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
        raise RuntimeError(rest_error or "GET_CONFIG requires IOSXE_API or LAB_SSH")

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
        commands = _text_to_cmds(config)
        if not commands:
            raise RuntimeError("APPLY_CONFIG has no commands")

        # IOS-XE has no native atomic commit semantics via RESTCONF; the
        # accepted pattern is: push config lines via SSH CLI in `configure
        # terminal` mode. The device commits immediately on each line.
        # A `commit` is implicit.
        if self.config.ssh_enabled:
            outputs: list[dict[str, str]] = []
            for cmd in ["configure terminal", *commands, "end"]:
                ssh_result = run_ssh_command(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    port=self.config.ssh_port,
                    command=cmd,
                )
                if not ssh_result["sshOk"]:
                    raise RuntimeError(ssh_result["error"] or f"SSH failed on: {cmd}")
                output = ssh_result["output"] or ""
                outputs.append({"command": cmd, "output": output})
                low = output.lower().strip()
                # IOS-XE CLI errors: "% Invalid input detected at '^' marker."
                if low.startswith("% "):
                    raise RuntimeError(output.strip() or f"Command failed: {cmd}")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "config": config,
                "commands": commands,
                "outputs": outputs,
                "message": f"Committed config to {device.name}",
                "previous": previous or "",
            }

        if self.config.iosxe.enabled:
            # No NETCONF wired here yet (ncclient dep planned). Surface
            # a clear error rather than silently no-op.
            raise RuntimeError(
                "IOS-XE RESTCONF config-apply requires NETCONF (ncclient); "
                "fall back to LAB_SSH for now."
            )

        raise RuntimeError("APPLY_CONFIG requires LAB_SSH (IOS-XE NETCONF is on the roadmap)")

    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        # IOS-XE rollback = `configure replace flash: [force]`.
        # Filename strategy: we expect APPLY_CONFIG to have saved
        # `flash:pre.config` before applying the new config. If that
        # file isn't there the device will error out — surfaced as-is.
        if not self.config.ssh_enabled:
            raise RuntimeError("ROLLBACK_CONFIG on IOS-XE requires LAB_SSH")
        ssh_result = run_ssh_command(
            host=device.ip,
            username=self.config.ssh_user,
            password=self.config.ssh_password,
            port=self.config.ssh_port,
            command="configure replace flash:pre.config force",
            timeout=60,
        )
        if not ssh_result["sshOk"]:
            raise RuntimeError(ssh_result["error"] or "IOS-XE rollback failed")
        output = ssh_result["output"] or ""
        if output.lower().startswith("% "):
            raise RuntimeError(output.strip())
        return {
            "implemented": True,
            "source": "ssh-cli",
            "rollback": "configure replace flash:pre.config",
            "config": previous or "",
            "message": f"Rolled back config on {device.name}",
        }

    def interface_action(
        self,
        device: DeviceInfo,
        *,
        action: str,
        iface: str,
        vlan: str | None,
    ) -> dict[str, Any]:
        try:
            iface = _validate_iface(iface)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc

        commands: list[str] = []
        if action == "shut":
            commands = ["configure terminal", f"interface {iface}", "shutdown", "end"]
        elif action == "no-shut":
            commands = ["configure terminal", f"interface {iface}", "no shutdown", "end"]
        elif action == "set-access-vlan":
            if not vlan:
                raise RuntimeError("set-access-vlan requires a vlan argument")
            commands = [
                "configure terminal",
                f"interface {iface}",
                "switchport mode access",
                f"switchport access vlan {vlan}",
                "end",
            ]
        elif action == "show-run":
            commands = [f"show running-config interface {iface}"]
        else:
            raise RuntimeError(f"Unsupported interface action for IOS-XE: {action}")

        if not self.config.ssh_enabled:
            raise RuntimeError("Interface actions on IOS-XE require LAB_SSH")
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
            low = (ssh_result["output"] or "").lower().strip()
            if action != "show-run" and low.startswith("% "):
                raise RuntimeError((ssh_result["output"] or "").strip() or f"Command failed: {cmd}")
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

    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.iosxe.enabled:
            r = self._rc_get(device, "/ietf-system:system")
            if r["ok"]:
                payload = r["payload"].get("ietf-system:system", {}) if isinstance(r["payload"], dict) else {}
                hostname = payload.get("hostname", "")
                return {
                    "checks": {
                        "ping": True,
                        "ssh": True,
                        "showVersion": bool(hostname),
                        "showRun": bool(r.get("raw")),
                    },
                    "showVersion": r.get("raw") or "",
                    "showRun": r.get("raw") or "",
                    "parsed": {"hostname": hostname, "vendor": "Cisco"},
                    "source": "iosxe-rest",
                    "message": "IOS-XE RESTCONF identity OK",
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

            parsed = parse_show_version(device.vendor or "Cisco", ssh_result["output"])
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
            "message": rest_error or "Enable IOSXE_API or LAB_SSH",
            "source": None,
        }


# -------------------- helpers / parsers --------------------------------------


def _text_to_cmds(config: str) -> list[str]:
    commands: list[str] = []
    for line in config.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("!"):
            continue
        commands.append(stripped)
    return commands


def _dump_json(payload: Any) -> str:
    import json

    return json.dumps(payload, indent=2, sort_keys=True)


def _parse_iosxe_interfaces(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """`ietf-interfaces:interfaces` → list of {name, adminStatus, operStatus, ...}."""
    interfaces = payload.get("ietf-interfaces:interfaces", {}).get("interface", [])
    out: list[dict[str, Any]] = []
    for entry in interfaces:
        out.append({
            "name": entry.get("name"),
            "adminStatus": (entry.get("enabled") and "up") or "down",
            "operStatus": entry.get("oper-status", "unknown"),
            "description": entry.get("description"),
            "speed": None,  # ietf-interfaces doesn't carry speed
            "macAddress": entry.get("phys-address"),
        })
    return out


def _parse_iosxe_arp(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """`Cisco-IOS-XE-arp-oper:arp-data` → list of {address, mac, interface}."""
    entries = payload.get("Cisco-IOS-XE-arp-oper:arp-data", {}).get("arp-entry", [])
    out: list[dict[str, Any]] = []
    for entry in entries:
        address = entry.get("address")
        mac = entry.get("hardware") or entry.get("mac")
        interface = entry.get("interface")
        if not address:
            continue
        out.append({"address": address, "macAddress": mac, "interface": interface})
    return out
