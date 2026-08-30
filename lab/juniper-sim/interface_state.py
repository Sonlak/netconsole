"""Shared stateful interface inventory for Junos lab simulators."""

from __future__ import annotations

import json
import os
import re
import subprocess
from copy import deepcopy
from typing import Any


STATE_PATH = os.environ.get("NETCONSOLE_IFACE_STATE", "/var/lib/netconsole/interfaces.json")


def _mgmt_ip() -> str:
    return (
        os.environ.get("DEVICE_IP_MGMT")
        or _read_env_file().get("DEVICE_IP_MGMT")
        or "172.30.0.11"
    )


def _read_env_file() -> dict[str, str]:
    values: dict[str, str] = {}
    path = "/etc/netconsole/device.env"
    if not os.path.exists(path):
        return values
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def _env_value(key: str, default: str = "") -> str:
    return os.environ.get(key) or _read_env_file().get(key) or default


def _svi_ifaces_spec() -> str:
    return _env_value("SVI_IFACES").strip()


def _device_role() -> str:
    return _env_value("DEVICE_ROLE").strip().lower()


def dhcp_relay_servers() -> list[str]:
    # Only when explicitly set (blank lab has no relay until pushed from app).
    raw = _env_value("DHCP_RELAY_SERVERS").strip()
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def default_core_interfaces(svi_spec: str) -> list[dict[str, Any]]:
    """L3 core: mgmt + inet gateways .1 on each VLAN iface (ethN -> ge-0/0/N)."""
    mgmt = _mgmt_ip()
    ifaces: list[dict[str, Any]] = [
        {
            "name": "ge-0/0/0",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "mgmt",
            "mode": "inet",
            "accessVlan": "",
            "address": f"{mgmt}/24",
            "mtu": "1514",
            "speed": "1000mbps",
        }
    ]
    for item in svi_spec.split():
        if ":" not in item:
            continue
        vid, eth = item.split(":", 1)
        vid = vid.strip()
        eth = eth.strip()
        m = re.match(r"^eth(\d+)$", eth)
        unit = m.group(1) if m else eth
        ifaces.append(
            {
                "name": f"ge-0/0/{unit}",
                "adminStatus": "up",
                "operStatus": "up",
                "description": f"vlan{vid}-gateway",
                "mode": "inet",
                "accessVlan": vid,
                "address": f"172.30.{vid}.1/24",
                "mtu": "1514",
                "speed": "1000mbps",
            }
        )
    return ifaces


def default_switch_interfaces() -> list[dict[str, Any]]:
    """Access/dist default: access ports + trunk uplink."""
    mgmt = _mgmt_ip()
    return [
        {
            "name": "ge-0/0/0",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "mgmt",
            "mode": "inet",
            "accessVlan": "",
            "address": f"{mgmt}/24",
            "mtu": "1514",
            "speed": "1000mbps",
        },
        {
            "name": "ge-0/0/1",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "access",
            "mode": "access",
            "accessVlan": "10",
            "address": "",
            "mtu": "1514",
            "speed": "1000mbps",
        },
        {
            "name": "ge-0/0/2",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "access",
            "mode": "access",
            "accessVlan": "20",
            "address": "",
            "mtu": "1514",
            "speed": "1000mbps",
        },
        {
            "name": "ge-0/0/3",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "access",
            "mode": "access",
            "accessVlan": "30",
            "address": "",
            "mtu": "1514",
            "speed": "1000mbps",
        },
        {
            "name": "xe-0/1/0",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "uplink",
            "mode": "trunk",
            "accessVlan": "",
            "address": "",
            "mtu": "1514",
            "speed": "10Gbps",
        },
    ]


def default_interfaces() -> list[dict[str, Any]]:
    # Blank lab: mgmt only unless SVI_IFACES is explicitly provided.
    svi = _svi_ifaces_spec()
    if svi:
        return default_core_interfaces(svi)
    mgmt = _mgmt_ip()
    return [
        {
            "name": "ge-0/0/0",
            "adminStatus": "up",
            "operStatus": "up",
            "description": "mgmt",
            "mode": "inet",
            "accessVlan": "",
            "address": f"{mgmt}/24",
            "mtu": "1514",
            "speed": "1000mbps",
        }
    ]


