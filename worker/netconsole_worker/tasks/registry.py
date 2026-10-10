"""Task definitions — vendor-agnostic dispatch.

Each task class wraps a `select_backend(device)` call and forwards to
the matching `DeviceBackend` method. The result shape is identical to
what the previous (vendor-hardcoded) implementation produced, so
the frontend + DB row writers don't need to change.

Vendor dispatch logic lives in `netconsole_worker.vendor`. Backends
live in `netconsole_worker.backends.{juniper,eos,iosxe,nxos}`.
"""

from __future__ import annotations

from typing import Any

from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.tasks.base import BaseTask
from netconsole_worker.tasks.managed_check import ManagedCheckTask
from netconsole_worker.tasks.netbox_sync import NetboxSyncAllTask, NetboxSyncDeviceTask
from netconsole_worker.vendor import select_backend


def _backend(device: DeviceInfo) -> Any:
    return select_backend(device)


def _stub(task: BaseTask, job: JobInfo, device: DeviceInfo, **overrides: Any) -> dict[str, Any]:
    base = task.stub_result(job, device)
    base.update(overrides)
    return base


class ConnectTestTask(BaseTask):
    job_type = "CONNECT_TEST"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        result = _backend(device).probe_identity(device)
        return {
            "implemented": bool(result.get("checks", {}).get("ssh")),
            "connected": bool(result.get("checks", {}).get("ssh")),
            "protocol": "ssh",
            "source": result.get("source"),
            "message": result.get("message"),
        }


class GetConfigTask(BaseTask):
    job_type = "GET_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return _backend(device).get_config(device)


class ApplyConfigTask(BaseTask):
    job_type = "APPLY_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        payload = job.payload or {}
        config = str(payload.get("config") or "").strip()
        if not config:
            raise RuntimeError("APPLY_CONFIG payload.config is empty")
        previous = payload.get("previous")
        return _backend(device).apply_config(
            device,
            config,
            log=f"NetConsole APPLY_CONFIG {device.name}",
            previous=str(previous) if previous else None,
        )


class RollbackConfigTask(BaseTask):
    job_type = "ROLLBACK_CONFIG"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        payload = job.payload or {}
        rollback_index = payload.get("rollback")
        previous = payload.get("previous")
        return _backend(device).rollback_config(
            device,
            rollback_index,
            previous=str(previous) if previous else None,
        )


class GetArpTask(BaseTask):
    job_type = "GET_ARP"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return _backend(device).get_arp(device)


class GetMacTask(BaseTask):
    job_type = "GET_MAC"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        return _backend(device).get_mac(device)


class GetInterfacesTask(BaseTask):
    job_type = "GET_INTERFACES"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        # Collect interface data (description, status, mode, etc.)
        interfaces_result = _backend(device).get_interfaces(device)
        # Collect LLDP neighbours (the ground-truth link map for fabric topology)
        lldp_result = _backend(device).get_lldp(device)
        # Build a lookup: normalize LLDP localPort to a short key for matching.
        # IOS: "Gi0/0" → "00"; IOS-XE: "Gi0/0/1" → "0001";
        # Juniper: "ge-0/0/1" → "ge-0001"; EOS: "Et1" → "1".
        # Both sides (LLDP localPort and interface name) pass through the same
        # `_norm_key` so abbreviated names ("Gi") match long names
        # ("GigabitEthernet") without needing a second join.
        neighbors = lldp_result.get("neighbors", [])

        # Order matters: long-form prefixes first so "GigabitEthernet0/0"
        # doesn't fall into the short-form "gi" branch by accident.
        _LONG_PREFIXES = (
            "gigabitethernet",
            "fastethernet",
            "ten gigabitethernet",
            "tengigabitethernet",
            "twentyfivegige",
            "fortygigabitethernet",
            "fiftygige",
            "hundredgige",
            "ethernet",
            "loopback",
            "port-channel",
            "vlan",
            "nve",
            "management",
            "service-engine",
        )
        # Cisco IOS short forms — only matched when followed by a digit, so
        # Junos `et-0/0/0` doesn't get rewritten to `Ethernet-0/0/0`.
        _SHORT_PREFIXES = ("gi", "te", "fa", "et", "tw", "twe", "fo", "hu", "fou", "po")

        def _norm_key(port: str) -> str:
            p = port.lower()
            stripped = False
            for prefix in _LONG_PREFIXES:
                if p.startswith(prefix):
                    p = p[len(prefix):]
                    stripped = True
                    break
            if not stripped:
                for prefix in _SHORT_PREFIXES:
                    if p.startswith(prefix) and len(p) > len(prefix) and p[len(prefix)].isdigit():
                        p = p[len(prefix):]
                        break
            return p.replace("/", "").replace(".", "").replace("-", "")

        lldp_by_iface: dict[str, dict[str, str]] = {}
        for n in neighbors:
            local = n.get("localPort") or ""
            key = _norm_key(local)
            if key and key not in lldp_by_iface:
                lldp_by_iface[key] = n

        # Merge LLDP data into each interface row so the frontend can display
        # the full link name (e.g. LINK_TO_SW-F6-DS-01_ge-0/0/5) without a
        # separate join.
        for iface in interfaces_result.get("interfaces", []):
            name = iface.get("name") or ""
            key = _norm_key(name)
            n = lldp_by_iface.get(key)
            if n:
                iface["remoteDeviceId"] = n.get("remoteDeviceId", "")
                iface["remotePort"] = n.get("remotePort", "")
                iface["portDescription"] = n.get("portDescription", "")
                iface["chassisId"] = n.get("chassisId", "")

        # Keep the raw neighbours array too for callers that want it.
        interfaces_result["lldpNeighbors"] = neighbors
        if lldp_result.get("implemented"):
            interfaces_result["lldpSource"] = lldp_result.get("source")
            interfaces_result["lldpMessage"] = lldp_result.get("message")
        return interfaces_result


