import { JobStatus, JobType } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { getLatestJobResult, jobPriority } from './deviceOperations.js';
import { fetchArpTable } from './junosRest.js';
import { fetchIosxeArpTable } from './iosxeRest.js';

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
        priority: jobPriority(JobType.GET_ARP),
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

/**
 * Collect ARP table for a single device via direct REST call (bypasses job queue).
 *
 * - Juniper: calls `fetchArpTable()` which uses Junos RESTCONF.
 * - IOS-XE:   calls `fetchIosxeArpTable()` which uses Cisco RESTCONF YANG.
 *             Falls back to job queue if YANG returns empty (SSH fallback via worker).
 * - Other:    always uses job queue (worker handles vendor-specific logic).
 *
 * Always writes a SUCCESS job row so GET /api/devices/:id/arp returns fresh data.
 * Returns `{ job, queued }` where `queued=true` means a worker job was also
 * queued as a fallback (e.g. IOS-XE with empty YANG response).
 */
export async function collectArpForDevice(
  deviceId: string,
  createdById: string | null,
): Promise<{ job: { id: string; type: JobType; status: JobStatus; createdAt: Date; deviceId: string | null }; queued: boolean }> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  const vendor = (device.vendor ?? '').toLowerCase();

  // Juniper: try REST first
  if (vendor === 'juniper') {
    const rest = await fetchArpTable(device.ip);
    if (rest.ok) {
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_ARP,
          status: JobStatus.SUCCESS,
          priority: jobPriority(JobType.GET_ARP),
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'junos-rest',
            entries: rest.entries,
            command: 'get-arp-table-information',
            message: `Collected ARP table from ${device.name} via REST`,
            collectMs: rest.collectMs,
          } as object,
        },
      });
      console.log(`[arp] ${device.ip} collected via REST in ${rest.collectMs}ms (${rest.entries.length} entries)`);
      return { job, queued: false };
    }
    // REST failed — fall through to job queue so worker can retry
    console.warn(`[arp] ${device.ip} REST failed (${rest.error}), falling back to job queue`);
  }

  // IOS-XE: try RESTCONF (YANG ARP is often empty on lab images)
  if (vendor === 'cisco') {
    const rest = await fetchIosxeArpTable(device.ip);
    if (rest.ok) {
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_ARP,
          status: JobStatus.SUCCESS,
          priority: jobPriority(JobType.GET_ARP),
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'iosxe-rest',
            entries: rest.entries,
            command: 'Cisco-IOS-XE-arp-oper:arp-data',
            message: `Collected ARP table from ${device.name} via RESTCONF`,
            collectMs: rest.collectMs,
          } as object,
        },
      });
      console.log(`[arp] ${device.ip} collected via RESTCONF in ${rest.collectMs}ms (${rest.entries.length} entries)`);
      return { job, queued: false };
    }
    // YANG empty or failed — fall through to job queue (worker SSH fallback)
    console.warn(`[arp] ${device.ip} RESTCONF ARP failed (${rest.error}), falling back to job queue`);
  }

  // Default: create a PENDING job (worker handles vendor-specific logic)
  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.GET_ARP,
      status: JobStatus.PENDING,
      priority: jobPriority(JobType.GET_ARP),
      ...(createdById ? { createdById } : {}),
    },
    select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
  });
  return { job, queued: true };
}
