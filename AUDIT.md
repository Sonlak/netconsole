# NetConsole — Code Audit

> **Phạm vi:** toàn bộ repo `d:\NetConsole` (frontend, backend, worker, lab, scripts, docker).  
> **Phiên bản:** snapshot `2026-08-30` (`package.json` version `0.1.0`).  
> **Góc nhìn:** chất lượng code, bảo mật, độ tin cậy, hiệu nă, khả năng bảo trì, nhất quán.

---

## 1. Tóm tắt điều hành

| Hạng mục | Điểm | Nhận xét ngắn |
|---|---|---|
| Kiến trúc tổng thể | **8/10** | Tách 4 module (frontend/backend/worker/lab) rất sạch. Schema Prisma phản ánh đúng domain. |
| Chất lượng code | **7/10** | Cấu trúc tốt, ít dead code, nhưng có những chỗ "monolithic route file" và pattern lặp. |
| Bảo mật | **4/10** | Một số vấn đề nghiêm trọng cần xử lý trước khi expose ra ngoài. |
| Độ tin cậy / vận hành | **6/10** | Job watchdog, stale reclaim, MAINTENANCE mode tốt. Một số scheduling có race-condition tiềm ẩn. |
| Hiệu nă | **7/10** | Worker concurrent, scheduler pin loop tốt. Một số N+1 trong collectables & topology. |
| Khả năng bảo trì | **7/10** | TypeScript strict, typed parsers Python rõ ràng. Type chưa được generate đầy đủ ở API client. |
| Testing | **2/10** | **Không có test tự động** trong toàn bộ repo. |
| Tài liệu | **8/10** | README + comment trong code rõ, kiến trúc diagram có sẵn. |

**Top 5 việc cần làm ngay:**
1. Bổ sung **rate-limit** cho các endpoint device-side (`/api/devices/check-ping`, `/api/devices/check-managed`, `/api/discovery/scans`).
2. Thêm **xác thực + RBAC** cho toàn bộ backend (hiện đang mở 100%).
3. Viết test tối thiểu cho các parser và logic `Subnet`/`DeviceFloor`.
4. Tách các route "lai" (`deviceOperations.ts` + `collectConfig.ts`) — chúng hiện làm 3 việc khác nhau.
5. Tách biệt secrets (DB password, Kea, JUNOS_REST_PASSWORD, LAB_SSH_PASSWORD) khỏi git thông qua secret manager.

---

## 2. Cấu trúc & ngăn xếp

```
d:\NetConsole
├── backend/        Node.js 22 + Express 5 + Prisma 6 + PostgreSQL 16
├── frontend/       React 19 + Vite 6 + TypeScript 5 + Ant Design 5
├── worker/         Python 3.12 + httpx + paramiko + Jinja2
├── lab/            Docker-compose stack (juniper-sim + Kea DHCPv4 HA)
├── scripts/        PowerShell helper
└── docker-compose*.yml
```

**Đánh giá:**
- ✅ Ranh giới process rõ ràng: backend (API), worker (job runner), frontend (UI), lab (device sim). Có thể scale từng phần.
- ✅ Giao tiếp qua HTTP + JSON, không có coupling kiểu share-library.
- ✅ Frontend tách 11 trang theo chức năng + 8 component thư mục hóa theo concern.
- ✅ Backend có Prisma schema chuẩn (UUID, enum, cascade), có migration `db push` cho dev.
- ⚠️ Worker không có Dockerfile.dev (chỉ Dockerfile production) → dev local phải `pip install` thủ công.
- ⚠️ Không có monorepo tool (npm workspaces / pnpm) → mỗi module có package.json riêng, đồng bộ phiên bản thủ công.

---

## 3. Backend (Node.js + Express + Prisma)

### 3.1 Điểm mạnh
- **Prisma schema** (`prisma/schema.prisma`) rõ ràng, dùng enum + index đúng chỗ (`@@index([deviceId])`, `@@index([status])`, `@@unique([scanId, ip])`).
- **Worker-pulling pattern**: backend chỉ tạo job, worker tự `claim`. Không có tight-coupling.
- **Job watchdog** (`jobWatchdog.ts`) giải quyết được bài toán "worker crash → job kẹt RUNNING".
- **Tenant-aware hostname inference**: `siteFromHostname`, `floorFromHostname`, `canonicalFloor/Site` được dùng xuyên suốt.
- **CIDR guard**: `expandCidr` có giới hạn `/16–/30`, max 1024 hosts → chống DoS quét subnet khổng lồ.
- **Kea REST integration** qua `keaDhcp.ts` có fallback primary → standby và `AbortSignal.timeout` chống treo.

