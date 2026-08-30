from __future__ import annotations

import re
from typing import Any

from netconsole_worker.parsers.junos_leaf import local_name, parse_xml_root, xml_child_text

_UNIT_RE = re.compile(r"\.\d+$")


def normalize_vlan_member(name: str) -> str:
    text = (name or "").strip().rstrip("*").strip()
    if _UNIT_RE.search(text) and not text.lower().startswith("irb."):
        text = _UNIT_RE.sub("", text)
    return text


def format_vlan_label(entries: list[dict[str, str]]) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for item in entries:
        name = (item.get("name") or "").strip()
        tag = (item.get("tag") or "").strip()
        if name and tag:
            label = f"{name} ({tag})"
        else:
            label = name or tag
        if not label or label in seen:
            continue
        seen.add(label)
        parts.append(label)
    return ", ".join(parts)


def parse_vlan_information_rpc(payload: Any) -> dict[str, list[dict[str, str]]]:
    """Map physical interface -> VLAN name/tag entries from show vlans XML."""
    membership: dict[str, list[dict[str, str]]] = {}
    root = parse_xml_root(payload)
    if root is None:
        return membership

    for group in root.iter():
        tag_name = local_name(group.tag)
        if tag_name not in {"l2ng-l2ald-vlan-instance-group", "vlan"}:
            continue
        vlan_name = xml_child_text(group, "l2ng-l2rtb-vlan-name", "vlan-name", "name")
        vlan_tag = xml_child_text(group, "l2ng-l2rtb-vlan-tag", "vlan-tag", "tag")
        if not vlan_name and not vlan_tag:
            continue
        for child in group.iter():
            if local_name(child.tag) not in {
                "l2ng-l2rtb-vlan-member-interface",
                "vlan-member-interface",
            }:
                continue
            iface = normalize_vlan_member((child.text or "").strip())
            if not iface:
                continue
            membership.setdefault(iface, []).append({"name": vlan_name, "tag": vlan_tag})
    return membership


def apply_vlan_membership(interfaces: list[dict[str, str]], membership: dict[str, list[dict[str, str]]]) -> None:
    for iface in interfaces:
        name = iface.get("name") or ""
        entries = membership.get(name) or membership.get(normalize_vlan_member(name))
        if not entries:
            continue
        iface["accessVlan"] = format_vlan_label(entries)
        tags = [item["tag"] for item in entries if item.get("tag")]
        names = [item["name"] for item in entries if item.get("name")]
        if tags:
            iface["vlanTag"] = tags[0]
        if names:
            iface["vlanName"] = names[0]
        current = (iface.get("mode") or "").lower()
        if len(entries) > 1 and current not in {"inet", "l3", "routed", "access", "trunk"}:
            iface["mode"] = "trunk"