def load_interfaces() -> list[dict[str, Any]]:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    if not os.path.exists(STATE_PATH) or os.path.getsize(STATE_PATH) == 0:
        ifaces = default_interfaces()
        save_interfaces(ifaces)
        return deepcopy(ifaces)

    try:
        with open(STATE_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (json.JSONDecodeError, OSError):
        ifaces = default_interfaces()
        save_interfaces(ifaces)
        return deepcopy(ifaces)

    ifaces = data.get("interfaces") if isinstance(data, dict) else data
    if not isinstance(ifaces, list) or not ifaces:
        ifaces = default_interfaces()
        save_interfaces(ifaces)
    return deepcopy(ifaces)


def save_interfaces(ifaces: list[dict[str, Any]]) -> None:
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as handle:
        json.dump({"interfaces": ifaces}, handle, indent=2)
    # REST may create the file as root; keep it writable for SSH user `lab`
    try:
        os.chmod(STATE_PATH, 0o666)
    except OSError:
        pass


def find_interface(name: str) -> dict[str, Any] | None:
    target = name.strip()
    for iface in load_interfaces():
        if iface["name"] == target:
            return iface
    return None


def _ip_cmd(*args: str) -> subprocess.CompletedProcess[str]:
    """Run ip(8); prefer sudo when not root (SSH lab user)."""
    argv = ["ip", *args]
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        argv = ["sudo", "-n", *argv]
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        check=False,
        timeout=5,
    )


def _linux_addrs() -> list[tuple[str, str]]:
    """Return (dev, ipv4) for non-lo interfaces."""
    try:
        completed = _ip_cmd("-4", "-o", "addr", "show")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return []
    if completed.returncode != 0:
        return []
    rows: list[tuple[str, str]] = []
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        dev = parts[1].split("@", 1)[0]
        if dev == "lo":
            continue
        ip = parts[3].split("/", 1)[0]
        rows.append((dev, ip))
    return rows


def resolve_linux_device(iface: dict[str, Any]) -> str | None:
    """Map Junos logical name to the Linux eth that carries that role."""
    explicit = str(iface.get("linuxDev") or "").strip()
    if explicit:
        return explicit

    address = str(iface.get("address") or "").split("/", 1)[0].strip()
    if address:
        for dev, ip in _linux_addrs():
            if ip == address:
                return dev

    vlan = str(iface.get("accessVlan") or "").strip()
    if vlan.isdigit():
        prefix = f"172.30.{vlan}."
        for dev, ip in _linux_addrs():
            if ip.startswith(prefix):
                return dev

    # Fallback: ge-0/0/N -> ethN (jr1 SVI layout)
    m = re.match(r"^ge-0/0/(\d+)$", str(iface.get("name") or ""))
    if m:
        candidate = f"eth{m.group(1)}"
        try:
            probe = _ip_cmd("link", "show", candidate)
            if probe.returncode == 0:
                return candidate
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return None
    return None


def sync_linux_admin(iface: dict[str, Any], admin_up: bool) -> str | None:
    """Bring Linux dataplane link up/down to match Junos admin state."""
    dev = resolve_linux_device(iface)
    if not dev:
        return None
    action = "up" if admin_up else "down"
    try:
        completed = _ip_cmd("link", "set", "dev", dev, action)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return f"linux {dev}: {exc}"
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "ip link failed").strip()
        return f"linux {dev}: {err}"
    return f"linux {dev} {action}"


def update_interface(name: str, **changes: Any) -> dict[str, Any] | None:
    ifaces = load_interfaces()
    for iface in ifaces:
        if iface["name"] == name:
            iface.update(changes)
            if iface.get("adminStatus") == "down":
                iface["operStatus"] = "down"
            elif iface.get("adminStatus") == "up" and iface.get("operStatus") == "down":
                # bring link back when admin enabled
                iface["operStatus"] = "up"
            save_interfaces(ifaces)
            return deepcopy(iface)
    return None


def format_terse() -> str:
    lines = [
        "Interface               Admin Link Proto    Local                 Remote",
    ]
    for iface in load_interfaces():
        proto = {
            "inet": "inet",
            "access": "eth-switch",
            "trunk": "eth-switch",
        }.get(str(iface.get("mode")), "eth-switch")
        local = iface.get("address") or ""
        lines.append(
            f"{iface['name']:<23} {iface['adminStatus']:<5} {iface['operStatus']:<4} "
            f"{proto:<8} {local}"
        )
    return "\n".join(lines) + "\n"


