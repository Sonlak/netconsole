# STATE.md — Working Memory

> **Read this FIRST** when picking up the project. Tells you exactly what was
> being worked on, what's blocking, and what the next agent should do.
> **Overwritten** when a task ends; current state always lives here.

---

## Last updated: 2026-09-09 09:50 (UTC+7)

## In-progress task

**Juniper `interface_action` fix: done, ready to deploy.**

Files changed (all in `worker/`):
- `netconsole_worker/junos_netconf.py` — added `fetch_interface_configuration()` and
  `fetch_full_configuration()` NETCONF helpers; fixed `_parse_ok_error()` to
  return True for `<get-configuration>` replies (they have `<configuration>` not `<ok>`).
- `netconsole_worker/parsers/configuration_rpc.py` — added `xml_to_set_format()` (XML
  → set-format converter) + `netconf_get_configuration_to_set()` +
  `_is_noise_output()` noise filter.
- `netconsole_worker/backends/juniper.py` — rewrote `interface_action()`:
  - **show-run**: RESTCONF scoped → NETCONF scoped → NETCONF full → SSH CLI.
  - **writes (shut/no-shut/set-access-vlan)**: NETCONF SSH → RESTCONF → SSH CLI.
  - Mirrors `apply_config` / `rollback_config` pattern (commit 212fbd9).

Routing summary (all Juniper port ops):
| Action | Path 1 | Path 2 | Path 3 |
|--------|--------|--------|--------|
| show-run | RESTCONF | NETCONF SSH | SSH CLI |
| shut / no-shut / set-access-vlan | **NETCONF SSH** | RESTCONF | SSH CLI |

- **Architecture rule (new, this commit)**:
  - **Collect (read)**: ARP, MAC, interfaces status, show run → backend calls
    device RESTCONF directly, writes a SUCCESS job row, returns immediately.
    No job queue, no 20s poll timeout, no "Device busy".
  - **Config ops (write)**: apply_config, rollback_config, shut/no-shut port,
    set-access-vlan → still go through job queue, worker uses NETCONF SSH
    (Juniper) or NETCONF primary / SSH fallback (IOS-XE).
- **Vendor routing** (backend decides per device.vendor):
  - Juniper: `JunosRESTPool`-style RESTCONF via `backend/services/junosRest.ts`
    (port 8443 for config, ARP/MAC/interfaces; port 830 NETCONF only on worker).
  - IOS-XE:   RESTCONF via new `backend/services/iosxeRest.ts` for ARP and
    interfaces (YANG). Falls back to worker SSH for MAC (no YANG).
  - Other:    job queue (worker handles vendor-specific).
- **Frontend** (`DeviceDetailPage.tsx`, `PortsPanel.tsx`):
  - Removed `waitForJob()` / `JobWaitTimeoutError` polling from ARP/MAC/
    interfaces Collect buttons. They call `triggerDeviceArp()` etc., wait
    300 ms for DB commit, re-fetch.
  - Write actions (shut/no-shut, set-access-vlan, show-run) still poll job.

## Blockers

(None — code complete, builds pass. Awaiting user review / deploy.)

## Next agent pickup notes

If user opens a new chat and asks something, here's what to know without
re-reading the codebase:

1. **NEW: Read vs Write routing** (this commit):
   - `POST /api/devices/:id/{config,arp,mac}` → backend REST-first for
     Juniper, IOS-XE ARP/interfaces. Falls back to job queue (worker) if
     REST fails or returns empty.
   - `POST /api/interfaces/:id/collect` → backend REST-first (same path).
   - `POST /api/interfaces/:id/actions` → always job queue (NETCONF/SSH).
   - `POST /api/jobs` (legacy direct-enqueue endpoints) → unchanged.
   - File touchpoints:
     - `backend/src/services/junosRest.ts` — added `fetchArpTable`,
       `fetchMacTable`, `fetchInterfaceList` (+ XML parsers).
     - `backend/src/services/iosxeRest.ts` — NEW file. IOS-XE RESTCONF
       client (`fetchIosxeArpTable`, `fetchIosxeInterfaceList`,
       `fetchIosxeMacTable` returns `ok:false` — no YANG).
     - `backend/src/services/arpAddress.ts` — added `collectArpForDevice()`.
     - `backend/src/services/macAddress.ts` — added `collectMacForDevice()`.
     - `backend/src/services/interfaces.ts` — added `collectInterfacesForDevice()`.
     - `backend/src/routes/deviceOperations.ts` — POST `/arp`, `/mac` now
       call new REST-first functions.
     - `backend/src/routes/interfaces.ts` — POST `/collect` now calls new
       REST-first function.
     - `docker-compose.app.yml` — added `IOSXE_API_*` env to backend service.
     - `frontend/src/pages/DeviceDetailPage.tsx` — Collect (ARP/MAC)
       simplified; no job polling.
     - `frontend/src/features/ports/PortsPanel.tsx` — Collect (interfaces)
       simplified; no job polling. Write actions unchanged.
     - `frontend/src/api/interfaces.ts` — `collectDeviceInterfaces()` now
       returns `{ job, queued: boolean }`.

2. **NETCONF SSH status** (commit 212fbd9, unchanged):
   - 4/6 Junipers use NETCONF SSH directly for write: LAB-F2-AS-01,
     LAB-F6-CORE-01, LAB-F6-CORE-02, LAB-F6-DS-01.
   - 2/6 fall back to RESTCONF: LAB-F3-AS-01, LAB-F6-DS-02.

3. **IOS-XE config path** (commit 60b7e4c, unchanged):
   - For show running-config collect: SSH `show running-config` text
     (worker still does this — backend collect_config uses `fetchConfigurationSet`
     only on Juniper).
   - For interface_action (shut/no-shut/set-access-vlan): worker uses
     NETCONF primary, SSH fallback. This commit does NOT change that.

4. **Frontend poll budget** (unchanged):
   - 20s frontend poll only used for write actions now. Read collects no
     longer poll — they wait 300 ms and refetch.
   - 90s poll for shut/no-shut actions, 45s for managed check (unchanged).

5. **Open TODOs** (unchanged):
   - `mustChangePassword` redirect not wired.
   - Rollback schema-drift.
   - Off-host backup.
   - Per-device vendor credentials (Phase 2).
   - Bulk-config safety net.
   - `netconfFallbackError` visible to operator in Logs UI.

## When to update this file

- **Starting a task** → add 1-line note under "In-progress task" with intent.
- **Hitting a blocker** → add to "Blockers" with reason.
- **Finishing a task** → write session log entry in `docs/sessions/` then
  clear this section.