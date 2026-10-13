# NetBox integration — periodic device sync

NetConsole → NetBox sync. Phase 1 (device-level). Lộ trình chi tiết xem
`docs/agents/14-netbox-sync.md` (sẽ tạo sau nếu cần).

## Files added

```
docker-compose.netbox.yml           # NetBox stack (postgres + redis + netbox)
lab/netbox/init/01-init.py          # Tạo API token + custom field + tag
worker/netconsole_worker/clients/netbox.py   # httpx wrapper cho NetBox REST
worker/netconsole_worker/tasks/netbox_sync.py # NETBOX_SYNC_DEVICE / _ALL tasks
backend/src/services/netboxSync.ts  # Periodic scheduler (setInterval-based)
```

## Files modified

```
backend/prisma/schema.prisma                 # +netboxDeviceId, +netboxSyncedAt,
                                              #  +netboxSyncError, +JobTypes
backend/src/index.ts                         # wire scheduleNetboxSync() + env
backend/src/routes/jobs.ts                   # POST /api/jobs/netbox-sync-all,
                                              #  +complete handler lưu netboxDeviceId
backend/src/routes/deviceOperations.ts       # POST /api/devices/:id/sync-netbox
worker/netconsole_worker/tasks/registry.py   # register NetboxSyncDeviceTask / NetboxSyncAllTask
worker/netconsole_worker/models.py           # parse_job() chịu được job không có device
worker/netconsole_worker/config.py           # +netbox_url, +netbox_token
docker-compose.app.yml                       # +NETBOX_URL/TOKEN, +NETBOX_SYNC_INTERVAL_SECONDS
                                              #  +placeholder netbox service cho -f merge
```

## Quick start (test local)

```bash
# 1. Khởi động NetBox
docker compose -f docker-compose.netbox.yml up -d

# 2. Đợi ~60s cho lần boot đầu (migrations + superuser + init script).
#    Lấy API token:
docker logs netbox-netbox 2>&1 | Select-String "API token set"

# 3. Mở browser: http://localhost:8001  (admin / Admin@123)

# 4. Build + chạy NetConsole stack (chỉnh env trong docker-compose.app.yml
#    nếu cần thay đổi NETBOX_URL / NETBOX_TOKEN):
docker compose -f docker-compose.app.yml -f docker-compose.netbox.yml up -d --build

# 5. Sau ~30s scheduler sẽ chạy cycle đầu tiên, tạo NETBOX_SYNC_ALL job.
#    Check log backend:
docker logs netconsole-backend 2>&1 | Select-String "netbox-sync"

# 6. Trigger thủ công 1 device:
curl.exe -X POST http://localhost:3000/api/devices/<device-id>/sync-netbox `
  -H "Authorization: Bearer <jwt>"
```

## NetBox data model mapping

| NetConsole | NetBox |
|---|---|
| `Device.id` (UUID) | `custom_field netconsole_id` (text) |
| `Device.name` | `Device.name` |
| `Device.site` (string) | `Site` (auto-created, slug=lowercase(name)) |
| `Device.vendor` (string) | `Manufacturer` (auto-created, name=Title-case) |
| `Device.model` (string) | `DeviceType.model` (auto-created per manufacturer) |
| `Device.partNumber` (string) | `DeviceType.part_number` |
| `Device.serial` (string) | `Device.serial` |
| `Device.status` (enum) | `Device.status` (active/offline/maintenance/planned) |
| `Device.ip` (string) | `Device.oob_ip` (mgmt IP — Phase 2 sẽ tạo IP address object) |
| `Device.description` | `Device.description` |
| `Device.version` | `Device.comments` (ghi chú thêm) |
| — | `Tag: source-netconsole` (gắn lên tất cả object sync từ NetConsole) |

## Job types

| JobType | Created by | Worker does |
|---|---|---|
| `NETBOX_SYNC_DEVICE` | `POST /api/devices/:id/sync-netbox` | Upsert 1 device |
| `NETBOX_SYNC_ALL` | `scheduleNetboxSync()` (mỗi `NETBOX_SYNC_INTERVAL_SECONDS`) | Lặp qua tất cả devices, upsert từng cái |

Cả 2 đều dùng `custom_field netconsole_id` làm khóa idempotent. PATCH nếu đã
có, POST nếu chưa. NetBox device id lưu lại trên NetConsole `Device.netboxDeviceId`
sau khi sync thành công — cycle sau sẽ skip lookup.

## Env vars

| Var | Default | Note |
|---|---|---|
| `NETBOX_SYNC_INTERVAL_SECONDS` | `0` (disabled) | Set > 0 để bật scheduler |
| `NETBOX_URL` | `http://netbox-netbox:8080/api/` | Bao gồm cả `/api/` |
| `NETBOX_TOKEN` | dev token literal | Token từ `lab/netbox/init/01-init.py` |

