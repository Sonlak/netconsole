# NetConsole — Pre-Production Security Runbook (Operator)

> **Ngày viết:** 2026-10-18
> **Đi kèm với:** `docs/agents/16-security-audit-preprod.md` (full audit report)
> **Người thực hiện:** một operator có SSH + sudo trên VPS `100.102.133.86`
> **Thời gian ước tính:** 1–2 giờ tổng (gồm đợi TTL DNS nếu chưa trỏ domain)

Tài liệu này là checklist các bước **operator chạy thủ công** trên VPS sau khi code đã deploy. Một số bước **phải chạy trước cut-over prod**, một số có thể làm sau. Từng bước có lý do + rollback.

---

## A. Bắt buộc trước production cut-over

### A1. Rotate `JWT_SECRET` (C7 — CRITICAL)

**Lý do:** Secret hiện tại đã commit trong git history. Repo public → attacker forge được admin JWT.

**Bước:**

```bash
ssh sonnx@100.102.133.86
cd /opt/netconsole

# (1) Tạo secrets.env từ template (CHỈ chạy lần đầu)
./scripts/rotate_secrets.sh --initial
chmod 600 secrets.env

# (2) Điền vendor credentials, NetBox tokens, CORS_ORIGINS bằng vim:
vim secrets.env

# (3) Đặt passphrase mạnh cho admin (bước A4 sẽ đổi bên trong DB).

# (4) Quay JWT_SECRET + WORKER_AUTH_TOKEN:
./scripts/rotate_secrets.sh
# → tự động:
#   - generate JWT_SECRET mới (48 bytes base64)
#   - mint WORKER_AUTH_TOKEN 24h (signed với secret mới)
#   - ghi cả 2 vào secrets.env (chmod 600)
#   - restart backend + worker
#   - health-check
```

**Sau bước này:**
- Mọi user access JWT (15 phút TTL) sẽ hết hạn trong vòng 15 phút.
- Mọi user phải đăng nhập lại.
- Worker JWT cũ (24h) bị revoke; worker reconnect với token mới từ env.

**Rollback:** Không có — không có secret "cũ" để quay về. Nếu backend không start sau rotate, xem logs:

```bash
docker logs --tail 40 netconsole-backend
```

### A2. Đổi password admin trên toàn bộ lab devices (M2)

**Lý do:** Vendor credentials (`LAB_SSH_PASSWORD`, `JUNOS_REST_PASSWORD`, `IOSXE_API_PASSWORD`, `EOS_API_PASSWORD`, `NXOS_API_PASSWORD`, `IOS_HTTP_PASSWORD`) đều share giá trị `Admin@123` đã commit. Cần đổi trước cut-over.

**Bước (lab device-by-device):**

```bash
# 1. SSH vào từng switch/router (Juniper/Cisco/Arista/NX-OS/IOS),
#    đổi password 'netconsole' thành một giá trị mới.
# 2. Cập nhật secrets.env trên VPS:
vim /opt/netconsole/secrets.env
# sửa:
LAB_SSH_PASSWORD=<new>
JUNOS_REST_PASSWORD=<new>
IOSXE_API_PASSWORD=<new>
EOS_API_PASSWORD=<new>
NXOS_API_PASSWORD=<new>
IOS_HTTP_PASSWORD=<new>

# 3. Restart backend + worker để pick up env mới:
docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml \
  up -d --no-deps --force-recreate backend worker

# 4. Trigger managedCheck scheduler để verify:
curl -H "Authorization: Bearer $ADMIN_JWT" -X POST \
  http://127.0.0.1:3000/api/devices/<device_id>/sync-netbox

# Hoặc đợi 3 phút cho scheduler chạy tự động (MANAGED_CHECK_INTERVAL_SECONDS=180).
```

**Sau bước này:**
- Không còn password shared `Admin@123` đi qua domain ngân hàng.

**Backlog:** Per-device credentials (`Device.connectorJson`) — phase 2 ngoài scope pre-prod. Khi cut-over thật, mỗi switch nên có credential riêng.

### A3. Đổi NetBox superuser password (C10)

**Lý do:** `SUPERUSER_PASSWORD: Admin@123` đã commit trong `docker-compose.netbox.yml`. Token API cũng bị lộ.

**Bước:**

```bash
# 1. SSH vào VPS.
ssh sonnx@100.102.133.86
cd /opt/netconsole

# 2. Đổi superuser password:
docker exec -it netconsole-netbox /bin/bash -lc "python manage.py shell -c \
\"from django.contrib.auth import get_user_model; \
u = get_user_model().objects.get(username='admin'); \
u.set_password('<new-strong-password>'); \
u.save()\""

# 3. Rotate API token:
docker exec -it netconsole-netbox /bin/bash -lc "python manage.py drf_create_token admin"
# → copy token, paste vào /opt/netconsole/secrets.env
vim /opt/netconsole/secrets.env
# sửa: NETBOX_TOKEN=<new>

# 4. Restart backend + worker:
docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml \
  up -d --no-deps --force-recreate backend worker
```