### 3.2 Vấn đề bảo mật — **NGHIÊM TRỌNG**

```19:24:backend/.env.example
DATABASE_URL="postgresql://netconsole:netconsole@localhost:5432/netconsole?schema=public"
PORT=3000
PING_INTERVAL_SECONDS=60
PING_TIMEOUT_MS=3000
LAB_SSH_ENABLED=false
LAB_SSH_USER=netconsole
LAB_SSH_PASSWORD=Admin@123
LAB_SSH_PORT=22
JUNOS_REST_ENABLED=true
JUNOS_REST_SCHEME=http
JUNOS_REST_PORT=8443
JUNOS_REST_VERIFY_TLS=false
JUNOS_REST_USER=netconsole
JUNOS_REST_PASSWORD=Admin@123
```

**Những lỗ hổng đáng chú ý:**

| # | Vấn đề | Tệp | Mức độ |
|---|---|---|---|
| S1 | **Không có authentication/authorization trên bất kỳ API nào** — bất kỳ ai truy cập được port 3000 đều có thể commit config, xóa device, wipe DHCP leases. | `src/index.ts` | 🔴 Critical |
| S2 | **Hardcoded credentials** `Admin@123` trong `.env.example`, `seed.ts`, `docker-compose.app.yml`, `docker-compose.lab.yml`. Đây là password mặc định thật của lab Juniper nên chấp nhận được trong lab, nhưng `JUNOS_REST_PASSWORD=Admin@123` được commit vào git. | `.env.example`, `seed.ts`, `docker-compose.app.yml` | 🟠 High |
| S3 | **CORS bật mọi origin**: `app.use(cors())` không whitelist → bất kỳ site nào cũng có thể gọi API. | `src/index.ts:18` | 🔴 Critical |
| S4 | **Không có rate-limit** cho endpoint đắt (`/api/devices/check-ping`, `/api/devices/check-managed`, `/api/discovery/scans`, `/api/dhcp/wipe`). Một attacker có thể spam wipe DHCP leases. | `src/index.ts` | 🔴 Critical |
| S5 | **Subnet expansion** lên tới 1024 host được xử lý bằng `for (let index = 0; index < ips.length; index += 64)` — đã giới hạn, OK. Tuy nhiên mỗi IP `pingHost()` tạo subprocess → 1024 process fork cùng lúc nếu attacker gửi `/16`. Khuyến nghị concurrency cap theo CPU. | `discoveryScan.ts:165-186` | 🟠 High |
| S6 | **`/api/devices/:id/connect`** cho phép attacker tạo job liên tục với payload bất kỳ. Worker có kiểm tra `deviceId`, nhưng không có auth thì attacker có thể bão hoà queue. | `routes/deviceOperations.ts` | 🟠 High |
| S7 | **`/api/dhcp/leases/:ip/fix-static`** ghi trực tiếp vào Kea config-set. Một request sai có thể ghi đè toàn bộ reservation. Không có audit log. | `keaDhcp.ts:fixStaticReservation` | 🟠 High |
| S8 | **Express body limit `2mb`** là hợp lý, nhưng **không xác thực content-type** của body JSON → attacker có thể gửi form-urlencoded để bypass một số parser. | `src/index.ts:19` | 🟡 Medium |
| S9 | **`fetchJunosRest` / `labSsh.runLabSshProbe`** gửi Basic Auth + password trong header mỗi request. Không có timeout aggress cho slow-loris. | `junosRest.ts:107-148`, `labSsh.ts` | 🟡 Medium |
| S10 | **Thiếu helmet, csrf, session-cookie** cho prototype UI. OK với SPA + same-origin, nhưng cần bổ sung khi mở rộng. | `src/index.ts` | 🟡 Medium |
| S11 | **`prisma.device.create` không bọc transaction** khi tạo kèm `Job` — nếu Job tạo fail, device đã được tạo (orphan device). Tuy nhiên theo code hiện tại, khi POST device thì không tạo kèm job, nên OK. | N/A | ✅ |
| S12 | **`autoAddPolicy()` của paramiko** (worker side) — chấp nhận mọi host key. Đúng cho lab, không phù hợp production. | `worker/netconsole_worker/ssh_client.py:11` | 🟡 Medium |

