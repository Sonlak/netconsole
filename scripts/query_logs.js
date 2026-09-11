const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  const logs = await p.deviceLog.findMany({
    where: {
      sourceIp: { in: ['10.10.20.101', '10.10.20.102', '10.10.20.110', '10.10.20.111', '10.10.20.201', '10.10.20.211', '10.10.20.221'] },
      message: { contains: 'ssh' }
    },
    orderBy: { createdAt: 'desc' },
    take: 15
  });
  console.log(JSON.stringify(logs, null, 2));
}
main().finally(() => p.$disconnect());
