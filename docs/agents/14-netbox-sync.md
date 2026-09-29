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
