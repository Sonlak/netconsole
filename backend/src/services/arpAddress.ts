import { JobStatus, JobType } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { getLatestJobResult } from './deviceOperations.js';

export type ArpTableEntry = {
  ip: string;
  mac: string;
  hostname: string;
  interface: string;
  flags: string;
};

export type ArpAddressRow = ArpTableEntry & {
  deviceId: string;
  deviceName: string;
  site: string;
  floor: string;
  deviceIp: string;
  collectedAt: string | null;
};

type ArpJobResult = {
  implemented?: boolean;
  entries?: ArpTableEntry[];
  message?: string;
};

export async function getArpInventory(): Promise<{
  rows: ArpAddressRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
}> {
  const devices = await listCollectableDevices();

  const rows: ArpAddressRow[] = [];
  let devicesWithData = 0;

  for (const device of devices) {
    const job = await getLatestJobResult(device.id, JobType.GET_ARP);
    const result = (job?.result ?? {}) as ArpJobResult;
    const entries = result.entries ?? [];

    if (entries.length > 0) {
      devicesWithData += 1;
    }

    for (const entry of entries) {
      rows.push({
        ip: entry.ip,
        mac: entry.mac,
        hostname: entry.hostname || entry.ip,
        interface: entry.interface,
        flags: entry.flags,
        deviceId: device.id,
        deviceName: device.name,
        site: canonicalSite(device.name, device.site),
        floor: canonicalFloor(device.name, device.floor),
        deviceIp: device.ip,
        collectedAt: job?.updatedAt?.toISOString() ?? null,
      });
    }
  }

  return {
    rows,
    managedDevices: devices.length,
    devicesWithData,
    lastUpdatedAt:
      rows.reduce<string | null>((latest, row) => {
        if (!row.collectedAt) {
          return latest;
        }
        if (!latest || row.collectedAt > latest) {
          return row.collectedAt;
        }
        return latest;
      }, null),
  };
}

export async function queueArpCollection(options?: {
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
          type: JobType.GET_ARP,
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
        type: JobType.GET_ARP,
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

export async function collectArpForManagedDevices() {
  return queueArpCollection({ force: true });
}

export function scheduleArpCollection(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;

  const run = async () => {
    try {
      const result = await queueArpCollection();
      console.log(
        `[arp] managed=${result.deviceCount} queued=${result.queued}${result.message ? ` (${result.message})` : ''}`,
      );
    } catch (error) {
      console.error('[arp] scheduler failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 20000);

  return setInterval(() => {
    void run();
  }, intervalMs);
}
