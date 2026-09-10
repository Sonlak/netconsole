"""Parser for `show lldp neighbors` CLI output across Juniper / IOS-XE / EOS.

LLDP is the ground truth for physical link topology — it tells us
exactly which port on the local device connects to which port on the
remote device.  Unlike `interface description` (which is human-written
and prone to typos or empty values), LLDP is populated by the protocol
itself and reflects the actual live cabling.

Output shape
------------
Each entry represents one LLDP advertisement received on a local port.
The remote device may not be in our device inventory (e.g. an upstream
ISP router), so `remoteDeviceId` may be an arbitrary hostname string.

    {
        "localPort":   "ge-0/0/1",       # our port
        "remoteDeviceId": "LAB-F1-DS01",   # neighbour's hostname / device-id
        "remotePort":  "ge-0/0/1",        # neighbour's port
        "chassisId":   "5000.0001.0001",  # MAC or chassis ID (optional)
    }
"""

from __future__ import annotations

import re


# ---------------------------------------------------------------------------
# Juniper: "show lldp neighbors"
#
#   Device ID                 Local Interface  Chassis ID        Port Info
#   LAB-F1-DS01               ge-0/0/1         5000.0001.0001   ge-0/0/1
#   LAB-F1-DS01               ge-0/0/2         5000.0001.0002   ge-0/0/2
#
# Columns are separated by 2+ spaces.  The Port Info column (last) contains
# the remote port; the Device ID is the neighbour's hostname.
# ---------------------------------------------------------------------------

_JUNOS_RE = re.compile(
    r"^\s*(?P<device_id>[^\s]+)\s+(?P<local_iface>\S+)\s+(?P<chassis>\S+)\s+(?P<remote_port>\S+)\s*$",
    re.IGNORECASE,
)


def parse_junos_lldp_neighbors(output: str) -> list[dict[str, str]]:
    """Parse Junos `show lldp neighbors` text output."""
    entries: list[dict[str, str]] = []
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Device ID") or stripped.startswith("Total"):
            continue
        m = _JUNOS_RE.match(stripped)
        if not m:
            continue
        entries.append({
            "localPort": m.group("local_iface"),
            "remoteDeviceId": m.group("device_id"),
            "remotePort": m.group("remote_port"),
            "chassisId": m.group("chassis"),
        })
    return entries


# ---------------------------------------------------------------------------
# Cisco IOS / IOS-XE: "show lldp neighbors"
#
#   Device ID    Local Intf   Hold-time  Capability  Platform  Port ID
#   LAB-F1-DS01 Gi0/0/1      120        R S         C8000V    Gi0/0/1
#   LAB-F1-DS01 Gi0/0/2      120        R           C8000V    Gi0/0/2
#
# Columns are separated by whitespace.  "Local Intf" = our port, "Device ID"
# = neighbour hostname, "Port ID" = neighbour port.  "Capability" and
# "Platform" are optional (may be absent or have extra whitespace).
# ---------------------------------------------------------------------------

def parse_ios_lldp_neighbors(output: str) -> list[dict[str, str]]:
    """Parse Cisco IOS/IOS-XE `show lldp neighbors` text output.

    Uses position-based parsing: tokens[0]=Device ID, [1]=Local Intf,
    [2]=Hold-time, [3..-2]=Capability/Platform (optional), [-1]=Port ID.
    """
    entries: list[dict[str, str]] = []
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Device ID") or stripped.startswith("Total"):
            continue
        tokens = stripped.split()
        # Minimum: Device ID, Local Intf, Hold-time, Port ID (4 tokens)
        if len(tokens) < 4:
            continue
        # Port ID is always the last non-empty token
        remote_port = tokens[-1]
        # Device ID is always the first token
        device_id = tokens[0]
        # Local Intf is the second token
        local_iface = tokens[1]
        entries.append({
            "localPort": local_iface,
            "remoteDeviceId": device_id,
            "remotePort": remote_port,
            "chassisId": "",
        })
    return entries


# ---------------------------------------------------------------------------
# Arista EOS: "show lldp neighbors"
#
#   Port      Neighbor Device ID      Neighbor Port         TTL
#   Et1       LAB-F1-DS01             Ethernet1             120
#   Et2       LAB-F1-DS01             Ethernet2              120
#
# Columns are separated by 2+ spaces.  Port = our port, "Neighbor Device ID"
# = neighbour hostname, "Neighbor Port" = neighbour port.
# ---------------------------------------------------------------------------

_EOS_RE = re.compile(
    r"^\s*(?P<local_port>\S+)\s+(?P<device_id>\S+)\s+(?P<remote_port>\S+)\s+(?P<ttl>\S+)\s*$",
    re.IGNORECASE,
)


def parse_eos_lldp_neighbors(output: str) -> list[dict[str, str]]:
    """Parse Arista EOS `show lldp neighbors` text output."""
    entries: list[dict[str, str]] = []
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Port") or stripped.startswith("Total"):
            continue
        m = _EOS_RE.match(stripped)
        if not m:
            continue
        entries.append({
            "localPort": m.group("local_port"),
            "remoteDeviceId": m.group("device_id"),
            "remotePort": m.group("remote_port"),
            "chassisId": "",
        })
    return entries


# ---------------------------------------------------------------------------
# Generic dispatcher — tries all three formats and returns the first non-empty
# result.  Use the vendor-specific parser when the vendor is known.
# ---------------------------------------------------------------------------

def parse_lldp_neighbors(output: str) -> list[dict[str, str]]:
    """Try all known LLDP formats and return the first non-empty list."""
    result = parse_junos_lldp_neighbors(output)
    if result:
        return result
    result = parse_ios_lldp_neighbors(output)
    if result:
        return result
    result = parse_eos_lldp_neighbors(output)
    return result
