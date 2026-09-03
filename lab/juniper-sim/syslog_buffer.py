"""Static log buffer for the Junos REST simulator.

The lab does not run a real syslog daemon; this module provides a small
per-device buffer of canned log lines that mimic Junos' standard format.
The buffer is keyed by hostname so different lab devices return different
entries.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _epoch() -> int:
    return int(time.time())


_HOSTNAME = os.environ.get("DEVICE_HOSTNAME") or "lab-jr1"
_ROLE = (os.environ.get("DEVICE_ROLE") or "").strip().lower()


# Severity weighting per role so each device produces believable traffic.
_ROLE_SEVERITY = {
    "core": ("info", "notice", "warning"),
    "dist": ("info", "notice", "warning", "error"),
    "access": ("info", "notice", "warning", "error", "critical"),
    "": ("info", "notice"),
}.get(_ROLE, ("info", "notice"))


_BASE_TEMPLATES = [
    ("mgd", "UI_CMDLINE_READ_LINE: '{user}', '{cmd}'"),
    ("mgd", "UI_COMMIT: commit performed by '{user}'"),
    ("mgd", "UI_LOGIN_EVENT: User '{user}' login"),
    ("mgd", "UI_DB_LOGIN_EVENT: User '{user}' login, class 'j-super-user'"),
    ("mib2d", "SNMP_TRAP_LINK_UP: ifIndex {ifindex}, ifAdminStatus up(1)"),
    ("mib2d", "SNMP_TRAP_LINK_DOWN: ifIndex {ifindex}, ifAdminStatus down(2)"),
    ("rpd", "OSPF neighbor {neighbor} state changed from Full to Down"),
    ("rpd", "BGP session {neighbor} state changed to Established"),
    ("l2ald", "MAC limit exceeded on interface {iface}"),
    ("l2ald", "Adding dynamic MAC {mac} on interface {iface} VLAN {vlan}"),
    ("dcd", "Configured interface {iface}, description '{desc}'"),
    ("chassisd", "FPC {slot} OK"),
    ("eventd", "SYSLOG_HOST_FORWARD: forwarding to udp://172.31.0.4:514"),
]


def _spawn_entries(count: int) -> list[dict[str, Any]]:
    """Build a deterministic-ish batch of `count` recent log entries."""
    out: list[dict[str, Any]] = []
    now = _now()
    severity_cycle = _ROLE_SEVERITY
    for idx in range(count):
        proc, template = _BASE_TEMPLATES[(idx + hash(_HOSTNAME)) % len(_BASE_TEMPLATES)]
        severity = severity_cycle[(idx + hash(_HOSTNAME)) % len(severity_cycle)]
        message = template.format(
            user="admin",
            cmd="show log messages",
            ifindex=str(500 + idx),
            neighbor=f"10.0.0.{(idx % 250) + 1}",
            iface=f"ge-0/0/{idx % 4}",
            vlan=str(((idx % 3) + 1) * 10),
            desc=f"uplink-{idx % 4}",
            mac=f"aa:bb:cc:00:{(idx % 99) + 1:02x}:{(idx * 7) % 99:02x}",
            slot=str(idx % 2),
        )
        ts = now.fromtimestamp(now.timestamp() - idx * 37, tz=timezone.utc)
        out.append(
            {
                "timestamp": ts.isoformat(),
                "hostname": _HOSTNAME,
                "program": proc,
                "pid": 1000 + idx,
                "tag": None,
                "severity": severity,
                "facility": "daemon" if proc != "mgd" else "auth",
                "message": message,
            }
        )
    return out


# Per-process module cache: avoid re-spawning on every request.
_BUFFER: list[dict[str, Any]] = _spawn_entries(40)
_LAST_SEED = _epoch()


def get_log_entries() -> list[dict[str, Any]]:
    """Return the device's current log buffer (with a few fresh lines added)."""
    global _LAST_SEED
    now = _epoch()
    if now - _LAST_SEED > 15:
        _BUFFER[0:0] = _spawn_entries(3)
        _LAST_SEED = now
        if len(_BUFFER) > 80:
            del _BUFFER[80:]
    # Return a snapshot copy so callers can't mutate state.
    return [dict(entry) for entry in _BUFFER]


def rest_payload() -> dict[str, Any]:
    """Build the RESTCONF XML-shaped payload for get-log-information."""
    entries = get_log_entries()
    return {
        "log-information": {
            "log-message": [
                {
                    "timestamp": entry["timestamp"],
                    "hostname": entry["hostname"],
                    "process": entry["program"],
                    "pid": str(entry.get("pid") or 0),
                    "severity": entry["severity"],
                    "facility": entry["facility"],
                    "message": entry["message"],
                }
                for entry in entries
            ]
        }
    }


def format_show_log() -> str:
    """Build CLI-style text (so SSH fallback also works against the simulator)."""
    lines = []
    for entry in get_log_entries():
        ts = entry["timestamp"]
        # Convert ISO -> "Sep  3 01:23:45"
        try:
            dt = datetime.fromisoformat(ts)
            ts_short = dt.strftime("%b %e %H:%M:%S").replace("  ", " ")
        except ValueError:
            ts_short = ts
        proc = entry.get("program") or "?"
        pid = entry.get("pid") or 0
        msg = entry.get("message") or ""
        lines.append(f"{ts_short} {entry['hostname']} {proc}[{pid}]: {msg}")
    return "\n".join(lines) + "\n"