def format_show_interfaces() -> str:
    chunks: list[str] = []
    for iface in load_interfaces():
        admin = iface.get("adminStatus") or "up"
        oper = iface.get("operStatus") or "up"
        enabled = "Enabled" if admin == "up" else "Disabled"
        flags = "Present Running" if oper == "up" else "Present"
        chunks.append(
            f"Physical interface: {iface['name']}, "
            f"{enabled}, Physical link is {oper}\n"
            f"  Interface index: 0, SNMP ifIndex: 0\n"
            f"  Description: {iface.get('description') or '-'}\n"
            f"  Link-level type: Ethernet, MTU: {iface.get('mtu')}, "
            f"Speed: {iface.get('speed')}\n"
            f"  Device flags: {flags}\n"
            f"  Interface flags: SNMP-Traps Internal: 0x0\n"
            f"  Admin status: {admin}, Oper status: {oper}\n"
            f"  Mode: {iface.get('mode')}, Access VLAN: {iface.get('accessVlan') or '-'}\n"
        )
    return "\n".join(chunks)


def format_config_interface(name: str) -> str:
    iface = find_interface(name)
    if not iface:
        return f"error: interface {name} not found\n"

    lines = [f"## interface {name}"]
    if iface.get("adminStatus") == "down":
        lines.append("disable;")
    if iface.get("description"):
        lines.append(f'description "{iface["description"]}";')

    if iface.get("mode") == "inet":
        addr = iface.get("address") or _mgmt_ip() + "/24"
        lines.append("unit 0 {")
        lines.append("    family inet {")
        lines.append(f"        address {addr};")
        lines.append("    }")
        lines.append("}")
    elif iface.get("mode") == "trunk":
        lines.append("unit 0 {")
        lines.append("    family ethernet-switching {")
        lines.append("        interface-mode trunk;")
        lines.append("        vlan {")
        lines.append("            members all;")
        lines.append("        }")
        lines.append("    }")
        lines.append("}")
    else:
        vlan = iface.get("accessVlan") or "1"
        lines.append("unit 0 {")
        lines.append("    family ethernet-switching {")
        lines.append("        interface-mode access;")
        lines.append("        vlan {")
        lines.append(f"            members {vlan};")
        lines.append("        }")
        lines.append("    }")
        lines.append("}")

    return "\n".join(lines) + "\n"


def format_config_set_interfaces() -> str:
    lines: list[str] = []
    for iface in load_interfaces():
        name = iface["name"]
        if iface.get("adminStatus") == "down":
            lines.append(f"set interfaces {name} disable")
        if iface.get("description"):
            lines.append(f'set interfaces {name} description "{iface["description"]}"')
        if iface.get("mode") == "inet":
            addr = iface.get("address") or f"{_mgmt_ip()}/24"
            lines.append(f"set interfaces {name} unit 0 family inet address {addr}")
        elif iface.get("mode") == "trunk":
            lines.append(
                f"set interfaces {name} unit 0 family ethernet-switching interface-mode trunk"
            )
            lines.append(
                f"set interfaces {name} unit 0 family ethernet-switching vlan members all"
            )
        else:
            vlan = iface.get("accessVlan") or "1"
            lines.append(
                f"set interfaces {name} unit 0 family ethernet-switching interface-mode access"
            )
            lines.append(
                f"set interfaces {name} unit 0 family ethernet-switching vlan members {vlan}"
            )
    return "\n".join(lines) + ("\n" if lines else "")