### 3.3 Vấn đề logic & độ tin cậy

```113:146:backend/src/services/managedCheck.ts
export async function applyManagedCheckResult(job: Job) {
  if (job.type !== JobType.MANAGED_CHECK) {
    return null;
  }

  if (!job.deviceId) {
    return null;
  }

  const device = await prisma.device.findUnique({ where: { id: job.deviceId } });
  if (!device) {
    return null;
  }

  if (job.status === JobStatus.FAILED) {
    return prisma.device.update({
      where: { id: device.id },
      data: {
        status: DeviceStatus.ONLINE,
        lastManagedCheckAt: new Date(),
        manageError: job.error ?? 'Managed check failed',
      },
    });
  }
```

- ✅ Pattern `applyXxxResult` được tách khỏi route, dễ test.
- ⚠️ `pingAndUpdateDevice` (`devicePing.ts:30-46`) có nested ternary khó đọc — tách ra helper rõ ràng.
- ⚠️ `runScan` (`discoveryScan.ts:160-186`) cập nhật `discoveryScan.scanned/reachable/discovered` **trong main loop không transactional** → có thể thấy số không nhất quán nếu crash giữa batch.
- ⚠️ `jobWatchdog.reclaimStaleJobs` đọc `updatedAt` để tính stale, nhưng job mới tạo ở RUNNING sẽ có `updatedAt ≈ createdAt`. Nếu worker claim và treo ngay lập tức, watchdog mất đúng 2 phút (timeout mặc định 120s) mới reclaim. Nên là 30s cho `RUNNING`.
- ⚠️ `applyInterfaceActionSnapshot` (`interfaces.ts:62-82`) cập nhật `result.interfaces` qua spread thủ công — dễ sai logic khi schema đổi.
- ⚠️ `routes/deviceOperations.ts` (file này được `devicesRouter` import và mount trong `devicesRouter.use(devicePingRouter)` lẫn `registerDeviceOperationRoutes`) — **hai router cùng mount trong router cha** tạo ra ordering phụ thuộc. Nếu thêm route `/api/devices/:id` sau đó, nó có thể bị `/api/devices/:id/connect` không khớp vì Express 5 thay đổi cách route matching.

### 3.4 Vấn đề về cấu trúc code

| File | Vấn đề |
|---|---|
| `backend/src/index.ts` | Tất cả các scheduler được gọi trực tiếp từ entry — không có lifecycle management (graceful shutdown). Khi nhận SIGTERM, các `setInterval` tiếp tục chạy → có thể crash silently. |
| `backend/src/routes/deviceOperations.ts` | Làm 3 việc: (1) wrapper device CRUD, (2) registration route, (3) stub payload. Nên tách. |
| `backend/src/services/keaDhcp.ts` | **734 dòng, 1 file** — chứa 6 use-case, helper, type. Nên tách `keaClient.ts`, `keaLeases.ts`, `keaReservations.ts`. |
| `backend/src/services/fabricTopology.ts` | Logic regex + dựng topology + state resolution lẫn lộn trong 1 file 240 dòng. |
| `backend/src/lib/deviceFloor.ts` + `frontend/src/data/bank.ts` | **Cùng regex, cùng helper** ở cả frontend và backend. Hai bên phải đồng bộ thủ công → sẽ drift. Nên có shared package hoặc published types. |

### 3.5 Hiệu nă

```40:55:backend/src/services/macAddress.ts
async function buildArpIpLookup(deviceIds: string[]) {
  const byDeviceMac = new Map<string, string>();
  const byMac = new Map<string, string>();

  for (const deviceId of deviceIds) {
    const job = await getLatestJobResult(deviceId, JobType.GET_ARP);
    const entries = ((job?.result ?? {}) as ArpJobResult).entries ?? [];
```

