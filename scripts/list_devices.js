const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.device.findMany({orderBy: {ip: 'asc'}}).then(d => {
  console.log(JSON.stringify(d.map(x => ({
    ip: x.ip, name: x.name, site: x.site, vendor: x.vendor, model: x.model, status: x.status
  })), null, 2));
  return p.$disconnect();
});