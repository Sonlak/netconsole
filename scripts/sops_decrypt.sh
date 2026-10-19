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
DECRYPTED="secrets.env"
AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/netconsole/.sops-age-key.txt}"
AGE_KEY_CMD="${SOPS_AGE_KEY_CMD:-}"

# ── Find the age key ──────────────────────────────────────────────────────────
# Priority: env override > .sops-age-key.txt > ~/.config/sops/age/key.txt
if [ -n "$AGE_KEY_CMD" ]; then
  # Use AGE key from env var (used by the deploy workflow).
  export AGE_SOPS_KEY="$AGE_KEY_CMD"
  echo "==> Using age key from SOPS_AGE_KEY_CMD env var"
elif [ -f "$AGE_KEY_FILE" ]; then
  export SOPS_AGE_KEY_FILE="$AGE_KEY_FILE"
  echo "==> Using age key from $AGE_KEY_FILE"
elif [ -f ~/.config/sops/age/key.txt ]; then
  export SOPS_AGE_KEY_FILE=~/.config/sops/age/key.txt
  echo "==> Using age key from ~/.config/sops/age/key.txt"
else
  echo "ERROR: age private key not found."
  echo "  Expected at: $AGE_KEY_FILE"
  echo "  Or set: SOPS_AGE_KEY_CMD='AGE-SECRET-KEY-1...'"
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
  echo "  Or:  download from https://github.com/mozilla/sops/releases"
  exit 1
fi

# ── Decrypt ───────────────────────────────────────────────────────────────────
echo "==> Decrypting $ENCRYPTED → $DECRYPTED"

# Backup existing secrets.env.
if [ -f "$DECRYPTED" ]; then
  cp -p "$DECRYPTED" "${DECRYPTED}.bak.$(date +%Y%m%d_%H%M%S)"
fi

# Decrypt.  --input-type=dotenv matches the --output-type=sops used in encrypt.
sops --input-type=dotenv --output-type=dotenv \
  --decrypt "$ENCRYPTED" > "$DECRYPTED"

chmod 600 "$DECRYPTED"

echo "✅ Decrypted $ENCRYPTED → $DECRYPTED ($(wc -l < "$DECRYPTED") lines)"
echo ""
echo "    (Backup of previous secrets.env saved if any)"
echo ""
echo "==> Next: restart services to pick up new env:"
echo "    docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml \\"
echo "      up -d --force-recreate backend worker"
