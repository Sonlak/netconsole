import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { queueArpCollection } from './arpAddress.js';
import { listCollectableDevices } from './collectableDevices.js';
import { queueInterfacesCollection } from './interfaces.js';
import { queueMacCollection } from './macAddress.js';

export async function queueConfigCollection(options?: {
  deviceIds?: string[];
  force?: boolean;
}) {
  const devices = await listCollectableDevices(options?.deviceIds);

  if (devices.length === 0) {
    return { jobs: [], deviceCount: 0, queued: 0, message: 'No managed devices' as const };
  }

  const jobs = [];

  for (const device of devices) {
    if (!options?.force) {
      const inflight = await prisma.job.findFirst({
        where: {
          deviceId: device.id,
          type: JobType.GET_CONFIG,
          status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
        },
      });
      if (inflight) {
        continue;
      }
    }

    const job = await prisma.job.create({
      data: {
        deviceId: device.id,
        type: JobType.GET_CONFIG,
        status: JobStatus.PENDING,
      },
      include: {
        device: {
          select: { id: true, name: true, ip: true, site: true },
        },
      },
    });
    jobs.push(job);
  }

  return { jobs, deviceCount: devices.length, queued: jobs.length };
}

export async function queueDeviceTabCollections(options?: {
  deviceIds?: string[];
  force?: boolean;
}) {
  const [mac, arp, interfaces, config] = await Promise.all([
    queueMacCollection(options),
    queueArpCollection(options),
    queueInterfacesCollection(options),
    queueConfigCollection(options),
  ]);

  const queued = mac.queued + arp.queued + interfaces.queued + config.queued;
  console.log(
    `[tabs] auto-collect devices=${mac.deviceCount} queued=${queued} (mac=${mac.queued} arp=${arp.queued} ports=${interfaces.queued} config=${config.queued})`,
  );

  return {
    deviceCount: Math.max(mac.deviceCount, arp.deviceCount, interfaces.deviceCount, config.deviceCount),
    queued,
    mac,
    arp,
    interfaces,
    config,
  };
}

export function scheduleConfigCollection(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;

  const run = async () => {
    try {
      const result = await queueConfigCollection();
      console.log(
        `[config] managed=${result.deviceCount} queued=${result.queued}${result.message ? ` (${result.message})` : ''}`,
      );
    } catch (error) {
      console.error('[config] scheduler failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 30000);

  return setInterval(() => {
    void run();
  }, intervalMs);
}
