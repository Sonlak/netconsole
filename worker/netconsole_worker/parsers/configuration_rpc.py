from __future__ import annotations

import html
import re
from typing import Any

from netconsole_worker.parsers.junos_leaf import local_name, parse_xml_root

_SET_TAGS = {
    "configuration-set",
    "configuration-text",
    "configuration-output",
    "config-text",
}

_HOST_NAME = re.compile(r"^set system host-name\s+(\S+)", re.MULTILINE)
_VERSION = re.compile(r"^set version\s+(\S+)", re.MULTILINE)
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")


def parse_configuration_set(payload: Any) -> str:
    """Extract Junos `display set` text from REST get-configuration payload."""
    root = parse_xml_root(payload)
    if root is not None:
        for element in [root, *list(root.iter())]:
            if local_name(element.tag) in _SET_TAGS:
                text = html.unescape("".join(element.itertext())).strip()
                if text:
                    return text
        text = html.unescape("".join(root.itertext())).strip()
        if text.startswith("set "):
            return text
        return ""

    if isinstance(payload, str):
        text = html.unescape(payload).strip()
        if text.startswith(("set ", "delete ")):
            return text
    return ""


def parse_identity_from_set_config(config: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    host = _HOST_NAME.search(config or "")
    if host:
        hostname = host.group(1).strip().strip('"')
        if _SAFE_TOKEN.fullmatch(hostname):
            parsed["hostname"] = hostname
    version = _VERSION.search(config or "")
    if version:
        value = version.group(1).strip().strip('"')
        if _SAFE_TOKEN.fullmatch(value):
            parsed["version"] = value
    return parsed
