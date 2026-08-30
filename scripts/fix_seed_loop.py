import subprocess, time
SSH = ['ssh','-i',r'C:\Users\XUANSON\.ssh\id_ed25519','-o','StrictHostKeyChecking=no','sonnx@42.119.165.109']
SCP = ['scp','-i',r'C:\Users\XUANSON\.ssh\id_ed25519','-o','StrictHostKeyChecking=no']
def r(c, **k):
    p = subprocess.run(c, capture_output=True, text=True, **k)
    if p.returncode != 0:
        print('E', p.stderr); raise SystemExit(1)
    return p.stdout
# Push Dockerfile
r(SCP + [r'D:\NetConsole\backend\Dockerfile','sonnx@42.119.165.109:/tmp/upload/Dockerfile'])
r(SCP + [r'D:\NetConsole\backend\prisma\seed.ts','sonnx@42.119.165.109:/tmp/upload/seed.ts'])
r(SSH + ['cp /tmp/upload/Dockerfile /opt/netconsole/backend/Dockerfile && cp /tmp/upload/seed.ts /opt/netconsole/backend/prisma/seed.ts'])
print('Files copied')
# Force-clear mustChangePassword on admin user BEFORE restarting
out = r(SSH + ["docker exec netconsole-backend node -e \"const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.user.update({where:{username:'admin'},data:{mustChangePassword:false}}).then(u=>{console.log('admin mustChangePassword='+u.mustChangePassword);return p.\\$disconnect();}).catch(e=>{console.error(e);process.exit(1)});\""])
print('DB UPDATE:', out.strip())
# Rebuild (Dockerfile changed)
o = r(SSH + ['cd /opt/netconsole && docker compose -f docker-compose.app.yml up -d --build --no-deps backend 2>&1 | tail -8'], timeout=240)
print('BUILD:', o)
time.sleep(6)
out = r(SSH + ["docker logs netconsole-backend 2>&1 | grep -E 'CORS allowed|listening|started' | tail -3"])
print('LOG:', out.strip())