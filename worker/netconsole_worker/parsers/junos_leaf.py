from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any


def local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def junos_text(value: Any) -> str:
    """Unwrap Junos REST JSON/XML leaf values (`data`, lists, #text)."""
    if value is None:
        return ""
    if isinstance(value, (str, int, float)):
        return str(value).strip()
    if isinstance(value, list):
        for item in value:
            text = junos_text(item)
            if text:
                return text
        return ""
    if isinstance(value, dict):
        for key in ("data", "#text", "_text"):
            if key in value:
                text = junos_text(value.get(key))
                if text:
                    return text
        return ""
    return str(value).strip()


def normalize_mac(value: str | None) -> str:
    if not value:
        return ""
    hex_only = re.sub(r"[^0-9a-fA-F]", "", str(value))
    if len(hex_only) != 12:
        return ""
    hex_only = hex_only.lower()
    return ":".join(hex_only[i : i + 2] for i in range(0, 12, 2))


def parse_xml_root(payload: Any) -> ET.Element | None:
    if isinstance(payload, ET.Element):
        return payload
    if not isinstance(payload, str):
        return None
    text = payload.strip()
    if not text.startswith("<"):
        start = text.find("<")
        if start < 0:
            return None
        text = text[start:]
        end = text.rfind(">")
        if end >= 0:
            text = text[: end + 1]
    try:
        return ET.fromstring(text)
    except ET.ParseError:
        return None


def xml_child_text(element: ET.Element, *names: str) -> str:
    wanted = set(names)
    for child in list(element):
        if local_name(child.tag) in wanted:
            text = (child.text or "").strip()
            if text:
                return text
    return ""
