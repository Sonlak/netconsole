#!/usr/bin/env python3
"""Reset admin password on remote postgres + clear rate-limit Redis key (if any)."""
import subprocess, sys, shlex

SSH = ["ssh", "-i", r"C:\Users\XUANSON\.ssh\id_ed25519",
       "-o", "StrictHostKeyChecking=no", "sonnx@42.119.165.109"]

def run(remote_cmd: str) -> str:
    p = subprocess.run(SSH + [remote_cmd], capture_output=True, text=True)
    if p.returncode != 0:
        print("STDERR:", p.stderr, file=sys.stderr)
        raise SystemExit(p.returncode)
    return p.stdout

# 1) Delete admin row so seed re-creates it with mustChangePassword=true
sql_delete = """DELETE FROM "User" WHERE username='admin';"""
out = run(f"docker exec -i netconsole-postgres psql -U netconsole -d netconsole -c {shlex.quote(sql_delete)}")
print("DELETE:", out)

# 2) Re-run seed inside the existing backend container
out = run("docker exec netconsole-backend npx tsx prisma/seed.ts 2>&1 | tail -20")
print("SEED:", out)