### A4. Đổi password admin NetConsole (admin user, không phải NetBox)

```bash
# 1. Login như admin (password cũ - default là 'Admin@123' nếu chưa đổi).
# 2. Settings → Users → admin → Change password.
# Hoặc programmatic:
NEW_PW="$(openssl rand -base64 24 | tr -d '\n')"
docker exec -it netconsole-backend sh -c "node -e \"
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();
(async () => {
  const h = await bcrypt.hash('$NEW_PW', 13);
  await p.user.update({ where: { username: 'admin' }, data: { password: h } });
  console.log('OK');
  await p.\$disconnect();
})();
\""
echo "New admin password: $NEW_PW"
# Lưu vào password manager (Bitwarden / 1Password), không echo ra git.
```

### A5. Cài TLS cert thật (C11)

**Lý do:** Self-signed cert MITM-vulnerable.

**Tiên quyết:**
- Domain A-record đã trỏ về VPS public IP (42.119.165.109).
- Tên miền đã mua (đề xuất: `netconsole.tailocbank.vn` — chọn theo domain ngân hàng).

**Bước:**

```bash
ssh sonnx@100.102.133.86
cd /opt/netconsole

# (1) Kiểm tra DNS đã resolve đúng:
dig +short netconsole.tailocbank.vn
# expected: 42.119.165.109

# (2) Install + obtain cert:
sudo ./scripts/install_lets_encrypt.sh netconsole.tailocbank.vn

# (3) Verify:
curl -I https://netconsole.tailocbank.vn/api/health
# expected: HTTP/2 200 (no cert warning)
```

**Sau bước này:**
- Trình duyệt không còn hiển thị "Your connection is not private".
- Certbot tự động rotate mỗi 60 ngày.

**Rollback:** Nếu cert install fail, frontend vẫn dùng self-signed cert — không có downtime. Check `/var/log/letsencrypt/letsencrypt.log`.

### A6. iptables hardening (H2, H3)

**Lý do:** Compose bind port `8001` (Kea control) + `1514/udp` (syslog) trên lab NIC là dạng optional. Cần chặn ở host firewall phòng case bind nhầm `0.0.0.0`.

**Bước:**

```bash
# 1. Syslog UDP chỉ accept từ lab subnet (10.10.20.0/24):
sudo iptables -I INPUT -p udp --dport 1514 ! -s 10.10.20.0/24 \
  -j DROP -m comment --comment "netconsole-syslog"
sudo iptables -I INPUT -p udp --dport 1514 -s 10.10.20.0/24 \
  -j ACCEPT -m comment --comment "netconsole-syslog-allow"

# 2. Kea control agent (port 8001 host) — chỉ accept từ local backend (172.31.0.3):
sudo iptables -I INPUT -p tcp --dport 8001 ! -s 127.0.0.0/8 \
  -j DROP -m comment --comment "netconsole-kea-ca"

# 3. Verify rules:
sudo iptables -L INPUT --line-numbers -n | grep -E '(1514|8001)'

# 4. Persist:
sudo netfilter-persistent save   # Debian/Ubuntu
sudo service iptables save       # CentOS/RHEL
```

**Backup:** `sudo iptables-save > /etc/iptables.rules.bak` trước khi sửa.

### A7. Đổi tất cả SSH keys trên lab devices (optional — phase 2)

**Lý do:** Nếu netconsole SSH key bị lộ (qua git, qua log), attacker có thể SSH vào switch mà không cần password. Phase 2 plan = per-device keys.

**Hiện tại:** Backend dùng password auth, không key-based. Nếu sau này nâng cấp, hãy dùng vault-managed SSH key rotation.

---

## B. Có thể làm sau (first 24h của production)

### B1. Setup backup encryption (L9 backlog)

`scripts/backup_postgres.sh` hiện tại dump plaintext. Nếu cần backup ra ngoài VPS (Tailscale NAS, S3, B2), **encrypt GPG trước khi gửi**:

```bash
# Trong script backup, thêm:
gpg --batch --symmetric --cipher-algo AES256 \
  --passphrase-file /etc/netconsole/backup-passphrase \
  < backup.sql > backup.sql.gpg
```

### B2. Setup Redis password (nếu cần cross-network auth)

```yaml
# docker-compose.app.yml, redis section:
command:
  - redis-server
  - --requirepass
  - ${REDIS_PASSWORD:?REDIS_PASSWORD must be set}
```

### B3. Đặt OpenAI key lên Vault (hiện lưu thẳng trong env)

Hiện tại `OPENAI_API_KEY` lưu trong `/opt/netconsole/.env` (chmod 600 bởi deploy workflow). Để strict hơn:

```bash
# Rotate via GitHub Actions secret + tự động rotate mỗi 90 ngày
echo "OPENAI_API_KEY=$(gh secret get OPENAI_API_KEY 2>/dev/null || echo '')" >> /opt/netconsole/.env
```

### B4. Enable audit log Ship to SIEM

