from __future__ import annotations

import re
from typing import Any

from netconsole_worker.parsers.junos_leaf import (
    junos_text,
    local_name,
    parse_xml_root,
    xml_child_text,
)

KEEP_IFACE = re.compile(
    r"^(ge-|xe-|et-|ae\d|irb|vlan|lo0|me0|fxp0|em0)",
    re.IGNORECASE,
)


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _keep(name: str) -> bool:
    return bool(name) and KEEP_IFACE.match(name) is not None


def _record(
    *,
    name: str,
    admin: str = "up",
    oper: str = "up",
    description: str = "",
    mode: str = "",
    access_vlan: str = "",
    address: str = "",
    mtu: str = "",
    speed: str = "",
) -> dict[str, str]:
    return {
        "name": name,
        "adminStatus": (admin or "up").lower(),
        "operStatus": (oper or "up").lower(),
        "description": description,
        "mode": mode,
        "accessVlan": access_vlan,
        "address": address,
        "mtu": mtu,
        "speed": speed,
    }


def _inet_from_logical(item: dict[str, Any]) -> str:
    families = _as_list(item.get("address-family") or item.get("address-family-name"))
    for family in families:
        if not isinstance(family, dict):
            continue
        family_name = junos_text(family.get("address-family-name") or family.get("name"))
        if family_name and family_name.lower() != "inet":
            continue
        for addr in _as_list(family.get("interface-address") or family.get("ifa-local") or family.get("address")):
            text = junos_text(addr if not isinstance(addr, dict) else addr.get("ifa-local") or addr.get("address") or addr)
            if text:
                return text.split("/")[0]
    return junos_text(item.get("address"))


def parse_interface_information_rpc(payload: Any) -> list[dict[str, str]]:
    """Parse Junos get-interface-information JSON or XML payload."""
    entries: list[dict[str, str]] = []

    root = parse_xml_root(payload)
    if root is not None:
        for element in root.iter():
            if local_name(element.tag) != "physical-interface":
                continue
            name = xml_child_text(element, "name")
            if not _keep(name):
                continue
            address = ""
            mode = xml_child_text(element, "link-level-type", "link-mode")
            for child in list(element):
                if local_name(child.tag) != "logical-interface":
                    continue
                logical_name = xml_child_text(child, "name")
                for family in list(child):
                    if local_name(family.tag) != "address-family":
                        continue
                    family_name = xml_child_text(family, "address-family-name")
                    if family_name.lower() == "inet":
                        for addr in list(family):
                            if local_name(addr.tag) in {"interface-address", "ifa-local"}:
                                text = (addr.text or "").strip() or xml_child_text(addr, "ifa-local", "ifa-destination")
                                if text:
                                    address = text.split("/")[0]
                                    break
                        if not address:
                            address = xml_child_text(family, "ifa-local")
                    if family_name.lower() in {"eth-switch", "ethernet-switching"}:
                        mode = "eth-switch"
                if logical_name.startswith("irb.") and address:
                    entries.append(
                        _record(
                            name=logical_name,
                            admin=xml_child_text(child, "admin-status") or xml_child_text(element, "admin-status"),
                            oper=xml_child_text(child, "oper-status") or xml_child_text(element, "oper-status"),
                            mode="inet",
                            address=address,
                        )
                    )
            entries.append(
                _record(
                    name=name,
                    admin=xml_child_text(element, "admin-status") or "up",
                    oper=xml_child_text(element, "oper-status") or "up",
                    description=xml_child_text(element, "description"),
                    mode=mode,
                    address=address if not name.lower().startswith("irb") else "",
                    mtu=xml_child_text(element, "mtu"),
                    speed=xml_child_text(element, "speed"),
                )
            )
        return _dedupe(entries)

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return

        if "physical-interface" in node:
            for item in _as_list(node["physical-interface"]):
                if not isinstance(item, dict):
                    continue
                name = junos_text(item.get("name"))
                if not _keep(name):
                    continue
                address = ""
                mode = junos_text(item.get("link-mode") or item.get("link-level-type") or item.get("mode"))
                for logical in _as_list(item.get("logical-interface")):
                    if isinstance(logical, dict):
                        inet = _inet_from_logical(logical)
                        if inet:
                            address = inet
                        logical_name = junos_text(logical.get("name"))
                        if logical_name.startswith("irb.") and inet:
                            entries.append(
                                _record(
                                    name=logical_name,
                                    admin=junos_text(logical.get("admin-status")) or junos_text(item.get("admin-status")),
                                    oper=junos_text(logical.get("oper-status")) or junos_text(item.get("oper-status")),
                                    mode="inet",
                                    address=inet,
                                )
                            )
                entries.append(
                    _record(
                        name=name,
                        admin=junos_text(item.get("admin-status") or item.get("adminStatus")) or "up",
                        oper=junos_text(item.get("oper-status") or item.get("operStatus")) or "up",
                        description=junos_text(item.get("description")),
                        mode=mode,
                        access_vlan=junos_text(item.get("access-vlan") or item.get("accessVlan")),
                        address=address if not name.lower().startswith("irb") else "",
                        mtu=junos_text(item.get("mtu")),
                        speed=junos_text(item.get("speed")),
                    )
                )
            return

        for value in node.values():
            walk(value)

    walk(payload)
    return _dedupe(entries)


def _dedupe(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for entry in entries:
        if entry["name"] in seen:
            continue
        seen.add(entry["name"])
        unique.append(entry)
    return unique


_TERSE_RE = re.compile(
    r"^(?P<name>\S+)\s+(?P<admin>up|down)\s+(?P<link>up|down)\s+"
    r"(?P<proto>\S+)(?:\s+(?P<local>\S+))?",
    re.IGNORECASE,
)


def parse_interfaces_terse(output: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped or stripped.lower().startswith("interface"):
            continue
        match = _TERSE_RE.match(stripped)
        if not match:
            continue
        name = match.group("name")
        if not _keep(name) and not name.startswith("irb."):
            continue

        proto = match.group("proto").lower()
        mode = "inet" if proto == "inet" else "access"
        local = match.group("local") or ""
        entries.append(
            _record(
                name=name,
                admin=match.group("admin").lower(),
                oper=match.group("link").lower(),
                mode=mode,
                address=local if proto == "inet" else "",
            )
        )
    return _dedupe(entries)
