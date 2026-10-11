"""Optional structured-output parser for CLI commands.

Wraps `ntc-templates` (textfsm) so the assistant can ask for a
specific show command and get back parsed rows instead of raw text.

The list of supported commands is deliberately small: just the
ones the assistant is most likely to be asked about and for which
ntc-templates ships a stable parser. Anything else returns
`{"rows": [], "raw": <text>, "parsed": False}` and the LLM
parses the text itself.

Why keep the surface narrow:
  - Each ntc-templates template drift is a CI hazard (different
    ntc-templates versions parse the same output slightly differently
    in column order or new fields).
  - The LLM does a fine job reading tabular text for one-off
    commands. Pre-parsing saves tokens only when the output is large
    and the user is going to ask follow-up questions about it.

Usage (from the assistant worker, NOT the backend):

    from netconsole_worker.parsers.textfsm_parse import try_parse
    rows = try_parse("cisco_ios", "show ip ospf neighbor", raw_output)

Returns list of dicts (one per row, headers lowercased) or None if
the command is not in our small allowlist. The backend assistant
handler doesn't call this directly — the worker's
`DeviceBackend.run_cli_command` returns the raw text and the
backend's assistant handler calls try_parse there if the LLM asked
for `parse: true` (currently always False, see below).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# (template_name, parsed_headers_renamed).
# template_name matches the file under ntc_templates/templates
# (without .textfsm). Renamed headers map the ntc-templates default
# (often ALL_CAPS) to our canonical lowercase form so the LLM sees
# the same shape across vendors.
#
# Restrict to commands the assistant is most likely to be asked
# about — keep this list small and audit-friendly.
ALLOWLIST: dict[tuple[str, str], dict[str, str]] = {
    # Cisco IOS / IOS-XE
    ("cisco_ios", "show ip ospf neighbor"): {
        "NEIGHBOR_ID": "neighborId",
        "PRIORITY": "priority",
        "STATE": "state",
        "DEAD_TIME": "deadTime",
        "ADDRESS": "address",
        "INTERFACE": "interface",
    },
    ("cisco_ios", "show ip route"): {
        "PROTOCOL": "protocol",
        "NETWORK": "network",
        "MASK": "mask",
        "DISTANCE": "distance",
        "METRIC": "metric",
        "NEXTHOP_IP": "nexthop",
        "NEXTHOP_IF": "interface",
    },
    ("cisco_ios", "show cdp neighbors"): {
        "DESTINATION_HOST": "neighbor",
        "LOCAL_PORT": "localPort",
        "MGMT_IP": "mgmtIp",
        "PLATFORM": "platform",
        "REMOTE_PORT": "remotePort",
    },
    ("cisco_ios", "show ip bgp summary"): {
        "ROUTER_ID": "routerId",
        "LOCAL_AS": "localAs",
        "NEIGHBOR": "neighbor",
        "NEIGHBOR_AS": "neighborAs",
        "STATE_PFXRCD": "state",
    },
    # Arista EOS
    ("arista_eos", "show ip ospf neighbor"): {
        "NEIGHBOR_ID": "neighborId",
        "PRIORITY": "priority",
        "STATE": "state",
        "DEAD_TIME": "deadTime",
        "ADDRESS": "address",
        "INTERFACE": "interface",
    },
    ("arista_eos", "show ip route"): {
        "PROTOCOL": "protocol",
        "NETWORK": "network",
        "MASK": "mask",
        "DISTANCE": "distance",
        "METRIC": "metric",
        "NEXTHOP_IP": "nexthop",
        "NEXTHOP_IF": "interface",
    },
    ("arista_eos", "show ip bgp summary"): {
        "ROUTER_ID": "routerId",
        "LOCAL_AS": "localAs",
        "NEIGHBOR": "neighbor",
        "NEIGHBOR_AS": "neighborAs",
        "STATE_PFXRCD": "state",
    },
    # Juniper Junos
    ("juniper_junos", "show ospf neighbor"): {
        "NEIGHBOR_ID": "neighborId",
        "PRIORITY": "priority",
        "STATE": "state",
        "DEAD_TIME": "deadTime",
        "ADDRESS": "address",
        "INTERFACE": "interface",
    },
    ("juniper_junos", "show route summary"): {
        "ROUTE_TABLE": "table",
        "DESTINATION_COUNT": "destinations",
        "ACTIVE_ROUTES": "active",
        "HOLDDOWN": "holddown",
    },
}


def vendor_to_template_prefix(vendor: str) -> str | None:
    """Map our Device.vendor string to the ntc-templates prefix."""
    v = (vendor or "").lower()
    if v in ("cisco", "ciscoiosxe", "ios-xe", "iosxe", "catalyst", "ios", "cisco-ios", "iosv"):
        return "cisco_ios"
    if v in ("arista", "aristaeos", "eos"):
        return "arista_eos"
    if v in ("juniper", "junos"):
        return "juniper_junos"
    return None


def try_parse(
    vendor: str,
    command: str,
    raw_output: str,
) -> dict[str, Any] | None:
    """Try to parse `raw_output` with the ntc-templates parser for
    `vendor` + `command`. Returns a dict with the parsed rows or None
    if the (vendor, command) pair isn't in our allowlist or ntc-templates
    doesn't have a template for it.

    Returns:

        {
            "rows":   [ {neighborId: "...", state: "FULL", ...}, ... ],
            "raw":    <unmodified raw text>,
            "parsed": True,
            "vendor": "cisco_ios",
            "command": "show ip ospf neighbor",
            "rowCount": 3,
        }

    or None on miss.
    """
    prefix = vendor_to_template_prefix(vendor)
    if not prefix:
        return None
    # Normalise the command — strip leading 'do ' (IOS), trailing ' | no-more', whitespace
    cmd = command.strip()
    if cmd.startswith("do "):
        cmd = cmd[3:].strip()
    if " | " in cmd:
        cmd = cmd.split(" | ", 1)[0].strip()

    key = (prefix, cmd)
    if key not in ALLOWLIST:
        return None
    header_map = ALLOWLIST[key]

    try:
        from ntc_templates.parse import parse_output  # type: ignore[import-untyped]
    except ImportError:
        logger.warning("ntc_templates not installed; skipping structured parse")
        return None

    try:
        rows_raw = parse_output(platform=prefix, command=cmd, data=raw_output)
    except Exception as exc:  # noqa: BLE001 — textfsm errors are vendor-specific
        logger.debug("ntc_templates parse failed for %s %s: %s", prefix, cmd, exc)
        return None

    rows: list[dict[str, Any]] = []
    for r in rows_raw:
        # ntc-templates returns OrderedDict[OriginalName, value] where
        # OriginalName is the ALL_CAPS header from the .textfsm file.
        # Rename to our lowercase canonical form.
        if not isinstance(r, dict):
            continue
        out: dict[str, Any] = {}
        for k, v in r.items():
            new_key = header_map.get(k, k.lower())
            out[new_key] = v
        rows.append(out)

    return {
        "rows": rows,
        "raw": raw_output,
        "parsed": True,
        "vendor": prefix,
        "command": cmd,
        "rowCount": len(rows),
    }
