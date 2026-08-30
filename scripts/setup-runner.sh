# =============================================================================
# Setup self-hosted GitHub Actions runner on RHEL 10
# Run ONCE per server. Idempotent.
#
# Usage:
#   sudo ./scripts/setup-runner.sh \
#     --repo "Sonlak/netconsole" \
#     --token "<REGISTRATION_TOKEN>" \
#     --name "vps-prod-01" \
#     --labels "self-hosted,linux,production"
#
# Get the registration token from:
#   https://github.com/Sonlak/netconsole/settings/actions/runners/new
# (token expires after 1 hour - regenerate if it does)
#
# After install:
#   sudo systemctl status actions.runner.Sonlak-netconsole.vps-prod-01
#   sudo journalctl -u actions.runner.Sonlak-netconsole.vps-prod-01 -f
# =============================================================================
#!/usr/bin/env bash
set -euo pipefail

REPO=""
TOKEN=""
RUNNER_NAME="$(hostname)-runner"
LABELS="self-hosted,linux,production"
RUNNER_VERSION="2.319.1"
RUNNER_DIR="/opt/actions-runner"
RUNNER_USER="${SUDO_USER:-$(whoami)}"

usage() {
  sed -n '2,15p' "$0"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO="$2"; shift 2 ;;
    --token)     TOKEN="$2"; shift 2 ;;
    --name)      RUNNER_NAME="$2"; shift 2 ;;
    --labels)    LABELS="$2"; shift 2 ;;
    --version)   RUNNER_VERSION="$2"; shift 2 ;;
    --dir)       RUNNER_DIR="$2"; shift 2 ;;
    --user)      RUNNER_USER="$2"; shift 2 ;;
    -h|--help)   usage ;;
    *)           echo "Unknown arg: $1"; usage ;;
  esac
done

if [[ -z "$REPO" || -z "$TOKEN" ]]; then
  echo "ERROR: --repo and --token are required"
  usage
fi

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)"
  exit 1
fi

echo ">>> Installing OS prerequisites"
dnf install -y git jq rsync libicu openssl-libs krb5-libs zlib libstdc++ glibc \
  || echo "Some packages already installed, continuing..."

echo ">>> Creating runner directory at $RUNNER_DIR"
mkdir -p "$RUNNER_DIR"
chown -R "$RUNNER_USER":"$RUNNER_USER" "$RUNNER_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  PKG_ARCH="x64" ;;
  aarch64) PKG_ARCH="arm64" ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

TARBALL="actions-runner-linux-${PKG_ARCH}-${RUNNER_VERSION}.tar.gz"
URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"

cd "$RUNNER_DIR"
if [[ ! -f "./run.sh" ]]; then
  echo ">>> Downloading $TARBALL"
  sudo -u "$RUNNER_USER" curl -fsSL -o "$TARBALL" "$URL"
  sudo -u "$RUNNER_USER" tar xzf "$TARBALL"
  rm -f "$TARBALL"
else
  echo ">>> Runner already extracted, skipping download"
fi

echo ">>> Registering runner '$RUNNER_NAME' for $REPO"
sudo -u "$RUNNER_USER" ./config.sh \
  --unattended \
  --replace \
  --url "https://github.com/$REPO" \
  --token "$TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --work "_work"

SVC_NAME="actions.runner.${REPO//\//-}.${RUNNER_NAME}"

echo ">>> Installing systemd service: $SVC_NAME"
cd "$RUNNER_DIR"
./svc.sh install "$RUNNER_USER"
./svc.sh start

sleep 2
systemctl status "$SVC_NAME" --no-pager || true

echo ""
echo "============================================================"
echo "âœ… Runner installed and started"
echo "   Name:    $RUNNER_NAME"
echo "   Repo:    https://github.com/$REPO/settings/actions/runners"
echo "   Service: systemctl status $SVC_NAME"
echo "   Logs:    journalctl -u $SVC_NAME -f"
echo "============================================================"
