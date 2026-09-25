import { Prisma, JobStatus, JobType } from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';
import { jobPriority } from './deviceOperations.js';
import { fetchArpTable } from './junosRest.js';
import { fetchIosxeArpTable } from './iosxeRest.js';
import { getFabricTopology, inferDeviceRole } from './fabricTopology.js';
import type { FabricLink, FabricNode } from './fabricTopology.js';

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
  endUserDevice: string;
  endUserPort: string;
};

type ArpJobResult = {
  implemented?: boolean;
  entries?: ArpTableEntry[];
  message?: string;
};

/**
 * Fetch the latest GET_ARP job (with its `result` blob) per device in one
 * round-trip. Without this, getArpInventory() loops N devices, each calling
 * prisma.job.findFirst with no LIMIT -- Postgres Seq Scans the entire
 * GET_ARP table (~46k rows), ~95ms per device, ~1.5s for 9 devices.
 *
 * DISTINCT ON gives us "latest by updatedAt per deviceId" in one pass.
 * Result is keyed by deviceId so the caller can O(1) lookup.
 */
async function fetchLatestArpJobsByDevice(
  deviceIds: string[],
): Promise<Map<string, { result: ArpJobResult; updatedAt: Date }>> {
  const out = new Map<string, { result: ArpJobResult; updatedAt: Date }>();
  if (deviceIds.length === 0) return out;
  const rows = await prisma.$queryRaw<
    Array<{ deviceId: string; result: unknown; updatedAt: Date }>
  >`
    SELECT DISTINCT ON ("deviceId")
           "deviceId", result, "updatedAt"
    FROM "Job"
    WHERE type = 'GET_ARP'::"JobType"
      AND status = 'SUCCESS'::"JobStatus"
      AND "deviceId" IN (${Prisma.join(deviceIds)})
    ORDER BY "deviceId", "updatedAt" DESC
  `;
  for (const row of rows) {
    out.set(row.deviceId, {
      result: (row.result ?? {}) as ArpJobResult,
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

type MacJobResult = {
  entries?: Array<{ mac?: string; interface?: string }>;
};

function normalizeMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return mac.toLowerCase().trim();
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`;
}

async function buildEndUserLookup(deviceIds: string[]): Promise<Map<string, { device: string; port: string }>> {
  const lookup = new Map<string, { device: string; port: string }>();
  if (deviceIds.length === 0) return lookup;

  const [macJobs, topology] = await Promise.all([
    prisma.$queryRaw<Array<{ deviceId: string; result: unknown }>>`
      SELECT DISTINCT ON ("deviceId") "deviceId", result
      FROM "Job"
      WHERE type = 'GET_MAC'::"JobType"
        AND status = 'SUCCESS'::"JobStatus"
        AND "deviceId" IN (${Prisma.join(deviceIds)})
      ORDER BY "deviceId", "updatedAt" DESC
    `,
    getFabricTopology() as Promise<{ nodes: FabricNode[]; links: FabricLink[] }>,
  ]);

  const deviceNames = new Map(topology.nodes.map((node) => [node.id, node.name]));
  const uplinkPorts = new Set<string>();
  for (const link of topology.links) {
    if (link.fromPort) uplinkPorts.add(`${link.fromDeviceId}:${link.fromPort.toLowerCase()}`);
    if (link.toPort) uplinkPorts.add(`${link.toDeviceId}:${link.toPort.toLowerCase()}`);
  }

  // Prefer access-switch MAC entries and ignore ports that topology identifies
  // as uplinks. This prevents the same host MAC learned on a distribution
  // trunk from being reported as the end-user port.
  for (const job of macJobs) {
    const node = topology.nodes.find((item) => item.id === job.deviceId);
    if (!node || inferDeviceRole(node.name, node.floor) !== 'access') continue;
    const entries = ((job.result ?? {}) as MacJobResult).entries ?? [];
    for (const entry of entries) {
      const mac = normalizeMac(String(entry.mac ?? ''));
      const port = String(entry.interface ?? '').trim();
      if (!mac || !port || uplinkPorts.has(`${job.deviceId}:${port.toLowerCase()}`)) continue;
      if (!lookup.has(mac)) lookup.set(mac, { device: deviceNames.get(job.deviceId) ?? node.name, port });
    }
  }
  return lookup;
}

export async function getArpInventory(): Promise<{
  rows: ArpAddressRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
}> {
  const devices = await listCollectableDevices();
  const latestByDevice = await fetchLatestArpJobsByDevice(
    devices.map((device) => device.id),
  );
  const endUserByMac = await buildEndUserLookup(devices.map((device) => device.id));

  const rows: ArpAddressRow[] = [];
  let devicesWithData = 0;

  for (const device of devices) {
    const job = latestByDevice.get(device.id);
    const result = job?.result ?? {};
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
        endUserDevice: endUserByMac.get(normalizeMac(entry.mac))?.device ?? '',
        endUserPort: endUserByMac.get(normalizeMac(entry.mac))?.port ?? '',
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

  // Juniper: try REST first. Only short-circuit to SUCCESS when the parser
  // actually extracted entries. If RESTCONF returned 200 but the regex
  // parser returned 0 entries (cRPD / stripped Junos variants may emit a
  // slightly different XML structure that the regex doesn't match), the
  // job MUST fall through to the worker — otherwise the new "successful"
  // job with `entries: []` will overwrite the previous real ARP data in
  // the inventory query (DISTINCT ON picks it as latest by updatedAt).
  // User-visible symptom: clicking "Collect" causes the ARP tab to go
  // blank even though the previous successful collect had data.
  if (vendor === 'juniper') {
    const rest = await fetchArpTable(device.ip);
    if (rest.ok && rest.entries.length > 0) {
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
    if (rest.ok && rest.entries.length === 0) {
      // RESTCONF succeeded but parser returned 0 — fall through to worker.
      console.warn(
        `[arp] ${device.ip} REST returned 0 entries (parser empty); falling back to worker (SSH)`,
      );
    } else {
      // REST failed outright.
      console.warn(`[arp] ${device.ip} REST failed (${rest.error}), falling back to job queue`);
    }
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
