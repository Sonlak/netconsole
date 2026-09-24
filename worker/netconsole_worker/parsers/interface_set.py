from __future__ import annotations

import re

IFACE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9/._-]{0,63}$")
VLAN_RE = re.compile(r"^[1-9]\d{0,3}$")
PROTECTED_PREFIXES = ("fxp", "em0", "em1", "me0", "vme", "lo0", "irb")


def validate_interface_name(iface: str) -> str:
    name = (iface or "").strip()
    if not IFACE_RE.fullmatch(name):
        raise ValueError(f"Invalid interface name: {iface}")
    return name


def split_interface(iface: str) -> tuple[str, str | None]:
    name = validate_interface_name(iface)
    if "." in name:
        head, tail = name.rsplit(".", 1)
        if tail.isdigit():
            return head, tail
    return name, None


def is_protected_interface(iface: str) -> bool:
    physical, _unit = split_interface(iface)
    lowered = physical.lower()
    return any(lowered == prefix or lowered.startswith(prefix) for prefix in PROTECTED_PREFIXES)


def xml_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


_SWITCH_MODE_RE = re.compile(
    r"^set interfaces (\S+) (?:unit \d+ )?family ethernet-switching "
    r"(?:interface-mode|port-mode) (trunk|access)\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_SWITCH_MEMBERS_RE = re.compile(
    r"^set interfaces (\S+) (?:unit \d+ )?family ethernet-switching vlan members (.+)$",
    re.IGNORECASE | re.MULTILINE,
)
_IFACE_DESC_RE = re.compile(
    r"^set interfaces (\S+) description (.+)$",
    re.IGNORECASE | re.MULTILINE,
)
_UNIT_DESC_RE = re.compile(
    r"^set interfaces (\S+) unit (\d+) description (.+)$",
    re.IGNORECASE | re.MULTILINE,
)
_L3_MODES = {"inet", "l3", "routed"}


