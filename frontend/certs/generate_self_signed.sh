#!/usr/bin/env bash
# generate_self_signed.sh — produce a 1-year self-signed cert for
# local dev. Writes to frontend/certs/{cert,key}.pem which is in
# .gitignore (cert files must NEVER be committed).
#
# Usage:
#   bash frontend/certs/generate_self_signed.sh
#
# Then either:
#   (a) `npm run dev` (vite, no cert needed — http://localhost:5173)
#   (b) `docker compose up -d frontend` and browse https://localhost:8443
#       (you'll get a cert warning — accept it once per browser)
#
# For Windows PowerShell: use `frontend/certs/generate_self_signed.ps1`
# (same content, different shebang / shell quoting).

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CERT="$DIR/cert.pem"
KEY="$DIR/key.pem"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "[generate_self_signed] certs already exist at $CERT"
  echo "[generate_self_signed] delete them first if you want to regenerate"
  exit 0
fi

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout "$KEY" \
  -out "$CERT" \
  -subj "/CN=localhost/O=NetConsole-Local-Dev" \
  -addext "subjectAltName=DNS:localhost,DNS:127.0.0.1,IP:127.0.0.1"

chmod 600 "$KEY" "$CERT"
echo "[generate_self_signed] wrote $CERT + $KEY (1y, 2048-bit RSA)"
echo "[generate_self_signed] now run: docker compose up -d frontend"
echo "[generate_self_signed] then open: https://localhost:8443 (accept the cert warning once)"
