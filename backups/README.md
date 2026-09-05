# Postgres Backup & Restore

Daily `pg_dump` backups of the production database.

## Schedule

```
# /etc/cron.d/netconsole-backup (one-time install on VPS)
0 2 * * *  sonnx cd /opt/netconsole && /opt/netconsole/scripts/backup_postgres.sh >> /var/log/netconsole-backup.log 2>&1
```

Install on first deploy:
```bash
sudo install -d /var/log
sudo touch /var/log/netconsole-backup.log
sudo chown sonnx:sonnx /var/log/netconsole-backup.log
echo '0 2 * * * sonnx cd /opt/netconsole && /opt/netconsole/scripts/backup_postgres.sh >> /var/log/netconsole-backup.log 2>&1' \
    | sudo tee /etc/cron.d/netconsole-backup
sudo chmod 644 /etc/cron.d/netconsole-backup
```

## Retention

- 14 daily dumps kept locally under `/opt/netconsole/backups/postgres/`.
- Off-host copy is the operator's responsibility (rsync / SCP / object storage).
  The script does NOT push anywhere — single VPS disk is not a backup.

## Restore

Restore drops and recreates every table in the `netconsole` database.
**All current data will be lost.**

```bash
# 1. Stop backend so no jobs write during the restore
docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml stop backend worker

# 2. Pick the dump to restore (most recent)
ls -lt /opt/netconsole/backups/postgres/*.sql.gz | head -5
DUMP=$(ls -t /opt/netconsole/backups/postgres/*.sql.gz | head -1)
echo "Restoring from: $DUMP"

# 3. Pipe the dump into the postgres container
gunzip -c "$DUMP" | docker exec -i netconsole-postgres psql -U netconsole -d netconsole

# 4. Restart backend + worker
docker compose -p netconsole -f /opt/netconsole/docker-compose.app.yml up -d --no-deps --force-recreate backend worker

# 5. Verify
sleep 5
curl -sf http://172.31.0.3:3000/api/health
```

## Disaster recovery checklist

If the VPS disk dies and you have to rebuild:

1. Provision a new VPS with the same Docker setup.
2. Pull the repo: `git clone git@github.com:Sonlak/netconsole.git /opt/netconsole`.
3. Copy `docker-compose.app.yml` back (it has the latest JWT_SECRET).
4. Pull the backup files from off-host storage.
5. Restore the most recent dump (see above).
6. Re-create the self-signed cert OR install Let's Encrypt:
   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
       -keyout /opt/netconsole/frontend/certs/key.pem \
       -out /opt/netconsole/frontend/certs/cert.pem \
       -subj "/CN=netconsole-vps" \
       -addext "subjectAltName=DNS:localhost,DNS:netconsole-vps,IP:127.0.0.1,IP:42.119.165.109"
   ```
7. `docker compose up -d --build`.
