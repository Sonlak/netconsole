const {PrismaClient} = require('@prisma/client');
const p = new PrismaClient();
p.device.delete({where: {ip: '10.10.3.1'}}).then(d => {
  console.log('deleted: ' + d.ip);
  return p.$disconnect();
}).catch(e => {
  console.error(e.message);
  process.exit(1);
});