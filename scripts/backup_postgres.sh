#!/usr/bin/env bash
# =============================================================================
# backup_postgres.sh
# Run on VPS as the user that owns /opt/netconsole (sonnx).
#
# Usage:
#   cd /opt/netconsole
#   ./scripts/backup_postgres.sh                # one-shot backup
#   sudo crontab -e                             # schedule daily:
#     0 2 * * *  cd /opt/netconsole && /opt/netconsole/scripts/backup_postgres.sh >> /var/log/netconsole-backup.log 2>&1
#
# What it does:
#   1. Runs pg_dump inside the netconsole-postgres container, piped to gzip.
#   2. Writes the dump to /opt/netconsole/backups/postgres/<UTC-date>.sql.gz.
#   3. Prunes any local backups older than 14 days (configurable below).
#   4. Prints a summary line for cron logs.
#
# Off-host copy:
#   The script does NOT push the backup off-VPS — that is the operator's
#   responsibility. Recommended: rsync /opt/netconsole/backups/postgres/
#   to a Tailscale-mounted or SCP-reachable NAS daily. Keep at least 30
#   days off-host. A single VPS disk is not a backup.
# =============================================================================
set -euo pipefail

cd /opt/netconsole

BACKUP_ROOT=/opt/netconsole/backups/postgres
KEEP_DAYS=14
MIN_FREE_GB=5   # refuse to start if the FS has less than this many GB free
TS_UTC=$(date -u +%Y%m%dT%H%M%SZ)
DEST="${BACKUP_ROOT}/${TS_UTC}.sql.gz"

mkdir -p "${BACKUP_ROOT}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting postgres backup -> ${DEST}"

# Pre-flight disk check. pg_dump emits plain SQL — uncompressed size is
# roughly the on-disk DB size. Refuse to run if free space is below
# MIN_FREE_GB so we never fill the root volume by accident.
FREE_KB=$(df -Pk "${BACKUP_ROOT}" | awk 'NR==2 {print $4}')
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "${FREE_GB}" -lt "${MIN_FREE_GB}" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] REFUSED: only ${FREE_GB}GB free at ${BACKUP_ROOT}, need >=${MIN_FREE_GB}GB" >&2
    exit 3
fi

# pg_dump from inside the postgres container. --no-owner / --no-privileges
# make the dump portable across postgres major versions.
docker exec netconsole-postgres pg_dump \
    -U netconsole \
    -d netconsole \
    --no-owner \
    --no-privileges \
    --clean \
    --if-exists \
    > "${DEST}.partial"

gzip -9 "${DEST}.partial"
# gzip leaves the .partial file as ${DEST}.partial.gz; rename to canonical name.
mv "${DEST}.partial.gz" "${DEST}"

BYTES=$(stat -c %s "${DEST}" 2>/dev/null || stat -f %z "${DEST}")
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wrote ${DEST} (${BYTES} bytes)"

# --- prune old backups (keep last ${KEEP_DAYS} days) ---
PRUNED=0
find "${BACKUP_ROOT}" -type f -name '*.sql.gz' -mtime "+${KEEP_DAYS}" -print -delete | while read -r f; do
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pruned $f"
    PRUNED=$((PRUNED + 1))
done

REMAINING=$(find "${BACKUP_ROOT}" -type f -name '*.sql.gz' | wc -l)
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup done. kept ${REMAINING} files (max age ${KEEP_DAYS}d)"

# --- integrity check (optional but cheap) ---
if gzip -t "${DEST}" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] gzip integrity OK"
else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARNING: gzip integrity check failed for ${DEST}" >&2
    exit 2
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ----"
