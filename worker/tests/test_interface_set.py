"""Tests for interface_set.commands_for_action (multi-action + smart delete).

The new contract:
- `set-access-vlan` does NOT prepend `delete ... vlan members`; callers
  read the current config and prepend it themselves only when the
  interface already has a vlan members line.
- `delete-interface` action exists and emits `delete interfaces <name>`.
"""
from netconsole_worker.parsers.interface_set import (
    _has_vlan_members,
    commands_for_action,
)


# ── commands_for_action ─────────────────────────────────────────────────────


def test_set_access_vlan_no_delete():
    """set-access-vlan alone must NOT include a `delete` line.

    Pre-fix bug: the unconditional `delete ... vlan members` was the
    root cause of "unknown command: delete" on the SSH CLI fallback for
    interfaces that didn't have ethernet-switching configured yet.
    """
    cmds = commands_for_action("set-access-vlan", "xe-0/0/7", "203", "")
    assert not any(c.startswith("delete") for c in cmds), f"unexpected delete in {cmds}"
    assert any("vlan members 203" in c for c in cmds)
    assert any("interface-mode access" in c for c in cmds)


def test_set_access_vlan_unit():
    cmds = commands_for_action("set-access-vlan", "xe-0/0/7.0", "100", "")
    assert any("unit 0" in c for c in cmds)
    assert any("vlan members 100" in c for c in cmds)


def test_set_access_vlan_rejects_bad_vlan():
    import pytest
    with pytest.raises(ValueError):
        commands_for_action("set-access-vlan", "xe-0/0/7", "abc", "")
    with pytest.raises(ValueError):
        commands_for_action("set-access-vlan", "xe-0/0/7", "5000", "")
    with pytest.raises(ValueError):
        commands_for_action("set-access-vlan", "xe-0/0/7", "0", "")


def test_set_description():
    cmds = commands_for_action("set-description", "xe-0/0/7", "", "uplink to core")
    assert cmds == ['set interfaces xe-0/0/7 description "uplink to core"']


def test_set_description_escapes_quotes():
    cmds = commands_for_action("set-description", "xe-0/0/7", "", 'say "hi"')
    assert cmds == [r'set interfaces xe-0/0/7 description "say \"hi\""']


def test_set_description_with_unit():
    cmds = commands_for_action("set-description", "xe-0/0/7.10", "", "vlan10 subif")
    assert cmds == ['set interfaces xe-0/0/7 unit 10 description "vlan10 subif"']


def test_remove_description():
    assert commands_for_action("remove-description", "xe-0/0/7") == [
        "delete interfaces xe-0/0/7 description"
    ]
    assert commands_for_action("remove-description", "xe-0/0/7.0") == [
        "delete interfaces xe-0/0/7 unit 0 description"
    ]


def test_shut_no_shut():
    assert commands_for_action("shut", "xe-0/0/7") == ["set interfaces xe-0/0/7 disable"]
    assert commands_for_action("shut", "xe-0/0/7.0") == ["set interfaces xe-0/0/7 unit 0 disable"]
    assert commands_for_action("no-shut", "xe-0/0/7") == ["delete interfaces xe-0/0/7 disable"]


def test_delete_interface():
    assert commands_for_action("delete-interface", "xe-0/0/7") == [
        "delete interfaces xe-0/0/7"
    ]
    # subif: still deletes the physical interface (which removes all units)
    assert commands_for_action("delete-interface", "xe-0/0/7.10") == [
        "delete interfaces xe-0/0/7"
    ]


def test_unsupported_action():
    import pytest
    with pytest.raises(ValueError, match="Unsupported interface action"):
        commands_for_action("totally-bogus", "xe-0/0/7")


# ── _has_vlan_members ───────────────────────────────────────────────────────


def test_has_vlan_members_empty():
    assert _has_vlan_members("", "xe-0/0/7") is False


def test_has_vlan_members_positive():
    cfg = """
set interfaces xe-0/0/7 unit 0 family ethernet-switching interface-mode access
set interfaces xe-0/0/7 unit 0 family ethernet-switching vlan members 100
"""
    assert _has_vlan_members(cfg, "xe-0/0/7") is True


def test_has_vlan_members_trunk():
    cfg = """
set interfaces xe-0/0/7 unit 0 family ethernet-switching interface-mode trunk
set interfaces xe-0/0/7 unit 0 family ethernet-switching vlan members all
"""
    assert _has_vlan_members(cfg, "xe-0/0/7") is True


def test_has_vlan_members_different_iface():
    cfg = """
set interfaces xe-0/0/8 unit 0 family ethernet-switching vlan members 100
"""
    assert _has_vlan_members(cfg, "xe-0/0/7") is False


def test_has_vlan_members_routed_port():
    """Interface with inet but no ethernet-switching → no vlan members."""
    cfg = """
set interfaces xe-0/0/7 unit 0 family inet address 10.0.0.1/24
"""
    assert _has_vlan_members(cfg, "xe-0/0/7") is False