Đặt cả 3 cùng lúc trong `docker-compose.app.yml` cho cả `backend` lẫn `worker`.

## Idempotency

- Lookup theo `cf_netconsole_id` (custom field) → PATCH nếu có
- Fallback: `serial` (cho device tạo trước khi có custom field)
- Lưu NetBox device id vào `Device.netboxDeviceId` để cycle sau skip lookup
- Tag `source-netconsole` gắn lên tất cả object — filter được trong NetBox UI

## Production notes

- **Token rotation**: dev token hard-coded trong `lab/netbox/init/01-init.py`.
  Đổi literal + redeploy init script. Hoặc `docker exec netbox-netbox
  python manage.py drf_create_token admin` rồi update env.
- **HTTPS**: compose local dùng HTTP. Production nên dùng HTTPS + NetBox
  `ALLOWED_HOSTS` whitelist.
- **Volume backup**: `netbox_pgdata` chứa toàn bộ NetBox DB. Thêm backup
  job cùng với `backup_postgres.sh` đang có.
- **Scaling**: khi fleet > 200 devices, đổi từ `NETBOX_SYNC_ALL` (1 job, loop
  tuần tự) sang enqueue `NETBOX_SYNC_DEVICE` per device (parallel). Phase 2.

## Known limitations (Phase 1)

- IP address chỉ sync `oob_ip` (string), chưa tạo `ipam.ip-addresses` object.
  Cần bảng `DeviceInterface` (chưa có) → Phase 2.
- Không sync `interface` table, MAC table, VLAN, prefix, v.v. → Phase 2+.
- Không có reconcile ngược (NetBox → NetConsole). Một chiều. Phase 4.
- Không có UI button "Sync to NetBox" trong frontend. Backend endpoint
  + `POST /api/jobs/netbox-sync-all` đã có; frontend button là Phase 2.

## Phase 2 (added 2026-10-13) — NetBox READ từ AI assistant + REST routes

Phase 1 là **push** (NetConsole → NetBox). Phase 2 thêm **query** (assistant
và frontend có thể đọc NetBox qua API). Worker vẫn là chỗ duy nhất mutate
NetBox; backend client chỉ GET.

### Files added

```
backend/src/services/netboxClient.ts   # Read-only HTTP client (in-process)
backend/src/routes/netbox.ts            # REST routes /api/netbox/*
```

### Files modified

```
backend/src/services/assistant/types.ts     # +11 tool names (1 sync_status + 10 netbox reads)
backend/src/services/assistant/prompts.ts   # +11 catalog entries + SYSTEM_PROMPT section
backend/src/services/assistant/handlers.ts  # +11 handler functions + HANDLERS dispatch
backend/src/index.ts                        # wire netboxRouter + /api/netbox
backend/tests/services/assistant/handlers.test.ts  # +18 tests (139 total)
```

### Backend NetBox client (READ-only)

`backend/src/services/netboxClient.ts` mirror pattern của `keaDhcp.ts`:
- `netboxGet<T>()` — internal fetch wrapper, timeout 15s, `Token {NETBOX_TOKEN}` auth
- `NetBoxError` — extends `Error`, surface HTTP status + body
- Endpoints: `/dcim/sites/`, `/dcim/device-roles/`, `/dcim/manufacturers/`,
  `/dcim/devices/`, `/dcim/interfaces/`, `/ipam/vlans/`, `/ipam/prefixes/`,
  `/ipam/ip-addresses/`, `/status/` (health)
- Tất cả return typed result (không cast sang `any`)
- Không có POST/PATCH/DELETE — write vẫn chỉ qua worker

Env: `NETBOX_URL`, `NETBOX_TOKEN` (đã có sẵn cho worker — set trong
`docker-compose.app.yml` cho backend service luôn), `NETBOX_TIMEOUT_MS`
(default 15000).

