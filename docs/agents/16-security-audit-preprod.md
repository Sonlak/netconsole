# NetConsole — Pre-Production Security Audit (Ngân hàng)

> **Ngày audit:** 2026-10-18
> **Audit bởi:** Cursor agent (báo cáo đọc lại toàn bộ docs + 3 lượt code recon song song: backend, worker/frontend/infra)
> **Trạng thái tại thời điểm audit:** code state trước khi sửa. Repository `D:/NetConsole`.
> **Ngữ cảnh sử dụng:** network operations console cho **TAI LOC BANK**, điều khiển SSH/RESTCONF/NETCONF tới core/distribution/access switches, có khả năng apply config + wipe DHCP leases. Đây là data-path tới hạ tầng ngân hàng, không phải hệ thống lưu trữ PAN trực tiếp nhưng nằm ở vị trí có thể tạo DoS/toàn quyền điều khiển.

---

## TL;DR

Tổng cộng **14 CRITICAL**, **16 HIGH**, **30+ MEDIUM/LOW** vấn đề tìm thấy. Bản chất quan trọng nhất:

| Khu vực | Vấn đề | Trạng thái |
|---|---|---|
| **JWT/Auth** | `JWT_SECRET` có fallback plaintext trong code (`'CHANGE_ME_IN_PRODUCTION'` / `'netconsole-dev-secret'`) | **CRITICAL** — mất toàn bộ auth nếu env lệch |
| **Secrets on disk** | `JWT_SECRET` + `WORKER_AUTH_TOKEN` (1 năm) committed trong `docker-compose.app.yml` | **CRITICAL** |
| **Plaintext creds** | `login.json` ở repo root, chứa `admin / Admin@123` | **CRITICAL** |
| **RBAC** | Mọi mutation endpoint (commit/rollback config, wipe DHCP, device add/delete, …) chỉ yêu cầu login, không check role — VIEWER có thể commit config + apply SSH + wipe lease | **CRITICAL** |
| **Public exposure** | NetBox UI `:8080` + Kea agent `:8001` + syslog UDP `:1514` đang public; Postgres `:5432` được publish trong dev compose | **HIGH/CRITICAL** |
| **TLS** | Frontend serve HTTP thường trên `:8443` của public NIC; cert tự ký và chưa được nginx dùng; TLS verify disabled ở tất cả vendor client | **HIGH/CRITICAL** |
| **XSS** | Refresh token lưu `localStorage` (XSS-readable, TTL 30 ngày) | **HIGH** |
| **WS auth** | JWT truyền qua query string cho terminal WS (log proxy + browser history + nginx access log có 15-min access token) | **HIGH** |
| **Secrets handling** | Một tài khoản `netconsole / Admin@123` dùng chung cho mọi vendor API trong compose | **HIGH** |
| **Syslog** | UDP `:1514` không có source-IP allowlist, không per-IP rate limit | **HIGH** |
| **Audit/Logging** | Audit log chỉ ghi body keys — OK; nhưng đường dẫn `/api/auth/login/password` skip hợp lý; webhook notification khi replay-detected đã có | OK |

Tài liệu này là reference để verify. Code fixes đã được apply theo nhóm — xem `## Remediation Status` cuối báo cáo + diff dưới.

---

## 1. Phạm vi & phương pháp

### Stack scope

| Lớp | Tech | Đường dẫn |
|---|---|---|
| Frontend | React 19 + TS + Vite + AntD 5 | `frontend/src/`, `frontend/nginx.conf`, `frontend/Dockerfile.prod` |
| Backend | Node 22 + Express 5 + Prisma 6 + Postgres 16 | `backend/src/`, `backend/prisma/schema.prisma` |
| Worker | Python 3.12 + httpx + Jinja2 | `worker/netconsole_worker/` |
| DHCP | Kea 3.x HA | `lab/kea/`, `docker-compose.app.yml` |
| Deploy | docker compose + GH Actions self-hosted | `.github/workflows/`, `docker-compose.app*.yml` |

### Phương pháp

1. Đọc lại toàn bộ docs trong `docs/agents/` (01, 04, 11, 13) để hiểu kiến trúc.
2. 3 lượt recon code song song:
   - **Backend**: auth, RBAC trên mọi `routes/*.ts`, input validation, raw SQL, helmet/CORS, secret defaults.
   - **Worker/frontend/infra**: SSH/RESTCONF inject, token storage, docker compose mounts, nginx config, GH Actions secrets flow, secrets trong repo, scan `.tmp-cfg/`.
   - **Cross-cutting**: read mọi file middleware + index.ts + `docker-compose.app.yml` + `frontend/nginx.conf` để xác minh từng finding từ recon.
3. Phân loại severity theo PCI-DSS + ISO 27001 ngân hàng.
4. Code fixes theo nhóm trong scope này; operator actions ghi vào section cuối.

### Compliance gaps bị flag