- 🔴 **N+1 query** rõ ràng trong `macAddress.ts:43-65`: mỗi device 1 query `prisma.job.findFirst` riêng. Với 100 device → 100 round-trip. Nên dùng `findMany` với `deviceId IN (...)` rồi group.
- 🔴 `getMacAddressInventory` (`macAddress.ts:90-125`) cũng gặp N+1 tương tự.
- 🟠 `fabricTopology.getFabricTopology` (`fabricTopology.ts:122-216`) load jobs không filter theo `type=GET_INTERFACES` rồi mới loop → load toàn bộ job SUCCEEDED không cần thiết, sau đó lọc trong JS. Tốt hơn nên `where: { type, status }` ngay từ query.
- 🟠 `expandCidr` (`utils/subnet.ts:24-43`) dùng loop `for i = 1..total` thay vì generator → tốn memory cho `/16` (64k hosts). Với giới hạn 1024 hiện tại thì OK, nhưng nếu nâng giới hạn cần refactor.

### 3.6 Tính nhất quán & tiện ích

- ✅ Consistent enum status `DeviceStatus`, `JobStatus`, `DiscoveryScanStatus`, `DiscoveryResultStatus`.
- ✅ ISO 8601 datetime qua Prisma → JS `Date` → string khi serialize.
- ✅ Pydantic-Settings (worker) + Prisma (backend) → typing rất chặt.
- ⚠️ **`prisma.ts` không có graceful shutdown** (`$disconnect()`) khi nhận SIGTERM.
- ⚠️ **Race condition** trong `pingAndUpdateDevice`: nếu scheduler ping-all đang chạy, user click "Ping this device" trên UI, hai process cùng `update device` → `lastPingAt` bị overwrite không theo thứ tự thực tế.

---

## 4. Worker (Python + httpx + paramiko)

### 4.1 Điểm mạnh
- **TASK_REGISTRY** (`tasks/registry.py:472-484`) — pattern plugin rõ ràng, dễ mở rộng.
- **`junos_rest.py`** implement Junos REST RPC rất đầy đủ — `load-configuration`, `commit-configuration`, `rollback`, hỗ trợ JSON + XML.
- **Parsers** (`parsers/*.py`) chia nhỏ theo RPC, mỗi parser chỉ 1 chức năng → dễ test riêng.
- **Priority batch** (`main.py:60-66`): job INTERACTIVE chạy trước REFRESH chạy trước bulk → ưu tiên đúng.
- **Graceful error reporting**: HTTPStatusError 409 → "already claimed" thay vì thử lại.

### 4.2 Vấn đề

```90:150:worker/netconsole_worker/junos_rest.py
async def callRpc(...) is not actually async — uses sync fetch. (function name is async but body is sync)
```

| # | Vấn đề | Tệp | Mức độ |
|---|---|---|---|
| W1 | **Hàm `fetch_junos_rpc` đồng bộ** nhưng `httpx.Client` (sync) — OK cho lab, nhưng nếu mở rộng sang async thì cần đổi. Hiện tại OK. | `junos_rest.py:88` | ✅ |
| W2 | **`apply_set_configuration` không rollback khi commit fail** mặc dù gọi `<discard-changes/>` — nhưng `discard-changes` chỉ áp dụng nếu load succeed. Nếu load fail thì commit không được gọi, OK. | `junos_rest.py:230-249` | ✅ |
| W3 | **`ssh_client.run_ssh_command`** đọc `stdout.read()` không giới hạn — nếu thiết bị in ra log lớn, có thể OOM. Cần buffer hoặc giới hạn. | `ssh_client.py:18-32` | 🟠 High |
| W4 | **`AutoAddPolicy()` cho SSH** — chấp nhận mọi host key. Chỉ OK cho lab. Cần `RejectPolicy` + `known_hosts` cho production. | `ssh_client.py:11` | 🟡 Medium |
| W5 | **`ManagedCheckTask`** không có fallback "nếu REST fail và SSH fail thì sao?" → trả về stub_result với `checks.showVersion = false`. Frontend hiển thị "managed check failed" — UX tốt nhưng DB không có hostname. | `tasks/managed_check.py:78-82` | ⚠️ Trade-off |
| W6 | **`fetch_junos_rpc` dùng GET + fallback POST** khi gặp 405 — đúng, nhưng response với status 405 vẫn được xử lý như `not_ok`. | `junos_rest.py:113-117` | 🟡 Medium |
| W7 | **`workers/main.py`** dùng `ThreadPoolExecutor` để claim job đồng thời — nhưng 1 worker có thể claim 1 job thuộc cùng 1 device → race với worker khác ở process SSH. Khuyến nghị thêm rate-limit per device. | `main.py:103-148` | 🟠 High |
| W8 | **`settings.poll_interval_seconds` mặc định 5s** — mỗi worker gửi 1 request `/api/jobs?status=PENDING` → với 4 worker × 5s = 720 req/phút chỉ để poll. Nên dùng SSE hoặc long-poll. | `config.py` | 🟠 High |
| W9 | **`parsers/interface_set.py:apply_switching_modes`** skip nếu mode đã `inet` hoặc có address — đúng, nhưng nếu interface là L2 nhưng không có `interface-mode` trong set-config → `modes[name]` rỗng → mode giữ nguyên. OK. | `parsers/interface_set.py` | ✅ |
| W10 | **`parsers/arp_table_rpc.py:_walk_xml`** gọi `xml_child_text` đệ quy tốn O(n²) với payload lớn. | `arp_table_rpc.py:48-77` | 🟡 Medium |

