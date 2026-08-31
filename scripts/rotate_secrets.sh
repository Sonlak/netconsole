#!/usr/bin/env bash
# =============================================================================
# rotate_secrets.sh
# Run on VPS as the user that owns /opt/netconsole (sonnx).
# Regenerates JWT_SECRET and WORKER_AUTH_TOKEN, restarts services.
#
# Usage:
#   cd /opt/netconsole
#   ./scripts/rotate_secrets.sh
#
# What it does:
#   1. Generates a new JWT_SECRET (random 64 bytes base64).
#   2. Generates a new WORKER_AUTH_TOKEN (signed JWT with role=worker).
#   3. Updates docker-compose.app.yml in-place.
#   4. Restarts backend + worker.
#   5. Health-checks backend.
#
# Side effects:
#   - Existing user JWTs become INVALID. Users must log in again.
#   - Existing worker JWT becomes INVALID. Worker reconnects with new one
#     immediately because it reads from docker compose env.
# =============================================================================
set -euo pipefail

cd /opt/netconsole

COMPOSE_FILE=/opt/netconsole/docker-compose.app.yml

# 1. Generate secrets
NEW_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')

# We need the new JWT_SECRET to sign the worker token, so do this in two steps:
#   a. Set JWT_SECRET placeholder in compose
#   b. Sign worker token
#   c. Set both back

OLD_IFS="$IFS"
IFS=''
# Use python so we can reliably write a real JWT
WORKER_TOKEN=$(python3 - <<PYEOF
import json, base64, hmac, hashlib, time
secret = "${NEW_JWT_SECRET}"
header = {"alg":"HS256","typ":"JWT"}
payload = {"sub":"worker","role":"worker","iat":int(time.time()),"exp":int(time.time())+365*24*3600}
def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d, separators=(',',':')).encode()).rstrip(b'=').decode()
signing = (b64(header) + "." + b64(payload)).encode()
sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), signing, hashlib.sha256).digest()).rstrip(b'=').decode()
print(b64(header) + "." + b64(payload) + "." + sig)
PYEOF
)
IFS="$OLD_IFS"

echo "Generated new JWT_SECRET and WORKER_AUTH_TOKEN"

# 2. Backup compose
cp -p "$COMPOSE_FILE" "${COMPOSE_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# 3. Replace in compose. We assume the form:
#      JWT_SECRET: "..."
#    appears once and
#      WORKER_AUTH_TOKEN: "..."
#    appears once (in worker section).
python3 - <<PYEOF
import re, sys
with open("${COMPOSE_FILE}", "r", encoding="utf-8") as f:
    content = f.read()

new_secret = "${NEW_JWT_SECRET}"
new_token  = "${WORKER_TOKEN}"

# Replace JWT_SECRET line if present, else insert in backend env
if re.search(r'^\s*JWT_SECRET:\s*"', content, re.MULTILINE):
    content = re.sub(r'^(\s*)JWT_SECRET:\s*"[^"]*"', r'\1JWT_SECRET: "{}"'.format(new_secret), content, count=1, flags=re.MULTILINE)
else:
    # insert right after backend depends_on / environment:
    content = re.sub(
        r'(environment:\s*\n)',
        r'\1      JWT_SECRET: "{}"\n'.format(new_secret),
        content,
        count=1,
    )

# Replace or insert WORKER_AUTH_TOKEN in worker environment block
# Find the worker environment section and add/replace token
def patch_worker(m):
    block = m.group(0)
    if re.search(r'WORKER_AUTH_TOKEN:', block):
        block = re.sub(r'WORKER_AUTH_TOKEN:\s*"[^"]*"', 'WORKER_AUTH_TOKEN: "{}"'.format(new_token), block, count=1)
    else:
        block = re.sub(r'(environment:\s*\n)', r'\1      WORKER_AUTH_TOKEN: "{}"\n'.format(new_token), block, count=1)
    return block

content = re.sub(
    r'  worker:\s*\n(?:    [^\n]*\n)*?(?=  frontend:|networks:)',
    patch_worker,
    content,
    count=1,
    flags=re.MULTILINE,
)

with open("${COMPOSE_FILE}", "w", encoding="utf-8") as f:
    f.write(content)
print("compose file updated")
PYEOF

# 4. Restart backend + worker
docker compose -p netconsole -f "$COMPOSE_FILE" up -d --no-deps --force-recreate backend worker

# 5. Health check
echo "Waiting for backend to come back up..."
for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 3 http://172.31.0.3:3000/api/health; then
        echo "✅ Backend healthy after ${i} attempt(s)"
        echo
        echo "⚠️  All user sessions invalidated. Users must log in again."
        exit 0
    fi
    sleep 2
done

echo "❌ Backend did not become healthy within 60s"
docker logs --tail 40 netconsole-backend
exit 1