### REST routes (`/api/netbox/*`)

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/api/netbox/health` | `{ok, url}` — connectivity check | VIEWER+ |
| GET | `/api/netbox/sites` | list sites, `?limit=200` | VIEWER+ |
| GET | `/api/netbox/device-roles` | list device-roles | VIEWER+ |
| GET | `/api/netbox/manufacturers` | list manufacturers | VIEWER+ |
| GET | `/api/netbox/devices` | list devices, filter `?site=&role=&status=&search=&netconsole_id=&manufacturer_id=&tag=&limit=&offset=` | VIEWER+ |
| GET | `/api/netbox/devices/:nbid` | get one device by NetBox id | VIEWER+ |
| GET | `/api/netbox/devices/:nbid/interfaces` | list interfaces, `?limit=500` | VIEWER+ |
| GET | `/api/netbox/vlans` | list VLANs, `?site=&limit=` | VIEWER+ |
| GET | `/api/netbox/prefixes` | list IPAM prefixes, `?site=&status=&limit=` | VIEWER+ |
| GET | `/api/netbox/ip-addresses` | list IPs, `?netbox_device_id=&status=&search=&limit=` | VIEWER+ |
| GET | `/api/netbox/sync-status` | sync state per device (từ NetConsole DB), `?device_id=&site=&device_name=` | VIEWER+ |

Lỗi NetBox 4xx/5xx → 502 với `{error: "NetBox HTTP 502: ..."}`. Lỗi 401 → kiểm tra
token. Lỗi 404 trên `/devices/:nbid` → 404 (khác với 502 — `getNetboxDeviceById`
đã tự xử lý).

### AI assistant tools (READ, không cần confirm)

11 tools mới, tất cả `requiresRole: 'VIEWER'`, `readonly: true`:

| Tool name | Args | Trả về |
|---|---|---|
| `get_netbox_health` | — | `{ok, url, message}` |
| `list_netbox_sites` | `limit` | sites với id/name/slug/status/tags |
| `list_netbox_device_roles` | — | roles với id/name/slug/color |
| `list_netbox_manufacturers` | — | manufacturers với id/name/slug |
| `list_netbox_devices` | `site, role, status, manufacturer_id, search, tag, netconsole_id, limit, offset` | `{total, returned, offset, devices[]}` — full record + `netconsoleId` custom field |
| `get_netbox_device` | `id?, netconsole_id?, name?` (1 trong 3) | `{found, device}` — id exact, netconsole_id exact match, name full-text (top 5) |
| `list_netbox_interfaces` | `netbox_device_id` (BẮT BUỘC), `only_up?, only_down?` | `{netboxDeviceId, total, returned, interfaces[]}` — speed auto-convert sang Mbps |
| `list_netbox_vlans` | `site?, limit?` | `{total, vlans[]}` — vid/name/site/group |
| `list_netbox_prefixes` | `site?, status?, limit?` | `{total, prefixes[]}` — prefix/site/vrf/utilization |
| `list_netbox_ip_addresses` | `netbox_device_id?, status?, search?, limit?` | `{total, addresses[]}` — address/dnsName/assignedTo{target device+iface} |
| `get_netbox_sync_status` | `device_name?, device_id?, site?, only_unsynced?, only_failed?, limit?` | `{summary: {total, synced, pending, failed}, devices[]}` — **đọc NetConsole DB, KHÔNG gọi NetBox API** |

Lưu ý data source:
- 10 tools đầu gọi NetBox REST API trực tiếp (in-process, không qua worker)
- `get_netbox_sync_status` đọc NetConsole DB (Prisma) — trả lời "NetConsole
  device nào đã/đang/lỗi sync NetBox" mà không cần NetBox trả lời

### Ví dụ sử dụng từ assistant

User hỏi: "Thiết bị F2-AS-01 trong NetBox có bao nhiêu port?"

```
1. get_netbox_device({name: "F2-AS-01"})            → {found: 1, device: {id: 7, ...}}
2. list_netbox_interfaces({netbox_device_id: 7})    → {total: 24, interfaces: [...]}
```

User hỏi: "Site NKKN có bao nhiêu switch Juniper active trong NetBox?"

```
1. list_netbox_devices({site: "nkkn", status: "active"})  → {total: 12, devices: [...]}
   # filter Juniper ở client side: devices.filter(d => d.manufacturer === "Juniper")
```

User hỏi: "Sync NetBox lần cuối lúc nào, có thiết bị nào lỗi?"

```
1. get_netbox_sync_status({only_failed: true})     → {summary: {failed: 2}, devices: [...]}
```

### Tests

`backend/tests/services/assistant/handlers.test.ts` thêm 18 test (139 total, 0 fail):
- `get_netbox_health` (2): reachable + unreachable
- `list_netbox_sites` (2): success + NetBox error
- `list_netbox_devices` (1): filter passthrough + compact shape
- `get_netbox_device` (4): by id, not-found, by netconsole_id, by name search, missing-arg reject
- `list_netbox_interfaces` (2): required-arg + speed convert + only_up filter
- `list_netbox_vlans` (1), `list_netbox_prefixes` (1), `list_netbox_ip_addresses` (2: with/without assignment)
- `get_netbox_sync_status` (2): summary + only_failed filter

### Known limitations (Phase 2)

- READ-only: không thể CREATE/UPDATE/DELETE qua assistant. Phải qua worker
  sync job (NetConsole → NetBox). Phase 3+ có thể add write tools (vd tạo
  site, tạo prefix) nếu user confirm cần.
- Chưa có frontend UI cho `/api/netbox/*`. Phase tiếp: thêm tab "NetBox"
  ở SettingsPage hoặc DevicesPage để xem sync status + drill-down.
- Reverse sync (NetBox → NetConsole) vẫn chưa có. Phase 4.
