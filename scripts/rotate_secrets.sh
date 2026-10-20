#!/usr/bin/env bash
# =============================================================================
# rotate_secrets.sh
# SECURITY (C7, see docs/agents/16-security-audit-preprod.md)
#
# Regenerate JWT_SECRET and WORKER_AUTH_TOKEN, refresh secrets.env on
# the VPS, restart backend + worker. PRODUCTION deploys use
# secrets.env (NOT in compose YAML). This script reads/writes that
# file so secrets never have to be re-typed by hand.
#
# Usage:
#   cd /opt/netconsole
#   ./scripts/rotate_secrets.sh                 # standard rotation
#   ./scripts/rotate_secrets.sh --initial       # first-time setup
#                                            # (creates secrets.env
#                                            # from secrets.env.example)
#   ./scripts/rotate_secrets.sh --worker-ttl HOURS
#                                            # override the default
#                                            # 24h worker JWT lifetime
#
# What it does:
#   1. Generates a new JWT_SECRET (random 64 bytes base64).
#   2. Mints a new WORKER_AUTH_TOKEN (signed JWT with role=worker, TTL
#      configurable via --worker-ttl; default 24h, NOT 365d like the
#      pre-prod version used to commit).
#   3. Writes both into secrets.env (creates from .example on --initial).
#   4. Restarts backend + worker via docker compose.
#   5. Health-checks backend.
#
# Side effects:
#   - All existing user JWTs become INVALID. Users must log in again.
#   - Worker container starts using the new token within ~5s.
#   - secrets.env is chmod 600 (no other user can read).
# =============================================================================

set -euo pipefail

cd /opt/netconsole

SECRETS_FILE=/opt/netconsole/secrets.env
EXAMPLE_FILE=/opt/netconsole/secrets.env.example
DEPLOY_DIR=/opt/netconsole

WORKER_TTL_HOURS=24
INITIAL=0

while [[ "${1:-}" != "" ]]; do
  case "$1" in
    --initial)
      INITIAL=1
      shift
      ;;
    --worker-ttl)
      WORKER_TTL_HOURS="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

# Sanity: TTL bounded. 24h default; never let an operator accidentally
# produce a 365d token by typing the wrong flag.
if [[ ! "$WORKER_TTL_HOURS" =~ ^[0-9]+$ ]] || [ "$WORKER_TTL_HOURS" -lt 1 ] || [ "$WORKER_TTL_HOURS" -gt 8760 ]; then
  echo "WORKER_TTL_HOURS must be 1..8760 (1 hour to 1 year). Got: $WORKER_TTL_HOURS"
  exit 1
fi

# First-time setup: copy the example, prompt the operator to fill in
# remaining required values, then exit early so they can edit secrets.env
# before the second invocation.
if [ "$INITIAL" = "1" ]; then
  if [ -f "$SECRETS_FILE" ]; then
    echo "secrets.env already exists at $SECRETS_FILE — refusing to overwrite."
    echo "Re-run without --initial to rotate the existing values."
    exit 1
  fi
  if [ ! -f "$EXAMPLE_FILE" ]; then
    echo "Missing template: $EXAMPLE_FILE"
    exit 1
  fi
  cp -p "$EXAMPLE_FILE" "$SECRETS_FILE"
  chmod 600 "$SECRETS_FILE"
  echo "Created $SECRETS_FILE from template."
  echo "Edit it (vim / nano) to fill in JWT_SECRET + all vendor passwords,"
  echo "then re-run this script with no args to mint a WORKER_AUTH_TOKEN."
  exit 0
fi

if [ ! -f "$SECRETS_FILE" ]; then
  echo "secrets.env not found at $SECRETS_FILE — run with --initial first."
  exit 1
fi

# 1. Generate a fresh JWT_SECRET (48 bytes base64 = 64 chars; >= 32
#    is the security floor enforced by middleware/auth.ts).
NEW_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')

# 2. Mint a fresh WORKER_AUTH_TOKEN signed with the new secret.
#    (WORKER_TTL_HOURS bounded above.)
WORKER_TOKEN=$(python3 - <<PYEOF
import json, base64, hmac, hashlib, time
secret = "${NEW_JWT_SECRET}"
header = {"alg":"HS256","typ":"JWT"}
exp_seconds = ${WORKER_TTL_HOURS} * 3600
payload = {"sub":"worker","role":"worker","type":"worker",
           "iss":"netconsole-backend","aud":"netconsole",
           "iat":int(time.time()),"exp":int(time.time())+exp_seconds}
def b64(d):
    return base64.urlsafe_b64encode(json.dumps(d, separators=(',',':')).encode()).rstrip(b'=').decode()
signing = (b64(header) + "." + b64(payload)).encode()
sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), signing, hashlib.sha256).digest()).rstrip(b'=').decode()
print(b64(header) + "." + b64(payload) + "." + sig)
PYEOF
)

# 3. Backup current secrets.env.
cp -p "$SECRETS_FILE" "${SECRETS_FILE}.bak.$(date +%Y%m%d_%H%M%S)"

# 4. Update JWT_SECRET and WORKER_AUTH_TOKEN in secrets.env in-place.
#    Other vars (NetBox tokens, vendor creds, CORS_ORIGINS) are left
#    alone — they don't need to rotate together.
python3 - <<PYEOF
import re
path = "${SECRETS_FILE}"
new_secret = "${NEW_JWT_SECRET}"
new_token  = """${WORKER_TOKEN}"""

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

