from __future__ import annotations

import re

ARP_LINE = re.compile(
    r"^([0-9a-fA-F:]{17})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)\s+(\S+)\s*$",
    re.MULTILINE,
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