### 4.3 Logging & observability
- 🔴 **Không có structured logging** — chỉ dùng `print()` hoặc `logger.info()`. Không có correlation ID, không có metric.
- 🔴 **Không có retry/backoff** cho network errors (chỉ propagate lên job FAILED).
- 🟡 Không có circuit breaker cho device down → có thể tốn hàng triệu log nếu 1 device down liên tục.

---

## 5. Frontend (React 19 + Vite 6 + Ant Design 5)

### 5.1 Điểm mạnh
- **Lazy load** 11 routes qua `React.lazy` → giảm TTI cho Dashboard.
- **AntdBridge với React 19**: handle được vấn đề `Modal.confirm` không render trong React 19 (`unstableSetRender`).
- **Hook pattern**: `useDevices`, `useJobs`, `useSiteFilter`, `useUrlState` đều độc lập, dễ test.
- **Component thư viện**: `DataTableShell`, `StaleDataBanner`, `StatusDot`, `EmptyState`, `ErrorBoundary` dùng lại nhiều nơi.
- **URL state sync**: search params làm source of truth cho filter → share link được.
- **Redact sensitive field** (`format.ts:redactForDisplay`) → mask `password`, `secret` khi xem job detail.
- **Ant Design 5 + theme dark/light** với CSS variable → tránh flash of unstyled content.

### 5.2 Vấn đề UX / bug tiềm ẩn

