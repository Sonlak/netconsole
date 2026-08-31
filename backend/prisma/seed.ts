import { DeviceStatus, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

const defaultDevices = [
  {
    site: 'Hanoi DC',
    floor: 'F3',
    name: 'Core-SW-HN-01',
    ip: '10.10.3.1',
    status: DeviceStatus.ONLINE,
    vendor: 'Cisco',
    model: 'C9300-48P',
    version: '17.9.4a',
    serial: 'FCW2345A1B2',
    description: 'Core switch tầng 3',
  },
];

const labDevices = [
  {
    site: 'Lab Prod',
    floor: 'Core',
    name: 'SW-CORE-01',
    ip: '172.30.0.11',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX4',
    version: '22.4R1.10',
    serial: 'JNCORE000001',
    description: 'Core L3 — lo0 1.1.1.1 — OSPF Area 0/10',
  },
  {
    site: 'Lab Prod',
    floor: 'Core',
    name: 'SW-CORE-02',
    ip: '172.30.0.12',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX3',
    version: '22.4R1.10',
    serial: 'JNCORE000002',
    description: 'Core L3 — lo0 1.1.1.2 — OSPF Area 0/10',
  },
  {
    site: 'Lab Prod',
    floor: 'Dist',
    name: 'SW-DS-01',
    ip: '172.30.0.13',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX1',
    version: '21.4R3.4',
    serial: 'JNDIST000001',
    description: 'Dist — Root Bridge / VRRP MASTER — DHCP relay → Kea',
  },
  {
    site: 'Lab Prod',
    floor: 'Dist',
    name: 'SW-DS-02',
    ip: '172.30.0.14',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX2',
    version: '21.4R3.4',
    serial: 'JNDIST000002',
    description: 'Dist — Secondary RB / VRRP BACKUP — DHCP relay → Kea',
  },
  {
    site: 'Lab Prod',
    floor: 'Access',
    name: 'SW-AS-01',
    ip: '172.30.0.15',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX7',
    version: '21.4R3.4',
    serial: 'JNACC000001',
    description: 'Access — dual-home DS — VPC5/6/9',
  },
  {
    site: 'Lab Prod',
    floor: 'Access',
    name: 'SW-AS-02',
    ip: '172.30.0.16',
    status: DeviceStatus.UNKNOWN,
    vendor: 'Juniper',
    model: 'vEX8',
    version: '21.4R3.4',
    serial: 'JNACC000002',
    description: 'Access — dual-home DS — VPC10/11/12',
  },
];

async function main() {
  if (process.env.SEED_DISABLED === 'true') {
    console.log('Seeding disabled (SEED_DISABLED=true)');
    return;
  }

  // Seed admin user
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';
  const adminUsername = process.env.SEED_ADMIN_USERNAME || 'admin';
  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    create: {
      username: adminUsername,
      email: 'admin@netconsole.local',
      password: hashedPassword,
      role: 'ADMIN',
      active: true,
    },
    update: {
      password: hashedPassword,
    },
  });
  console.log(`Admin user: ${admin.username} (password: ${adminPassword})`);

  // Generate worker token for reference
  const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'CHANGE_ME_IN_PRODUCTION';
  const workerToken = jwt.sign(
    { sub: 'worker', type: 'worker', name: 'seed-worker' },
    jwtSecret,
    { expiresIn: '365d' }
  );
  console.log(`Worker token (for WORKER_AUTH_TOKEN env):\n${workerToken}`);

  const useLab = process.env.LAB_SSH_ENABLED === 'true';
  const seedDevices = useLab ? labDevices : defaultDevices;

  for (const device of seedDevices) {
    await prisma.device.upsert({
      where: { ip: device.ip },
      create: device,
      update: {
        name: device.name,
        site: device.site,
        floor: device.floor,
        vendor: device.vendor,
        model: device.model,
        version: device.version,
        serial: device.serial,
        description: device.description,
      },
    });
  }

  console.log(`Seeded ${seedDevices.length} devices (${useLab ? 'lab' : 'default'} mode)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
