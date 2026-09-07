from __future__ import annotations

import re

ARP_LINE = re.compile(
    r"^([0-9a-fA-F:]{17})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)\s+(\S+)\s*$",
    re.MULTILINE,
)

# Cisco IOS `show ip arp` format:
#   Internet  10.10.20.10            93   8a3e.68ec.1149  ARPA   GigabitEthernet4
# Columns: <protocol> <address> <age (min)> <hardware-addr> <type> <interface>
# Spaces vary widely; use permissive pattern: <ip>  <hw-mac>  <garbage>  <iface>
_CISCO_ARP_LINE = re.compile(
    r"(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+\S+\s+(\S+)"
)


def parse_juniper_arp_table(output: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []

    for match in ARP_LINE.finditer(output):
        mac, ip, interface, flags = match.groups()
        entries.append(
            {
                "ip": ip,
                "mac": mac.lower(),
                "interface": interface,
                "flags": flags,
            }
        )

    return entries


def parse_cisco_arp_table(output: str) -> list[dict[str, str]]:
    """Parse `show ip arp` from Cisco IOS/IOS-XE.

    Hardware-addrs are Cisco-style `8a3e.68ec.1149` (24 bits, three
    dot-separated hex octets). We normalize to standard `aa:bb:cc:dd:ee:ff`
    so the frontend doesn't need a separate path.
    """
    entries: list[dict[str, str]] = []
    for match in _CISCO_ARP_LINE.finditer(output):
        ip, hw, interface = match.groups()
        normalized = _normalize_cisco_mac(hw)
        if normalized:
            entries.append(
                {
                    "ip": ip,
                    "mac": normalized,
                    "interface": interface,
                    "flags": "internet",
                }
            )
    return entries


def _normalize_cisco_mac(mac: str) -> str:
    """`8a3e.68ec.1149` -> `8a:3e:68:ec:11:49`. Returns '' on bad input."""
    parts = mac.split(".")
    if len(parts) != 3 or any(len(p) != 4 for p in parts):
        return ""
    return ":".join(p.lower() for p in parts)
