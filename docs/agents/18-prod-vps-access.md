# PRODUCTION VPS — ACCESS GUIDE & PROD REVIEW (2026-10-26)

> **ĐỌC FILE NÀY TRƯỚC KHI LÀM BẤT CỨ VIỆC GÌ LIÊN QUAN ĐẾN PROD.**
> Sửa/verify mọi thứ trên prod đều đi qua 2 hop. Sai hop = mất 30 phút.

---

## 1. ĐƯỜNG VÀO PROD (2 HOP — ĐÃ TEST 2026-10-26)

```
Windows (Tailscale 100.68.137.102)
   │  ssh sonnx@100.102.133.86
   ▼
VPS NETCONSOLE (dev/test) — hostname: netconsole-vps
   Tailscale 100.102.133.86  |  LAN nội bộ 10.10.20.20
   │  ssh sonnx@10.10.20.40
   ▼
VPS PROD — hostname: netconsole-pd
   ens33 192.168.81.171  (LAN văn phòng — user mở console ở đây)
   ens34 10.10.20.40     (LAN nội bộ — nối với dev VPS 10.10.20.20)
```

**HOP 1 — vào vps netconsole (qua Tailscale):**

```bash
ssh sonnx@100.102.133.86
```

**HOP 2 — từ vps netconsole sang prod (qua IP private):**

```bash
ssh sonnx@10.10.20.40
```

**Gộp 1 dòng (chạy từ Windows, an toàn với PowerShell):**

```bash
ssh -t sonnx@100.102.133.86 "ssh -t sonnx@10.10.20.40 'hostname; docker ps --format \"{{.Names}} | {{.Status}}\"'"
```

> **Cảnh báo PowerShell:** nested quotes trong 1 dòng của PowerShell hay vỡ
> (`Expressions are only allowed as the first element of a pipeline`). Khi đó
> **đừng** debug lệnh — hãy chuyển sang 2 bước riêng, hoặc dùng cách pipe
> script (mục 2).

### 1b. Cách pipe script (KHUYẾN NGHỊ — không bị quote vỡ)

