import { Prisma, JobStatus, JobType } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { jobPriority } from './deviceOperations.js';
import { fetchMacTable } from './junosRest.js';
import { fetchIosxeMacTable } from './iosxeRest.js';

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

/**
 * Fetch the latest successful Job of a given `type` per device in one
 * round-trip via DISTINCT ON. Returns Map<deviceId, result>.
 *
 * Why: `prisma.job.findFirst({where:{deviceId, type, status:SUCCESS},
 * orderBy:updatedAt desc})` triggers a Parallel Seq Scan on the Job table
 * (~46k+ rows per type) at ~95ms per device. For 9 devices we spend ~900ms
 * to ~3.5s depending on how many types we query per page. DISTINCT ON with
 * IN (devices) returns one row per device in a single ~5ms index lookup.
 */
async function fetchLatestJobResultsByDevice(
  deviceIds: string[],
  type: JobType,
): Promise<Map<string, { result: unknown; updatedAt: Date }>> {
  const out = new Map<string, { result: unknown; updatedAt: Date }>();
  if (deviceIds.length === 0) return out;
  const rows = await prisma.$queryRaw<
    Array<{ deviceId: string; result: unknown; updatedAt: Date }>
  >`
    SELECT DISTINCT ON ("deviceId")
           "deviceId", result, "updatedAt"
    FROM "Job"
    WHERE type = ${type}::"JobType"
      AND status = 'SUCCESS'::"JobStatus"
      AND "deviceId" IN (${Prisma.join(deviceIds)})
    ORDER BY "deviceId", "updatedAt" DESC
  `;
  for (const row of rows) {
    out.set(row.deviceId, { result: row.result, updatedAt: row.updatedAt });
  }
  return out;
}

async function buildArpIpLookup(deviceIds: string[]) {
  const byDeviceMac = new Map<string, string>();
  const byMac = new Map<string, string>();

  const latestArpByDevice = await fetchLatestJobResultsByDevice(
    deviceIds,
    JobType.GET_ARP,
  );
  for (const [deviceId, job] of latestArpByDevice) {
    const entries = ((job.result ?? {}) as ArpJobResult).entries ?? [];
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
  const deviceIds = devices.map((device) => device.id);
  // One raw query per type instead of N per-device round-trips.
  const [latestMacByDevice, arpLookup] = await Promise.all([
    fetchLatestJobResultsByDevice(deviceIds, JobType.GET_MAC),
    buildArpIpLookup(deviceIds),
  ]);

  const rows: MacAddressRow[] = [];
  let devicesWithData = 0;

  for (const device of devices) {
    const job = latestMacByDevice.get(device.id);
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
        priority: jobPriority(JobType.GET_MAC),
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

/**
 * Collect MAC table for a single device via direct REST call (bypasses job queue).
 *
 * - Juniper: calls `fetchMacTable()` which uses Junos RESTCONF.
 * - IOS-XE:  always falls back to job queue (no stable YANG for MAC table;
 *             worker uses SSH `show mac address-table`).
 * - Other:   always uses job queue.
 *
 * Always writes a SUCCESS job row so GET /api/devices/:id/mac returns fresh data.
 * Returns `{ job, queued }` where `queued=true` means a worker job was also
 * queued as a fallback.
 */
export async function collectMacForDevice(
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
    const rest = await fetchMacTable(device.ip);
    if (rest.ok) {
      const job = await prisma.job.create({
        data: {
          deviceId: device.id,
          type: JobType.GET_MAC,
          status: JobStatus.SUCCESS,
          priority: jobPriority(JobType.GET_MAC),
          ...(createdById ? { createdById } : {}),
          result: {
            implemented: true,
            source: 'junos-rest',
            entries: rest.entries,
            command: 'get-ethernet-switching-table-information',
            message: `Collected MAC table from ${device.name} via REST`,
            collectMs: rest.collectMs,
          } as object,
        },
      });
      console.log(`[mac] ${device.ip} collected via REST in ${rest.collectMs}ms (${rest.entries.length} entries)`);
      return { job, queued: false };
    }
    console.warn(`[mac] ${device.ip} REST failed (${rest.error}), falling back to job queue`);
  }

  // IOS-XE: no YANG for MAC table — always queue worker job (SSH fallback)
  if (vendor === 'cisco') {
    console.warn(`[mac] ${device.ip} IOS-XE has no YANG MAC model, using job queue`);
  }

  // Default: create a PENDING job (worker handles vendor-specific logic)
  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.GET_MAC,
      status: JobStatus.PENDING,
      priority: jobPriority(JobType.GET_MAC),
      ...(createdById ? { createdById } : {}),
    },
    select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
  });
  return { job, queued: true };
}
