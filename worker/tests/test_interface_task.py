"""Tests for the cross-interface multi-action grouping in InterfaceActionTask.

The worker accepts payload shapes:
- Legacy single-action: { action, interface, vlan?, description? }
- Same-interface multi-action: { interface, actions: [...] }
- Cross-interface multi-action: { actions: [{interface, action, ...}, ...] }

The cross-interface shape groups subactions by interface, then calls
`backend.interface_action_multi()` once per group. We test the
grouping + per-group validation without hitting real devices.
"""
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock


# Stub the heavy imports the registry brings in so the test module
# imports cleanly. The InterfaceActionTask only needs _backend + a few
# helpers, which we patch below.
def _import_task():
    sys.path.insert(0, '.')
    from netconsole_worker.tasks.registry import InterfaceActionTask
    return InterfaceActionTask


def _make_device(vendor: str = "juniper") -> SimpleNamespace:
    return SimpleNamespace(
        name="LAB-F6-DS-01",
        ip="10.10.20.6",
        vendor=vendor,
        id="dev-1",
    )


def _make_job(payload: dict) -> SimpleNamespace:
    return SimpleNamespace(payload=payload)


# ── Cross-interface grouping ────────────────────────────────────────────────


def test_cross_interface_groups_correctly():
    """Subactions on 2 interfaces should split into 2 groups, preserving order."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()

    # Mock the backend
    backend = MagicMock()
    backend.interface_action_multi.side_effect = [
        {"source": "junos-rest", "interface": "xe-0/0/8", "ok": True, "message": "OK"},
        {"source": "junos-rest", "interface": "xe-0/0/9", "ok": True, "message": "OK"},
    ]

    # Patch the _backend factory to return our mock
    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "actions": [
                {"interface": "xe-0/0/8", "action": "delete-interface"},
                {"interface": "xe-0/0/9", "action": "delete-interface"},
                {"interface": "xe-0/0/8", "action": "set-access-vlan", "vlan": "201"},
                {"interface": "xe-0/0/8", "action": "set-description", "description": "client-tang1"},
                {"interface": "xe-0/0/9", "action": "set-access-vlan", "vlan": "202"},
                {"interface": "xe-0/0/9", "action": "set-description", "description": "client-tang2"},
            ],
        })
        result = task.run(job, device)
    finally:
        reg._backend = orig

    assert result["source"] == "cross-interface"
    assert result["interfaceCount"] == 2
    assert result["subActionCount"] == 6
    assert result["interfaces"] == ["xe-0/0/8", "xe-0/0/9"]

    # Should have called interface_action_multi twice (once per interface)
    assert backend.interface_action_multi.call_count == 2

    # Verify each call got the right subactions
    call_args_list = backend.interface_action_multi.call_args_list
    first_call = call_args_list[0]
    second_call = call_args_list[1]

    assert first_call.kwargs["iface"] == "xe-0/0/8"
    assert len(first_call.kwargs["subactions"]) == 3
    assert first_call.kwargs["subactions"][0]["action"] == "delete-interface"
    assert first_call.kwargs["subactions"][1]["action"] == "set-access-vlan"
    assert first_call.kwargs["subactions"][2]["action"] == "set-description"

    assert second_call.kwargs["iface"] == "xe-0/0/9"
    assert len(second_call.kwargs["subactions"]) == 3
    assert second_call.kwargs["subactions"][0]["action"] == "delete-interface"
    assert second_call.kwargs["subactions"][2]["description"] == "client-tang2"


def test_same_interface_multi_uses_single_call():
    """When all subactions target the same interface, ONE call (atomic)."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()
    backend.interface_action_multi.return_value = {
        "source": "junos-rest", "interface": "xe-0/0/7", "ok": True, "message": "OK",
    }

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",
            "actions": [
                {"action": "set-access-vlan", "vlan": "203"},
                {"action": "set-description", "description": "sonnx_test"},
            ],
        })
        result = task.run(job, device)
    finally:
        reg._backend = orig

    # Should call interface_action_multi ONCE
    assert backend.interface_action_multi.call_count == 1
    assert result["source"] != "cross-interface"
    assert result["interface"] == "xe-0/0/7"


