#!/usr/bin/env python3
"""Rebuild and restart backend with new auth rate-limit (20/15min)."""
import subprocess, time

SSH = ["ssh", "-i", r"C:\Users\XUANSON\.ssh\id_ed25519",
       "-o", "StrictHostKeyChecking=no", "sonnx@42.119.165.109"]
SCP = ["scp", "-i", r"C:\Users\XUANSON\.ssh\id_ed25519",
       "-o", "StrictHostKeyChecking=no"]

def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        print("STDOUT:", p.stdout); print("STDERR:", p.stderr)
        raise SystemExit(p.returncode)
    return p.stdout

# Push updated middleware
run(SCP + [r"D:\NetConsole\backend\src\middleware\rateLimit.ts",
           "sonnx@42.119.165.109:/tmp/upload/rateLimit.ts"])
run(SSH + ["cp /tmp/upload/rateLimit.ts /opt/netconsole/backend/src/middleware/rateLimit.ts"])

# Verify edit
out = run(SSH + ["grep -n 'max: 20' /opt/netconsole/backend/src/middleware/rateLimit.ts"])
print("VERIFIED:", out.strip())

# Rebuild + restart
out = run(SSH + ["cd /opt/netconsole && docker compose -f docker-compose.app.yml up -d --build --no-deps backend 2>&1 | tail -10"], timeout=240)
print("BUILD:", out)

# Wait, verify health
time.sleep(6)
out = run(SSH + ["docker logs netconsole-backend 2>&1 | grep -E 'listening|authRouter|listening on|started' | tail -3"])
print("LOG:", out.strip())

out = run(SSH + ["docker exec netconsole-backend wget -q -O- http://localhost:3000/api/health 2>&1 | head -c 200"])
print("HEALTH:", out.strip())