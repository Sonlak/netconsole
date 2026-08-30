import subprocess
SSH=['ssh','-i',r'C:\Users\XUANSON\.ssh\id_ed25519','-o','StrictHostKeyChecking=no','sonnx@42.119.165.109']
SCRIPT = '''const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.device.findMany({orderBy:{ip:'asc'}}).then(d=>{console.log(JSON.stringify(d.map(x=>({ip:x.ip,name:x.name,site:x.site,vendor:x.vendor,model:x.model,status:x.status})),null,2));return p.$disconnect();})'''
p = subprocess.run(SSH + ['docker exec netconsole-backend sh -c "cat > /tmp/q.js << \'JS\'\\n' + SCRIPT + '\\nJS\\nnode /tmp/q.js"'], capture_output=True, text=True)
print('OUT:', p.stdout)
print('ERR:', p.stderr)