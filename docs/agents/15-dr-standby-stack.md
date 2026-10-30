# Phase 3 -- Kea DC↔DR Standby Stack (IMPLEMENTED 2026-10-17)

> **⚠️ OBSOLETE — 2026-10-30.** Kea was removed entirely and DHCP now runs on
> the distribution switch (Junos extended DHCP local server). There is **no
> HA**: no Kea container, no control agent, no DC↔DR pair, no auto-failback
> scheduler, no `kea-dr1` host. This file is kept for historical context
> only.
>
> **The current design lives in `docs/agents/20-dhcp-on-switch.md`** and in
> `backend/src/services/junosDhcp.ts`.
>
> **Mục tiêu (historical)**: Mô hình 1+1 hot-standby giữa DC (kea-dc1) và DR (kea-dr1).
> Active ở DC, standby ở DR. Có scheduler auto-failback khi DC recover.
> **Backend (NetConsole) chạy ở DC**, giao tiếp với DR qua Tailscale.

## Topology thực tế

```
                          ┌────────────────────────────┐
                          │      DC VPS (Tailscale)    │
                          │     100.102.133.86         │
                          │     Public: 42.119.165.109 │
                          │                            │
                          │  ┌────────────────────┐    │
                          │  │ kea-dc1 (primary)  │    │ :67 on 10.10.20.20
                          │  │ 172.31.0.10        │    │ :8000 control
                          │  │ HA peer: kea-dr1   │    │
                          │  └────────┬───────────┘    │
                          │           │ Tailscale      │
   ┌──────────┐            │           │ tunnel         │
   │  Router/ │ helper     │           ▼                │
   │  Switch  │────────► 10.10.20.20:67                │
   │  (relay) │            │                            │
   │          │ helper     │  ┌────────────────────┐    │
   │          │────────► 10.10.20.30:67 ────► DR side │
   └──────────┘            │           ▲                │
                          │           │                │
                          │  ┌────────┴───────────┐    │
                          │  │ NetConsole backend │    │
                          │  │ 172.31.0.3         │────┤ queries both
                          │  │ Auto-failback      │    │ Kea control agents
                          │  │ scheduler          │    │
                          │  └────────────────────┘    │
                          │                            │
                          └────────────┬───────────────┘
                                       │ Tailscale tunnel
                                       │ (100.102.133.86 ↔ 100.105.166.18)
                                       │
                          ┌────────────▼───────────────┐
                          │      DR VPS (Tailscale)    │
                          │     100.105.166.18         │
                          │                            │
                          │  ┌────────────────────┐    │
                          │  │ kea-dr1 (standby)  │    │ :67 on 10.10.20.30
                          │  │ 172.31.0.11        │    │ :8000 control
                          │  │ HA peer: kea-dc1   │    │ (only binds :67
                          │  └────────────────────┘    │  after promote)
                          │                            │
                          └────────────────────────────┘
```

## IPs thật (production)

| Site | Host Tailscale | DHCP bind IP | Container IP | Notes |
|------|----------------|--------------|--------------|-------|
| DC   | 100.102.133.86 | 10.10.20.20  | 172.31.0.10  | Active (primary) |
| DR   | 100.105.166.18 | 10.10.20.30  | 172.31.0.11  | Standby → promote on DC fail |

## Files đã thay đổi (2026-10-17)

### Kea container
- `lab/kea/kea-dhcp4.conf.template` — single peer template (1+1), subnets inline, HA timing env-driven
- `lab/kea/entrypoint.sh` — thêm KEA_PEER_NAME/KEA_PEER_URL/KEA_PEER_ROLE env vars, thêm KEA_HEARTBEAT_DELAY_MS/KEA_MAX_RESPONSE_DELAY_MS/KEA_MAX_ACK_DELAY_MS

### Compose files
- `docker-compose.app.yml` — rename `kea-dhcp1` → `kea-dc1`, **remove** `kea-dhcp2` (local standby gone), peer URL → DR Tailscale, volume `kea_primary_leases` → `kea_dc_leases`
- `docker-compose.kea-dr.yml` — **NEW** — chạy trên DR VPS, single kea-dr1 container, peer URL → DC Tailscale

### Backend
- `backend/src/services/keaDhcp.ts` — thêm `getHaState()` (snapshot), `switchHaPartner()` (manual swap), `keaCommandBoth()` (parallel DC+DR queries). `DhcpHaPeer` thêm `site: 'DC' | 'DR'`. Backward-compat aliases `getPrimaryUrl`/`getStandbyUrl` giữ nguyên
- `backend/src/services/keaFailback.ts` — **NEW** — scheduler mỗi 30s, 4 stability gates (DC reachable + state hot-standby + DR active + DC stable 5min), cooldown 1h, in-memory status
- `backend/src/routes/dhcp.ts` — thêm `/api/dhcp/ha-state`, `/api/dhcp/switchover`, `/api/dhcp/auto-failback`, `/api/dhcp/auto-failback/check`
- `backend/src/index.ts` — wire scheduler, thêm kea env vars vào `/api/health`

