"""Parse Junos syslog payloads from RESTCONF (XML) or CLI text."""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any

# Standard-format message:
#   Sep  3 01:23:45 lab-jr1 mgd[12345]: UI_CMDLINE_READ_LINE: ...
#   Sep  3 01:23:45 lab-jr1 mgd: UI_CMDLINE_READ_LINE: ...     (no PID)
# BSD-style with explicit priority:
#   <165>Sep  3 01:23:45 lab-jr1 mgd[12345]: UI_CMDLINE_READ_LINE: ...
_STANDARD_LINE = re.compile(
    r"^(?:<\s*(\d+)\s*>)?"  # optional <priority> prefix
    r"(?P<ts>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})"
    r"\s+(?P<host>\S+)"
    r"\s+(?P<proc>[A-Za-z0-9_-]+)(?:\[(?P<pid>\d+)\])?"
    r"(?::\s*)?"
    r"(?P<rest>.*)$",
)

# Structured-data (RFC 5424) message:
#   <165>1 2007-02-15T09:17:15.719Z router1 mgd 3046 - - User 'user' logged out
_STRUCTURED_LINE = re.compile(
    r"^<\s*(\d+)\s*>1\s+"
    r"(?P<ts>\S+)"  # ISO timestamp
    r"\s+(?P<host>\S+)"
    r"\s+(?P<proc>\S+)"
    r"\s+(?P<pid>\S+)"
    r"\s+(?P<msgid>\S+)"
    r"(?:\s+(?P<sd>\S+))?"
    r"\s+(?P<rest>.*)$",
)


def _safe_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None

    # ISO 8601 with timezone (RFC 5424 structured format)
    iso_match = re.match(
        r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$",
        text,
    )
    if iso_match:
        date_part = iso_match.group(1)
        time_part = iso_match.group(2)
        tz_part = (iso_match.group(3) or "").replace(":", "")
        try:
            if tz_part in ("", "Z"):
                dt = datetime.fromisoformat(f"{date_part}T{time_part}")
                return dt.replace(tzinfo=timezone.utc)
            return datetime.fromisoformat(f"{date_part}T{time_part}{tz_part}")
        except ValueError:
            return None

    # Syslog standard: "Sep  3 01:23:45" — append current year.
    # Local clock is fine here because we only compare against the same clock
    # to decide whether to roll the year back; the output is normalised to UTC.
    std_match = re.match(r"^(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})$", text)
    if std_match:
        try:
            now_local = datetime.now()  # noqa: DTZ005
            parsed_naive = datetime.strptime(  # noqa: DTZ007
                f"{now_local.year} {std_match.group(1)} {int(std_match.group(2))} {std_match.group(3)}",
                "%Y %b %d %H:%M:%S",
            )
            # If parse says "in the future", assume previous year
            if parsed_naive > now_local:
                parsed_naive = parsed_naive.replace(year=parsed_naive.year - 1)
            # Attach UTC since we parsed in the same local clock that produced "now"
            return parsed_naive.replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    # Fallback: try generic fromisoformat
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _priority_to_severity(priority: int | None) -> str:
    if priority is None:
        return "info"
    return ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"][
        priority & 0x07
    ]


def _priority_to_facility(priority: int | None) -> str:
    if priority is None:
        return "unknown"
    code = (priority >> 3) & 0xff
    table = {
        0: "kernel",
        1: "user",
        2: "mail",
        3: "daemon",
        4: "auth",
        5: "syslog",
        6: "lpr",
        7: "news",
        8: "uucp",
        9: "cron",
        10: "authpriv",
        11: "ftp",
        12: "ntp",
        13: "security",
        14: "console",
        16: "local0",
        17: "local1",
        18: "local2",
        19: "local3",
        20: "local4",
        21: "local5",
        22: "local6",
        23: "local7",
    }
    return table.get(code, "unknown")