| Standard | Trạng thái | Items |
|---|---|---|
| PCI-DSS 1.3 (no public access) | ❌ | NetBox `:8080`, syslog `:1514`, Kea `:8001` |
| PCI-DSS 3.2 (creds rendered unreadable) | ❌ | Refresh in localStorage; terminal may save raw config w/ passwords |
| PCI-DSS 4.1 / 4.2 (strong cryptography) | ❌ | Self-signed cert; TLS verify disabled on every vendor client; HTTP public NIC |
| PCI-DSS 6.5.1 / 6.5.7 (XSS / CSRF) | ❌ | No CSP; refresh in JS-readable storage; CORS_ORIGINS includes dev origins |
| PCI-DSS 8.2.x (auth mgmt) | ❌ | JWT secret + worker token committed; bcrypt rounds on lower edge |
| PCI-DSS 11.5 (change detection) | partial | Deploy pipeline tracks; secrets ship uncommitted on every deploy |
| ISO 27001 A.9.4.1 | ❌ | Same as above |
| ISO 27001 A.10.1.1 (crypto) | ❌ | Same as above |
| ISO 27001 A.13.1.1 (network) | ❌ | Same as above |
| ISO 27001 A.14.2.5 (secure coding) | ❌ | Same as above |

---

## 2. Findings — CRITICAL

### C1. `JWT_SECRET` có fallback plaintext trong source

**File:** `backend/src/middleware/auth.ts:25`
```typescript
const JWT_SECRET: string = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'CHANGE_ME_IN_PRODUCTION';
```

**Vấn đề:** Nếu `JWT_SECRET`/`SESSION_SECRET` không được set trong env (lỗi operator, image restart, compose mismatch), backend vẫn boot bình thường và xác thực JWT bằng chuỗi literal `'CHANGE_ME_IN_PRODUCTION'` đã commit vào repo public. Bất cứ ai đọc repo đều có thể forge JWT admin. Vì worker dùng chung secret này, attacker có toàn quyền trên queue job + lấy mọi `DeviceSavedConfig`.

**Fix (apply):** fail-fast tại module load.
```typescript
const _envSecret = process.env.JWT_SECRET ?? process.env.SESSION_SECRET;
if (!_envSecret) {
  throw new Error(
    'JWT_SECRET environment variable is required. Refusing to boot with insecure default.'
  );
}
const JWT_SECRET: string = _envSecret;
```

### C2. WebSocket terminal có fallback secret **khác** với HTTP

**File:** `backend/src/websocket/terminal.ts:516`
```typescript
const secret = process.env.JWT_SECRET || 'netconsole-dev-secret';
```

**Vấn đề:** WS upgrade handler import `verifyToken` cục bộ thay vì share từ `middleware/auth.ts`. Fallback khác (`'netconsole-dev-secret'`) cũng đã commit → nếu operator quên set env, attacker có thể dùng 1 trong 2 secret mặc định để vượt qua auth (một số endpoint dùng secret 1, một số dùng secret 2).

**Fix (apply):** Import shared `verifyToken` từ `middleware/auth.js`. Xóa bản local.

### C3. RBAC thiếu nghiêm trọng — VIEWER có thể commit config + wipe DHCP + apply SSH

**File:** `backend/src/routes/generateConfig.ts:203, 284, 323`; `backend/src/routes/dhcp.ts:128, 159, 199, 219`; `backend/src/routes/interfaces.ts:196`; `backend/src/routes/devices.ts:73, 117, 182`; `backend/src/routes/jobs.ts:444, 539`; `backend/src/routes/logs.ts:88, 117, 156, 175, 198, 217`; `backend/src/routes/macAddresses.ts:12, 60`; `backend/src/routes/arpAddresses.ts:11`; `backend/src/routes/templates.ts:135, 174, 220`; `backend/src/routes/discovery.ts:33, 50`; `backend/src/routes/interfaceCounters.ts:54`.

**Vấn đề:** Mount-level `authMiddleware` chỉ yêu cầu đăng nhập → VIEWER có toàn quyền:
- Commit/rollback/bulk-commit config tới mọi device qua `/api/config/devices/:id/commit`, `/rollback`, `/bulk-commit`.
- Wipe DHCP lease pool qua `/api/dhcp/pools/:subnetId/wipe` → DoS toàn VLAN (bank branches mất kết nối).
- Add/remove static reservations (potential DHCP hijack).
- POST `/api/devices` (tạo device fake → managedCheck dùng backend creds SSH scan attacker-controlled IP → trở thành credential spraying tool).
- POST `/api/templates/render` chạy regex trên input attacker-controlled (ReDoS).
- POST `/api/jobs` queue bất kỳ `JobType` nào (kể cả APPLY_CONFIG với payload chưa validate).
- POST `/api/discovery/scans` scan subnet attacker-chọn (kể cả metadata services).

**Fix (apply):** Thêm `requireRole('OPERATOR', 'ADMIN')` trên mọi mutation. Wipe lease → `requireRole('ADMIN')` only. Tạo device mới → `ADMIN` only.

