from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def _junos_text(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node.strip()
    if isinstance(node, (int, float)):
        return str(node)
    if isinstance(node, list):
        for item in node:
            text = _junos_text(item)
            if text:
                return text
        return ""
    if isinstance(node, dict):
        if "data" in node:
            return _junos_text(node.get("data"))
        for key in ("host-name", "hostname", "product-model", "hardware-model", "junos-version", "os-version", "serial-number"):
            if key in node:
                text = _junos_text(node.get(key))
                if text:
                    return text
        for value in node.values():
            text = _junos_text(value)
            if text:
                return text
    return ""


def _find_json(node: Any, keys: set[str]) -> str:
    if isinstance(node, list):
        for item in node:
            found = _find_json(item, keys)
            if found:
                return found
        return ""
    if not isinstance(node, dict):
        return ""
    for key, value in node.items():
        if key in keys:
            text = _junos_text(value)
            if text:
                return text
    for value in node.values():
        if isinstance(value, (dict, list)):
            found = _find_json(value, keys)
            if found:
                return found
    return ""


def _find_xml(element: ET.Element, keys: set[str]) -> str:
    name = _local_name(element.tag)
    if name in keys and (element.text or "").strip():
        return (element.text or "").strip()
    for child in list(element):
        found = _find_xml(child, keys)
        if found:
            return found
    return ""


def _parse_payload(payload: Any) -> ET.Element | Any:
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, str) and payload.strip():
        try:
            return ET.fromstring(payload)
        except ET.ParseError:
            return payload
    return payload


def parse_system_or_software_info(payload: Any) -> dict[str, str]:
    parsed: dict[str, str] = {"vendor": "Juniper"}
    node = _parse_payload(payload)

    if isinstance(node, ET.Element):
        hostname = _find_xml(node, {"host-name", "hostname"})
        model = _find_xml(node, {"hardware-model", "product-model", "product-name"})
        version = _find_xml(node, {"os-version", "junos-version"})
        serial = _find_xml(node, {"serial-number"})
    else:
        hostname = _find_json(node, {"host-name", "hostname"})
        model = _find_json(node, {"hardware-model", "product-model", "product-name"})
        version = _find_json(node, {"os-version", "junos-version"})
        serial = _find_json(node, {"serial-number"})

    if hostname:
        parsed["hostname"] = hostname
    if model:
        parsed["model"] = model
    if version:
        parsed["version"] = version
    serial = (serial or "").strip()
    if serial and serial.upper() not in {"BUILTIN", "N/A", "UNKNOWN"}:
        parsed["serial"] = serial
    return parsed


def parse_system_uptime(payload: Any) -> dict[str, str]:
    """Parse get-system-uptime-information into seconds + display text."""
    node = _parse_payload(payload)
    seconds = ""
    label = ""

    def attrib_seconds(element: ET.Element) -> str:
        for key, value in element.attrib.items():
            if _local_name(key) == "seconds" and str(value).strip():
                try:
                    return str(int(float(value)))
                except ValueError:
                    return ""
        return ""

    if isinstance(node, ET.Element):
        for element in node.iter():
            name = _local_name(element.tag)
            if name == "up-time":
                seconds = attrib_seconds(element) or seconds
                text = (element.text or "").strip()
                if text:
                    label = text
            elif name == "time-length" and not seconds:
                seconds = attrib_seconds(element)
                if not label:
                    label = (element.text or "").strip()
    else:
        seconds = _find_json(node, {"seconds", "up-time"})
        label = _find_json(node, {"up-time", "time-length"})

    parsed: dict[str, str] = {}
    if seconds.isdigit():
        parsed["uptimeSeconds"] = seconds
    if label:
        parsed["uptime"] = label
    return parsed


def _is_placeholder_serial(serial: str) -> bool:
    return serial.upper() in {"BUILTIN", "N/A", "UNKNOWN", ""}


def parse_chassis_serial(payload: Any) -> str:
    node = _parse_payload(payload)
    serials: list[str] = []

    def collect_xml(element: ET.Element) -> None:
        if _local_name(element.tag) == "serial-number" and (element.text or "").strip():
            serials.append((element.text or "").strip())
        for child in list(element):
            collect_xml(child)

    def collect_json(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                collect_json(item)
            return
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            if key == "serial-number":
                text = _junos_text(child)
                if text:
                    serials.append(text)
            elif isinstance(child, (dict, list)):
                collect_json(child)

    if isinstance(node, ET.Element):
        collect_xml(node)
    else:
        collect_json(node)

    for serial in serials:
        if not _is_placeholder_serial(serial):
            return serial
    return ""