def apply_set_command(command: str) -> str:
    """Apply simplified Junos set/delete interface commands (auto-commit)."""
    text = command.strip()
    lower = text.lower()

    m_disable = re.match(r"^set\s+interfaces\s+(\S+)\s+disable$", lower)
    if m_disable:
        name = _original_iface_name(text, m_disable.group(1))
        if not find_interface(name):
            return f"error: interface {name} not found\n"
        updated = update_interface(name, adminStatus="down", operStatus="down")
        link_note = sync_linux_admin(updated or {}, admin_up=False) if updated else None
        suffix = f"; {link_note}" if link_note else ""
        return f"commit complete (disabled {name}{suffix})\n"

    m_enable = re.match(r"^delete\s+interfaces\s+(\S+)\s+disable$", lower)
    if m_enable:
        name = _original_iface_name(text, m_enable.group(1))
        if not find_interface(name):
            return f"error: interface {name} not found\n"
        updated = update_interface(name, adminStatus="up", operStatus="up")
        link_note = sync_linux_admin(updated or {}, admin_up=True) if updated else None
        suffix = f"; {link_note}" if link_note else ""
        return f"commit complete (enabled {name}{suffix})\n"

    m_mode = re.match(
        r"^set\s+interfaces\s+(\S+)\s+unit\s+0\s+family\s+ethernet-switching\s+"
        r"interface-mode\s+(access|trunk)$",
        lower,
    )
    if m_mode:
        name = _original_iface_name(text, m_mode.group(1))
        mode = m_mode.group(2)
        current = find_interface(name)
        if not current:
            return f"error: interface {name} not found\n"
        changes: dict[str, Any] = {"mode": mode}
        if mode == "access" and not current.get("accessVlan"):
            changes["accessVlan"] = "1"
        if mode == "trunk":
            changes["accessVlan"] = ""
        update_interface(name, **changes)
        return f"commit complete (mode {mode} on {name})\n"

    m_vlan = re.match(
        r"^set\s+interfaces\s+(\S+)\s+unit\s+0\s+family\s+ethernet-switching\s+"
        r"vlan\s+members\s+(\S+)$",
        lower,
    )
    if m_vlan:
        name = _original_iface_name(text, m_vlan.group(1))
        vlan = m_vlan.group(2)
        if not find_interface(name):
            return f"error: interface {name} not found\n"
        if vlan == "all":
            update_interface(name, mode="trunk", accessVlan="")
        else:
            update_interface(name, mode="access", accessVlan=vlan)
        return f"commit complete (vlan {vlan} on {name})\n"

    if lower == "commit":
        return "commit complete\n"

    return f"unknown command: {command}\n"


def _original_iface_name(command: str, lower_name: str) -> str:
    # Preserve original casing/punctuation from the command token.
    parts = command.split()
    for idx, part in enumerate(parts):
        if part.lower() == "interfaces" and idx + 1 < len(parts):
            return parts[idx + 1]
    return lower_name


def rest_payload() -> dict[str, Any]:
    entries = []
    for iface in load_interfaces():
        entries.append(
            {
                "name": iface["name"],
                "admin-status": iface["adminStatus"],
                "oper-status": iface["operStatus"],
                "description": iface.get("description") or "",
                "mtu": str(iface.get("mtu") or ""),
                "speed": str(iface.get("speed") or ""),
                "link-mode": iface.get("mode") or "",
                "access-vlan": iface.get("accessVlan") or "",
                "address": iface.get("address") or "",
            }
        )
    return {"interface-information": {"physical-interface": entries}}


def _eth_to_junos(dev: str) -> str:
    """Map Linux ethN -> ge-0/0/N.0 for lab sim display."""
    m = re.match(r"^eth(\d+)$", dev)
    if m:
        return f"ge-0/0/{m.group(1)}.0"
    if dev.startswith("br-vlan"):
        return f"irb.{dev.replace('br-vlan', '')}"
    return f"{dev}.0"


