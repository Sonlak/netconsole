#!/usr/bin/env bash
# =============================================================================
# sops_decrypt.sh — decrypt secrets.env.enc → secrets.env
#
# Used on the VPS to decrypt the git-tracked secrets.env.enc back into
# secrets.env (the file that docker-compose reads).
#
# Prerequisites (same as sops_encrypt.sh):
#   age + sops installed, and the age private key at:
#     /opt/netconsole/.sops-age-key.txt  (chmod 600)
#   OR at ~/.config/sops/age/key.txt
#   OR provided via the SOPS_AGE_KEY env var (what the deploy workflows use
#      when the key lives in GitHub Actions secrets instead of on the host).
#
# Usage:
#   cd /opt/netconsole
#   ./scripts/sops_decrypt.sh
#
# The deploy pipeline calls this automatically (via the deploy.yml step).
# This script is for manual / off-cycle decrypts on the VPS.
# =============================================================================

set -euo pipefail

cd /opt/netconsole

ENCRYPTED="secrets.env.enc"
DECRYLED="secrets.env"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/netconsole/.sops-age-key.txt}"

# ── Find the age key ──────────────────────────────────────────────────────────
# sops reads THREE different env vars and tries every one it finds:
#   SOPS_AGE_KEY      -> raw key content
#   SOPS_AGE_KEY_FILE -> path to a key file
#   SOPS_AGE_KEY_CMD  -> a COMMAND to exec that prints the key
#
# Mixing them breaks things: SOPS_AGE_KEY_CMD is exec'd, so handing it raw key
# text makes sops try to run the key as a binary ("executable file not found
# in $PATH"). So we resolve to exactly ONE source and unset the other two
# before calling sops.
#
# Priority: SOPS_AGE_KEY (raw, used by the deploy workflows via GitHub
# secrets) > SOPS_AGE_KEY_CMD (command) > key file > ~/.config/sops/age/key.txt
if [ -n "${SOPS_AGE_KEY:-}" ]; then
  unset SOPS_AGE_KEY_CMD
  unset SOPS_AGE_KEY_FILE
  export SOPS_AGE_KEY
  echo "==> Using age key from SOPS_AGE_KEY env var"
elif [ -n "${SOPS_AGE_KEY_CMD:-}" ]; then
  unset SOPS_AGE_KEY
  unset SOPS_AGE_KEY_FILE
  export SOPS_AGE_KEY_CMD
  echo "==> Using age key from SOPS_AGE_KEY_CMD command"
elif [ -f "$AGE_KEY_FILE" ]; then
  unset SOPS_AGE_KEY
  unset SOPS_AGE_KEY_CMD
  export SOPS_AGE_KEY_FILE="$AGE_KEY_FILE"
  echo "==> Using age key from $AGE_KEY_FILE"
elif [ -f ~/.config/sops/age/key.txt ]; then
  unset SOPS_AGE_KEY
  unset SOPS_AGE_KEY_CMD
  export SOPS_AGE_KEY_FILE=~/.config/sops/age/key.txt
  echo "==> Using age key from ~/.config/sops/age/key.txt"
else
  echo "ERROR: age private key not found."
  echo "  Expected at: $AGE_KEY_FILE"
  echo "  Or set SOPS_AGE_KEY=AGE-SECRET-KEY-1... (what the deploy workflows use)"
  echo "  Run: age-keygen -o $AGE_KEY_FILE && chmod 600 $AGE_KEY_FILE"
  exit 1
fi

if [ ! -f "$ENCRYPTED" ]; then
  echo "ERROR: $ENCRYPTED not found."
  echo "  Check that the file was synced from git."
  exit 1
fi

# ── Prerequisites ──────────────────────────────────────────────────────────────
if ! command -v sops &>/dev/null; then
  echo "ERROR: sops not installed."
  echo "  Run: sudo apt install -y sops   # Debian/Ubuntu"
  echo "  Or:  download from https://github.com/getsops/sops/releases"
  exit 1
fi

# ── Decrypt ───────────────────────────────────────────────────────────────────
echo "==> Decrypting $ENCRYPTED → $DECRYLED"

# Backup existing secrets.env.
if [ -f "$DECRYLED" ]; then
  cp -p "$DECRYLED" "${DECRYLED}.bak.$(date +%Y%m%d_%H%M%S)"
fi

# Decrypt. The .enc extension makes SOPS default to binary input/output
# — we override with explicit dotenv on both ends so the result is a
# plain KEY=VALUE file that docker-compose can read directly.
sops --config .sops.yaml \
  --input-type dotenv --output-type dotenv \
  --decrypt "$ENCRYPTED" > "$DECRYLED"

chmod 600 "$DECRYLED"

echo "OK - Decrypted $ENCRYPTED -> $DECRYLED ($(wc -l < "$DECRYLED") lines)"
echo ""
echo "    (Backup of previous secrets.env saved if any)"
echo ""
echo "==> Next: restart services to pick up new env:"
echo "    docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml \\"
echo "      up -d --force-recreate backend worker"