### Frontend
- `frontend/src/types/dhcp.ts` — thêm `HaStateSnapshot`, `AutoFailbackStatus`, `SwitchoverResult`, `DhcpHa.site: 'DC'|'DR'`, `DhcpHa.active: 'DC'|'DR'|null`
- `frontend/src/api/dhcp.ts` — thêm `fetchHaState`, `setAutoFailback`, `triggerSwitchover`, `triggerAutoFailbackCheck`
- `frontend/src/components/dashboard/KeaHaCard.tsx` — **NEW** — full HA control panel (DC/DR blocks, auto-failback toggle, failback events, manual switchover button)
- `frontend/src/pages/DhcpPage.tsx` — replace inline Kea HA card với `<KeaHaCard />`
- `frontend/src/components/dashboard/KeaSummary.tsx` — update labels primary/standby → DC/DR

### Docs
- `docs/agents/15-dr-standby-stack.md` — file này (replace planning doc)
- `docs/agents/01-system-overview-workflow.md` — update diagram + service table
- `deploy.sh` — update service names (kea-dhcp1/2 → kea-dc1, container name → netconsole-kea-dc)
- `DEPLOYMENT.md` — same

## HA timing

```yaml
# Default in compose (tunable via env)
KEA_HEARTBEAT_DELAY_MS: 5000        # DC gửi heartbeat mỗi 5s
KEA_MAX_RESPONSE_DELAY_MS: 10000    # Sau 10s không có reply → nghi ngờ
KEA_MAX_ACK_DELAY_MS: 2000          # Ack delay cho lease-update
```

**Failover timeline (DC primary down):**
- T+0s: DC dies (container crash, host reboot, network partition)
- T+5s, T+10s, T+15s: DR heartbeat tới DC timeout (3 lần liên tiếp với 5s interval)
- T+15-30s: DR promote lên primary, bind :67 trên 10.10.20.30
- T+15-30s+: switch relay forward DHCP tới cả DC (no reply) + DR (reply) → client mới xin IP từ DR
- T+~5phút: ops rebuild DC container
- T+~5phút+5phút (stability): scheduler detect DC healthy + DR active → trigger ha-switch-partner
- T+~10phút: DC primary again, DR standby (1-3s swap gap, tất cả client OK)

## Auto-failback scheduler

```typescript
// backend/src/services/keaFailback.ts
const stabilityRequiredSeconds = envNumber('KEA_FAILBACK_STABILITY_SECONDS', 300);
const cooldownSeconds = envNumber('KEA_FAILBACK_COOLDOWN_SECONDS', 3600);
const checkIntervalSeconds = envNumber('KEA_FAILBACK_CHECK_INTERVAL_SECONDS', 30);
```

**Stability gates (tất cả phải đạt):**
1. DC reachable qua control agent (HTTP :8000)
2. DC's HA state = `hot-standby` (joined pair, synced lease DB)
3. DR is currently the active site (`activeSite === 'DR'`)
4. DC healthy continuously for `stabilityRequiredSeconds` (default 5 phút)
5. Cooldown `cooldownSeconds` (default 1 giờ) kể từ lần failback trước

**Env vars:**
- `KEA_AUTO_FAILBACK=true` — bật scheduler (default false, toggle qua API cũng được)
- `KEA_FAILBACK_STABILITY_SECONDS=300` — DC phải ổn định bao lâu trước khi failback
- `KEA_FAILBACK_COOLDOWN_SECONDS=3600` — minimum time giữa 2 lần failback
- `KEA_FAILBACK_CHECK_INTERVAL_SECONDS=30` — polling interval

## API endpoints

| Method | Path | Auth | Mô tả |
|--------|------|------|-------|
| GET    | /api/dhcp/ha-state                  | user | Snapshot HA state + auto-failback status |
| GET    | /api/dhcp/auto-failback             | user | Status của scheduler (in-memory) |
| POST   | /api/dhcp/auto-failback             | ADMIN | Toggle on/off (body: `{enabled: bool}`) |
| POST   | /api/dhcp/auto-failback/check       | ADMIN | Force check ngay (không đợi interval) |
| POST   | /api/dhcp/switchover                | ADMIN | Manual swap (body: `{currentPrimary: 'DC'|'DR'}`) |
| GET    | /api/health                         | — | Thêm `keaStandbyApiUrl`, `keaAutoFailback` |

## Deploy procedure

### DC VPS (production server — 100.102.133.86)

```bash
# 1. Pull latest code (auto via GitHub Actions on push to main)
ssh sonnx@100.102.133.86 "cd /opt/netconsole && git pull origin main"

# 2. Restart kea-dc1 với config mới
ssh sonnx@100.102.133.86 "cd /opt/netconsole && \
  docker compose -f docker-compose.app.yml up -d --force-recreate kea-dc1"

# 3. Verify kea-dc1 healthy
ssh sonnx@100.102.133.86 "docker inspect --format='{{.State.Health.Status}}' netconsole-kea-dc"
# → "healthy"

# 4. Verify HA state
ssh sonnx@100.102.133.86 "docker exec netconsole-kea-dc curl -s -X POST http://127.0.0.1:8000/ \
  -H 'Content-Type: application/json' \
  -d '{\"command\":\"ha-heartbeat\",\"service\":[\"dhcp4\"]}'"
# → should return state: "hot-standby" and partner's state

# 5. Restart backend (to load new code with auto-failback scheduler)
ssh sonnx@100.102.133.86 "cd /opt/netconsole && \
  docker compose -f docker-compose.app.yml up -d --force-recreate backend"
```

