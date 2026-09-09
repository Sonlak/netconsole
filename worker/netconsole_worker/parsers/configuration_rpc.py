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


def xml_to_set_format(payload: Any) -> str:
    """Convert a NETCONF `<get-configuration>` XML reply into set-format text.

    Junos NETCONF replies come back as nested XML like:

        <rpc-reply>
          <configuration>
            <interfaces>
              <interface>
                <name>ge-0/0/2</name>
                <description>uplink</description>
                <disable/>
                <unit><name>0</name>...</unit>
              </interface>
            </interfaces>
          </configuration>
        </rpc-reply>

    Walks the tree and emits one ``set ...`` line per leaf, in document
    order.  Presence containers (no text child) become bare flags
    (e.g. ``set interfaces ge-0/0/2 disable``).  Leaves with text become
    ``set <path> <value>``.

    The ``<name>`` child is the path anchor for its parent: the XML path
    ``<interfaces><interface><name>ge-0/0/2</name><description>X</description>``
    maps to ``set interfaces ge-0/0/2 description X``.  The ``<name>`` value
    is NOT emitted as a separate ``set X name Y`` line.

    Only RPC envelope tags (``<configuration>``, ``<rpc-reply>``) are stripped
    from the path.  Semantic stanza tags (``<interfaces>``, ``<protocols>``,
    ``<system>``) and list-entry wrappers (``<interface>``, ``<unit>``) are
    NOT stripped from the path itself — they are handled by the name-anchor
    logic so the output follows Junos set-format conventions.

    Returns an empty string if `payload` cannot be parsed as XML.
    """
    root = parse_xml_root(payload)
    if root is None:
        return ""

    # Locate the first <configuration> element.  Scoped RPCs can return
    # just the stanza subtree without a <configuration> wrapper.
    config_root: Any = None
    for el in [root, *list(root.iter())]:
        if local_name(el.tag) == "configuration":
            config_root = el
            break

    if config_root is None:
        config_root = root

    # Tags that are RPC / data-model envelope and never appear in the
    # set-format path.
    _ENVELOPE_TAGS = {"configuration", "rpc-reply", "rpc-error"}

    # List-entry wrapper tags where the name value becomes a direct child
    # of the semantic container.  The <name> value is NOT emitted as a
    # separate `set X name Y` line.
    # - <interface><name>X</name> -> "interfaces X" (strip <interface>)
    # - <vlan><name>V</name>      -> "vlans V"   (strip <vlan>)
    # - <protocols><ospf><area><name>0</name> -> "protocols ospf 0" (strip <area>)
    _LIST_ENTRY_TAGS = {"interface", "vlan", "area"}

    lines: list[str] = []

    def _quote(value: str) -> str:
        if value == "":
            return '""'
        if re.match(r"^[A-Za-z0-9_./:-]+$", value):
            return value
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

    def _walk(node: Any, path: list[str]) -> None:
        local = local_name(node.tag)
        children = list(node)

        if not children:
            # Leaf node
            text = (node.text or "").strip()
            # Strip envelope tags from path before emitting
            filtered = [p for p in path if p not in _ENVELOPE_TAGS]
            full_path = filtered + [local]
            if text:
                lines.append(f"set {' '.join(full_path)} {_quote(text)}")
            else:
                lines.append(f"set {' '.join(full_path)}")
            return

        # Has children — look for a <name>X</name> primary-key child.
        name_child: Any = None
        for c in children:
            if local_name(c.tag) == "name" and not list(c):
                name_child = c
                break

        if name_child is not None:
            name_value = (name_child.text or "").strip()
            parent_stripped = [p for p in path if p not in _ENVELOPE_TAGS]
            if local in _LIST_ENTRY_TAGS:
                # List-entry wrapper: name value becomes direct child of
                # the semantic container.
                # E.g. <interfaces><interface><name>ge-0/0/2</name>
                #   -> path = ["interfaces", "ge-0/0/2"]
                base = parent_stripped + [name_value]
            else:
                # Named list: parent tag + name value in the path.
                # E.g. <ospf><area><name>0</name>  (area IS a list-entry tag here)
                # The <name> key itself is NOT emitted as a separate line.
                base = parent_stripped + [local, name_value]

            # Recurse into remaining children (skip the <name> key itself)
            for c in children:
                if c is name_child:
                    continue
                _walk(c, base)
        else:
            new_path = path + [local]
            for c in children:
                _walk(c, new_path)

    _walk(config_root, [])
    return "\n".join(lines)


def netconf_get_configuration_to_set(payload: Any) -> str:
    """Parse a NETCONF `<get-configuration>` reply to set-format.

    The reply is nested XML that ``xml_to_set_format`` converts to set lines.
    Falls back to ``parse_configuration_set`` in case the payload is already
    in flat set-format text (e.g. from a RESTCONF fallback path).

    Replies that contain only noise (e.g. ``<ok/>``, ``<rpc-reply>`` with
    no configuration) return an empty string.
    """
    result = xml_to_set_format(payload)
    if result and not _is_noise_output(result):
        return result
    fallback = parse_configuration_set(payload)
    if fallback:
        return fallback
    return ""


def _is_noise_output(text: str) -> bool:
    """Return True if the output contains only noise, not config lines."""
    if not text:
        return True
    # Strip the single `set ok` / `set rpc-reply ok` line from a bare
    # <ok/> reply — not a configuration statement.
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) == 1 and lines[0] in (
        "set ok",
        "set rpc-reply ok",
        "set rpc-error",
    ):
        return True
    return False
