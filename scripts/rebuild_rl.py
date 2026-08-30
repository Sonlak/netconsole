import subprocess, time
SSH = ['ssh','-i',r'C:\Users\XUANSON\.ssh\id_ed25519','-o','StrictHostKeyChecking=no','sonnx@42.119.165.109']
SCP = ['scp','-i',r'C:\Users\XUANSON\.ssh\id_ed25519','-o','StrictHostKeyChecking=no']
def r(c, **k):
    p = subprocess.run(c, capture_output=True, text=True, **k)
    if p.returncode != 0:
        print('E', p.stderr); raise SystemExit(1)
    return p.stdout
r(SCP + [r'D:\NetConsole\backend\src\middleware\rateLimit.ts','sonnx@42.119.165.109:/tmp/upload/rl.ts'])
r(SSH + ['cp /tmp/upload/rl.ts /opt/netconsole/backend/src/middleware/rateLimit.ts'])
out = r(SSH + ["grep -n 'max: 600' /opt/netconsole/backend/src/middleware/rateLimit.ts"])
print('VERIFIED:', out.strip())
o = r(SSH + ['cd /opt/netconsole && docker compose -f docker-compose.app.yml up -d --build --no-deps backend 2>&1 | tail -6'], timeout=240)
print('BUILD:', o)
time.sleep(6)
print('Sleeping to let backend come up')
out = r(SSH + ["docker logs netconsole-backend 2>&1 | grep -E 'CORS allowed|listening' | tail -3"])
print('LOG:', out.strip())