def patch(key, value):
    global content
    pattern = rf'^{re.escape(key)}=.*$'
    if re.search(pattern, content, flags=re.MULTILINE):
        content = re.sub(pattern, f'{key}={value}', content, flags=re.MULTILINE, count=1)
    else:
        # Append at the end, no section header reordering.
        if not content.endswith('\n'):
            content += '\n'
        content += f'{key}={value}\n'

patch('JWT_SECRET', new_secret)
patch('WORKER_AUTH_TOKEN', new_token)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print("secrets.env updated")
PYEOF

# 5. Lock down permissions.
chmod 600 "$SECRETS_FILE"

# 6. Restart the two services that consume these env vars.
# SECURITY+correctness: must pass --env-file secrets.env (the deploy
# workflow does this on every invocation; we have to mirror it here,
# otherwise docker compose refuses to parse the YAML because of the
# `${VAR:?msg}` fail-fast interpolations in docker-compose.app.yml).
# We also pass --env-file .env (created by deploy.yml; redeploy-build
# populates it with OPENAI_API_KEY/OPENAI_MODEL from GH secrets). If
# .env doesn't exist (operator-only rotation, no deploy) it's fine —
# the bash array skips undefined elements.
#
# IMPORTANT: must include -f docker-compose.app.prod.yml too. The base
# file declares `build:` only (no `image:` for backend/worker/frontend),
# which makes `up` try to build. The prod overlay replaces `build:` with
# `image: ghcr.io/sonlak/netconsole-*:${GITHUB_SHA:-main}` — that's how
# the deploy workflow gets away without rebuilding. Rotation must do
# the same.
# Without the overlay, `up -d` fails with
# `Container ... Recreate   Error response from daemon: No such image:
#  netconsole-backend:latest`.
#
# GITHUB_SHA: deploy.yml sets it to the running commit SHA so the
# pinned image is pulled. Operator-only rotation has no $GITHUB_SHA,
# so we fall back to whatever's currently running — read .last-deploy-sha
# (the marker deploy.yml maintains). If that file is missing, fall
# back to :main and let the user accept the (small) risk of pulling
# a different commit than what was previously running.
if [ -z "${GITHUB_SHA:-}" ] && [ -f "$DEPLOY_DIR/.last-deploy-sha" ]; then
  GITHUB_SHA="$(cat "$DEPLOY_DIR/.last-deploy-sha")"
  export GITHUB_SHA
fi

ENV_FILE_ARGS=(--env-file "$SECRETS_FILE")
if [ -f "$DEPLOY_DIR/.env" ]; then
  ENV_FILE_ARGS+=(--env-file "$DEPLOY_DIR/.env")
fi
docker compose -p netconsole \
  -f /opt/netconsole/docker-compose.app.yml \
  -f /opt/netconsole/docker-compose.app.prod.yml \
  "${ENV_FILE_ARGS[@]}" \
  stop backend worker 2>/dev/null || true
docker compose -p netconsole \
  -f /opt/netconsole/docker-compose.app.yml \
  -f /opt/netconsole/docker-compose.app.prod.yml \
  "${ENV_FILE_ARGS[@]}" \
  up -d --no-deps --no-build --pull=never backend worker

# 7. Health check.
echo "Waiting for backend to come back up..."
for i in $(seq 1 30); do
    if curl -sf -o /dev/null --max-time 3 http://172.31.0.3:3000/api/health; then
      echo "✅ Backend healthy after ${i} attempt(s)"
      echo
      echo "⚠️  All user sessions invalidated. Users must log in again."
      echo "Worker token TTL: ${WORKER_TTL_HOURS}h (rotated)."
      echo
      # P1 hardening: secrets.env is now SOPS-encrypted in git. The plaintext
      # file we just rotated lives only on the VPS. To make the new values
      # durable across deploys, the operator must re-encrypt and commit.
      if [ -f "/opt/netconsole/secrets.env.enc" ]; then
        echo "==> Re-encrypt secrets.env → secrets.env.enc?"
        echo "    Run on the VPS (requires age key at /opt/netconsole/.sops-age-key.txt):"
        echo "      SOPS_AGE_KEY_CMD=\"\$(cat /opt/netconsole/.sops-age-key.txt)\" \\"
        echo "        ./scripts/sops_decrypt.sh   # already done; backs up the OLD encrypted file"
        echo "      # Re-encrypt in place (overwrites secrets.env.enc):"
        echo "      sops --input-type=dotenv --output-type=dotenv \\"
        echo "        --encrypt secrets.env > secrets.env.enc"
        echo "      # Then commit + push from the VPS:"
        echo "      cd /opt/netconsole"
        echo "      git add secrets.env.enc"
        echo "      git commit -m 'chore: rotate JWT_SECRET + WORKER_AUTH_TOKEN'"
        echo "      git push origin main"
        echo
        echo "    (Or run ./scripts/sops_encrypt.sh from your local machine after"
        echo "     scp-ing the new secrets.env to your dev box.)"
      fi
      exit 0
    fi
    sleep 2
done

echo "❌ Backend did not become healthy within 60s"
docker logs --tail 40 netconsole-backend
exit 1