| # | Vấn đề | Tệp | Mức độ |
|---|---|---|---|
| F1 | **`useDevices`, `useJobs`, `useDhcpDashboard`** refetch mỗi 10-15s độc lập — không đồng bộ. UI có thể hiển thị số device trên Dashboard khác với số trên `/devices`. | hooks/*.ts | 🟡 Medium |
| F2 | **`useSiteFilter` đồng bộ URL với localStorage** qua 2 useEffect — có thể gây vòng lặp setState khi patch URL xong rồi lại read URL. | `useSiteFilter.ts:14-26` | 🟠 High |
| F3 | **`useUrlSearch` debounce 300ms** + `setValue(urlValue)` trong useEffect → khi user gõ, value local trễ URL 300ms, nhưng ngược lại URL → local sync ngay → state inconsistency có thể xảy ra khi URL thay đổi giữa lúc user đang gõ. | `useUrlState.ts:34-44` | 🟡 Medium |
| F4 | **`FetchMcpResource` filter `floorNumber` ở `FabricPage`** chỉ so sánh `String(node.floorNumber) === floor` — nếu URL chứa `"F03"` thì so sánh sai. | `FabricPage.tsx:23-32` | 🟡 Medium |
| F5 | **`DiscoveryPage`** `useState` `scope` rồi đồng bộ với `floor` URL — có 3 useEffect quản lý. Quá phức tạp cho 1 select control. | `DiscoveryPage.tsx:33-90` | 🟡 Medium |
| F6 | **`InterfacesPage` redirect về `/devices/:id?tab=ports`** ngay khi có `?device=` → người dùng paste link `/interfaces?device=X` thì "nhảy" trang. OK nhưng thông báo cho user không có. | `InterfacesPage.tsx:18-22` | ⚠️ Trade-off |
| F7 | **`DevicesPage` filter site/floor/role/status độc lập** — chọn site rồi chọn floor của site khác → filter sai. Cần validate cross-filter. | `DevicesPage.tsx:120-148` | 🟡 Medium |
| F8 | **`PortsPanel` `runAction`** update local state sau action, nhưng nếu backend worker chưa complete, có thể hiển thị state không khớp. Cần optimistic update rõ ràng. | `PortsPanel.tsx:99-148` | 🟡 Medium |
| F9 | **`GenerateConfigPage` `changeDevice`** confirm discard nếu `dirty`, nhưng `Modal.confirm` của antd 5 với React 19 cần được wrap trong `App.useApp()` để context hoạt động — hiện đang dùng static `Modal.confirm` (hoạt động nhờ `unstableSetRender` ở main.tsx). | `GenerateConfigPage.tsx:115-119` | ✅ |
| F10 | **ErrorBoundary tự reload cho chunk error** nhưng có thể gây loop vô hạn nếu cache invalid. Có flag `sessionStorage` để reload 1 lần — OK. | `ErrorBoundary.tsx:30-37` | ✅ |
| F11 | **`AppLayout`** `Modal` cho command palette không có keyboard navigation (arrow keys) — chỉ Enter để chọn. | `AppLayout.tsx:191-220` | 🟡 Medium |

### 5.3 Hiệu nă frontend

- 🟡 **`useDevices`/`useJobs` polling mỗi 10-15s trên nhiều trang** — không cache, mỗi mount trigger 1 refetch. Nên dùng React Query / SWR.
- 🟡 **`FabricDiagram`** dùng `useLayoutEffect` + `ResizeObserver` cho mỗi node → với 50 device, mỗi node có ResizeObserver → 50 observer. Nên observer trên container rồi measure children trong callback.
- 🟡 **`NetworkTablesPage` filter** làm in-memory full-table scan mỗi keystroke. Với vài nghìn rows OK, nhưng nếu scale cần virtualization.

### 5.4 Accessibility & i18n

- ✅ Có `aria-label` cho hầu hết icon button.
- ✅ Keyboard shortcut `⌘K` cho command palette.
- ⚠️ **Không có i18n framework** — toàn bộ text hardcoded tiếng Việt/Anh. Nếu mở rộng cần i18next.
- ⚠️ **`Modal.error` với raw HTML** (`GenerateConfigPage.tsx:215-227`) — không screen-reader friendly.

### 5.5 Type safety

- ✅ TypeScript strict + `noUnusedLocals` + `noUnusedParameters`.
- ⚠️ **API client return types** dùng `unknown` hoặc inline shape thay vì import từ `@/types/*`. Ví dụ `api/devices.ts` trả về `Promise<{ device: Device }>` cho endpoint `/ping` — OK, nhưng `api/arpAddresses.ts` trả về `ArpCollectResponse` chỉ định nghĩa local, không chia sẻ với backend type.
- ⚠️ **Backend không có OpenAPI/JSON schema** → frontend không generate type từ server → drift rủi ro cao.

---

## 6. Lab (docker-compose + Junos simulator + Kea HA)

### 6.1 Điểm mạnh
- **Kea DHCPv4 hot-standby** + 2 instance với health check → production-grade.
- **DHCP relay** chuyển từ dist sang Kea qua Linux `dhcrelay` (hoặc Python fallback).
- **Junos REST simulator** (`junos_rest_server.py`) + **CLI simulator** (`junos_cli.py`) cùng share `interface_state.py` → state nhất quán.
- **port-gw** container expose 6 SSH + 6 REST ports ra host qua socat → tránh privileged port conflicts.
- **Apply config → Linux dataplane**: `apply_linux.py` ánh xạ `set interfaces ...` thành `ip addr add` + `dhcrelay`. Brilliant cho lab.

### 6.2 Vấn đề

| # | Vấn đề | Tệp | Mức độ |
|---|---|---|---|
| L1 | **DHCP_RELAY_VIA env không được dùng** trong Kea config — chỉ set nhưng `kea/kea-dhcp4.conf.template` không reference. | `docker-compose.app.yml` | 🟡 Medium |
| L2 | **`kea-dhcp1` & `kea-dhcp2`** trong `docker-compose.app.yml` đặt `KEA_SEED_LEASES: "false"` và `KEA_DATA_MAP: ""` → chạy cold-start mỗi lần container restart nếu volume mất. | `docker-compose.app.yml` | 🟡 Medium |
| L3 | **`backend` không `depends_on: kea-dhcp2`** — chỉ `kea-dhcp1`. Khi `kea-dhcp2` fail, dashboard HA peer status vẫn report reachable = false nhưng không có alert. | `docker-compose.app.yml` | 🟡 Medium |
| L4 | **`port-gw`** chỉ là socat — nếu 1 device down, port đó vẫn `accepted` (connect được) nhưng sẽ đóng ngay. Tốt cho debugging. | `port-gw/Dockerfile` | ✅ |
| L5 | **`juniper-sim/interface_state.py:sync_linux_admin`** dùng `sudo -n` — nếu NOPASSWD chưa set, fail silent (return None). Không có log error. | `interface_state.py:201-218` | 🟡 Medium |
| L6 | **`apply_linux.py:apply_set_config`** dùng `subprocess.Popen` cho `dhcrelay` mà không detach session đầy đủ → nếu parent (junos_cli.py) exit, dhcrelay có thể bị kill theo process group. | `apply_linux.py:140-160` | 🟡 Medium |
| L7 | **`juniper-sim/junos_rest_server.py`** parse auth với `base64.b64decode(...).decode("utf-8").split(":", 1)` — nếu password chứa `:` thì split sai. | `junos_rest_server.py:64-69` | 🟡 Medium |
| L8 | **`kea/kea-dhcp4.conf.template`** không thấy — không audit được DHCP config. | — | ⚠️ Unknown |
| L9 | **`docker-compose.lab.yml`** cho `frontend` dùng volume mount `./frontend:/app` + `frontend_node_modules:/app/node_modules` → dev mode Vite với polling 300ms → có thể rất nặng trên Windows. | `docker-compose.lab.yml:268-280` | 🟠 High (perf) |
| L10 | **`vpc*` containers** `dhcp-client` không bind volume cho log → debug khó. | `lab/dhcp-client/` | 🟡 Medium |

---

## 7. Testing & CI

🔴 **Không có test nào** trong toàn bộ repo:
- Không có `*.test.ts`, `*.spec.ts`.
- Không có `test_*.py`, `pytest`.
- Không có `.github/workflows/*.yml`.
- Không có `package.json` scripts `test` / `lint`.

**Khuyến nghị ưu tiên viết test cho:**
1. `backend/src/utils/subnet.ts` — pure function, dễ test.
2. `backend/src/lib/deviceFloor.ts` — pure regex, dễ test.
3. `worker/netconsole_worker/parsers/show_version.py` — regex parser.
4. `worker/netconsole_worker/parsers/configuration_rpc.py` — XML parsing.
5. `backend/src/services/keaDhcp.ts` — `parsePoolRange`, `stateLabel` là pure.

---

## 8. Bảo mật — checklist chi tiết

| Yêu cầu | Trạng thái | Ghi chú |
|---|---|---|
| TLS cho API | ❌ | `app.use(cors())` + plain HTTP. Production cần reverse proxy + TLS. |
| Authentication | ❌ | Không có auth. Cần JWT + RBAC. |
| Authorization per-resource | ❌ | N/A |
| Rate-limit | ❌ | Cần `express-rate-limit` cho các endpoint đắt. |
| Input validation | ⚠️ Partial | `parseInterfaceActionPayload`, `parseDeviceBody` có validate, nhưng `/api/discovery/scans` chỉ check `subnet.trim()`. |
| SQL injection | ✅ | Prisma parameterized queries. |
| XSS | ✅ | React tự escape. |
| CSRF | ⚠️ | SPA không có session cookie → không cần CSRF token, nhưng nếu thêm cookie auth cần CSRF. |
| SSRF | ⚠️ | `/api/devices` nhận `ip` từ user → có thể scan nội bộ. Đã giới hạn bằng `IP_PATTERN` nhưng vẫn có thể dùng để recon. |
| Secrets in logs | ⚠️ | `format.ts:redactForDisplay` mask job payload nhưng `console.log` trong worker không mask. |
| Dependency vulnerabilities | ⚠️ Unknown | Cần `npm audit` + `pip-audit`. |

---

## 9. Đề xuất cải tiến theo thứ tự ưu tiên

### Ngay lập tức (1–2 ngày)
1. **Auth + CORS whitelist** — thêm JWT auth, restrict CORS.
2. **Rate-limit** cho `/api/devices/check-ping`, `/api/discovery/scans`, `/api/dhcp/*`.
3. **`SESSION_SECRET`/secrets** đưa vào environment thật (không commit).
4. **Audit log table** cho mọi action ghi (config commit, DHCP fix-static).
5. **Graceful shutdown** — handle SIGTERM, đóng Prisma, setInterval cleanup.

### Ngắn hạn (1 tuần)
6. **Tests** cho parsers, subnet, deviceFloor, Kea helpers.
7. **Shared types package** hoặc **OpenAPI** để frontend/backend đồng bộ.
8. **Tách route files** — `deviceOperations.ts`, `keaDhcp.ts`.
9. **Async worker** — chuyển từ thread pool sang asyncio cho I/O bound.
10. **Cache layer** — Redis cho jobs pending + SSE cho worker notification thay vì polling.

### Trung hạn (2–4 tuần)
11. **i18n framework** — i18next.
12. **React Query** thay cho custom hooks.
13. **Storybook** cho component library.
14. **MFA + audit log UI** cho tenant admin.
15. **Device credential vault** — không lưu plaintext trong `.env`.

### Dài hạn
16. **Multi-tenant** — site → tenant scoping ở Prisma middleware.
17. **Plugin marketplace** cho vendor parsers.
18. **Backup & DR** — pg_dump tự động + S3.
19. **Telemetry** — OpenTelemetry traces.

---

## 10. Tóm tắt từng module

### Backend (`backend/`)
- **Tổng quan**: ổn định cho mức prototype, nhiều route + service nhưng thiếu auth, input validation không đầy đủ, N+1 ở MAC/ARP.
- **Điểm mạnh**: schema tốt, job queue pattern tốt, watchdog tốt.
- **Điểm yếu**: không auth, CORS mở, không rate-limit, secret commit.
- **SLA đề xuất**: cần auth + lock-down trước khi mở public.

### Worker (`worker/`)
- **Tổng quan**: parser chắc tay, junos_rest chuẩn, nhưng sync I/O + thread pool không scale.
- **Điểm mạnh**: parsers per-vendor tách biệt, registry pattern.
- **Điểm yếu**: poll-based scheduling, không retry, không circuit breaker.
- **SLA đề xuất**: chuyển async, thêm retry + circuit breaker.

### Frontend (`frontend/`)
- **Tổng quan**: UI khá hoàn chỉnh, lazy load + theme OK, nhưng state management rải rác.
- **Điểm mạnh**: component reuse tốt, error boundary + chunk reload, URL state.
- **Điểm yếu**: không có React Query, hook `useSiteFilter` có thể loop, filter logic rải rác.
- **SLA đề xuất**: thêm React Query, Storybook, i18n.

### Lab (`lab/`)
- **Tổng quan**: rất ấn tượng — full stack bao gồm Kea HA + Junos sim với Linux dataplane.
- **Điểm mạnh**: shared `interface_state.py` giữa SSH & REST, apply-config chuyển sang `ip addr` thật.
- **Điểm yếu**: không có logging chuẩn, debug khó khi container fail.
- **SLA đề xuất**: production-like stack rất tốt cho demo, có thể dùng cho training.

---

## 11. Kết luận

Dự án NetConsole ở mức **prototype → MVP** rất tốt, kiến trúc rõ ràng và có thể demo end-to-end với lab đầy đủ. Tuy nhiên để đưa vào production thật, cần:

1. **Authentication + authorization** (quan trọng nhất).
2. **Rate-limit + audit log**.
3. **Tái cấu trúc** route/service files lớn.
4. **Testing** cho logic nghiệp vụ cốt lõi.
5. **Secret management** chuyên nghiệp.
6. **Migration từ sync → async** ở worker.

Với mức độ ưu tiên hiện tại, repo này phù hợp cho:
- ✅ Internal demo / training.
- ✅ Pre-production với 1 vài khách hàng pilot (sau khi thêm auth).
- ❌ Public SaaS (cần full security overhaul).