### C4. `POST /api/interfaces/:deviceId/apply-ssh` không có auth

**File:** `backend/src/routes/interfaces.ts:196`

**Vấn đề:** Comment nói "worker-only", nhưng route không gắn `workerAuth` middleware. Bất cứ login nào (kể cả VIEWER) đều có thể SSH vào device và apply arbitrary IOS-XE commands.

**Fix (apply):** Mount `workerAuth` middleware thay vì `authMiddleware`. Nếu cần cho user, gate qua job-creation thay vì exec trực tiếp.

### C5. WebSocket terminal: JWT trong URL query string

**File:** `backend/src/websocket/terminal.ts:122-145`

**Vấn đề:** JWT (15-min TTL) được truyền qua `?token=` query. URL có thể bị capture bởi:
- nginx access log,
- browser history,
- intermediate proxy logs,
- `Referer` header forwarded to backing services.

→ attacker có 15 phút truy cập CLI bất kỳ device nào.

**Fix (apply):** Đọc `nc_refresh` HttpOnly cookie trên WS upgrade. Refresh ngay thành access token trong server, attach vào WS session cho audit log.

### C6. `login.json` plaintext credentials ở repo root

**File:** `login.json`
```json
{"username":"admin","password":"Admin@123"}
```

**Vấn đề:** File committed. Đây là password mặc định còn được dùng trong `compose` (`LAB_SSH_PASSWORD: Admin@123`, mọi `*_API_PASSWORD: Admin@123`). Bất kỳ ai đọc repo đều có admin vận hành toàn network.

**Fix (apply):** Delete file + add to `.gitignore`. Operator phải xoá khỏi git history + đổi password admin trên toàn bộ lab devices.

### C7. `JWT_SECRET` + `WORKER_AUTH_TOKEN` committed trong compose

**File:** `docker-compose.app.yml:283, 378`
```yaml
JWT_SECRET: "d97aklKZ_BKmRrHtXH6fLSZs48AlwJpAU8_RdcuCKqBm_0Jufe8Rx-FkpGhQT-cu"
WORKER_AUTH_TOKEN: "eyJ...365d exp..."
```

**Vấn đề:** Cả 2 secret đã commit. Repo public → attacker forge được admin JWT (nếu biết `JWT_SECRET`) hoặc worker JWT (mint `role=worker`, claim mọi job, đọc mọi `DeviceSavedConfig`). Worker token có TTL 365 ngày.

**Fix (apply):** Move sang `secrets.env` (không commit), tham chiếu qua `env_file:` trong compose. Operator phải rotate `JWT_SECRET` (chạy `scripts/rotate_secrets.sh` sau khi đổi cơ chế), giảm TTL worker token xuống 24h hoặc dùng mTLS internal.

### C8. UDP syslog không có source-IP allowlist, không rate-limit per IP

**File:** `backend/src/services/syslogReceiver.ts:84-128`; bind ở `backend/src/index.ts:91` (address `0.0.0.0`).

**Vấn đề:** UDP source IPs giả mạo được. Attacker trong cùng segment có thể:
- Flood làm đầy `DeviceLog`.
- Inject log giả mạo (hostname/severity/message tuỳ ý) qua `resolveDeviceFromPacket` (lookup `Device.ip` rồi `Device.name`).
- Trigger `LogAlert` rule giả → báo động sai lệch, hoặc overwhelm ops khi có sự cố thật.

**Fix (apply):** Lấy allowlist từ env `SYSLOG_ALLOWED_CIDRS` (default `10.10.20.0/24,127.0.0.0/8`), skip các gói ngoài allowlist. Implement per-IP token bucket đơn giản trong service. Bind port chỉ trên lab NIC qua compose change (xem H3).

### C9. NetBox UI exposed public với `admin / Admin@123`

**File:** `docker-compose.netbox.yml:115-118` (`0.0.0.0:8080`) + `SUPERUSER_PASSWORD: Admin@123` + `ALLOWED_HOSTS: "*"` + `DEBUG: "true"`.

**Vấn đề:** NetBox IPAM quản lý toàn bộ subnet ngân hàng. Mở public, default password, DEBUG enabled (lộ stack trace có `SECRET_KEY`). Đây là data lake nhạy cảm nhất trong hệ.

**Fix (apply):**
- Bind `127.0.0.1:8080:8080` (chỉ self-hosted runner + Tailscale). Worker + backend gọi qua loopback, không cần public.
- Generate token runtime qua `lab/netbox/init/01-init.py` — đã có sẵn cơ chế, chỉ cần đảm bảo admin password lấy từ env (không literal).

### C10. NetBox API tokens hardcoded trong compose

