from __future__ import annotations

import re

MAC_LINE = re.compile(
    r"^\s*([SDLCR])\s+(\d+)\s+([0-9a-fA-F:]{17})\s+(\S+)\s+(\S+)\s+(\S+)\s*$",
    re.MULTILINE,
)

# Cisco IOS `show mac address-table` format:
#   All    0100.0ccc.cccc    STATIC      CPU
#   10     1a2b.3c4d.5e6f    DYNAMIC     Gi0/1
# Columns: <vlan> <mac> <type> <port>
_CISCO_MAC_LINE = re.compile(
    r"\s+(\d+|All|\*)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\S+)\s+(\S+)"
)

FLAG_LABELS = {
    "S": "static",
    "D": "dynamic",
    "L": "locally learned",
    "C": "control",
    "R": "remote",
}


def parse_juniper_mac_table(output: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []

    for match in MAC_LINE.finditer(output):
        flag, sess_id, mac, vlan, tag, interface = match.groups()
        entries.append(
            {
                "mac": mac.lower(),
                "vlan": vlan,
                "tag": tag,
                "interface": interface,
                "flags": flag,
                "type": FLAG_LABELS.get(flag, flag),
                "sessId": sess_id,
            }
        )

    return entries


def _normalize_cisco_mac(mac: str) -> str:
    """`0100.0ccc.cccc` -> `01:00:0c:cc:cc:cc` (digits-only mac).

    Cisco may use `xxxx.xxxx.xxxx` where each 4-hex segment represents
    the full 16 bits of an octet — different from `x4 hex padded'.
    Just split on `.` and lowercase.
    """
    parts = mac.split(".")
    if len(parts) != 3:
        return ""
    return ":".join(p.lower() for p in parts)


def parse_cisco_mac_table(output: str) -> list[dict[str, str]]:
    """Parse `show mac address-table` from Cisco IOS / IOS-XE."""
    entries: list[dict[str, str]] = []
    for match in _CISCO_MAC_LINE.finditer(output):
        vlan, hw, type_, port = match.groups()
        mac = _normalize_cisco_mac(hw)
        if not mac:
            continue
        entries.append(
            {
                "mac": mac,
                "vlan": vlan,
                "tag": "",
                "interface": port,
                "flags": "",
                "type": type_.lower(),
                "sessId": "",
            }
        )
    return entries
