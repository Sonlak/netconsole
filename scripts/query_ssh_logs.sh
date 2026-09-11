#!/bin/bash
docker exec netconsole-postgres psql -U netconsole -d netconsole << 'SQL'
SELECT created_at, message FROM device_logs
WHERE source_ip = '10.10.20.101' AND message LIKE '%ssh%'
ORDER BY created_at DESC LIMIT 10;
SQL