class InterfaceActionTask(BaseTask):
    job_type = "INTERFACE_ACTION"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        """
        Supports two payload shapes:

        1. Legacy single-action: { action, interface, vlan?, description? }
           → backend parses InterfaceActionPayload.action and dispatches.

        2. Multi-action: { interface, actions: [{action, ...}, ...] }
           → build commands for every subaction in order, then commit
           ALL of them in ONE device commit. This is atomic on the device:
           either every change lands together or none do.

        Reject contradictory batches (e.g. shut + no-shut) with a clear
        error so the operator gets a useful message instead of "commit
        failed with X syntax error".
        """
        payload = job.payload or {}
        iface = str(payload.get("interface") or "").strip()
        if not iface:
            raise RuntimeError("Missing 'interface' in job payload")

        subactions_raw = payload.get("actions")
        if isinstance(subactions_raw, list) and len(subactions_raw) > 0:
            return self._run_multi_action(device, iface, subactions_raw)

        # Legacy single-action path
        action = str(payload.get("action") or "").strip()
        vlan = payload.get("vlan")
        description = payload.get("description")

        # Treat empty-string or null description as "remove". The frontend
        # sends description="" when the user clears the field, and may
        # omit the field entirely (description=None) when the user didn't
        # touch it. Both should map to a remove-description action so the
        # UI text "Clear the field to remove it" actually removes.
        #
        # Pre-fix bug: when the backend dropped the description field
        # entirely (see parseInterfaceActionPayload in interfaces.ts),
        # every set-description silently turned into a remove, which
        # made "type anything" still wipe the description.
        effective_action = action
        effective_description: str | None = None
        if action == "set-description":
            if isinstance(description, str) and description.strip():
                effective_description = description
            else:
                # Empty string or null → remove
                effective_action = "remove-description"
                effective_description = None

        return _backend(device).interface_action(
            device,
            action=effective_action,
            iface=iface,
            vlan=str(vlan) if vlan is not None else None,
            description=effective_description,
        )

    def _run_multi_action(
        self,
        device: DeviceInfo,
        iface: str,
        subactions_raw: list[object],
    ) -> dict[str, Any]:
        """
        Build one combined command list from the subactions and dispatch
        via a NEW single backend call (`interface_action_multi`) that
        commits all of them in one load+commit on the device.

        For Junos this means ONE `<load-configuration>` RPC and ONE
        `<commit-configuration>` RPC, even if 3 subactions were requested.
        """
        # Parse + validate the batch.
        subactions: list[dict[str, object]] = []
        for i, raw in enumerate(subactions_raw):
            if not isinstance(raw, dict):
                raise RuntimeError(f"actions[{i}] is not an object")
            sa = self._normalize_subaction(iface, raw)
            subactions.append(sa)

        if not subactions:
            raise RuntimeError("Empty actions list")

        # Reject contradictory pairs.
        actions = {s["action"] for s in subactions}
        if "shut" in actions and "no-shut" in actions:
            raise RuntimeError("Contradictory batch: 'shut' and 'no-shut' on the same interface in one commit")
        if "delete-interface" in actions and len(actions) > 1:
            raise RuntimeError(
                "'delete-interface' must be the only subaction in the batch "
                "(combining it with set-vlan/description is contradictory — "
                "delete clears everything anyway)"
            )

        backend = _backend(device)
        multi = getattr(backend, "interface_action_multi", None)
        if multi is None:
            # Older backend without the new method — fall back to running
            # each subaction sequentially through the legacy single-action
            # path. NOT atomic (each subaction is its own commit), but at
            # least the operator's change isn't rejected outright.
            results = []
            for sa in subactions:
                results.append(
                    backend.interface_action(
                        device,
                        action=str(sa["action"]),
                        iface=iface,
                        vlan=str(sa.get("vlan", "")) if sa.get("vlan") is not None else None,
                        description=str(sa.get("description", "")) if sa.get("description") is not None else None,
                    )
                )
            return {
                "implemented": True,
                "source": "sequential",
                "interface": iface,
                "subActionCount": len(subactions),
                "subActions": subactions,
                "results": results,
                "message": f"Multi-action fallback (sequential commits) on {iface} — backend lacks atomic multi method.",
            }
        return backend.interface_action_multi(device, iface=iface, subactions=subactions)

    def _normalize_subaction(
        self,
        iface: str,
        raw: dict[str, object],
    ) -> dict[str, object]:
        """Mirror parseInterfaceActionPayload's parseSubAction in TS."""
        action = raw.get("action")
        if not isinstance(action, str) or action not in {
            "shut", "no-shut", "set-access-vlan", "set-description",
            "remove-description", "delete-interface",
        }:
            raise RuntimeError(f"Invalid subaction action: {action!r}")
        out: dict[str, object] = {"action": action}
        if action == "set-access-vlan":
            vlan = raw.get("vlan")
            if not isinstance(vlan, str) or not vlan.strip():
                raise RuntimeError("set-access-vlan requires non-empty vlan")
            if not vlan.isdigit() or not (1 <= int(vlan) <= 4094):
                raise RuntimeError(f"vlan out of range (1-4094): {vlan!r}")
            out["vlan"] = vlan.strip()
        elif action == "set-description":
            d = raw.get("description")
            if not isinstance(d, str) or not d.strip():
                raise RuntimeError("set-description requires non-empty description")
            out["description"] = d.strip()
        return out