def test_mixed_top_level_and_per_subaction_interface():
    """Hoisted top-level interface, but a subaction overrides with its own."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()
    backend.interface_action_multi.side_effect = [
        {"source": "junos-rest", "interface": "xe-0/0/7", "ok": True},
        {"source": "junos-rest", "interface": "xe-0/0/8", "ok": True},
    ]

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",  # default
            "actions": [
                {"action": "set-access-vlan", "vlan": "203"},  # uses top-level
                {"interface": "xe-0/0/8", "action": "set-access-vlan", "vlan": "201"},  # overrides
            ],
        })
        result = task.run(job, device)
    finally:
        reg._backend = orig

    assert result["source"] == "cross-interface"
    assert result["interfaceCount"] == 2
    assert result["interfaces"] == ["xe-0/0/7", "xe-0/0/8"]


def test_rejects_contradictory_shut_and_no_shut_per_interface():
    """shut + no-shut on the SAME interface in the same batch is rejected."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",
            "actions": [
                {"action": "shut"},
                {"action": "no-shut"},
            ],
        })
        try:
            task.run(job, device)
            assert False, "should have raised"
        except RuntimeError as e:
            assert "Contradictory" in str(e) or "shut" in str(e)
    finally:
        reg._backend = orig


def test_rejects_delete_interface_mixed_with_set_vlan():
    """delete-interface + set-access-vlan on same interface is NOW ALLOWED
    (declaration order = commit order in Junos; the interface gets
    re-configured with just the vlan). Documented behavior, not error."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()
    backend.interface_action_multi.return_value = {
        "source": "junos-rest", "interface": "xe-0/0/7", "ok": True,
    }

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",
            "actions": [
                {"action": "delete-interface"},
                {"action": "set-access-vlan", "vlan": "100"},
            ],
        })
        task.run(job, device)
    finally:
        reg._backend = orig

    # Both subactions go through to the backend in order
    assert backend.interface_action_multi.call_count == 1
    subs = backend.interface_action_multi.call_args.kwargs["subactions"]
    assert len(subs) == 2
    assert subs[0]["action"] == "delete-interface"
    assert subs[1]["action"] == "set-access-vlan"


def test_rejects_more_than_8_distinct_interfaces():
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        # 9 different interfaces
        actions = [{"interface": f"xe-0/0/{i}", "action": "shut"} for i in range(9)]
        job = _make_job({"actions": actions})
        try:
            task.run(job, device)
            assert False, "should have raised"
        except RuntimeError as e:
            assert "Too many" in str(e) or "8" in str(e)
    finally:
        reg._backend = orig


def test_rejects_subaction_without_interface_when_no_top_level():
    """Cross-interface batch with a subaction missing 'interface' fails."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "actions": [
                {"action": "shut"},  # no interface, no top-level
            ],
        })
        try:
            task.run(job, device)
            assert False, "should have raised"
        except RuntimeError as e:
            assert "interface" in str(e).lower()
    finally:
        reg._backend = orig


def test_sequential_fallback_when_backend_lacks_multi_method():
    """Old backends without interface_action_multi fall back to per-subaction interface_action calls."""
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock(spec=["interface_action"])  # no interface_action_multi
    backend.interface_action.return_value = {"ok": True, "interface": "xe-0/0/7"}

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",
            "actions": [
                {"action": "set-access-vlan", "vlan": "203"},
                {"action": "set-description", "description": "test"},
            ],
        })
        result = task.run(job, device)
    finally:
        reg._backend = orig

    # Each subaction should call interface_action (NOT atomic)
    assert backend.interface_action.call_count == 2
    assert result["source"] == "sequential"


# ── Legacy single-action still works ────────────────────────────────────────


def test_legacy_single_action_still_works():
    InterfaceActionTask = _import_task()
    task = InterfaceActionTask()
    device = _make_device()
    backend = MagicMock()
    backend.interface_action.return_value = {"ok": True}

    import netconsole_worker.tasks.registry as reg
    orig = reg._backend
    reg._backend = lambda d: backend
    try:
        job = _make_job({
            "interface": "xe-0/0/7",
            "action": "set-access-vlan",
            "vlan": "203",
        })
        task.run(job, device)
    finally:
        reg._backend = orig

    assert backend.interface_action.call_count == 1
    assert backend.interface_action.call_args.kwargs["action"] == "set-access-vlan"
    assert backend.interface_action.call_args.kwargs["vlan"] == "203"
