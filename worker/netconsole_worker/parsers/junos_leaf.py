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


#: NETCONF message terminator (RFC 4741 §4.1).
_NC_TERMINATOR = "]]>]]>"

#: The device's session greeting, which precedes every reply.
_NC_HELLO_RE = re.compile(r"<hello\b.*?</hello>", re.DOTALL)


def parse_xml_root(payload: Any) -> ET.Element | None:
    if isinstance(payload, ET.Element):
        return payload
    if not isinstance(payload, str):
        return None
    text = payload.strip()
    # A raw NETCONF exchange ends with the `]]>]]>` message terminator and
    # is prefixed by the device's `<hello>` greeting.  Both make the
    # document multi-root, which `ET.fromstring` rejects outright
    # ("junk after document element").  Strip them before parsing.
    text = text.replace(_NC_TERMINATOR, "")
    text = _NC_HELLO_RE.sub("", text).strip()
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
        pass
    # Still multi-root (e.g. `<hello>` + `<rpc-reply>` where the hello
    # was not self-closed).  Fall back to the first well-formed root
    # element in the document.
    m = re.search(r"<([A-Za-z_][\w.-]*)(\s[^>]*)?>(.*)</\1>", text, re.DOTALL)
    if m:
        try:
            return ET.fromstring(m.group(0))
        except ET.ParseError:
            return None
    return None


def xml_child_text(element: ET.Element, *names: str) -> str:
    wanted = set(names)
    for child in list(element):
        if local_name(child.tag) in wanted:
            text = (child.text or "").strip()
            if text:
                return text
    return ""
