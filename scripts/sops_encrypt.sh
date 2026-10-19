#!/usr/bin/env bash
# =============================================================================
# sops_encrypt.sh — encrypt secrets.env → secrets.env.enc
#
# Encrypts secrets.env with the age public key defined in .sops.yaml.
# The encrypted output (secrets.env.enc) is what gets committed to git.
#
# Prerequisites:
#   1. Install age:  https://github.com/FiloSottile/age/releases
#   2. Install sops: https://github.com/getsops/sops/releases
#      (macOS: brew install age sops)
#      (Linux: download the binary from GitHub releases)
#   3. Generate an age key pair:
#        age-keygen -o ~/.sops-age-key.txt
#      The public key goes in .sops.yaml.
#   4. Set the private key on the VPS:
#        scp ~/.sops-age-key.txt sonnx@100.102.133.86:/opt/netconsole/.sops-age-key.txt
#        ssh sonnx@100.102.133.86 chmod 600 /opt/netconsole/.sops-age-key.txt
#   5. Set the private key in GitHub Actions:
#        repo → Settings → Secrets → Actions → New secret
#        Name: SOPS_AGE_KEY
#        Value: (paste the full contents of ~/.sops-age-key.txt)
#
# Usage (on any machine with age + sops installed):
#   ./scripts/sops_encrypt.sh
#
# What it does:
#   1. Reads .sops.yaml to find the age public key.
#   2. Encrypts secrets.env → secrets.env.enc (whole file; selective
#      value encryption via `encrypted_regex` has a bug in SOPS 3.10.x
#      with dotenv output, so we encrypt the whole file instead).
#   3. Overwrites secrets.env.enc in-place.
#   4. Prints a diff of what changed (before/after line count).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

SECRETS="secrets.env"
ENCRYPTED="secrets.env.enc"

# ── Prerequisites check ────────────────────────────────────────────────────────
if ! command -v sops &>/dev/null; then
  echo "ERROR: sops is not installed."
  echo "  macOS: brew install sops"
  echo "  Linux: download from https://github.com/getsops/sops/releases"
  echo "  Then re-run $0"
  exit 1
fi

if ! command -v age &>/dev/null; then
  echo "ERROR: age is not installed."
  echo "  macOS: brew install age"
  echo "  Linux: download from https://github.com/FiloSottile/age/releases"
  echo "  Then re-run $0"
  exit 1
fi

if [ ! -f "$SECRETS" ]; then
  echo "ERROR: $SECRETS not found."
  echo "  Run ./scripts/rotate_secrets.sh --initial on the VPS first,"
  echo "  then copy secrets.env back to your local machine."
  exit 1
fi

if [ ! -f ".sops.yaml" ]; then
  echo "ERROR: .sops.yaml not found. Have you committed it yet?"
  exit 1
fi

# Check the placeholder is still in .sops.yaml (operator forgot to replace it).
if grep -q "PLACEHOLDER" .sops.yaml; then
  echo "ERROR: .sops.yaml still contains the PLACEHOLDER public key."
  echo "  1. Generate a key pair: age-keygen -o age-priv.txt"
  echo "  2. Paste the 'age1...' public key into .sops.yaml"
  echo "  3. Commit .sops.yaml before encrypting secrets."
  exit 1
fi

echo "==> Encrypting $SECRETS → $ENCRYPTED"
echo "    (using age public key from .sops.yaml)"

# Backup the old encrypted file (if it exists).
if [ -f "$ENCRYPTED" ]; then
  cp -p "$ENCRYPTED" "${ENCRYPTED}.bak.$(date +%Y%m%d_%H%M%S)"
  echo "    (backed up old $ENCRYPTED)"
fi

# We need the encrypted file to have the .enc extension so SOPS's
# path_regex matches. Workaround: copy the file with the new name,
# encrypt in-place, then move back.
cp -p "$SECRETS" "$ENCRYPTED"
trap 'rm -f "$ENCRYPTED"' EXIT

# Encrypt. --input-type=dotenv + --output-type=dotenv so SOPS treats
# the file as KEY=VALUE lines (the format our deploy expects). Both
# args are MANDATORY for this version of SOPS — the .enc extension
# alone makes SOPS default to binary output, which we don't want.
sops --config .sops.yaml \
  --input-type dotenv --output-type dotenv \
  --encrypt "$ENCRYPTED" > "$ENCRYPTED.tmp"
mv "$ENCRYPTED.tmp" "$ENCRYPTED"
trap - EXIT

echo "✅ Encrypted $SECRETS → $ENCRYPTED"
echo ""
echo "==> Stats"
echo "    Unencrypted size: $(wc -c < "$SECRETS") bytes, $(wc -l < "$SECRETS") lines"
echo "    Encrypted size:   $(wc -c < "$ENCRYPTED") bytes, $(wc -l < "$ENCRYPTED") lines"
echo ""
echo "==> Next steps:"
echo "    git add $ENCRYPTED"
echo "    git commit -m 'chore: update encrypted secrets'"
echo "    git push"
echo ""
echo "    (DO NOT commit the unencrypted secrets.env — it is gitignored)"
