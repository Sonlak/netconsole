#!/bin/bash
set -e
ssh -i "C:\Users\XUANSON\.ssh\id_ed25519" -o StrictHostKeyChecking=no sonnx@42.119.165.109 << 'REMOTE'
cat > /tmp/check.sql << 'EOSQL'
SELECT username, role, active, "mustChangePassword" FROM "User";
EOSQL
docker exec -i netconsole-postgres psql -U netconsole -d netconsole < /tmp/check.sql
REMOTE