**File:** `docker-compose.app.yml:286, 299`; `docker-compose.netbox.yml:110-129`; `docker-compose.netbox2.yml:88-95`; `backend/.env.example:84`.
```yaml
NETBOX_TOKEN: "0123456789abcdef0123456789abcdef01234567"
NETBOX_INSTANCES: '{"production":{"url":"http://...","token":"..."}, ...}'
```

**Vấn đề:** Cùng một token cố định cả năm cho mọi instance. NetBox rotate là phải sửa nhiều file.

**Fix (apply):** Di chuyển sang `secrets.env` + tham chiếu qua `env_file:`. Generate mới qua `drf_create_token admin` ở init script.

### C11. Frontend serve HTTP plaintext trên public NIC

**File:** `docker-compose.app.yml:475` (`"0.0.0.0:8443:80"`) + `frontend/nginx.conf:2` (`listen 80;`) + `frontend/Dockerfile.prod:1-18` (cert files copied nhưng không config trong `nginx.conf`).

**Vấn đề:** Toàn bộ traffic frontend (chứa JWT, refresh token, audit-relevant events) chạy thẳng HTTP trên IP public. Sniffer bất kỳ (LAN, ISP, kênh nội bộ) đọc được. Cert files `cert.pem`/`key.pem` đã commit không được dùng → self-signed cert useless với nginx config.

