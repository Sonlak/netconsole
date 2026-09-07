"""Cisco NX-OS backend — NX-API REST + NX-API CLI.

NX-API REST serves DME (Data Model Engine) JSON at `/api/mo/...`
(every object has a long, descriptive class name). NX-API CLI serves
the familiar `show` and `config t` commands at `/ins` as JSON-RPC.

Default scheme is HTTP on port 80 because that's the lab default;
production should use HTTPS :443. Configurable via `nxos_api_*` env vars.
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
from netconsole_worker.parsers.show_arp import parse_juniper_arp_table  # reused for SSH fallback
from netconsole_worker.parsers.show_interfaces import parse_interfaces_terse
from netconsole_worker.parsers.show_mac_table import parse_juniper_mac_table
from netconsole_worker.ssh_client import run_ssh_command

logger = logging.getLogger(__name__)


_IFACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9/.:-]{0,63}$")
_PROTECTED_PREFIXES = ("loopback", "tunnel", "port-channel", "vlan", "mgmt", "bdi")


def _validate_iface(iface: str) -> str:
    if not _IFACE_RE.match(iface):
        raise ValueError(f"Invalid NX-OS interface name: {iface!r}")
    if iface.lower().startswith(_PROTECTED_PREFIXES):
        raise ValueError(f"Refusing to act on protected interface {iface}")
    return iface


def _creds(config: Any) -> dict[str, Any]:
    return {
        "username": config.nxos.user or config.ssh_user,
        "password": config.nxos.password or config.ssh_password,
        "scheme": config.nxos.scheme,
        "port": config.nxos.port,
        "verify_tls": config.nxos.verify_tls,
    }


class NxosBackend(DeviceBackend):
    """Cisco NX-OS backend (NX-API REST + NX-API CLI)."""

    source = "nxos-nxapi"

    MO = "/api/mo"  # DME object paths
    INS = "/ins"    # show / config commands

    def _mo_get(self, device: DeviceInfo, mo_path: str) -> dict[str, Any]:
        """NX-API REST GET against a DME object path."""
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
            resp = client.get(f"{creds['scheme']}://{device.ip}:{creds['port']}{self.MO}/{mo_path}.json", timeout=30.0)
        except Exception as exc:  # noqa: BLE001
            pool.invalidate(
                host=device.ip, port=creds["port"], username=creds["username"], scheme=creds["scheme"]
            )
            return {"ok": False, "error": str(exc)}
        if resp.status_code >= 400:
            return {"ok": False, "error": f"NX-API HTTP {resp.status_code}: {resp.text[:200]}"}
        try:
            return {"ok": True, "payload": resp.json(), "raw": resp.text}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"NX-API JSON decode failed: {exc}"}

    def _cli(self, device: DeviceInfo, commands: list[str], type_: str = "cli_show") -> dict[str, Any]:
        """POST a batch of CLI commands at /ins."""
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
        payload = {
            "ins_api": {
                "version": "1.0",
                "type": type_,
                "chunk": "0",
                "sid": "1",
                "input": " ; ".join(commands),
                "output_format": "json",
            }
        }
        try:
            resp = client.post(f"{creds['scheme']}://{device.ip}:{creds['port']}{self.INS}", json=payload, timeout=45.0)
        except Exception as exc:  # noqa: BLE001
            pool.invalidate(
                host=device.ip, port=creds["port"], username=creds["username"], scheme=creds["scheme"]
            )
            return {"ok": False, "error": str(exc)}
        if resp.status_code >= 400:
            return {"ok": False, "error": f"NX-API HTTP {resp.status_code}: {resp.text[:200]}"}
        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"NX-API JSON decode failed: {exc}"}
        ins_api = data.get("ins_api", {})
        if ins_api.get("type") == "cli_show" and ins_api.get("outputs"):
            body = ins_api["outputs"].get("output", {})
            if isinstance(body, dict) and body.get("code") not in (None, "200"):
                return {"ok": False, "error": f"NX-API CLI error code {body.get('code')}: {body.get('msg')}"}
        return {"ok": True, "result": data.get("ins_api"), "raw": resp.text}

    def _ssh_fallback(self, device: DeviceInfo, command: str, parser=None) -> dict[str, Any]:
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
        return {"ok": True, "output": output, "parsed": parser(output) if parser else None}

    # -- READ --------------------------------------------------------------

    def get_interfaces(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.nxos.enabled:
            r = self._mo_get(device, "sys/intf/phys-[*]")
            if r["ok"]:
                interfaces = _parse_nxos_interfaces(r["payload"])
                if interfaces:
                    return {
                        "implemented": True,
                        "source": "nxos-nxapi",
                        "command": "sys/intf/phys-[*]",
                        "interfaces": interfaces,
                        "message": "NX-API REST interfaces OK",
                    }
                rest_error = "NX-API returned no interfaces"
            else:
                rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show ip interface brief vrf all", parse_interfaces_terse)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show ip interface brief vrf all",
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
            "message": rest_error or "Enable NXOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_arp(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.nxos.enabled:
            r = self._mo_get(device, "show-ip-arp-1")
            if r["ok"]:
                entries = _parse_nxos_arp(r["payload"])
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "command": "show-ip-arp-1",
                    "entries": entries,
                    "message": "NX-API ARP OK" if entries else "NX-API ARP OK (empty)",
                }
            rest_error = r["error"]
        else:
            rest_error = None

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
            "message": rest_error or "Enable NXOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_mac(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.nxos.enabled:
            r = self._mo_get(device, "show-mac-address-table-1")
            if r["ok"]:
                entries = _parse_nxos_mac(r["payload"])
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "command": "show-mac-address-table-1",
                    "entries": entries,
                    "message": "NX-API MAC OK" if entries else "NX-API MAC OK (empty)",
                }
            rest_error = r["error"]
        else:
            rest_error = None

        if self.config.ssh_enabled:
            fb = self._ssh_fallback(device, "show mac address-table", parse_juniper_mac_table)
            if fb["ok"]:
                return {
                    "implemented": True,
                    "source": "ssh-cli",
                    "command": "show mac address-table",
                    "entries": fb["parsed"] or [],
                    "message": "SSH fallback OK" if rest_error else "Lab SSH MAC OK",
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
            "message": rest_error or "Enable NXOS_API or LAB_SSH",
            "restError": rest_error,
        }

    def get_config(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.nxos.enabled:
            r = self._mo_get(device, "show-running-config-1")
            if r["ok"]:
                # DME response is verbose; we serialize the body as text.
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "config": r.get("raw") or "",
                    "command": "show-running-config-1",
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
        raise RuntimeError(rest_error or "GET_CONFIG requires NXOS_API or LAB_SSH")

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

        if self.config.nxos.enabled:
            # NX-API CLI batch uses ';' as cmd separator.
            batch = ["config terminal", *commands, "end"]
            r = self._cli(device, batch, type_="cli_conf")
            if r["ok"]:
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "config": config,
                    "commands": commands,
                    "message": f"Committed config to {device.name}",
                    "raw": r.get("raw", ""),
                    "previous": previous or "",
                }
            raise RuntimeError(r["error"] or "NX-API config failed")

        if self.config.ssh_enabled:
            outputs: list[dict[str, str]] = []
            for cmd in ["config t", *commands, "end"]:
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
                # NX-OS CLI errors start with '%%' (double percent).
                if low.startswith("%%"):
                    raise RuntimeError((ssh_result["output"] or "").strip() or f"Command failed: {cmd}")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "config": config,
                "commands": commands,
                "outputs": outputs,
                "message": f"Committed config to {device.name}",
                "previous": previous or "",
            }

        raise RuntimeError("APPLY_CONFIG requires NXOS_API or LAB_SSH")

    def rollback_config(
        self,
        device: DeviceInfo,
        rollback_index: int | None,
        previous: str | None = None,
    ) -> dict[str, Any]:
        # NX-OS rollback = `rollback running-config checkpoint <name>` or
        # `rollback running-config checkpoint previous`. We use the
        # `previous` keyword so it doesn't require a named checkpoint.
        commands = ["rollback running-config checkpoint previous"]
        if self.config.nxos.enabled:
            r = self._cli(device, commands, type_="cli_conf")
            if r["ok"]:
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "rollback": "checkpoint previous",
                    "config": previous or "",
                    "message": f"Rolled back config on {device.name}",
                    "raw": r.get("raw", ""),
                }
            raise RuntimeError(r["error"] or "NX-API rollback failed")

        if self.config.ssh_enabled:
            ssh_result = run_ssh_command(
                host=device.ip,
                username=self.config.ssh_user,
                password=self.config.ssh_password,
                port=self.config.ssh_port,
                command="rollback running-config checkpoint previous",
                timeout=60,
            )
            if not ssh_result["sshOk"]:
                raise RuntimeError(ssh_result["error"] or "NX-OS rollback failed")
            return {
                "implemented": True,
                "source": "ssh-cli",
                "rollback": "checkpoint previous",
                "config": previous or "",
                "message": f"Rolled back config on {device.name}",
            }

        raise RuntimeError("ROLLBACK_CONFIG requires NXOS_API or LAB_SSH")

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
            commands = ["config t", f"interface {iface}", "shutdown", "end"]
        elif action == "no-shut":
            commands = ["config t", f"interface {iface}", "no shutdown", "end"]
        elif action == "set-access-vlan":
            if not vlan:
                raise RuntimeError("set-access-vlan requires a vlan argument")
            commands = [
                "config t",
                f"interface {iface}",
                "switchport mode access",
                f"switchport access vlan {vlan}",
                "end",
            ]
        elif action == "show-run":
            commands = [f"show running-config interface {iface}"]
        else:
            raise RuntimeError(f"Unsupported interface action for NX-OS: {action}")

        if self.config.nxos.enabled:
            type_ = "cli_conf" if action != "show-run" else "cli_show"
            r = self._cli(device, commands, type_=type_)
            if r["ok"]:
                config = None
                if action == "show-run" and r.get("result"):
                    ins = r["result"]
                    outputs = ins.get("outputs", {})
                    body = outputs.get("output") if isinstance(outputs, dict) else None
                    if isinstance(body, dict):
                        config = body.get("body", "")
                return {
                    "implemented": True,
                    "source": "nxos-nxapi",
                    "action": action,
                    "interface": iface,
                    "vlan": vlan or None,
                    "commands": commands,
                    "message": f"Interface action {action} OK on {iface}",
                    "adminStatus": "down" if action == "shut" else "up" if action == "no-shut" else None,
                    "accessVlan": vlan if action == "set-access-vlan" else None,
                    "config": config,
                    "raw": r.get("raw", ""),
                }
            raise RuntimeError(r["error"] or f"NX-API {action} failed")

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
                low = (ssh_result["output"] or "").lower().strip()
                if action != "show-run" and low.startswith("%%"):
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

        raise RuntimeError("Interface actions require NXOS_API or LAB_SSH")

    def probe_identity(self, device: DeviceInfo) -> dict[str, Any]:
        if self.config.nxos.enabled:
            r = self._mo_get(device, "show-version-1")
            if r["ok"]:
                parsed = _parse_nxos_show_version(r["payload"])
                hostname = (parsed.get("hostname") or "").strip()
                if hostname:
                    parsed["description"] = f"Hostname {hostname} (NX-API)"
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
                    "source": "nxos-nxapi",
                    "message": "NX-API identity OK",
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
            "message": rest_error or "Enable NXOS_API or LAB_SSH",
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


def _parse_nxos_interfaces(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """DME `sys/intf/phys-[*]` → list of interface dicts."""
    items = payload.get("imdata") or payload.get("items") or []
    out: list[dict[str, Any]] = []
    for item in items:
        # DME wraps each item in a class key like 'physIf'.
        body = next(iter(item.values())) if isinstance(item, dict) else {}
        attributes = body.get("attributes", {}) if isinstance(body, dict) else {}
        out.append({
            "name": attributes.get("id"),
            "adminStatus": attributes.get("adminSt") or attributes.get("adminStatus"),
            "operStatus": attributes.get("operSt") or attributes.get("operState"),
            "description": attributes.get("descr"),
            "speed": attributes.get("speed"),
            "mtu": attributes.get("mtu"),
            "macAddress": attributes.get("mac"),
        })
    return out


def _parse_nxos_arp(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """DME `show-ip-arp-1` → list of {ip, mac, interface, ...}.

    Field names normalized to match `ArpAddressRow`. NX-OS DME uses
    `addr`/`mac`/`ifId` (no `hostname`, no `flags`).
    """
    items = payload.get("imdata") or []
    out: list[dict[str, Any]] = []
    for item in items:
        body = next(iter(item.values())) if isinstance(item, dict) else {}
        attributes = body.get("attributes", {}) if isinstance(body, dict) else {}
        address = attributes.get("addr")
        if not address:
            continue
        mac = normalize_mac(attributes.get("mac") or "")
        if not mac:
            continue
        try:
            parsed = ip_address(address)
            if parsed.is_loopback or parsed.is_link_local:
                continue
        except ValueError:
            continue
        out.append({
            "ip": address,
            "mac": mac,
            "hostname": address,
            "interface": attributes.get("ifId") or "-",
            "flags": "none",
            "age": attributes.get("age"),
        })
    return out


def _parse_nxos_mac(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """DME `show-mac-address-table-1` → list of {mac, vlan, interface, ...}.

    Field names normalized to match `MacAddressRow`. NX-OS `type` is
    `"static"`/`"dynamic"` (long form) — we mirror it to `type` and
    derive a single `flags` char.
    """
    items = payload.get("imdata") or []
    out: list[dict[str, Any]] = []
    for item in items:
        body = next(iter(item.values())) if isinstance(item, dict) else {}
        attributes = body.get("attributes", {}) if isinstance(body, dict) else {}
        mac = normalize_mac(attributes.get("macAddr") or "")
        if not mac:
            continue
        entry_type = (attributes.get("type") or "dynamic").lower()
        flag = "S" if entry_type == "static" else "D"
        out.append({
            "mac": mac,
            "vlan": str(attributes.get("vlanId") or "-"),
            "tag": "-",
            "interface": attributes.get("intf") or "-",
            "flags": flag,
            "type": entry_type,
            "sessId": "0",
        })
    return out


def _parse_nxos_show_version(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("imdata") or []
    if not items:
        return {}
    body = next(iter(items[0].values())) if isinstance(items[0], dict) else {}
    attributes = body.get("attributes", {}) if isinstance(body, dict) else {}
    return {
        "hostname": attributes.get("host_name") or attributes.get("hostName"),
        "model": attributes.get("model"),
        "version": attributes.get("nxos_ver_str") or attributes.get("version"),
        "serial": attributes.get("proc_sn") or attributes.get("serial"),
        "uptime": attributes.get("kern_uptm") or attributes.get("uptime"),
        "vendor": "Cisco",
    }
