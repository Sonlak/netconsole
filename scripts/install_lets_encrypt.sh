#!/usr/bin/env bash
# =============================================================================
# install_lets_encrypt.sh
# Run on the VPS as root (or with sudo) AFTER DNS A-record for the
# public domain points at 42.119.165.109.
#
# Replaces the self-signed cert in /opt/netconsole/frontend/certs/
# with a Let's Encrypt cert via certbot. The certbot renew timer
# auto-rotates every 60 days; nothing to do after install.
#
# SECURITY (C11, see docs/agents/16-security-audit-preprod.md):
# required because the self-signed cert is MITM-vulnerable by design.
# Even a bank-internal pilot should use a CA-issued cert; let's encrypt
# is free and automated.
#
# Usage:
#   sudo /opt/netconsole/scripts/install_lets_encrypt.sh <domain>
#   sudo /opt/netconsole/scripts/install_lets_encrypt.sh netconsole.tailocbank.vn
#
# After install:
#   cd /opt/netconsole
#   docker compose -p netconsole -f docker-compose.app.yml restart frontend
#   # no backend restart needed — cert is read by nginx inside frontend
#
# Re-run anytime the cert is about to expire (certbot will skip if
# not yet within 30d of expiry; force-renew with `certbot renew
# --force-renewal`).
# =============================================================================

set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "Must run as root (or via sudo). certbot needs port 80."
  exit 1
fi

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <domain>   (e.g. $0 netconsole.tailocbank.vn)"
  exit 1
fi

DOMAIN="$1"
EMAIL="${LETSENCRYPT_EMAIL:-ops@tailocbank.vn}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/netconsole}"

# Sanity: DNS must already resolve to this host.
RESOLVED_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}')
HOST_PUBLIC_IP=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
if [ -n "$HOST_PUBLIC_IP" ] && [ "$RESOLVED_IP" != "$HOST_PUBLIC_IP" ]; then
  echo "❌ DNS for $DOMAIN resolves to $RESOLVED_IP but this host is $HOST_PUBLIC_IP."
  echo "   Update the A-record first, then re-run."
  exit 1
fi

# 1. Install certbot if not present.
if ! command -v certbot >/dev/null 2>&1; then
  echo "Installing certbot..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y certbot
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot
  elif command -v yum >/dev/null 2>&1; then
    yum install -y certbot
  else
    echo "❌ Could not detect package manager. Install certbot manually:"
    echo "   https://certbot.eff.org/instructions"
    exit 1
  fi
fi

# 2. Obtain a cert via the standalone plugin. Temporarily stops
#    any process listening on :80 — we use --standalone which spins
#    up certbot's own http server on :80 for the http-01 challenge.
#    If netconsole's frontend is also bound to :80, stop it first.
echo "Stopping frontend container (if any) to free :80 for the http-01 challenge..."
docker compose -p netconsole -f "$DEPLOY_DIR/docker-compose.app.yml" stop frontend 2>/dev/null || true

# 3. Request a cert.
echo "Requesting cert for $DOMAIN..."
certbot certonly --standalone \
  --non-interactive --agree-tos --register-unsafely-without-email \
  -m "$EMAIL" \
  -d "$DOMAIN"

# 4. Wire the cert into frontend/certs/ (the path baked into the
#    image's nginx config). Use a hard-link so the next certbot
#    renew (writing into /etc/letsencrypt/live/$DOMAIN/) is picked
#    up by the next frontend restart without re-running this script.
CERT_DIR="$DEPLOY_DIR/frontend/certs"
mkdir -p "$CERT_DIR"
ln -sf "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/cert.pem"
ln -sf "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "$CERT_DIR/key.pem"
chmod 600 "$CERT_DIR/key.pem"

# 5. Restart frontend so nginx picks up the new cert.
echo "Restarting frontend..."
docker compose -p netconsole -f "$DEPLOY_DIR/docker-compose.app.yml" \
  up -d --no-deps --force-recreate frontend

# 6. Sanity check.
sleep 2
echo
echo "Testing TLS endpoint..."
if curl -sfI --max-time 5 "https://$DOMAIN/api/health" -o /dev/null -w '%{http_code}\n' 2>/dev/null | grep -q '^200$'; then
  echo "✅ https://$DOMAIN is live with a CA-signed cert."
else
  echo "⚠️  Could not reach https://$DOMAIN — check firewall / DNS / nginx logs."
fi

# 7. Show renewal info.
echo
certbot certificates 2>/dev/null | sed -n "/$DOMAIN/,/^$/p" | head -20
echo
echo "Certbot auto-renews via the systemd timer. To test renewal:"
echo "  certbot renew --dry-run"