class GetLogsTask(BaseTask):
    job_type = "GET_LOGS"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        """
        Logs are now ingested **passively via syslog UDP push** on the
        backend (`backend/src/services/syslogReceiver.ts` listening on
        UDP 1514). Real devices send their syslog stream to that
        endpoint and rows land directly in `DeviceLog`.

        This collector exists only as a fallback / on-demand pull for
        a single device at a time (e.g. when an operator wants the
        full historical buffer). The vendor backend decides whether
        to expose a RESTCONF/RPC pull (Juniper) or return a stub
        pointing at the syslog stream.
        """
        payload = job.payload or {}
        filename = str(payload.get("filename") or "").strip() or None
        return _backend(device).get_logs(device, filename=filename)


TASK_REGISTRY = {
    task.job_type: task
    for task in [
        ConnectTestTask(),
        GetConfigTask(),
        ApplyConfigTask(),
        RollbackConfigTask(),
        GetArpTask(),
        GetMacTask(),
        GetInterfacesTask(),
        GetLogsTask(),
        InterfaceActionTask(),
        ManagedCheckTask(),
        # NetBox sync — periodic + on-demand (see services/scheduler in
        # backend). Not interactive (no SSH/RPC), but tagged for a
        # dedicated queue group so we can add a special "netbox-only"
        # pull path later if traffic warrants.
        NetboxSyncDeviceTask(),
        NetboxSyncAllTask(),
    ]
}