def _parse_text_message(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    text = raw.strip()
    if not text:
        return None

    # Structured (RFC 5424) first
    sd = _STRUCTURED_LINE.match(text)
    if sd:
        priority = _safe_int(sd.group(1))
        ts = _parse_timestamp(sd.group("ts"))
        proc = sd.group("proc")
        pid = _safe_int(sd.group("pid"))
        rest = sd.group("rest") or ""
        return {
            "timestamp": ts.astimezone(timezone.utc).isoformat() if ts else None,
            "hostname": sd.group("host"),
            "program": proc if proc and proc != "-" else None,
            "pid": pid if pid is not None and pid != -1 else None,
            "tag": sd.group("msgid") if sd.group("msgid") and sd.group("msgid") != "-" else None,
            "severity": _priority_to_severity(priority),
            "facility": _priority_to_facility(priority),
            "message": rest,
        }

    std = _STANDARD_LINE.match(text)
    if std:
        priority = _safe_int(std.group(1))
        ts = _parse_timestamp(std.group("ts"))
        proc = std.group("proc")
        pid = _safe_int(std.group("pid"))
        rest = (std.group("rest") or "").lstrip(": ").strip()
        tag = None
        if rest:
            tag_match = re.match(r"^([A-Z][A-Z0-9_]+):\s*", rest)
            if tag_match:
                tag = tag_match.group(1)
        return {
            "timestamp": ts.astimezone(timezone.utc).isoformat() if ts else None,
            "hostname": std.group("host"),
            "program": proc,
            "pid": pid,
            "tag": tag,
            "severity": _priority_to_severity(priority),
            "facility": _priority_to_facility(priority),
            "message": rest,
        }

    return None


def _walk_xml_log_entries(element: ET.Element, collector: list[dict[str, Any]]) -> None:
    """Recurse into RESTCONF XML and pick out <log-message> nodes."""
    tag = element.tag.rsplit("}", 1)[-1].lower()
    if tag in {"log-message", "log-message-entry", "log-entry"}:
        ts_text = (element.text or "").strip()
        if ts_text:
            parsed = _parse_text_message(ts_text)
            if parsed:
                collector.append(parsed)
    for child in list(element):
        _walk_xml_log_entries(child, collector)


def _walk_json_log_entries(node: Any, collector: list[dict[str, Any]]) -> None:
    """Walk a JSON dict/list structure and collect log entries.

    Handles two shapes:
    1. Lab simulator RESTCONF JSON: each <log-message> node carries explicit
       timestamp/severity/facility/process/hostname fields directly.
    2. BSD/syslog text in a 'message' field: parse as a log line.
    """
    if isinstance(node, list):
        for item in node:
            _walk_json_log_entries(item, collector)
        return
    if not isinstance(node, dict):
        return

    message_text: str | None = node.get("message")  # type: ignore[assignment]

    # Check whether this dict carries explicit structured fields
    has_explicit = bool(
        node.get("timestamp")  # type: ignore[arg-type]
        or node.get("process")  # type: ignore[arg-type]
        or node.get("program")  # type: ignore[arg-type]
        or node.get("severity")  # type: ignore[arg-type]
        or node.get("hostname"),  # type: ignore[arg-type]
    )

    if message_text and isinstance(message_text, str):
        # Try to parse the 'message' field as a BSD/syslog line
        parsed = _parse_text_message(message_text)
        if parsed:
            # Augment with explicit fields if the device provided them
            if node.get("severity"):  # type: ignore[arg-type]
                parsed["severity"] = str(node["severity"]).lower()  # type: ignore[index]
            if node.get("facility"):  # type: ignore[arg-type]
                parsed["facility"] = str(node["facility"]).lower()  # type: ignore[index]
            if node.get("hostname"):  # type: ignore[arg-type]
                parsed["hostname"] = str(node["hostname"])  # type: ignore[index]
            if node.get("process") or node.get("program"):  # type: ignore[arg-type]
                parsed["program"] = str(node.get("process") or node.get("program"))  # type: ignore[arg-type]
            if node.get("pid"):  # type: ignore[arg-type]
                parsed["pid"] = _safe_int(node["pid"])  # type: ignore[index]
            if node.get("tag"):  # type: ignore[arg-type]
                parsed["tag"] = str(node["tag"])  # type: ignore[index]
            collector.append(parsed)
    elif has_explicit:
        # Lab simulator RESTCONF JSON shape: explicit fields available directly
        _ts = _parse_timestamp(str(node.get("timestamp") or ""))  # type: ignore[arg-type]
        _hostname = str(node.get("hostname") or "")  # type: ignore[arg-type]
        _process = node.get("process")  # type: ignore[arg-type]
        _program = node.get("program")  # type: ignore[arg-type]
        _proc_str = str(_process) if _process else (str(_program) if _program else "")
        _pid = _safe_int(node.get("pid"))  # type: ignore[arg-type]
        _tag = node.get("tag")  # type: ignore[arg-type]
        _prio = node.get("priority")  # type: ignore[arg-type]
        _sev_raw = node.get("severity")  # type: ignore[arg-type]
        if _prio is not None:
            _sev: str = _priority_to_severity(_safe_int(_prio))
        else:
            _sev = str(_sev_raw or "info").lower()
        _fac = str(node.get("facility") or "unknown").lower()  # type: ignore[arg-type]
        _msg = str(message_text if message_text else node.get("message-text") or node.get("text") or "")  # type: ignore[arg-type]
        entry = {
            "timestamp": _ts.astimezone(timezone.utc).isoformat() if _ts else None,
            "hostname": _hostname,
            "program": _proc_str or None,
            "pid": _pid,
            "tag": str(_tag) if _tag else None,
            "severity": _sev,
            "facility": _fac,
            "message": _msg,
        }
        collector.append(entry)

    for value in node.values():  # type: ignore[union-attr]
        if isinstance(value, (dict, list)):
            _walk_json_log_entries(value, collector)


def _dedupe(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for entry in entries:
        key = (
            str(entry.get("timestamp") or ""),
            str(entry.get("hostname") or ""),
            str(entry.get("program") or ""),
            str(entry.get("message") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(entry)
    return unique


def parse_log_payload(payload: Any) -> list[dict[str, Any]]:
    """Parse either a Junos RESTCONF XML/JSON or a multi-line CLI output."""
    entries: list[dict[str, Any]] = []
    if payload is None:
        return entries

    if isinstance(payload, str):
        text = html.unescape(payload).strip()
        if not text:
            return entries

        # Try XML first
        if text.startswith("<"):
            try:
                root = ET.fromstring(text)
                _walk_xml_log_entries(root, entries)
            except ET.ParseError:
                pass

        # Fallback: parse as line-by-line text (CLI `show log messages`)
        if not entries:
            for line in text.splitlines():
                parsed = _parse_text_message(line)
                if parsed:
                    entries.append(parsed)
        return _dedupe(entries)

    if isinstance(payload, (dict, list)):
        _walk_json_log_entries(payload, entries)
    return _dedupe(entries)