def _unquote_set_value(value: str) -> str:
    text = (value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def physical_interface_name(name: str) -> str:
    text = (name or "").strip()
    if "." in text and not text.lower().startswith("irb."):
        head, tail = text.rsplit(".", 1)
        if tail.isdigit():
            return head
    return text


def parse_switching_mode_from_set(config: str) -> dict[str, dict[str, str]]:
    """Parse interface-mode / vlan members from `display set` interface config."""
    modes: dict[str, dict[str, str]] = {}
    for match in _SWITCH_MODE_RE.finditer(config or ""):
        name = physical_interface_name(match.group(1))
        modes.setdefault(name, {})["mode"] = match.group(2).lower()
    for match in _SWITCH_MEMBERS_RE.finditer(config or ""):
        name = physical_interface_name(match.group(1))
        members = " ".join((match.group(2) or "").strip().strip("[]").split())
        if not members:
            continue
        info = modes.setdefault(name, {})
        existing = (info.get("members") or "").strip()
        if not existing:
            info["members"] = members
        elif members.lower() not in existing.lower().split():
            info["members"] = f"{existing} {members}"
    return modes


def apply_switching_modes(interfaces: list[dict[str, str]], modes: dict[str, dict[str, str]]) -> None:
    """Merge `interface-mode` / `vlan members` from `display set` config.

    The VLAN member parser (`apply_vlan_membership`) already populated
    `accessVlan` with the formatted "VLAN201 (201), VLAN202 (202), ..." list
    when the device's `get-vlan-information` returned those members. We
    don't want to overwrite that with the literal `vlan members all` /
    `vlan members VLAN201` config string — the formatted list is more
    informative and matches what the user sees in the CLI.

    Rules:
    - mode="trunk" + members="all" → keep existing accessVlan (from VLAN
      membership parser) if it looks like a list; otherwise set "all".
    - mode="trunk" + members="<expr>" → use members only when there is
      no existing list-style accessVlan (single-member case).
    - mode="access" + members="<expr>" → keep existing accessVlan (the
      formatted "VLAN204 (204)") if already populated, else use members.

    See `docs/sessions/2026-09-24.md` for the user-visible bug this fixes
    (vQFX xe-0/0/0 on F4-AS-01 showed `accessVlan=all` even though the
    device reported members VLAN201,202,203,204,default).
    """
    for iface in interfaces:
        name = physical_interface_name(iface.get("name") or "")
        info = modes.get(name)
        if not info:
            continue
        current = (iface.get("mode") or "").lower()
        if current in _L3_MODES or iface.get("address"):
            continue
        mode = (info.get("mode") or "").lower()
        members = (info.get("members") or "").strip()
        existing = (iface.get("accessVlan") or "").strip()
        if mode in {"trunk", "access"}:
            iface["mode"] = mode

        if mode == "trunk":
            # If existing accessVlan already shows a list of VLANs (from
            # the membership parser), keep it. The literal "all" / "1-4094"
            # from the config is less informative than the device's actual
            # member list.
            if existing and ("," in existing or re.search(r"\(\d+\)", existing)):
                # already formatted — leave as is
                pass
            elif members.lower() == "all":
                iface["accessVlan"] = "all"
            elif members:
                iface["accessVlan"] = members
            # else: keep whatever was there (might be empty)
        elif mode == "access" and members and not existing:
            iface["accessVlan"] = members


def parse_interface_descriptions_from_set(config: str) -> dict[str, str]:
    """Parse interface / unit descriptions from `display set` interface config."""
    descriptions: dict[str, str] = {}
    for match in _UNIT_DESC_RE.finditer(config or ""):
        physical = physical_interface_name(match.group(1))
        unit = match.group(2)
        text = _unquote_set_value(match.group(3))
        if not text:
            continue
        descriptions[f"{physical}.{unit}"] = text
        if unit == "0":
            descriptions.setdefault(physical, text)
    for match in _IFACE_DESC_RE.finditer(config or ""):
        name = match.group(1)
        text = _unquote_set_value(match.group(2))
        if not text:
            continue
        descriptions[name] = text
        descriptions[physical_interface_name(name)] = text
    return descriptions


def apply_interface_descriptions(interfaces: list[dict[str, str]], descriptions: dict[str, str]) -> None:
    for iface in interfaces:
        name = iface.get("name") or ""
        physical = physical_interface_name(name)
        text = descriptions.get(name) or descriptions.get(physical) or ""
        if text:
            iface["description"] = text


def filter_interface_set_lines(config: str, iface: str) -> str:
    physical, _unit = split_interface(iface)
    prefix = f"set interfaces {physical}"
    lines: list[str] = []
    for line in (config or "").splitlines():
        if line == prefix or line.startswith((prefix + " ", prefix + ".")):
            lines.append(line)
    return "\n".join(lines).strip()


def _escape_junos(value: str) -> str:
    """Wrap value in double-quotes for Junos set command, escaping embedded double-quotes."""
    return '"' + value.replace('"', '\\"') + '"'


def commands_for_action(action: str, iface: str, vlan: str = "", description: str = "") -> list[str]:
    physical, unit = split_interface(iface)
    if action == "shut":
        if unit:
            return [f"set interfaces {physical} unit {unit} disable"]
        return [f"set interfaces {physical} disable"]
    if action == "no-shut":
        if unit:
            return [f"delete interfaces {physical} unit {unit} disable"]
        return [f"delete interfaces {physical} disable"]
    if action == "set-access-vlan":
        if not VLAN_RE.fullmatch(vlan) or int(vlan) > 4094:
            raise ValueError("VLAN must be 1–4094")
        unit_id = unit or "0"
        target = f"interfaces {physical} unit {unit_id} family ethernet-switching"
        return [
            f"delete {target} vlan members",
            f"set {target} interface-mode access",
            f"set {target} vlan members {vlan}",
        ]
    if action == "set-description":
        if description is None:
            raise ValueError("set-description requires a description argument")
        physical2, _unit2 = split_interface(iface)
        if unit:
            return [f"set interfaces {physical2} unit {unit} description {_escape_junos(description)}"]
        return [f"set interfaces {physical2} description {_escape_junos(description)}"]
    if action == "remove-description":
        physical2, _unit2 = split_interface(iface)
        if unit:
            return [f"delete interfaces {physical2} unit {unit} description"]
        return [f"delete interfaces {physical2} description"]
    raise ValueError(f"Unsupported interface action: {action}")
