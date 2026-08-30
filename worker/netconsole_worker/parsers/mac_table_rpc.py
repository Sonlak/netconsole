from __future__ import annotations

from typing import Any

from netconsole_worker.parsers.junos_leaf import (
    junos_text,
    local_name,
    normalize_mac,
    parse_xml_root,
    xml_child_text,
)

FLAG_LABELS = {
    "S": "static",
    "D": "dynamic",
    "L": "locally learned",
    "C": "control",
    "R": "remote",
}


def _flag_to_type(flags: str) -> str:
    if not flags:
        return "dynamic"
    first = flags.strip()[0].upper()
    return FLAG_LABELS.get(first, flags.strip().lower())


def _entry(
    *,
    mac: str,
    vlan: str = "-",
    tag: str = "-",
    interface: str = "-",
    flags: str = "D",
    sess_id: str = "0",
) -> dict[str, str] | None:
    mac_norm = normalize_mac(mac)
    if not mac_norm:
        return None
    return {
        "mac": mac_norm,
        "vlan": str(vlan or "-"),
        "tag": str(tag or "-"),
        "interface": str(interface or "-"),
        "flags": str(flags or "D")[:8],
        "type": _flag_to_type(str(flags or "D")),
        "sessId": str(sess_id or "0"),
    }


def _walk_json(node: Any, collector: list[dict[str, str]]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_json(item, collector)
        return
    if not isinstance(node, dict):
        return

    mac = junos_text(
        node.get("l2ng-l2-mac-address")
        or node.get("mac-address")
        or node.get("mac")
    )
    if mac:
        flags_raw = (
            node.get("l2ng-l2-mac-flags")
            or node.get("l2ng-l2-mac-entry-flags")
            or node.get("mac-flags")
            or node.get("mac-type")
            or "D"
        )
        flags = junos_text(flags_raw) or "D"
        vlan = junos_text(
            node.get("l2ng-l2-vlan-id")
            or node.get("l2ng-l2-mac-vlan-name")
            or node.get("mac-vlan")
            or node.get("vlan")
        ) or "-"
        interface = junos_text(
            node.get("l2ng-l2-mac-logical-interface")
            or node.get("mac-interfaces")
            or node.get("interface")
        ) or "-"
        entry = _entry(
            mac=mac,
            vlan=vlan,
            tag=junos_text(node.get("vlan-tag") or node.get("tag")) or "-",
            interface=interface,
            flags=flags,
            sess_id=junos_text(node.get("l2ng-l2-mac-sequence-number") or node.get("sess-id")) or "0",
        )
        if entry:
            collector.append(entry)

    for value in node.values():
        if isinstance(value, (dict, list)):
            _walk_json(value, collector)


def _walk_xml(element: Any, collector: list[dict[str, str]], inherited_vlan: str = "-") -> None:
    vlan_here = xml_child_text(element, "l2ng-l2-vlan-id") or inherited_vlan

    mac = xml_child_text(element, "l2ng-l2-mac-address", "mac-address")
    if mac:
        vlan = (
            xml_child_text(element, "l2ng-l2-vlan-id")
            or vlan_here
            or xml_child_text(element, "l2ng-l2-mac-vlan-name", "mac-vlan", "vlan")
            or "-"
        )
        interface = xml_child_text(
            element,
            "l2ng-l2-mac-logical-interface",
            "mac-interfaces",
            "interface-name",
            "interface",
        )
        if not interface:
            for child in list(element):
                if local_name(child.tag) == "mac-interfaces-list":
                    interface = xml_child_text(child, "mac-interfaces")
                    break
        flags = xml_child_text(
            element,
            "l2ng-l2-mac-flags",
            "l2ng-l2-mac-entry-flags",
            "mac-flags",
            "mac-type",
        ) or "D"
        sess_id = xml_child_text(element, "l2ng-l2-mac-sequence-number", "sess-id") or "0"
        entry = _entry(mac=mac, vlan=vlan or "-", interface=interface or "-", flags=flags, sess_id=sess_id)
        if entry:
            collector.append(entry)

    for child in list(element):
        _walk_xml(child, collector, vlan_here)


def _dedupe(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[tuple[str, str, str]] = set()
    unique: list[dict[str, str]] = []
    for entry in entries:
        key = (entry["mac"], entry["vlan"], entry["interface"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(entry)
    return unique


def parse_mac_table_rpc(payload: Any) -> list[dict[str, str]]:
    """Parse Junos REST/NETCONF RPC payload (JSON dict/list or XML string)."""
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
