"""Cisco IOS-XE backend — RESTCONF + SSH CLI fallback.

IOS-XE supports RESTCONF on port 443 with the same YANG models as
Catalyst 9000 / ASR 1000 / ISR 4000. Coverage is patchy for ARP/MAC,
so we SSH-fallback for those (mirrors the Juniper approach).
"""

from __future__ import annotations

import logging
import re
from ipaddress import ip_address
from typing import Any

from netconsole_worker.backends.base import DeviceBackend
from netconsole_worker.http_pool import get_http_pool
from netconsole_worker.models import DeviceInfo
from netconsole_worker.parsers.junos_leaf import normalize_mac
from netconsole_worker.parsers.show_arp import parse_cisco_arp_table
from netconsole_worker.parsers.show_mac_table import parse_cisco_mac_table
from netconsole_worker.ssh_client import (
    netconf_get_interface_config,
    netconf_interface_action,
    netconf_set_access_vlan,
    run_ssh_command,
    run_ssh_commands_session,
)

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
            url = f"{creds['scheme']}://{device.ip}:{creds['port']}{self.BASE}{path}"
            resp = client.get(
                url,
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
        # Prefer SSH — `show interfaces` gives speed/MTU/description/mac.
        # RESTCONF ietf-interfaces is sparse on this lab image.
        rest_error: str | None = None
        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show interfaces", None)
            if fb["ok"]:
                lines = (fb["output"] or "").splitlines()
                interfaces = _parse_cisco_interfaces(lines)
                if interfaces:
                    return {
                        "implemented": True,
                        "source": "ssh-cli",
                        "command": "show interfaces",
                        "interfaces": interfaces,
                        "message": "Lab SSH interfaces OK",
                        "raw": fb["output"],
                    }
                ssh_error = "SSH show interfaces returned no data"
            else:
                ssh_error = fb["error"] or "SSH failed"
        else:
            ssh_error = None

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
                        "restError": ssh_error,
                    }
                rest_error = "RESTCONF returned no interfaces"
            else:
                rest_error = r["error"]

        return {
            "implemented": False,
            "interfaces": [],
            "source": None,
            "message": rest_error or ssh_error or "Enable IOSXE_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        # Prefer SSH (`show ip arp`) — Cisco IOS-XE 17.x RESTCONF YANG
        # returns empty `Cisco-IOS-XE-arp-oper:arp-data` even when the
        # ARP table is populated, so SSH is the reliable path.
        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show ip arp", parse_cisco_arp_table)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show ip arp",
                    "entries": fb["parsed"] or [],
                    "message": "Lab SSH ARP OK",
                    "raw": fb["output"],
                }
            ssh_error = fb["error"] or "SSH failed"
        else:
            ssh_error = None

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
                    "restError": ssh_error,
                }
            rest_error = r["error"]
        else:
            rest_error = None

        return {
            "implemented": False,
            "entries": [],
            "source": None,
            "message": rest_error or ssh_error or "Enable IOSXE_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        # No stable IOS-XE YANG MAC table — SSH only.
        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show mac address-table", parse_cisco_mac_table)
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
        # Prefer SSH CLI because RESTCONF returns JSON (Cisco YANG model)
        # which the frontend Config Studio can't render as code. SSH returns
        # the actual `show running-config` text — same shape as Juniper/Arista.
        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show running-config",
            )
            if ssh_result.get("sshOk"):
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "config": ssh_result["output"] or "",
                    "command": "show running-config",
                    "message": f"Collected running config from {device.name}",
                }
            ssh_error = ssh_result.get("error") or "SSH failed"

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

        raise RuntimeError(rest_error or ssh_error or "GET_CONFIG requires IOSXE_API or LAB_SSH")

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
            # All commands must run in one SSH session so `configure terminal`
            # config mode persists across all config lines.
            all_cmds = ["configure terminal", *commands, "end"]
            session_result = run_ssh_commands_session(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                commands=all_cmds,
                timeout=60,
            )
            if not session_result["sshOk"]:
                raise RuntimeError(
                    session_result["error"] or "SSH session failed for apply_config"
                )
            outputs = session_result["outputs"]
            for out in outputs:
                if out["error"] and out["error"].lower().startswith("% "):
                    raise RuntimeError(out["error"] or "Config command failed")
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

        if action in ("shut", "no-shut", "set-access-vlan", "show-run"):
            # NETCONF primary (gotcha #14). Reliable, atomic, structured
            # output for show-run. SSH remains the fallback path.
            nc_result = None
            if action in ("shut", "no-shut"):
                nc_result = netconf_interface_action(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    iface_name=iface,
                    action=action,
                    port=830,
                    timeout=30,
                )
            elif action == "set-access-vlan":
                if not vlan:
                    raise RuntimeError("set-access-vlan requires a vlan argument")
                nc_result = netconf_set_access_vlan(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    iface_name=iface,
                    vlan=int(vlan),
                    port=830,
                    timeout=30,
                )
            elif action == "show-run":
                nc_result = netconf_get_interface_config(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    iface_name=iface,
                    port=830,
                    timeout=30,
                )

            if nc_result and nc_result.get("ok"):
                # Build a uniform success envelope so the frontend doesn't
                # care which backend won.
                admin = (
                    "down"
                    if action == "shut"
                    else "up"
                    if action == "no-shut"
                    else None
                )
                return {
                    "implemented": True,
                    "source": "netconf",
                    "action": action,
                    "interface": iface,
                    "vlan": vlan or None,
                    "commands": [],
                    "outputs": [],
                    "message": nc_result.get("message", f"Interface action {action} OK on {iface}"),
                    "adminStatus": admin,
                    "accessVlan": vlan if action == "set-access-vlan" else None,
                    "config": nc_result.get("config") if action == "show-run" else None,
                }
            # NETCONF failed — fall back to SSH CLI
            logger.warning(
                "NETCONF %s on %s failed (%s), falling back to SSH CLI",
                action,
                iface,
                (nc_result or {}).get("error", ""),
            )

        # Build CLI commands (SSH fallback for all actions including shut/no-shut)
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
            # Cisco IOS-XE default session uses `terminal pager` which paginates
            # `show running-config` with `--More--` prompts and reads back as
            # empty string when our pipeline (no TTY input) eats them. Prefixing
            # `terminal length 0` disables the pager for the session, and the
            # `| section` filter scopes the output to just this interface so we
            # don't dump the whole running-config.
            commands = [
                "terminal length 0",
                f"show running-config interface {iface}",
            ]
        else:
            raise RuntimeError(f"Unsupported interface action for IOS-XE: {action}")

        if not self.config.ssh_enabled:
            raise RuntimeError("Interface actions on IOS-XE require LAB_SSH or NETCONF")

        # All commands must run in one SSH session so `configure terminal`
        # config mode persists across all config lines.
        session_result = run_ssh_commands_session(
            host=device.ip,
            username=self.config.ssh_user,
            password=self.config.ssh_password,
            port=self.config.ssh_port,
            commands=commands,
            timeout=30,
        )
        if not session_result["sshOk"]:
            raise RuntimeError(
                session_result["error"] or "SSH session failed for interface action"
            )

        outputs: list[dict[str, str]] = session_result["outputs"]
        for out in outputs:
            if out["error"] and not out["error"].lower().startswith("% "):
                # Only hard-fail on true CLI errors; ignore info banners
                raise RuntimeError(out["error"] or "Command failed in session")

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
            ssh_version = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="show version",
            )
            if not ssh_version["sshOk"]:
                return {
                    "checks": {"ping": True, "ssh": False, "showVersion": False, "showRun": False},
                    "message": ssh_version["error"] or "SSH failed",
                    "source": "ssh-cli",
                    "restError": rest_error,
                }
            from netconsole_worker.parsers.show_version import parse_show_version

            parsed = parse_show_version(device.vendor or "Cisco", ssh_version["output"])

            # Also test show running-config so the managed-check banner shows green
            show_run_ok = False
            show_run_output = ""
            if ssh_version["sshOk"]:
                ssh_run = run_ssh_command(
                    host=device.ip,
                    username=self.config.ssh_user,
                    password=self.config.ssh_password,
                    port=self.config.ssh_port,
                    command="show running-config",
                )
                if ssh_run["sshOk"] and len(ssh_run.get("output", "")) > 50:
                    show_run_ok = True
                    show_run_output = ssh_run["output"]

            return {
                "checks": {"ping": True, "ssh": True, "showVersion": True, "showRun": show_run_ok},
                "showVersion": ssh_version["output"],
                "showRun": show_run_output,
                "parsed": parsed,
                "source": "ssh-cli",
                "message": "Lab SSH show version OK" if show_run_ok else "Lab SSH show version OK; show running-config " + ("OK" if show_run_ok else "FAILED"),
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


def _parse_cisco_interfaces(lines: list[str]) -> list[dict[str, Any]]:
    """Parse Cisco IOS `show interfaces` text output.

    Each interface block starts with a line like:
      GigabitEthernet1 is administratively down, line protocol is down
    We extract name, adminStatus, operStatus, speed, MTU, mac, description.
    """
    out: list[dict[str, Any]] = []

    # Find interface block boundaries (lines that start with an interface name).
    block_starts: list[int] = []
    for i, line in enumerate(lines):
        # Interface name line: starts with alphanumeric (no leading space) and
        # contains ` is ` to mark the admin-status clause.
        if not line or line[0].isspace():
            continue
        if re.search(r"\s+is\s+", line):
            block_starts.append(i)

    for idx, start in enumerate(block_starts):
        end = block_starts[idx + 1] if idx + 1 < len(block_starts) else len(lines)
        block_lines = lines[start:end]
        block_text = "\n".join(block_lines)
        first_line = block_lines[0]

        # Extract name: everything before the first ` is `.
        name_m = re.match(r"^(\S+)", first_line)
        name = name_m.group(1) if name_m else first_line.split()[0]

        # Admin/oper status.
        status_m = re.search(
            r"is\s+((?:administratively\s+)?up|down),\s+line\s+protocol\s+is\s+((?:administratively\s+)?up|down)",
            first_line,
        )
        admin = "up" if status_m and status_m.group(1) == "up" else "down"
        oper = "up" if status_m and status_m.group(2) == "up" else "down"

        # Speed.
        speed: int | None = None
        sm = re.search(r"(\d+)\s*(Mbps|Gbps)", block_text, re.IGNORECASE)
        if sm:
            val = int(sm.group(1))
            speed = val if sm.group(2).upper() == "MBPS" else val * 1000

        # MTU.
        mtu: int | None = None
        mtu_m = re.search(r"MTU\s+(\d+)\s+bytes", block_text)
        if mtu_m:
            mtu = int(mtu_m.group(1))

        # MAC: "Hardware is ..., address is 5000.0007.0000"
        mac: str | None = None
        mac_m = re.search(r"address\s+is\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})", block_text)
        if mac_m:
            mac = _normalize_cisco_mac(mac_m.group(1))

        # Description.
        desc: str | None = None
        desc_m = re.search(r"Description:\s+(.+)$", block_text, re.MULTILINE)
        if desc_m:
            desc = desc_m.group(1).strip()

        out.append({
            "name": name,
            "adminStatus": admin,
            "operStatus": oper,
            "description": desc,
            "speed": speed,
            "mtu": mtu,
            "macAddress": mac,
        })
    return out


def _normalize_cisco_mac(mac: str) -> str:
    """`5000.0007.0003` → `50:00:00:07:00:03`."""
    parts = mac.split(".")
    if len(parts) != 3:
        return mac
    # Each 4-hex-char group represents the lower 16 bits of an octet.
    return ":".join(p.lower() for p in parts)


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
    """`Cisco-IOS-XE-arp-oper:arp-data` → list of {ip, mac, interface, ...}.

    Field names normalized to match `ArpAddressRow`. IOS-XE YANG
    `arp-entry` uses `address`/`hardware` (no `hostname`, no `flags`).
    """
    entries = payload.get("Cisco-IOS-XE-arp-oper:arp-data", {}).get("arp-entry", [])
    out: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        address = entry.get("address")
        if not address:
            continue
        mac = normalize_mac(entry.get("hardware") or entry.get("mac") or "")
        if not mac:
            continue
        # Skip loopback / link-local.
        try:
            parsed = ip_address(address)
            if parsed.is_loopback or parsed.is_link_local:
                continue
        except ValueError:
            continue
        out.append({
            "ip": address,
            "mac": mac,
            "hostname": entry.get("hostname") or address,
            "interface": entry.get("interface") or "-",
            "flags": "none",
        })
    return out
