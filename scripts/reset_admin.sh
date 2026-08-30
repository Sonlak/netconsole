#!/usr/bin/env bash
set -e
ssh -i "C:\Users\XUANSON\.ssh\id_ed25519" -o StrictHostKeyChecking=no sonnx@42.119.165.109 /bin/bash << 'REMOTE'
set -e
docker exec -i netconsole-postgres psql -U netconsole -d netconsole -v ON_ERROR_STOP=1 <<'SQL'
DELETE FROM "User" WHERE username='admin';
SQL
echo "rows deleted ok"
REMOTE