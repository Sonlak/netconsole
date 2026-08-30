#!/usr/bin/env bash
# NetConsole deploy script — for use on the server (42.119.165.109)
# Run as root after code is uploaded to /opt/netconsole
#
# Usage:  bash deploy.sh [image-tag]
# Default image tag = latest

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/netconsole}"
COMPOSE_FILE="docker-compose.app.yml"
IMAGE_TAG="${1:-latest}"
TAG_SUFFIX=":${IMAGE_TAG}"

cd "${REPO_DIR}"

echo "==> 1. Stop running containers"
docker compose -f "${COMPOSE_FILE}" down

echo "==> 2. Pull / build backend & frontend images"
docker compose -f "${COMPOSE_FILE}" build --pull --no-cache backend frontend

echo "==> 3. Start postgres + kea first (so backend can run prisma db push + seed)"
docker compose -f "${COMPOSE_FILE}" up -d postgres kea-dhcp1 kea-dhcp2

echo "==> 4. Wait for postgres to be healthy"
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' netconsole-postgres 2>/dev/null || echo "starting")
  echo "    postgres status = ${status}"
  if [ "${status}" = "healthy" ]; then break; fi
  sleep 2
done

echo "==> 5. Wait for kea primary to be healthy"
for i in $(seq 1 40); do
  status=$(docker inspect --format='{{.State.Health.Status}}' netconsole-kea-primary 2>/dev/null || echo "starting")
  echo "    kea-primary status = ${status}"
  if [ "${status}" = "healthy" ]; then break; fi
  sleep 2
done

echo "==> 6. Start backend (will auto-run prisma db push + seed)"
docker compose -f "${COMPOSE_FILE}" up -d backend

echo "==> 7. Wait for backend to be ready"
for i in $(seq 1 30); do
  if curl -fsS http://172.31.0.3:3000/api/health >/dev/null 2>&1; then
    echo "    backend OK"
    break
  fi
  sleep 2
done

echo "==> 8. Start worker + frontend"
docker compose -f "${COMPOSE_FILE}" up -d worker frontend

echo "==> 9. Final state"
docker compose -f "${COMPOSE_FILE}" ps
echo
echo "==> Backend health:"
curl -fsS http://172.31.0.3:3000/api/health || true
echo
echo
echo "==> Verify admin user was seeded (mustChangePassword=true):"
docker exec netconsole-postgres psql -U netconsole -d netconsole -c \
  "SELECT username, role, active, \"mustChangePassword\" FROM \"User\";"
echo
echo "==> Done. Open http://<server>:8443/ — login with admin / Admin@123"
echo "    You will be forced to change the password before reaching the dashboard."