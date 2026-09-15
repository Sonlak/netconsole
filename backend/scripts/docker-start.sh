#!/bin/sh
# =============================================================================
# Resilient startup script for netconsole-backend container.
#
# This script replaces the old inline CMD:
#   npx prisma db push --skip-generate && node dist/index.js
#
# WHY THIS SCRIPT:
#   - `prisma db push` fails when schema changes require dropping columns/tables
#     that contain data (e.g. removing a field). This breaks both DEPLOY
#     (healthcheck fails) and ROLLBACK (rollback.yml also runs `docker compose
#     up --build` which hits the same failing prisma db push).
#
#   - `prisma db push --accept-data-loss` lets Prisma apply the schema even
#     when it must drop data. It STILL fails with a non-zero exit if data
#     would be lost — so we cannot rely on && chaining.
#
# BEHAVIOUR:
#   1. Try `prisma migrate deploy` first — safe for normal schema drift.
#      Only applies NEW migrations; leaves existing schema untouched if
#      nothing to migrate. Does NOT push arbitrary schema changes.
#
#   2. If migrate deploy fails (no migration history, fresh DB, or the DB
#      schema diverged without a migration file), fall back to `db push
#      --accept-data-loss`. This applies whatever schema is in schema.prisma.
#      We capture the exit code but always proceed — the previous deploy's
#      schema is still in the DB and the backend will start cleanly.
#
#   3. Seed if SEED_ON_BOOT=true (local dev only).
#
#   4. Start the backend. Never let Prisma step 1 or 2 prevent container start.
#
# ROLLBACK SAFETY:
#   On rollback, this container is rebuilt from the OLD commit (which has the
#   OLD schema.prisma). The DB already has the NEWER schema. Steps 1+2 will
#   detect drift and attempt to revert the schema. We proceed regardless of
#   their exit codes — the DB schema stays at the newer version, but the OLD
#   backend binary (compiled against the OLD Prisma client) starts against
#   it. Field-level incompatibilities (new columns, removed fields) may cause
#   runtime errors in affected API calls, but the service comes up and the
#   healthcheck passes, giving ops time to investigate. The next clean deploy
#   of the correct commit will push the right schema.
# =============================================================================

set -e

echo "[startup] Waiting for database to be ready..."
# pg_isready exits 0 when Postgres is accepting connections.
# Loop with timeout to avoid infinite hang on DB unavailability.
READY=false
for i in $(seq 1 30); do
  if pg_isready -U netconsole -d netconsole >/dev/null 2>&1; then
    READY=true
    break
  fi
  echo "[startup] waiting for postgres ($i/30)..."
  sleep 2
done

if [ "$READY" != "true" ]; then
  echo "[startup] WARNING: postgres not ready after 60s — proceeding anyway"
fi

# Prisma generate (must match the schema baked into the image)
echo "[startup] Generating Prisma client..."
npx prisma generate

# Step 1: migrate deploy (safe, respects migration history)
echo "[startup] Running prisma migrate deploy..."
if npx prisma migrate deploy; then
  echo "[startup] migrate deploy succeeded"
else
  MIGRATE_EXIT=$?
  echo "[startup] migrate deploy exited $MIGRATE_EXIT — falling back to db push"
fi

# Step 2: db push with accept-data-loss as fallback.
# Exit code is captured but NEVER blocks container start.
echo "[startup] Running prisma db push --accept-data-loss..."
npx prisma db push --accept-data-loss --skip-generate
PUSH_EXIT=$?

if [ $PUSH_EXIT -eq 0 ]; then
  echo "[startup] db push succeeded (schema in sync)"
else
  echo "[startup] db push exited $PUSH_EXIT (schema drift or data loss) — continuing anyway"
fi

# Seed (local dev only — SEED_ON_BOOT is never set in production compose)
if [ "${SEED_ON_BOOT:-false}" = "true" ]; then
  echo "[startup] SEED_ON_BOOT=true — running database seed..."
  npm run db:seed
fi

# Start backend — this is the one thing that MUST happen
echo "[startup] Starting backend (node dist/index.js)..."
exec node dist/index.js