Viết script bash ra file (UTF-8, **LF** — xem gotcha #3), rồi:

```bash
# script chạy trên DEV vps (netconsole-vps):
ssh sonnx@100.102.133.86 "bash -s" < script.sh

# script chạy trên PROD (netconsole-pd):
ssh sonnx@100.102.133.86 "ssh sonnx@10.10.20.40 'bash -s'" < script.sh
```

Đây đúng là cách đã dùng để review prod ngày 2026-10-26.

---

## 2. FACTS PROD (đã verify — đừng đoán lại)

| Hạng mục | Giá trị |
| --- | --- |
| Hostname | `netconsole-pd` (RHEL 10.2, /dev/mapper/rhel-root 70G) |
| LAN văn phòng (entry point user) | `192.168.81.171` — console `https://192.168.81.171:8443` |
| LAN nội bộ (nối dev VPS) | `10.10.20.40` — dev VPS là `10.10.20.20` |
| NetBox UI | `http://192.168.81.171:8080` |
| Deploy dir | `/opt/netconsole` |
| Marker commit | `/opt/netconsole/.last-deploy-sha` = `dc284ef0e7a07141386dd0a0391a59c2729cc6e8` |
| Deploy qua CI | push vào `main` → workflow **Deploy Prod** (`deploy-prod.yml`) |
| Prod KHÔNG có Tailscale | prod không thuộc tailnet; chỉ có `netconsole-vps` (100.102.133.86), `gotothemoon-vps` (100.105.166.18), `xuanson-win` (100.68.137.102) |
| Containers | backend (healthy), frontend, worker-1, worker-2, postgres, redis, kea-dc (healthy), netbox-netbox (**unhealthy**), netbox-postgres, netbox-redis |

### Credentials prod

| Service | User | Password |
| --- | --- | --- |
| NetConsole console | `admin` | `NCP-Admin-2026xQ7` |
| NetBox | `admin` | xem `secrets.env` (`NETBOX_SUPERUSER_PASSWORD`) |

> **`Admin@123` KHÔNG đăng nhập được vào prod** → 401 `Invalid credentials`.
> `Admin@123` chỉ dùng cho VPS dev (42.119.165.109). Password prod đã được
> rotate ngày 2026-10-22 (`docs/sessions/2026-10-22.md`) mà **chưa báo lại user**.

### DB prod

- `User` table: đúng 1 dòng — `admin` / `admin@netconsole.local` / role `ADMIN` /
  `active=t` / `mustChangePassword=f` / `totpEnabled=f` (tạo 2026-10-22 08:52Z,
  đổi pass 09:51Z).
- Prod là DB sạch (không dữ liệu dev) — đúng yêu cầu "lấy dữ liệu mới hoàn toàn".

---

## 3. KẾT QUẢ REVIEW PROD — 2026-10-26 (đã test thật, không phải suy đoán)

### Cái đã ĐÚNG

1. Deploy pipeline chạy đúng: CI `Deploy Prod` success, marker = commit trên `main`,
   `/api/health` trả 200 (`gitCommit: dc284ef`).
2. Login qua nginx **hoạt động**: `POST https://192.168.81.171:8443/api/auth/login`
   với `NCP-Admin-2026xQ7` → **200 + token**; với `Admin@123` → 401.
3. Preflight `OPTIONS /api/auth/login` qua nginx → 204, `access-control-allow-origin`
   = origin của browser (same-origin detection dựa `X-Forwarded-Host`).
4. Frontend build không hardcode API URL (gọi relative `/api`) → không lệch host.

### LỖI / ĐỂ MỞ (xếp theo mức độ ảnh hưởng)

| # | Vấn đề | Bằng chứng | Hệ quả | Fix |
| --- | --- | --- | --- | --- |
| **L1** | **Console prod không truy cập được từ PC ngoài LAN `192.168.81.0/24`** — prod không có Tailscale; Tailscale cài thử 2026-10-26 nhưng `controlplane.tailscale.com` / `derp*` đều **timeout** (chỉ HTTP(S) qua proxy `192.168.154.101:1985` mới ra ngoài được) → đã **gỡ lại**. | `Test-NetConnection 192.168.81.171 -Port 8443` fail từ PC (192.168.101.236) | User mở console không được | Tunnel qua dev VPS: `ssh -L 8443:192.168.81.171:8443 sonnx@100.102.133.86` → `https://localhost:8443` (origin này đã có trong `CORS_ORIGINS`). Hoặc mở NAT public, hoặc subnet-router trên dev VPS |
| **L2** | **TLS cert prod vẫn là cert fallback trong image**: `CN=localhost`, SAN `DNS:localhost, IP:127.0.0.1` | `openssl x509` trong container `netconsole-frontend` | Browser báo **lỗi tên miền** khi vào `https://192.168.81.171:8443` (không chỉ warning) | Let's Encrypt trên DNS public (`scripts/install_lets_encrypt.sh`) hoặc sinh cert có SAN đúng IP |
| **L3** | **NetBox container kẹt `unhealthy` vĩnh viễn**: healthcheck `curl -sf http://localhost:8080/api/` → NetBox 4.x trả **403** (API cần auth) | `FailingStreak: 10826`, exit code 22 | Mọi thứ phụ thuộc `service_healthy` của netbox có thể đứng; cảnh báo đỏ mỗi lần deploy | Đổi healthcheck sang `http://localhost:8080/login/` (trả 200) |
| **L4** | **NetBox API token chưa có**: bảng `users_token` **rỗng**, còn `NETBOX_INSTANCES.production.token` trong env backend là **placeholder** `0123456789abcdef...` | `POST /api/dcim/sites/?limit=1` với token đó → **403** | Tính năng NetBox (import device, prefix sync) **không hoạt động** trên prod — log sync toàn `updated=0 failed=0` | Tạo API token trong NetBox (user `admin`), đặt vào `secrets.env` (`NETBOX_TOKEN` / `NETBOX_INSTANCES`), deploy lại |
| **L5** | **Deploy probe NetBox sai**: `curl -sf http://192.168.81.171:8080/api/dcim/sites/?limit=1` không kèm token → 403 → **mỗi lần deploy mất 5 phút** chờ rồi `::warning::NetBox not healthy in 5 min` | log deploy + curl tay | Deploy chậm + cảnh báo giả | Probe `/login/` (200, không cần token) hoặc kèm `Authorization: Token` |
| **L6** | `CORS_ORIGINS` của prod **không có** origin của chính prod (`https://192.168.81.171:8443`) — chỉ có `localhost:8443` + `42.119.165.109:8443` (origin dev) | env container `netconsole-backend` | Qua nginx vẫn OK (same-origin). Nhưng **gọi thẳng backend** (`:3000`) với `Origin` → 403 `CORS not allowed` — đây là hành vi **đúng**, không phải bug | (tuỳ) thêm origin prod + các URL tunnel vào `CORS_ORIGINS` |

### Ghi chú khác

- NetBox 4.x đổi tên bảng: `users_user` / `users_token` (không còn `auth_user`,
  `authtoken_token`). Query bằng tên cũ sẽ báo `relation does not exist`.
- `docker exec` cần `sudo -n` với user `sonnx` trên prod (docker group không
  có quyền root).
- Host prod **không ping được** ra ngoài trực tiếp (`ping 42.119.165.109` 100%
  loss) — chỉ đi qua proxy. Không dùng ping để test connectivity, dùng `curl`.
- Cert trong container prod được mount từ image, `ls /opt/netconsole/certs` trống
  → Let's Encrypt chưa cài.

---

## 4. CHECKLIST NHANH KHI VÀO PROD

```bash
# 1. Vào prod
ssh sonnx@100.102.133.86            # hop 1
ssh sonnx@10.10.20.40               # hop 2

# 2. Trạng thái
hostname                            # netconsole-pd
cat /opt/netconsole/.last-deploy-sha
docker ps --format '{{.Names}} | {{.Status}}'

# 3. API sống?
curl -s http://127.0.0.1:3000/api/health | head -c 200

# 4. Login test (dùng password đúng!)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"NCP-Admin-2026xQ7"}'      # -> 200
#    Admin@123 -> 401 (SAI, đó là password của VPS dev)

# 5. Log nhanh
docker logs --tail 40 netconsole-backend
```

---

## 5. SỬA GÌ (code) → QUA GIT, KHÔNG SỬA TRỰC TIẾP TRÊN VPS

Deploy prod = push `main` → GitHub Actions (`Deploy Prod`). Mọi fix L2–L6 phải
commit vào `main` rồi push, **không** edit file trên VPS.

Fix gợi ý (file cụ thể):

- L3: `docker-compose.netbox.yml` — healthcheck `http://localhost:8080/api/` →
  `http://localhost:8080/login/`.
- L5: `.github/workflows/deploy-prod.yml` — probe NetBox dùng `/login/`.
- L4: `scripts/` — thêm bước tạo/verify NetBox API token sau khi NetBox healthy
  (superuser + token phải nằm trong `secrets.env`, không hardcode).
- L2: `scripts/install_lets_encrypt.sh` (đã có sẵn) + mount cert vào
  `netconsole-frontend`.