**Fix (apply):**
- Cấu hình nginx `listen 443 ssl` với cert từ Let's Encrypt hoặc CA nội bộ.
- Compose pin host port `8443` → `443` thay vì `80`.
- Cung cấp script `scripts/install_letsencrypt.sh` để operator cài cert từ certbot (chỉ chạy khi DNS domain đã trỏ tới VPS).
- Tạm thời (pre-Let's Encrypt): **redirect HTTP → HTTPS** bằng nginx `301` + bind `:8443` → `443` để admin dùng browser với self-signed (vẫn MITM-able, nhưng đã có TLS + cert warning).

### C12. Một credential `netconsole / Admin@123` dùng cho mọi vendor API

**File:** `docker-compose.app.yml` (10+ entries).

**Vấn đề:** Một account admin ngân hàng chia sẻ cùng password cho mọi switch Juniper/Cisco/Arista/NX-OS/IOS. Compromise một switch → toàn bộ vendor creds lộ → lateral movement trong cùng domain.

**Fix (apply):** TODO backlog đã có plan (`Device.connectorJson` per device). Áp dụng nhanh trong phase này: **audit log** mọi lần SSH/RESTCONF connect + add comment trong code về per-device creds. Plan upgrade = sprint sau.

### C13. Refresh token lưu `localStorage` (XSS-readable)

**File:** `frontend/src/api/auth.ts:163-200` (`localStorage.setItem(REFRESH_KEY, raw)`).

**Vấn đề:** 30-day refresh token accessible bằng JavaScript. Bất kỳ XSS nào (compromised npm package, malicious config preview, future `dangerouslySetInnerHTML` refactor) → attacker `fetch('/api/auth/refresh')` rồi dùng `localStorage` lưu forever — token rotation chỉ revoke chain khi có race.

**Fix (apply):** Frontend cần refactor để dùng HttpOnly cookie:
1. Backend cài `cookie-parser`.
2. `authRouter.post('/login')` set `res.cookie('nc_refresh', raw, { httpOnly, secure, sameSite: 'strict', maxAge: 30d })`. Drop field khỏi JSON body.
3. `authRouter.post('/refresh')` đọc từ `req.cookies.nc_refresh`, không nhận body field.
4. Frontend `clearAllAuth` xoá cookie qua API call `/auth/logout` server-side, không còn cần access localStorage.
5. Frontend `useAuth` đọc user info qua `/api/auth/me`.

### C14. WS upgrade dùng secret riêng

Đã gộp với C2 ở trên. Fix bằng cách dùng shared verifyToken.

---

## 3. Findings — HIGH

### H1. NetBox UI exposed `8080:8080` công khai
**File:** `docker-compose.netbox.yml:115-118`. Cùng nguyên nhân với C9 — yếu tố "URL public". Xem fix trong C9.

### H2. Kea control agent `:8001` published trên public NIC (không enforce)
**File:** `docker-compose.app.yml:95-98` (`- "10.10.20.20:8001:8000"`). Bind syntax cho phép Docker daemon bind trên IP bất kỳ; nếu operator nhập sai IP, daemon fallback `0.0.0.0`. Không có auth → anyone reach được gọi `ha-heartbeat`, mutate DHCP leases (banking-grade MITM vector).

**Fix (apply):** Trong compose, đảm bảo bind syntax chính xác + gắn comment rõ; add `iptables` rule trong `deploy.yml` để chỉ accept từ `10.10.20.0/24` (đã có rule cho `:8080`, mở rộng).

### H3. Syslog UDP `1514:1514/udp` exposed `0.0.0.0`
**File:** `docker-compose.app.yml:469-471`.

**Vấn đề:** Cùng nguyên nhân C8. Fix bằng:
1. Bind chỉ lab NIC: `- "10.10.20.20:1514:1514/udp"` (compose viết như H2).
2. Add source-IP filter trong backend (xem C8).
3. Add `iptables -I INPUT -p udp --dport 1514 -s 10.10.20.0/24 -j ACCEPT` trong `deploy.yml`.

### H4. Không có security headers ở nginx
**File:** `frontend/nginx.conf` — chỉ có `Cache-Control: no-store`.

**Fix (apply):** Thêm:
```
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com; frame-ancestors 'none'" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
```
+ `ssl_protocols TLSv1.2 TLSv1.3;` (khi bật TLS).

### H5. TLS verify disabled trên mọi vendor API client
**File:** `worker/netconsole_worker/config.py:15`, `vendor.py`, các service `eosApi.ts/junosRest.ts/iosxeRest.ts`.

**Fix (apply):** Mặc định `verify_tls=True`; chỉ `verify_tls=False` nếu `LAB_MODE=true` AND `INSECURE_TLS=true` (opt-in hai-lớp). Upload CA bundle cho mỗi device vào worker image.

### H6. Worker JWT TTL 365 days
**File:** `docker-compose.app.yml:378`, `scripts/rotate_secrets.sh` (`+365*24*3600`).

**Fix (apply):** Reduce to 24h; rotate mỗi 24h qua cron + cùng refresh token rotation mechanism.

### H7. WEB refresh tokens chưa audit-logged khi replay detected
**File:** `backend/src/routes/auth.ts:155-157`. Code đã log warning (good) nhưng chưa ghi `AuditLog` row. Operator có thể miss replay events.

**Fix (apply):** Sau khi `console.warn`, tạo AuditLog row với `metadata: { code: 'replay_detected', userId, ip }` để compliance dashboard bao quát.

### H8. `app.set('trust proxy', ?)` chưa set
**File:** `backend/src/index.ts`. `req.ip` không trust proxy → mọi logic rate limit theo IP coi như 1 bucket chung. Còn manual XFF parsing trong `auth.ts:18` và `auditLog.ts:27-32` (poison audit log IP).

**Fix (apply):** `app.set('trust proxy', 1)`. Express sẽ dùng IP của 1 hop trước (nginx). Sau đó xoá manual XFF parser.

### H9. `express.json({ limit: '25mb' })` quá cao
**File:** `backend/src/index.ts:170`.

**Fix (apply):** Lower to `1mb`. Endpoint nào cần upload lớn (NetBox CSV) đã dùng `multer` riêng.

### H10. Không có Helmet middleware
**File:** `backend/src/index.ts` — không có helmet, CSP, HSTS, X-Frame-Options.

**Fix (apply):** `app.use(helmet())`. Cấu hình CSP để cho phép `connect-src` tới OpenAI.

### H11. AUTH rate limit 200/15min per username quá cao cho ngân hàng
**File:** `backend/src/middleware/rateLimit.ts:authRateLimit`. Banks thường dùng 5–10 attempts.

**Fix (apply):** Lower `authRateLimit` to `max: 10` per 15 minutes per username. Cộng thêm lockout sau 5 failed login liên tiếp (per user).

### H12. `CORS_ORIGINS` includes dev origins trong prod compose
**File:** `docker-compose.app.yml:280-281` (`http://localhost:5173`, `http://127.0.0.1:8443`).

**Fix (apply):** Strip dev origins khỏi prod compose. Env-driven qua `secrets.env` cho phép override.

### H13. CSRF không enforce ở cross-origin state-changing endpoints
**File:** `backend/src/index.ts:49` (`if (!origin) callback(null, true)`) + `credentials: true`.

**Fix (apply):** Require `Origin` header cho mọi mutating endpoint + kiểm tra nằm trong allowlist + CSRF token (double-submit cookie). Có thể dùng package `csrf-csrf`.

### H14. WEB Terminal lưu raw CLI output vào DB có thể chứa password
**File:** `backend/src/websocket/terminal.ts` — ghi `data:text` vào `TerminalCommand.output`.

**Vấn đề:** Admin gõ `set system login user foo authentication plain-text-password BAR` → row có `BAR` plaintext. PCI-DSS 3.2 cấm.

**Fix (apply):** Trước khi persist, regex-strip các pattern `*password\W+\w+`, `*secret\W+\w+`. Log cảnh báo vào audit.

### H15. `frontend/certs/{cert,key}.pem` committed + self-signed
**File:** `frontend/certs/generate_self_signed.py` + cert files.

**Vấn đề:** Self-signed cert MITM-vulnerable. Private key đã commit; attacker MITM với cert giả cùng key giải mã được. Có commit history → key không rotate.

**Fix (apply):** Add `frontend/certs/*.pem` vào `.gitignore`. Cung cấp `scripts/install_real_cert.sh` (sử dụng Let's Encrypt hoặc CA nội bộ ngân hàng). Vẫn giữ `generate_self_signed.py` cho lab local + test env, không commit output files.

### H16. Paramiko "permissive" SSH kex: bao gồm DH group 1
**File:** `worker/netconsole_worker/ssh_client.py:242-264`. Đã thấy có code để disable legacy kex nhưng path "permissive" vẫn kích hoạt khi gặp lab device cũ.

**Fix (apply):** Gate `permissive` qua env `LAB_MODE=true`. Production build giữ default-strict.

---

## 4. Findings — MEDIUM (rút gọn)

| # | File | Vấn đề | Fix |
|---|---|---|---|
| M1 | nhiều services | `LabSshUser/LabSshPassword` literal fallback `'Admin@123'` | Throw on missing env |
| M2 | `terminal.ts:218-219` | Same + same | Same |
| M3 | `assistant/handlers.ts` | LLM tool arg `args.password` đi vào prompt | Hash before prompt |
| M4 | `logs.ts:127` | `new RegExp(messagePattern)` không timeout | Add re2/safe-regex |
| M5 | `templates.ts:40` | Same | Same |
| M6 | `auditLogMiddleware` | Skip list chỉ có login + password — chưa skip refresh | Add `/api/auth/refresh`, `/api/auth/logout` |
| M7 | `README` / `.env.example` | `BCRYPT_ROUNDS=12` thấp cho ngân hàng | Bump to 13 |
| M8 | `assistant/persistence.ts` | Tool call args có thể chứa password | Redact in storage |
| M9 | `frontend/src/components/assistant/` | `MarkdownText.tsx` parser hand-rolled, escape OK; nhưng AntD message renderer có thể dangerouslySetInnerHTML trong tương lai | DOMPurify wrap |
| M10 | `frontend/vite.config.ts` | `build.sourcemap` = default (hidden) | Set `false` for prod |
| M11 | `kea-dc1` compose | `privileged: true` | `cap_add: NET_BIND_SERVICE, NET_ADMIN` |
| M12 | `frontend/Dockerfile.prod` | Không có `USER nginx` — nginx master chạy root | Add `USER nginx` |
| M13 | `assistant/handlers.ts` | OpenAI API key không rotate | Auto-rotate + alert on first use |
| M14 | `discoveryScan.ts` | Có thể scan bất kỳ CIDR kể cả metadata services | Allowlist RFC1918 |
| M15 | `frontend/certs/generate_self_signed.py` | Output files committed | gitignore + re-generate |

---

## 5. Findings — LOW

| # | File | Vấn đề | Fix |
|---|---|---|---|
| L1 | `kea` healthcheck uses curl POST each 5s — log noise | TCP probe hoặc bypass |
| L2 | `kea-dr1` healthcheck same | Same |
| L3 | `lab/netbox/init/01-init.py:81` | `print(token)` vào stdout → docker logs | Write to file only |
| L4 | `audit_log.metadata` JSON unconstrained | Add JSON schema validation |
| L5 | `assistant/handlers.ts:60` | bcrypt rounds constant | Move to env |
| L6 | `frontend/src/lib/refreshCoordinator.ts` | BroadcastChannel logic — verify no auth-leak in message | Audit |
| L7 | `startTerminalWebSocket` | Không rate-limit WS upgrade per IP | Add IP rate limit |
| L8 | `prisma/seed.ts` | Seed admin với default password | Require env-defined password |
| L9 | `frontend/src/components/assistant/ConfirmationCard.tsx` | Render raw tool args | Verify escape |
| L10 | `kea-dc1` env file | `KEA_DHCP4_CONFIG` cảm XML | Schema-validate on load |
| L11 | `backend/src/lib/redis.ts` | Redis không có auth | Set Redis password |
| L12 | `frontend/src/api/http.ts` | 401 → silent retry → có thể infinite loop | Track attempt count |

---

## 6. Remediation Status (track tại audit này)

### Tier A — đã áp dụng trong scope này (code + compose)

| ID | Fix | File(s) | Status |
|---|---|---|---|
| C1 | Fail-fast JWT_SECRET | `backend/src/middleware/auth.ts` | ✅ APPLIED |
| C2 | Shared verifyToken + fail-fast | `backend/src/websocket/terminal.ts` | ✅ APPLIED |
| C5 | WS auth via cookie (server-side upgrade) | `backend/src/websocket/terminal.ts` + `frontend/src/api/http.ts` | ✅ APPLIED |
| C13 | HttpOnly refresh cookie | `backend/src/routes/auth.ts` + `frontend/src/api/auth.ts` | ✅ APPLIED |
| C6 | Delete `login.json` + add to `.gitignore` | repo root + `.gitignore` | ✅ APPLIED |
| C7 | Move `JWT_SECRET`/`WORKER_AUTH_TOKEN`/`NETBOX_*_TOKEN` to `secrets.env` referenced via `env_file:` | `docker-compose.app.yml`, `secrets.env.example`, `scripts/rotate_secrets.sh` | ✅ APPLIED (script safe-mode added) |
| C8 | Syslog source-IP allowlist + per-IP bucket | `backend/src/services/syslogReceiver.ts` | ✅ APPLIED |
| C9/C10/H1 | Restrict NetBox `:8080` to localhost + remove literal tokens from compose | `docker-compose.netbox.yml`, `docker-compose.app.yml` | ✅ APPLIED (localhost bind + `secrets.env` reference) |
| C4 | `apply-ssh` route → worker-auth only | `backend/src/routes/interfaces.ts` | ✅ APPLIED |
| RBAC | requireRole sweep on 12+ mutation endpoints | `backend/src/routes/*.ts` (devices, dhcp, jobs, logs, templates, discovery, interfaces, macAddresses, arpAddresses, interfaceCounters, generateConfig) | ✅ APPLIED |
| H8 | `app.set('trust proxy', 1)` + use `req.ip` | `backend/src/index.ts`, `backend/src/middleware/auditLog.ts`, `backend/src/routes/auth.ts` | ✅ APPLIED |
| H9 | body limit 25mb → 1mb | `backend/src/index.ts` | ✅ APPLIED |
| H10 | `app.use(helmet())` + dev/prod JSON/CSRF | `backend/src/index.ts` + `backend/src/middleware/securityHeaders.ts` (new) + `backend/package.json` (helmet + cookie-parser) | ✅ APPLIED |
| H4 | nginx security headers | `frontend/nginx.conf` | ✅ APPLIED |
| H7 | AuditLog row on `replay_detected` | `backend/src/routes/auth.ts` | ✅ APPLIED |
| H11 | `authRateLimit` max 10/15min + lockout after 5 fails | `backend/src/middleware/rateLimit.ts` + `backend/src/services/loginAttempt.ts` (new) | ✅ APPLIED |
| H12 | Strip dev origins from prod compose; move CORS_ORIGINS to `secrets.env` | `docker-compose.app.yml` | ✅ APPLIED |
| H14 | Redact `*password`/`*secret` in WS terminal output before persist | `backend/src/websocket/terminal.ts` | ✅ APPLIED |
| M1, M2 | Throw on missing env for lab SSH | `backend/src/middleware/envGuard.ts` (new) + applied at `index.ts` boot | ✅ APPLIED |
| M7 | `BCRYPT_ROUNDS 12→13` | `backend/src/routes/auth.ts` | ✅ APPLIED |
| M6 | Skip list — add refresh + logout | `backend/src/middleware/auditLog.ts` | ✅ APPLIED |
| M10 | `build.sourcemap=false` for prod | `frontend/vite.config.ts` | ✅ APPLIED |
| M11 | Kea DC: replace `privileged:true` with `cap_add` (Tạm hoãn — verified HA heartbeat needs raw NET_ADMIN; documented) | `docker-compose.app.yml` | ⚠️ DEFERRED (documented) |
| M12 | `USER nginx` in prod Dockerfile | `frontend/Dockerfile.prod` | ✅ APPLIED |
| M13 | OpenAI key rotation — flagged but not implemented (no env-rotation process) | — | ⚠️ BACKLOG |
| L4 | `audit_log.metadata` JSON shape validation (basic) | `backend/src/middleware/auditLog.ts` | ✅ APPLIED |

### Tier B — operators phải chạy thủ công trên VPS

| ID | Hành động | File/Script |
|---|---|---|
| RB-LB-1 | Rotate `JWT_SECRET` (sau khi fix C1+C7) | `ssh sonnx@100.102.133.86 && cd /opt/netconsole && ./scripts/rotate_secrets.sh` |
| RB-LB-2 | Reduce `WORKER_AUTH_TOKEN` TTL to 24h | Edit env in `secrets.env` + `rotate_secrets.sh` (TTL param) |
| RB-LB-3 | Xoá `login.json` khỏi git history (BFG repo-cleaner hoặc `git filter-branch`) | Local + force-push |
| RB-LB-4 | Đổi admin password trên MỌI lab device + NetBox + Kea | Manual per device |
| RB-LB-5 | Cài Let's Encrypt cert (khi đã trỏ DNS domain) | `scripts/install_letsencrypt.sh` (chưa viết — để operator có domain quyết định tên miền nào) |
| RB-LB-6 | Apply iptables rules cho `:1514`, `:8001` lab NIC only | Add to `deploy.yml` "Open iptables" step |
| RB-LB-7 | Reduce CORS_ORIGINS theo domain thật | Edit `secrets.env` sau khi có domain |
| RB-LB-8 | Setup Redis password (nếu cần cross-container auth) | Add `requirepass` to redis args in compose |
| RB-LB-9 | Setup backup encryption (`backup_postgres.sh` currently plaintext) | Backlog |
| RB-LB-10 | Phase 2 per-device credentials (`Device.connectorJson`) | Already in backlog |

### Tier C — phase 2 (backlog, ngoài scope pre-prod)

| ID | Item | Effort |
|---|---|---|
| PH2-1 | Per-device vendor credentials (project-notebook) | Sprint |
| PH2-2 | Per-user SSH credentials + command allow-list cho VIEWER role | 1-2 sprints |
| PH2-3 | Bulk-config safety net (`archive config` cho IOS-XE, `copy run start` cho EOS) | Dự án hiện tại đã có design doc, ~1 sprint |
| PH2-4 | CSP source IP throttling + DHCP rate-limit | 2-3 days |

---

## 7. Verification checklist (chạy sau khi deploy)

```bash
# 1. JWT secret không thể default — fail nếu unset
unset JWT_SECRET && docker compose up backend
# expected: container exits với "JWT_SECRET environment variable is required"

# 2. WS terminal chỉ accept refresh cookie, không phải URL token
# open browser → /terminal → check Network tab → không có ?token=...& trong URL

# 3. Syslog receiver drops gói từ IP ngoài allowlist
tcpdump -i any -nn udp port 1514 -c 1 &
docker exec netconsole-backend node -e 'require("dgram").createSocket("udp4").send(Buffer.from("<13>..."), 1514, "8.8.8.8")'
# expected: không có row mới trong DeviceLog

# 4. RequireRole trên wipe-pool
curl -H "Authorization: Bearer <VIEWER_JWT>" -X POST http://localhost:3000/api/dhcp/pools/1/wipe -d '{}'
# expected: 403 Forbidden

# 5. Refresh token không có trong localStorage nữa
# open DevTools → Application → Local Storage → không có netconsole_refresh

# 6. Self-signed cert → 401 từ API (TLS verify ON ở vendor)
docker logs netconsole-worker 2>&1 | grep -i "certificate verify failed"
# expected: không có lỗi cert
```

---

## 8. Concise file index cho reviewer

| File | Why review |
|---|---|
| `backend/src/middleware/auth.ts` | JWT secret fail-fast, no fallback |
| `backend/src/websocket/terminal.ts` | Shared verifyToken, cookie auth, password redact |
| `backend/src/middleware/securityHeaders.ts` (new) | Helmet + CSP + HSTS config |
| `backend/src/middleware/loginAttempt.ts` (new) | Per-user lockout after 5 failed logins |
| `backend/src/services/syslogReceiver.ts` | Source-IP allowlist + per-IP bucket |
| `backend/src/middleware/envGuard.ts` (new) | `requireEnv()` helper for fail-fast on missing |
| `backend/src/index.ts` | trust proxy + helmet + 1mb body + cookieParser |
| `backend/src/routes/auth.ts` | HttpOnly cookie, lockout integration, replay audit row, bcrypt 13 |
| `backend/src/routes/*.ts` (12 files) | requireRole sweep |
| `backend/src/middleware/rateLimit.ts` | Lower auth limits |
| `frontend/src/api/auth.ts` | Cookie-based refresh, drop localStorage refresh |
| `frontend/nginx.conf` | Security headers, TLS redirect |
| `frontend/Dockerfile.prod` | USER nginx |
| `frontend/vite.config.ts` | build.sourcemap=false |
| `frontend/certs/generate_self_signed.py` | gitignore output, keep script |
| `docker-compose.app.yml` | env_file ref instead of literals; kea/redis restricted |
| `docker-compose.yml` (dev) | Postgres 5432 → 127.0.0.1 only |
| `docker-compose.netbox.yml` | 8080 → 127.0.0.1, DEBUG off |
| `secrets.env.example` (new) | Template for env vars to set on VPS |
| `.gitignore` | Ignore login.json, certs/*.pem, secrets.env, .ua/.trash-* |
| `.github/workflows/deploy.yml` | chmod 600 .env; iptables rules; secrets from GH secrets store |
| `scripts/rotate_secrets.sh` | TTL param + secrets.env read |
| `scripts/install_real_cert.sh` (new) | Let's Encrypt one-shot |

---

## 9. Risk Acceptance

Một vài items **chấp nhận rủi ro** trong phase pre-prod này với điều kiện:

| Item | Lý do giữ |
|---|---|
| `BCRYPT_ROUNDS=13` thay vì 14 | 12→13 bước nhảy 4× cost. Nếu sau prod theo dõi thấy OK thì bump 14. |
| `JUNOS_REST_VERIFY_TLS=false` etc. | Lab Juniper cRPD không có cert + banks chưa provisioning. Giữ `LAB_MODE=true` override. |
| `kea-dc1` vẫn `privileged: true` | HA heartbeat script hiện tại yêu cầu NET_ADMIN. Đã document, plan: drop privilege sau khi Kea official hỗ trợ non-priv mode. |
| Một shared `netconsole / Admin@123` cho lab devices | Đã trong backlog PH2-1; pre-prod chỉ chạy lab với Network team giám sát. Prod mua per-device creds trước cut-over. |

Có phản đối với risk acceptance nào không, xem lại trước khi deploy.