### DR VPS (DR server — 100.105.166.18)

```bash
# 1. SSH to DR
ssh sonnx@100.105.166.18

# 2. Install docker (nếu chưa có)
curl -fsSL https://get.docker.com | sh

# 3. Create /opt/kea-dr and copy files
sudo mkdir -p /opt/kea-dr/lab
# Copy from DC: docker-compose.kea-dr.yml + lab/kea/* (build context)
rsync -avz sonnx@100.102.133.86:/opt/netconsole/docker-compose.kea-dr.yml /opt/kea-dr/
rsync -avz sonnx@100.102.133.86:/opt/netconsole/lab/kea/ /opt/kea-dr/lab/kea/

# 4. Make sure 10.10.20.30 IP is bound on the host's lab NIC
#    (this depends on physical/virtual network config — not in scope for app code)
ip addr show | grep 10.10.20.30
# If missing, add it:
# sudo ip addr add 10.10.20.30/24 dev <lab-nic-name>

# 5. Start kea-dr1
cd /opt/kea-dr
docker compose -f docker-compose.kea-dr.yml up -d --build

# 6. Verify
docker inspect --format='{{.State.Health.Status}}' netconsole-kea-dr
docker logs netconsole-kea-dr | grep -i "ha\|heartbeat\|state"
```

### Switch DHCP relay (router/switch)

Configure DHCP helper-address trên cả 2 IP:

```
! Trên Cisco IOS switch L3 (ví dụ)
interface Vlan201
 ip helper-address 10.10.20.20
 ip helper-address 10.10.20.30
!
! Hoặc nếu dùng Juniper
set forwarding-options helpers bootp server 10.10.20.20
set forwarding-options helpers bootp server 10.10.20.30
```

## Verify HA đang hoạt động

### Test 1: Cả 2 đang chạy
```bash
# DC side
docker exec netconsole-kea-dc curl -s -X POST http://127.0.0.1:8000/ \
  -H 'Content-Type: application/json' \
  -d '{"command":"ha-heartbeat","service":["dhcp4"]}' | jq

# Expected: state="hot-standby" (DC's own role), partner state shown
```

### Test 2: Simulate DC fail
```bash
# Stop DC container
ssh sonnx@100.102.133.86 "docker stop netconsole-kea-dc"

# Wait ~20s, then check DR
ssh sonnx@100.105.166.18 "docker exec netconsole-kea-dr curl -s -X POST http://127.0.0.1:8000/ \
  -H 'Content-Type: application/json' \
  -d '{\"command\":\"ha-heartbeat\",\"service\":[\"dhcp4\"]}' | jq"

# Expected: state="partner-down" or "unavailable" (DR sees DC is gone, DR took over)
```

### Test 3: Restore DC, watch auto-failback
```bash
# Restart DC
ssh sonnx@100.102.133.86 "docker start netconsole-kea-dc"

# Wait 5+ minutes (stability window), then check backend logs
ssh sonnx@100.102.133.86 "docker logs netconsole-backend --since 10m | grep kea-failback"

# Expected: 
#   [kea-failback] DC is healthy ... stability timer reset
#   [kea-failback] Triggering ha-switch-partner on DR ...
#   [kea-failback] FAILBACK completed: DR → DC
```

## Failure modes & rollback

| Symptom | Cause | Fix |
|---------|-------|-----|
| Backend can't reach DR | Tailscale tunnel down | `tailscale status` on both hosts; restart if needed |
| Auto-failback triggered too often (flapping) | DC container unstable, keeps crashing | Increase `KEA_FAILBACK_STABILITY_SECONDS` to 900+ s; fix root cause |
| Scheduler says "DC state is waiting/syncing" | DC just started, not done syncing yet | Wait 30-60s for sync to complete; check DC logs |
| Manual switchover rejected by Kea | Currently in transition (e.g. DC is restarting) | Wait 30s, retry |
| Both sites report "unavailable" | Network partition, both lost contact | Investigate switch/router; once resolved, Kea auto-recovers |

## KHÔNG đụng
- Bingx service (port 8091, PID 1196607, files ở `/opt/bingx`)
- Service port 50074 (của chủ VM)  
- Tailscale config
- Postgres / NetBox / NetConsole app stack (trừ backend/frontend update qua CI)
- docker-compose.lab.yml (lab vẫn dùng 2-kea local HA, không phải DC↔DR)
- lab/clab/netconsole.clab.yml (containerlab cũng vẫn 2-kea)
