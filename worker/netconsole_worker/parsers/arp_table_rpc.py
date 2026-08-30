from __future__ import annotations

from ipaddress import ip_address
from typing import Any

from netconsole_worker.parsers.junos_leaf import (
    junos_text,
    local_name,
    normalize_mac,
    parse_xml_root,
    xml_child_text,
)


def _is_skipped_ip(ip: str) -> bool:
    try:
        value = ip_address(ip)
    except ValueError:
        return True
    return value.is_loopback or value.is_link_local


def _entry(
    *,
    ip: str,
    mac: str,
    interface: str = "-",
    flags: str = "none",
    hostname: str = "",
) -> dict[str, str] | None:
    ip_norm = (ip or "").strip()
    mac_norm = normalize_mac(mac)
    if not ip_norm or not mac_norm or _is_skipped_ip(ip_norm):
        return None
    return {
        "ip": ip_norm,
        "mac": mac_norm,
        "hostname": (hostname or ip_norm).strip(),
        "interface": str(interface or "-"),
        "flags": str(flags or "none"),
    }


def _walk_json(node: Any, collector: list[dict[str, str]]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_json(item, collector)
        return
    if not isinstance(node, dict):
        return

    mac = junos_text(node.get("mac-address") or node.get("mac"))
    ip = junos_text(node.get("ip-address") or node.get("ip") or node.get("address"))
    if mac and ip:
        interface = junos_text(
            node.get("interface-name") or node.get("interface") or node.get("logical-interface")
        ) or "-"
        flags = junos_text(node.get("arp-flags") or node.get("flags")) or "none"
        hostname = junos_text(node.get("hostname") or node.get("name"))
        entry = _entry(ip=ip, mac=mac, interface=interface, flags=flags, hostname=hostname)
        if entry:
            collector.append(entry)

    for value in node.values():
        if isinstance(value, (dict, list)):
            _walk_json(value, collector)


def _walk_xml(element: Any, collector: list[dict[str, str]]) -> None:
    name = local_name(element.tag)
    if name in {"arp-table-entry", "arp-table-entry-brief"}:
        mac = xml_child_text(element, "mac-address", "mac")
        ip = xml_child_text(element, "ip-address", "address")
        hostname = xml_child_text(element, "hostname", "name")
        interface = xml_child_text(element, "interface-name", "interface") or "-"
        flags_el = None
        for child in list(element):
            if local_name(child.tag) in {"arp-table-entry-flags", "arp-flags", "flags"}:
                flags_el = child
                break
        flags = "none"
        if flags_el is not None:
            nested = [local_name(child.tag) for child in list(flags_el)]
            flags = ",".join(tag for tag in nested if tag and tag != "none") or "none"
        entry = _entry(ip=ip, mac=mac, interface=interface, flags=flags, hostname=hostname)
        if entry:
            collector.append(entry)

    for child in list(element):
        _walk_xml(child, collector)


def _dedupe(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    unique: list[dict[str, str]] = []
    for entry in entries:
        key = (entry["ip"], entry["mac"], entry["interface"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(entry)
    return unique


def parse_arp_table_rpc(payload: Any) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    if payload is None:
        return entries

    root = parse_xml_root(payload)
    if root is not None:
        _walk_xml(root, entries)
        return _dedupe(entries)

    if isinstance(payload, (dict, list)):
        _walk_json(payload, entries)
    return _dedupe(entries)
