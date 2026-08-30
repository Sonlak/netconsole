import { JobStatus, JobType } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function getLatestJobResult(
  deviceId: string,
  type: JobType,
) {
  return prisma.job.findFirst({
    where: { deviceId, type, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createDeviceJob(
  deviceId: string,
  type: JobType,
  res: Response,
) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }

  const job = await prisma.job.create({
    data: {
      deviceId,
      type,
      status: JobStatus.PENDING,
    },
    include: { device: true },
  });

  return job;
}

export function stubPayload(type: JobType, deviceName: string) {
  const base = {
    implemented: false,
    message: 'Worker chưa kết nối lab. Endpoint đã sẵn sàng để tích hợp.',
    deviceName,
  };

  switch (type) {
    case JobType.CONNECT_TEST:
      return { ...base, connected: false };
    case JobType.GET_CONFIG:
      return { ...base, config: `# Configuration for ${deviceName}\n# TODO: worker + aionet` };
    case JobType.GET_ARP:
      return {
        ...base,
        entries: [
          { ip: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', interface: 'Vlan10', age: '-' },
        ],
      };
    case JobType.GET_MAC:
      return {
        ...base,
        entries: [
          {
            mac: 'aa:bb:cc:00:02:01',
            vlan: '10',
            tag: '-',
            interface: 'ge-0/0/1.0',
            flags: 'D',
            type: 'dynamic',
            sessId: '0',
          },
        ],
      };
    case JobType.GET_INTERFACES:
      return {
        ...base,
        interfaces: [
          {
            name: 'ge-0/0/0',
            adminStatus: 'up',
            operStatus: 'up',
            description: 'mgmt',
            mode: 'inet',
            accessVlan: '',
            address: '',
            mtu: '1514',
            speed: '1000mbps',
          },
        ],
      };
    default:
      return base;
  }
}
