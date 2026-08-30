#!/usr/bin/env python3
"""Upload updated docker-compose.app.yml and restart backend."""
import subprocess, sys, shlex

SCP = ["scp", "-i", r"C:\Users\XUANSON\.ssh\id_ed25519",
       "-o", "StrictHostKeyChecking=no"]
SSH = ["ssh", "-i", r"C:\Users\XUANSON\.ssh\id_ed25519",
       "-o", "StrictHostKeyChecking=no", "sonnx@42.119.165.109"]

def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        print("STDOUT:", p.stdout); print("STDERR:", p.stderr)
        raise SystemExit(p.returncode)
    return p.stdout

local = r"D:\NetConsole\docker-compose.app.yml"
remote_tmp = "/tmp/upload/docker-compose.app.yml"

# Upload
run(SCP + [local, f"sonnx@42.119.165.109:{remote_tmp}"])
# Move into place
run(SSH + [f"cp {remote_tmp} /opt/netconsole/docker-compose.app.yml"])
# Verify new line present
out = run(SSH + ["grep CORS_ORIGINS /opt/netconsole/docker-compose.app.yml"])
print("VERIFIED:", out.strip())

# Restart backend (env changes require recreate, not just restart)
out = run(SSH + ["cd /opt/netconsole && docker compose -f docker-compose.app.yml up -d --no-deps backend 2>&1 | tail -8"])
print("RESTART:", out)

# Wait + show new CORS log line
import time
time.sleep(5)
out = run(SSH + ["docker logs netconsole-backend --tail 30 2>&1 | grep -E 'CORS allowed' | tail -3"])
print("LOG:", out.strip())