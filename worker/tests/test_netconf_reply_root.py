"""Tests for the NETCONF reply-root resolution in `ssh_client.py`.

Context (2026-11-19): on production, a Catalyst C9200 (10.1.250.21,
IOS-XE 17.3.5) had `netconf-yang` + `netconf ssh` enabled, but every
NETCONF-backed task failed with:

    NETCONF error: 'RPCReply' object has no attribute 'findall'

Root cause: `ncclient` changed its reply API. The code did

    root = getattr(rpc_reply_root, "data_xml", None) or rpc_reply_root

but on ncclient >= 0.7.x a raw `conn.dispatch(rpc)` returns a plain
`RPCReply` that has NEITHER `.data_xml` NOR `.data` — only `.xml`
(the whole `<rpc-reply>` document). So `root` stayed the RPCReply
object and `.findall()` blew up.

`_nc_reply_root` now resolves the root across all three shapes:
  - `.data`     → lxml element (ncclient < 0.7)
  - `.data_xml` → str of `<data>`    (ncclient < 0.7)
  - `.xml`      → str of `<rpc-reply>` (ncclient >= 0.7)
"""

from __future__ import annotations

import unittest

from lxml import etree

from netconsole_worker.ssh_client import _nc_data_to_ios_text, _nc_reply_root

_NS_NC = "urn:ietf:params:xml:ns:netconf:base:1.0"
_NS_NATIVE = "http://cisco.com/ns/yang/Cisco-IOS-XE-native"

# Real reply captured from NTMK-AS-T02-01-C9200 on 2026-11-19
# (ncclient 0.7.1 raw dispatch of a filtered <get-config>).
_RPC_REPLY_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<rpc-reply xmlns="{_NS_NC}" message-id="urn:uuid:93392f18" xmlns:nc="{_NS_NC}">'
    f'<data><native xmlns="{_NS_NATIVE}"><interface><GigabitEthernet><name>1/0/1</name>'
    "<description>TO-STM-172.28.201.1</description>"
    '<switchport><access xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-switch">'
    "<vlan><vlan>400</vlan></vlan></access>"
    '<mode xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-switch"><access/></mode>'
    "</switchport></GigabitEthernet></interface></native></data></rpc-reply>"
)


class _FakeRpcReply:
    """Stand-in for ncclient's raw `RPCReply` (ncclient >= 0.7 shape).

    Has `.xml` and `.errors` but deliberately NO `.data` / `.data_xml`
    — exactly the shape that broke the production path.
    """

    def __init__(self, xml: str) -> None:
        self.xml = xml
        self.errors: list = []

    def findall(self, *_args, **_kwargs):  # pragma: no cover - must not be called
        raise AttributeError("'RPCReply' object has no attribute 'findall'")


class _FakeGetReply:
    """Stand-in for ncclient's `GetConfigReply` (ncclient < 0.7 shape).

    Exposes `.data` (lxml element) and `.data_xml` (str).
    """

    def __init__(self, data_xml: str) -> None:
        self.data_xml = data_xml
        self.data = etree.fromstring(data_xml.encode())


class TestNcReplyRoot(unittest.TestCase):
    def test_resolves_raw_dispatch_reply_via_xml_attribute(self) -> None:
        reply = _FakeRpcReply(_RPC_REPLY_XML)
        root = _nc_reply_root(reply)
        self.assertIsNotNone(root)
        # The interface block must be reachable from the resolved root.
        found = root.findall(f".//{{{_NS_NATIVE}}}interface")
        self.assertEqual(len(found), 1)

    def test_resolves_get_reply_via_data_attribute(self) -> None:
        data_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<data xmlns="{_NS_NC}"><native xmlns="{_NS_NATIVE}"><interface>'
            "<GigabitEthernet><name>1/0/1</name></GigabitEthernet>"
            "</interface></native></data>"
        )
        root = _nc_reply_root(_FakeGetReply(data_xml))
        self.assertIsNotNone(root)
        self.assertEqual(len(root.findall(f".//{{{_NS_NATIVE}}}interface")), 1)

    def test_resolves_get_reply_via_data_xml_attribute(self) -> None:
        class OnlyDataXml:
            data_xml = (
                '<?xml version="1.0" encoding="UTF-8"?>'
                f'<data xmlns="{_NS_NC}"><native xmlns="{_NS_NATIVE}"><interface>'
                "<GigabitEthernet><name>2</name></GigabitEthernet>"
                "</interface></native></data>"
            )

        root = _nc_reply_root(OnlyDataXml())
        self.assertIsNotNone(root)
        self.assertEqual(len(root.findall(f".//{{{_NS_NATIVE}}}interface")), 1)

    def test_returns_none_for_garbage(self) -> None:
        self.assertIsNone(_nc_reply_root(object()))


class TestNcDataToIosText(unittest.TestCase):
    def test_raw_dispatch_reply_produces_ios_cli_text(self) -> None:
        """The exact production failure must now produce real CLI text."""
        text = _nc_data_to_ios_text(_FakeRpcReply(_RPC_REPLY_XML))
        self.assertIn("interface GigabitEthernet1/0/1", text)
        self.assertIn("description TO-STM-172.28.201.1", text)
        self.assertIn("switchport access vlan 400", text)
        self.assertIn("switchport mode access", text)
        self.assertNotIn("<name>", text)

    def test_empty_reply_returns_placeholder(self) -> None:
        text = _nc_data_to_ios_text(_FakeRpcReply(
            f'<?xml version="1.0" encoding="UTF-8"?><rpc-reply xmlns="{_NS_NC}"><data/></rpc-reply>'
        ))
        self.assertIn("no interface block", text.lower())


if __name__ == "__main__":
    unittest.main()
