from __future__ import annotations

import re

MAC_LINE = re.compile(
    r"^\s*([SDLCR])\s+(\d+)\s+([0-9a-fA-F:]{17})\s+(\S+)\s+(\S+)\s+(\S+)\s*$",
    re.MULTILINE,
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
