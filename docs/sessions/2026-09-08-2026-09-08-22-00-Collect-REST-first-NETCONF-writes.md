### 22:00 -- Config Studio Collect: REST-first read ops, NETCONF for writes

**User request (recap):** "Collect buttons still broken. Make all read ops
(ARP, MAC, interfaces status, show run) go through REST API directly. Only
config ops (interface config, shut/no-shut, VLAN) go through NETCONF."

**Why:** The previous priority fix (16019cc) only addressed the "Device busy"
contention but still left Collect depending on a 20s frontend poll that timed
out under load. The user wants reads to be a single round-trip, with writes
keeping the queue/audit trail.

**Architecture decision (new rule):**

| Operation | Path |
| --- | --- |
| GET_ARP / GET_MAC / GET_INTERFACES (collect) | backend → device RESTCONF → write SUCCESS job → return 200 |
| GET_CONFIG (collect running-config) | already direct (backend `fetchConfigurationSet` for Juniper, SSH-via-worker for IOS-XE — unchanged) |
| APPLY_CONFIG / ROLLBACK_CONFIG / INTERFACE_ACTION | job queue → worker NETCONF (Juniper) or NETCONF/SSH (IOS-XE) |

**Backend changes:**

- `backend/src/services/junosRest.ts` — added 3 new REST helpers:
  - `fetchArpTable(host)` → GET `/rpc/get-arp-table-information`, parse
    `<arp-table-entry>` blocks.
  - `fetchMacTable(host)` → GET `/rpc/get-ethernet-switching-table-information`,
    parse `<l2ng-l2-mac-address>` blocks.
  - `fetchInterfaceList(host)` → GET `/rpc/get-interface-information`,
    parse terse rows (much faster than full XML).
  - New helpers: `xmlChildText`, `xmlChildrenOf`, `normalizeMac`,
    `flagToType`, `parseArpTableXml`, `parseMacTableXml`,
    `parseTerseLine`.

- `backend/src/services/iosxeRest.ts` — **NEW file**. RESTCONF client:
  - `fetchIosxeArpTable(host)` → GET `/restconf/data/Cisco-IOS-XE-arp-oper:arp-data`.
    Returns `ok: false` if YANG empty (lab image bug — must use SSH fallback).
  - `fetchIosxeMacTable(host)` → always returns `ok: false` (no YANG for MAC).
  - `fetchIosxeInterfaceList(host)` → GET `/restconf/data/ietf-interfaces:interfaces`.
    Sparse on lab images but usable.

- `backend/src/services/arpAddress.ts` — added `collectArpForDevice()`:
  - Juniper: call `fetchArpTable()`, write SUCCESS job.
  - IOS-XE:   call `fetchIosxeArpTable()`, write SUCCESS job if non-empty,
              else fall through to queue.
  - Other:    queue.

- `backend/src/services/macAddress.ts` — added `collectMacForDevice()`:
  - Juniper: call `fetchMacTable()`, write SUCCESS job.
  - IOS-XE:   always queue (no YANG).
  - Other:    queue.

- `backend/src/services/interfaces.ts` — added `collectInterfacesForDevice()`:
  - Juniper: call `fetchInterfaceList()`, write SUCCESS job.
  - IOS-XE:   call `fetchIosxeInterfaceList()`, write SUCCESS job if non-empty.
  - Other:    queue.

- `backend/src/routes/deviceOperations.ts` — POST `/:id/arp` and `/:id/mac`
  now call the new REST-first functions. Returns 200 (REST hit) or 202
  (queued fallback).

- `backend/src/routes/interfaces.ts` — POST `/:deviceId/collect` calls
  `collectInterfacesForDevice()`. Removed unused `queueGetInterfaces` import.

- `docker-compose.app.yml` — added `IOSXE_API_*` env vars to backend service
  (already on worker). Backend now talks to IOS-XE RESTCONF directly.

**Frontend changes:**

- `frontend/src/pages/DeviceDetailPage.tsx` — `handleCollect` for ARP/MAC
  no longer polls `waitForJob`. Calls `triggerDeviceArp`/`triggerDeviceMac`,
  waits 300 ms for DB commit, re-fetches. Removed `waitForJob` and
  `JobWaitTimeoutError` branches.

- `frontend/src/features/ports/PortsPanel.tsx` — `load({collect:true})` no
  longer polls `waitForJob`. Calls `collectDeviceInterfaces()`, waits 300 ms,
  re-fetches. Write actions (shut/no-shut/VLAN/show-run) still poll — kept
  `JobWaitTimeoutError` import for that path.

- `frontend/src/api/interfaces.ts` — `collectDeviceInterfaces()` return type
  changed from `{ job, message? }` to `{ job, queued }`.

**Verification:**

- `cd backend && npm run build` → ✅ no TS errors
- `cd frontend && npm run build` → ✅ no TS errors, 10s build time
- Manual end-to-end test on VPS pending deploy (no deploy step taken in
  this session — code is ready to commit & push).

**Open follow-ups (not started):**

- Bulk-many-device Collect (NetworkTablesPage, LogsPage) still uses
  `queueArpCollection()` etc. — can be made parallel-REST for a noticeable
  speedup but not in scope this session.
- Backend REST-first path needs ENV validation on the backend container to
  make sure IOSXE_API_ENABLED and JUNOS_REST_ENABLED are actually picked up
  on next deploy (already in compose, just verify after deploy).