def read_linux_arp() -> list[dict[str, str]]:
    """Read live ARP/neighbor table from the container dataplane."""
    import subprocess

    try:
        raw = subprocess.check_output(
            ["ip", "-4", "neigh", "show"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return []

    rows: list[dict[str, str]] = []
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        ip = parts[0]
        if "dev" not in parts or "lladdr" not in parts:
            continue
        state = parts[-1].upper()
        if state in {"FAILED", "INCOMPLETE", "NONE"}:
            continue
        try:
            dev = parts[parts.index("dev") + 1]
            mac = parts[parts.index("lladdr") + 1]
        except (ValueError, IndexError):
            continue
        rows.append(
            {
                "mac": mac.lower(),
                "ip": ip,
                "interface": _eth_to_junos(dev),
                "flags": "none" if state in {"REACHABLE", "DELAY", "PROBE"} else state.lower(),
            }
        )
    rows.sort(key=lambda item: item["ip"])
    return rows


def format_show_arp() -> str:
    rows = read_linux_arp()
    lines = ["MAC Address       Address         Interface         Flags"]
    if not rows:
        lines.append("(no ARP entries)")
        return "\n".join(lines) + "\n"
    for row in rows:
        lines.append(
            f"{row['mac']:<17} {row['ip']:<15} {row['interface']:<17} {row['flags']}"
        )
    return "\n".join(lines) + "\n"


def arp_rest_payload() -> dict[str, Any]:
    entries = [
        {
            "mac-address": row["mac"],
            "ip-address": row["ip"],
            "interface-name": row["interface"],
            "arp-flags": row["flags"],
        }
        for row in read_linux_arp()
    ]
    return {"arp-table-information": {"arp-table-entry": entries}}


_LEGACY_DATA_VLANS = {10, 20, 30, 40}
_LAB_SVI_VLANS = {201, 202, 203}


def _vlan_from_ip(ip: str) -> str | None:
    parts = ip.split(".")
    if len(parts) != 4:
        return None
    try:
        a, b, third, _host = (int(item) for item in parts)
    except ValueError:
        return None
    # Current lab SVIs / DHCP pools: 10.1.201/202/203.0/24
    if a == 10 and b == 1 and third in _LAB_SVI_VLANS:
        return str(third)
    # Legacy lab: 172.30.{10,20,30,40}.0/24
    if a == 172 and b == 30 and third in _LEGACY_DATA_VLANS:
        return str(third)
    return None


def _local_vlan_ips() -> list[tuple[str, str]]:
    """Return (dev, ipv4) for data-plane VLAN addresses on this host."""
    import subprocess

    found: list[tuple[str, str]] = []
    try:
        raw = subprocess.check_output(
            ["ip", "-4", "-o", "addr", "show"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, OSError):
        return found

    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        dev = parts[1]
        if dev == "lo" or "@" in dev:
            continue
        cidr = parts[3]
        ip = cidr.split("/", 1)[0]
        if _vlan_from_ip(ip):
            found.append((dev, ip))
    return found


def _probe_vlan_neighbors() -> None:
    """Best-effort ARP refresh so access/dist learn PC/.1/.2 before MAC read."""
    import subprocess

    targets: set[str] = set()
    for _dev, ip in _local_vlan_ips():
        parts = ip.split(".")
        prefix = ".".join(parts[:3])
        for host in ("1", "2", "100", "252", "253", "254"):
            candidate = f"{prefix}.{host}"
            if candidate != ip:
                targets.add(candidate)

    for host in sorted(targets):
        try:
            subprocess.run(
                ["ping", "-c", "1", "-W", "1", host],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=2,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue


def read_linux_mac_table(*, probe: bool = True) -> list[dict[str, str]]:
    """Build ethernet-switching table from live ARP (lab dataplane)."""
    if probe:
        _probe_vlan_neighbors()

    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for arp in read_linux_arp():
        vlan = _vlan_from_ip(arp["ip"])
        if not vlan:
            continue
        key = (arp["mac"], vlan, arp["interface"])
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "mac": arp["mac"],
                "vlan": vlan,
                "tag": "-",
                "interface": arp["interface"],
                "flags": "D",
                "sessId": "0",
            }
        )
    rows.sort(key=lambda item: (int(item["vlan"]), item["mac"]))
    return rows


def format_show_mac_table() -> str:
    rows = read_linux_mac_table()
    lines = [
        "MAC flags (S - static, D - dynamic, L - locally learned, C - control MAC)",
        "       SESS-ID  MAC address       VLAN  Tag  Logical interface",
    ]
    if not rows:
        lines.append("(no MAC entries)")
        return "\n".join(lines) + "\n"
    for row in rows:
        lines.append(
            f"    {row['flags']}  {row['sessId']:<8} {row['mac']} "
            f"{row['vlan']:<5} {row['tag']:<4} {row['interface']}"
        )
    return "\n".join(lines) + "\n"


def mac_rest_payload() -> dict[str, Any]:
    entries = [
        {
            "l2ng-l2-mac-address": row["mac"],
            "l2ng-l2-vlan-id": row["vlan"],
            "l2ng-l2-mac-vlan-name": f"vlan{row['vlan']}",
            "l2ng-l2-mac-logical-interface": row["interface"],
            "l2ng-l2-mac-entry-flags": row["flags"],
            "l2ng-l2-mac-sequence-number": row["sessId"],
        }
        for row in read_linux_mac_table()
    ]
    return {"l2ng-l2ald-macdb": {"l2ng-l2ald-mac-entry-vlan": entries}}