Có thể forward `AuditLog` table → Splunk / ELK / Graylog:
- Set retention cao hơn (`LOG_RETENTION_DAYS=365` hoặc archive sang cold storage).
- Add a cron job để dump rows > 30 ngày vào NAS/S3.

---

## C. Khi sự cố / remediation

### C1. Compromised JWT_SECRET

```bash
# Quay JWT_SECRET khẩn cấp (≈30s, restart backend):
ssh sonnx@100.102.133.86
cd /opt/netconsole
./scripts/rotate_secrets.sh
# → Tất cả user bị logout. Worker reconnect với token mới.
```

### C2. Replay attack detected (`refresh_detected` event)

- Audit log đã tự động record event (xem Settings → Users → Audit Log filter `code=replay_detected`).
- Toàn bộ refresh chain của user đó bị revoke; họ phải login lại.
- Nếu lặp lại nhiều lần: lock account thủ công, kiểm tra XSS trên session user.

### C3. Kea subnet bị wipe (`POST /api/dhcp/pools/:id/wipe`)

```bash
# 1. Check audit log: ai đã wipe, khi nào, từ IP nào.
docker exec -it netconsole-postgres psql -U netconsole -d netconsole \
  -c "SELECT username, ip, createdat, action FROM \"AuditLog\" WHERE action LIKE '%wipe%' ORDER BY createdat DESC LIMIT 10;"

# 2. Khôi phục leases từ DR peer (nếu DHCP đang ở chế độ HA):
# (Kea HA đã sync sang DR mỗi 10s, nên chỉ mất ~10s lease gần nhất.)

# 3. Restart Kea primary nếu cần:
docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml restart kea-dc1
```

### C4. Compromised admin credentials

```bash
# 1. Login vào NetConsole, đổi password admin.
# 2. Force-logout mọi sessions:
curl -H "Authorization: Bearer $ADMIN_JWT" -X POST \
  http://127.0.0.1:3000/api/auth/logout-all

# 3. Deactivate admin nếu cần (qua UI hoặc DB):
docker exec -it netconsole-backend sh -c "node -e \"
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.update({ where: { username: 'compromised-admin' }, data: { active: false } })
  .then(() => console.log('deactivated'));
\""

# 4. Audit log review:
psql -c "SELECT * FROM \"AuditLog\" WHERE username='compromised-admin' ORDER BY createdat DESC LIMIT 100;"

# 5. Rotate JWT_SECRET (đảm bảo attacker mất session):
./scripts/rotate_secrets.sh
```

---

## D. Verification checklist

Chạy sau mỗi deploy / mỗi rotate. Mỗi command có expected output.

```bash
# 1. Backend không start nếu thiếu JWT_SECRET (kiểm tra fail-fast)
unset JWT_SECRET; docker compose up backend 2>&1 | head -5
# expected: exits với "JWT_SECRET environment variable is required"

# 2. WS terminal không chấp nhận URL token, chỉ cookie:
# (Mở browser tới https://$DOMAIN/terminal. Trong DevTools Network → WS handshake,
# không có query param ?token=..., chỉ có Cookie: nc_refresh=...)

# 3. Syslog reject packet từ IP ngoài allowlist:
docker exec netconsole-backend node -e '
const dgram = require("dgram");
const c = dgram.createSocket("udp4");
c.send(Buffer.from("<13>FAKE-TEST"), 1514, "8.8.8.8");
'
sleep 2
docker logs netconsole-backend --tail 5 | grep -c "dropped .* non-allowlisted"
# expected: > 0 (drop count > 0)

# 4. VIEWER không wipe được DHCP pool:
VIEWER_JWT=$(...)
curl -H "Authorization: Bearer $VIEWER_JWT" -X POST \
  http://127.0.0.1:3000/api/dhcp/pools/1/wipe
# expected: 403 Forbidden

# 5. Refresh token đã có trong HttpOnly cookie:
curl -i -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}' | grep -i 'set-cookie'
# expected: Set-Cookie: nc_refresh=...; HttpOnly; SameSite=Strict; Path=/api/auth

# 6. Self-signed cert thay bằng CA cert (sau khi chạy install_lets_encrypt.sh):
curl -I https://netconsole.tailocbank.vn/api/health
# expected: không có cert warning trong browser
```

---

## E. Liên hệ khi cần

| Vấn đề | Liên hệ |
|---|---|
| Cert / DNS / Domain | ops@tailocbank.vn |
| Backend issue | xem logs: `docker logs --tail 100 -f netconsole-backend` |
| Worker issue | `docker logs --tail 100 -f netconsole-worker-1` |
| NetBox issue | `docker logs --tail 100 -f netconsole-netbox` |
| Kea issue | `docker logs --tail 100 -f netconsole-kea-dc` |
| Syslog issue | `docker logs --tail 100 -f netconsole-backend 2>&1 \| grep -E '\[syslog\]'` |

Khi cần mở incident: tạo `docs/sessions/YYYY-MM-DD-incident-<short>.md` ngay lập tức (xem existing pattern trong `docs/sessions/`).
