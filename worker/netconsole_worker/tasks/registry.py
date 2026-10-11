"""Task definitions — vendor-agnostic dispatch.

Each task class wraps a `select_backend(device)` call and forwards to
the matching `DeviceBackend` method. The result shape is identical to
what the previous (vendor-hardcoded) implementation produced, so
the frontend + DB row writers don't need to change.

Vendor dispatch logic lives in `netconsole_worker.vendor`. Backends
live in `netconsole_worker.backends.{juniper,eos,iosxe,nxos}`.
"""

from __future__ import annotations

import logging
from typing import Any

from netconsole_worker.models import DeviceInfo, JobInfo
from netconsole_worker.tasks.base import BaseTask
from netconsole_worker.tasks.managed_check import ManagedCheckTask
from netconsole_worker.tasks.netbox_sync import NetboxSyncAllTask, NetboxSyncDeviceTask
from netconsole_worker.vendor import select_backend

logger = logging.getLogger(__name__)


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
        Supports three payload shapes:

        1. Legacy single-action:
           { action, interface, vlan?, description? }
           → backend parses InterfaceActionPayload.action and dispatches.

        2. Same-interface multi-action (atomic on the device):
           { interface, actions: [{action, ...}, ...] }
           → one backend.interface_action_multi() call, ONE device commit.

        3. Cross-interface multi-action (new):
           { actions: [{interface, action, ...}, ...] }
           → worker groups subactions by interface (in declaration order),
           calls backend.interface_action_multi() once per interface group.
           Each group lands atomically on its own interface; groups commit
           sequentially. No top-level `interface` field required.

        All shapes go through the same single `interface_action` (legacy)
        or `interface_action_multi` (multi) backend methods — the cross-
        interface shape is just "same-interface multi-action" applied once
        per distinct interface.

        Reject contradictory batches per interface (e.g. shut + no-shut)
        with a clear error so the operator gets a useful message instead
        of "commit failed with X syntax error".
        """
        payload = job.payload or {}
        top_iface = str(payload.get("interface") or "").strip()

        subactions_raw = payload.get("actions")
        if isinstance(subactions_raw, list) and len(subactions_raw) > 0:
            return self._run_multi_action(device, top_iface, subactions_raw)

        # Legacy single-action path
        if not top_iface:
            raise RuntimeError("Missing 'interface' in job payload (single-action requires top-level interface)")
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
            iface=top_iface,
            vlan=str(vlan) if vlan is not None else None,
            description=effective_description,
        )

    def _run_multi_action(
        self,
        device: DeviceInfo,
        top_iface: str,
        subactions_raw: list[object],
    ) -> dict[str, Any]:
        """
        Multi-action dispatcher. Three sub-modes:

        - All subactions target the same interface (top-level `interface`
          covers them, or all have the same `interface` field):
          ONE backend.interface_action_multi() call → ONE device commit.

        - Subactions target multiple interfaces (cross-interface batch):
          group by interface (declaration order), call
          interface_action_multi() once per group, return a per-group
          result envelope. Each group is atomic on its own interface;
          groups commit sequentially.

        For Junos, each group is one `<load-configuration>` + one
        `<commit-configuration>` pair (~17s RESTCONF). The whole job is
        still ONE confirmation in the UI.
        """
        # 1) Parse + validate the batch. Each subaction resolves to
        #    (interface, action, fields) and gets a normalised dict.
        resolved: list[tuple[str, dict[str, object]]] = []
        for i, raw in enumerate(subactions_raw):
            if not isinstance(raw, dict):
                raise RuntimeError(f"actions[{i}] is not an object")
            sub_iface = raw.get("interface")
            if isinstance(sub_iface, str) and sub_iface.strip():
                iface = sub_iface.strip()
            elif top_iface:
                iface = top_iface
            else:
                raise RuntimeError(
                    f"actions[{i}] has no 'interface' (provide top-level "
                    f"'interface' or per-subaction 'interface' for cross-interface batches)"
                )
            sa = self._normalize_subaction(iface, raw)
            resolved.append((iface, sa))

        if not resolved:
            raise RuntimeError("Empty actions list")

        # 2) Sanity cap. Backend allows up to 16 subactions total; we
        #    further cap to 8 distinct interfaces per job so the UI
        #    summary stays readable.
        distinct_ifaces = []
        for iface, _ in resolved:
            if iface not in distinct_ifaces:
                distinct_ifaces.append(iface)
        if len(distinct_ifaces) > 8:
            raise RuntimeError(
                f"Too many distinct interfaces in one batch ({len(distinct_ifaces)} > 8). "
                f"Split into multiple calls."
            )

        # 3) Group by interface (preserving declaration order).
        groups: list[tuple[str, list[dict[str, object]]]] = []
        seen: dict[str, int] = {}
        for iface, sa in resolved:
            if iface in seen:
                groups[seen[iface]][1].append(sa)
            else:
                seen[iface] = len(groups)
                groups.append((iface, [sa]))

        # 4) Per-group contradictory validation. Only shut+no-shut is
        #    contradictory (they negate each other).
        #    `delete-interface` mixed with `set-access-vlan` / `set-description`
        #    is FINE: in Junos the commands sequence in declaration order
        #    within one `<load-configuration>` load, so
        #    `delete interfaces X` followed by
        #    `set interfaces X unit 0 family ethernet-switching vlan members 201`
        #    produces a clean interface with just vlan 201. (The
        #    `delete ... vlan members` line that the smart-delete logic
        #    prepends for set-access-vlan becomes a no-op after the
        #    earlier delete, which Junos handles as a warning, not error.)
        for iface, subs in groups:
            actions = {s["action"] for s in subs}
            if "shut" in actions and "no-shut" in actions:
                raise RuntimeError(
                    f"Contradictory batch on {iface}: 'shut' and 'no-shut' in one commit"
                )

        backend = _backend(device)

        # 5) Single-interface fast path: one call, one commit.
        if len(groups) == 1:
            iface, subs = groups[0]
            multi = getattr(backend, "interface_action_multi", None)
            if multi is None:
                # Older backend without the new method — fall back to
                # running each subaction sequentially. NOT atomic.
                results = self._sequential_fallback(backend, device, iface, subs)
                return {
                    "implemented": True,
                    "source": "sequential",
                    "interface": iface,
                    "subActionCount": len(subs),
                    "subActions": subs,
                    "results": results,
                    "message": f"Multi-action fallback (sequential commits) on {iface} — backend lacks atomic multi method.",
                }
            return multi(device, iface=iface, subactions=subs)

        # 6) Cross-interface: one commit-group per interface, sequentially.
        per_group: list[dict[str, Any]] = []
        for iface, subs in groups:
            multi = getattr(backend, "interface_action_multi", None)
            if multi is None:
                results = self._sequential_fallback(backend, device, iface, subs)
                per_group.append({
                    "interface": iface,
                    "subActionCount": len(subs),
                    "subActions": subs,
                    "results": results,
                    "source": "sequential",
                })
            else:
                res = multi(device, iface=iface, subactions=subs)
                per_group.append({
                    "interface": iface,
                    "subActionCount": len(subs),
                    "subActions": subs,
                    "source": res.get("source"),
                    "message": res.get("message"),
                    "commands": res.get("commands"),
                    "loadMs": res.get("loadMs"),
                    "commitMs": res.get("commitMs"),
                    "raw": res.get("raw"),
                })
        return {
            "implemented": True,
            "source": "cross-interface",
            "interfaceCount": len(groups),
            "interfaces": [g[0] for g in groups],
            "subActionCount": len(resolved),
            "groups": per_group,
            "message": (
                f"Cross-interface multi-action OK on {len(groups)} interface(s), "
                f"{len(resolved)} subaction(s) total. Each interface's subactions "
                f"landed in 1 commit on that interface; groups committed sequentially."
            ),
        }

    def _sequential_fallback(
        self,
        backend: Any,
        device: DeviceInfo,
        iface: str,
        subs: list[dict[str, object]],
    ) -> list[dict[str, Any]]:
        """Sequential single-action fallback (NOT atomic)."""
        results: list[dict[str, Any]] = []
        for sa in subs:
            results.append(
                backend.interface_action(
                    device,
                    action=str(sa["action"]),
                    iface=iface,
                    vlan=str(sa.get("vlan", "")) if sa.get("vlan") is not None else None,
                    description=str(sa.get("description", "")) if sa.get("description") is not None else None,
                )
            )
        return results

    def _normalize_subaction(
        self,
        iface: str,
        raw: dict[str, object],
    ) -> dict[str, object]:
        """Mirror parseInterfaceActionPayload's parseSubAction in TS.

        The `interface` arg here is the RESOLVED interface for this
        subaction (either from the per-subaction field or hoisted from
        the top level). We don't store it back into the normalised dict
        because the worker groups by it before calling the backend.
        """
        action = raw.get("action")
        if not isinstance(action, str) or action not in {
            "shut", "no-shut", "set-access-vlan", "set-description",
            "remove-description", "delete-interface",
        }:
            raise RuntimeError(f"Invalid subaction action: {action!r}")
        out: dict[str, object] = {"action": action, "_iface": iface}
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


class CliCommandTask(BaseTask):
    """Run an arbitrary vendor CLI command on a device.

    Added 2026-10-11 to back the AI assistant's `run_cli_command` tool.
    The assistant surface area (show route, show ospf neighbor, show
    cdp, clear counters, request system reboot, ...) maps cleanly to
    ONE generic job type rather than 20+ specialised ones — the LLM
    is responsible for picking the right vendor syntax.

    Payload shape:

        {
            "command":  "show ospf neighbor",
            "write":    false,                // optional, default false
        }

    For `write=True` the backend tool gates enqueue behind a
    confirmation card; the worker just runs whatever the LLM asked
    for, so the gate is at the assistant layer, not here.

    Returns the full backend result (output text, source, exitCode,
    error, truncated). The raw `output` is capped at 8 KB by
    `DeviceBackend.run_cli_command` to keep the assistant preview
    LLM-friendly; Job.result keeps the full string for the
    /api/jobs UI.

    If the (vendor, command) pair is in the small structured-parse
    allowlist (see `netconsole_worker.parsers.textfsm_parse`), the
    result also carries `parsed.rows` (list of dicts with normalised
    field names) so the LLM can pick fields without re-parsing the
    text. Allowlist is intentionally small — see
    `docs/agents/14-vendor-cli-commands.md` §6.
    """

    job_type = "CLI_COMMAND"

    def run(self, job: JobInfo, device: DeviceInfo) -> dict[str, Any]:
        payload = job.payload or {}
        command = str(payload.get("command") or "").strip()
        if not command:
            raise RuntimeError("CLI_COMMAND payload.command is empty")
        write = bool(payload.get("write") or False)
        result = _backend(device).run_cli_command(device, command, write=write)

        # Optional structured parse via ntc-templates (textfsm).
        # Best-effort — if the parser isn't installed, the command
        # isn't in the allowlist, or the template drifts between
        # ntc-templates versions, we silently fall back to the raw
        # text and let the LLM parse it.
        if result.get("implemented") and not result.get("error"):
            try:
                from netconsole_worker.parsers.textfsm_parse import try_parse
                parsed = try_parse(
                    device.vendor or "",
                    command,
                    result.get("output", "") or "",
                )
                if parsed is not None:
                    result["parsed"] = parsed
            except Exception:  # noqa: BLE001 — parser failures must not break the job
                logger.debug(
                    "textfsm parse failed for %s %s; falling back to raw text",
                    device.name, command, exc_info=True,
                )
        return result


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
        # Generic vendor CLI exec — backs the assistant's
        # `run_cli_command` tool. Keep this AFTER the specialised
        # collectors so a future per-command override (e.g. a
        # RESTCONF fast-path for `show route`) wins on name match
        # if we ever split it out.
        CliCommandTask(),
        # NetBox sync — periodic + on-demand (see services/scheduler in
        # backend). Not interactive (no SSH/RPC), but tagged for a
        # dedicated queue group so we can add a special "netbox-only"
        # pull path later if traffic warrants.
        NetboxSyncDeviceTask(),
        NetboxSyncAllTask(),
    ]
}
