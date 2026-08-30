import { JobStatus, JobType } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { getLatestJobResult } from './deviceOperations.js';

export type MacTableEntry = {
  mac: string;
  vlan: string;
  tag: string;
  interface: string;
  flags: string;
  type: string;
  sessId: string;
};

export type MacAddressRow = MacTableEntry & {
  /** Host IP for this MAC from ARP inventory; "n/a" when unknown. */
  ip: string;
  deviceId: string;
  deviceName: string;
  site: string;
  floor: string;
  deviceIp: string;
  collectedAt: string | null;
};

type MacJobResult = {
  implemented?: boolean;
  entries?: MacTableEntry[];
  message?: string;
};

type ArpJobResult = {
  implemented?: boolean;
  entries?: Array<{ ip?: string; mac?: string }>;
  message?: string;
};

function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

async function buildArpIpLookup(deviceIds: string[]) {
  const byDeviceMac = new Map<string, string>();
  const byMac = new Map<string, string>();

  for (const deviceId of deviceIds) {
    const job = await getLatestJobResult(deviceId, JobType.GET_ARP);
    const entries = ((job?.result ?? {}) as ArpJobResult).entries ?? [];
    for (const entry of entries) {
      const macNorm = normalizeMac(String(entry.mac ?? ''));
      const ip = String(entry.ip ?? '').trim();
      if (!macNorm || !ip) {
        continue;
      }
      byDeviceMac.set(`${deviceId}:${macNorm}`, ip);
      if (!byMac.has(macNorm)) {
        byMac.set(macNorm, ip);
      }
    }
  }

  return { byDeviceMac, byMac };
}

function resolveHostIp(
  deviceId: string,
  mac: string,
  lookup: { byDeviceMac: Map<string, string>; byMac: Map<string, string> },
): string {
  const macNorm = normalizeMac(mac);
  if (!macNorm) {
    return 'n/a';
  }
  return lookup.byDeviceMac.get(`${deviceId}:${macNorm}`) ?? lookup.byMac.get(macNorm) ?? 'n/a';
}

export async function getMacAddressInventory(): Promise<{
  rows: MacAddressRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
}> {
  const devices = await listCollectableDevices();
  const arpLookup = await buildArpIpLookup(devices.map((device) => device.id));

  const rows: MacAddressRow[] = [];
  let devicesWithData = 0;

  for (const device of devices) {
    const job = await getLatestJobResult(device.id, JobType.GET_MAC);
    const result = (job?.result ?? {}) as MacJobResult;
    const entries = result.entries ?? [];

    if (entries.length > 0) {
      devicesWithData += 1;
    }

    for (const entry of entries) {
      rows.push({
        mac: entry.mac,
        ip: resolveHostIp(device.id, entry.mac, arpLookup),
        vlan: entry.vlan,
        tag: entry.tag,
        interface: entry.interface,
        flags: entry.flags,
        type: entry.type,
        sessId: entry.sessId,
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

export async function queueMacCollection(options?: {
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
          type: JobType.GET_MAC,
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
        type: JobType.GET_MAC,
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

export async function collectMacAddressesForManagedDevices() {
  return queueMacCollection({ force: true });
}

export function scheduleMacCollection(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;

  const run = async () => {
    try {
      const result = await queueMacCollection();
      console.log(
        `[mac] managed=${result.deviceCount} queued=${result.queued}${result.message ? ` (${result.message})` : ''}`,
      );
    } catch (error) {
      console.error('[mac] scheduler failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 15000);

  return setInterval(() => {
    void run();
  }, intervalMs);
}
