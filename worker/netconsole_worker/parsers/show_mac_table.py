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
    """Cisco IOS `xxxx.xxxx.xxxx` -> standard `aa:bb:cc:dd:ee:ff`.

    Each 4-hex segment represents 2 bytes in big-endian:
    0100.0ccc.cccc -> 01 00 0c cc cc cc -> 00:0c:29:0d:4a:63
    (the leading nibble of the first byte is the trailing nibble of segment 1).
    """
    parts = mac.split(".")
    if len(parts) != 3 or any(len(p) != 4 for p in parts):
        return ""
    # Each 4-char segment: first 2 chars = byte 1, last 2 chars = byte 2 (big-endian)
    byte1 = parts[0][:2]
    byte2 = parts[0][2:]
    byte3 = parts[1][:2]
    byte4 = parts[1][2:]
    byte5 = parts[2][:2]
    byte6 = parts[2][2:]
    return f"{byte1}:{byte2}:{byte3}:{byte4}:{byte5}:{byte6}".lower()


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
