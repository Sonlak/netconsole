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
        payload = job.payload or {}
        action = str(payload.get("action") or "").strip()
        iface = str(payload.get("interface") or "").strip()
        vlan = payload.get("vlan")
        description = payload.get("description")
        return _backend(device).interface_action(
            device,
            action=action,
            iface=iface,
            vlan=str(vlan) if vlan is not None else None,
            description=str(description) if description is not None else None,
        )


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
    ]
}
