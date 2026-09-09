import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

// Per-job-type stale thresholds in milliseconds. Vendor-aware
// overrides are applied in `reclaimStaleJobs` so we can give Junos
// cRPD sim more headroom (its first commit RPC can spike to 30s on a
// cold session) while keeping tight bounds on fast read jobs.
const STALE_MS: Partial<Record<JobType, number>> = {
  GET_INTERFACES: 120_000,
  GET_MAC: 120_000,
  GET_ARP: 120_000,
  GET_CONFIG: 120_000,
  MANAGED_CHECK: 120_000,
  CONNECT_TEST: 120_000,
  DISCOVERY_PROBE: 120_000,
  INTERFACE_ACTION: 120_000,
  APPLY_CONFIG: 240_000,
  ROLLBACK_CONFIG: 240_000,
};

// Some vendors need even more headroom. The bulk of the read paths
// are vendor-agnostic (RESTCONF/SSH share a 120s budget) but Juniper
// cRPD can spike a first-of-session commit to 30s and a rollback to
// another 20s, so we cap Juniper write jobs at 5 minutes to absorb
// the spike without falsely reclaiming a job that is still making
// real progress on the device.
//
// INTERFACE_ACTION (shut/no-shut/set-access-vlan/show-run) can take up
// to 90s per transport (NETCONF SSH load+commit, gotcha #15) plus 30s
// for a cold-session spike, so Juniper gets +120s extra (240s total).
const VENDOR_EXTRA_MS: Partial<Record<JobType, number>> = {
  APPLY_CONFIG: 60_000,
  ROLLBACK_CONFIG: 60_000,
  INTERFACE_ACTION: 120_000,
};

const DEFAULT_STALE_MS = 120_000;

export async function reclaimStaleJobs() {
  const running = await prisma.job.findMany({
    where: { status: JobStatus.RUNNING },
    select: { id: true, type: true, updatedAt: true, deviceId: true },
  });
  if (running.length === 0) {
    return 0;
  }

  // Pull the vendor for every running job's device in one round-trip
  // so we can apply the per-vendor extension. Reads with no deviceId
  // fall back to the base threshold.
  const deviceIds = Array.from(
    new Set(running.map((job) => job.deviceId).filter((id): id is string => Boolean(id))),
  );
  const devices = deviceIds.length
    ? await prisma.device.findMany({
        where: { id: { in: deviceIds } },
        select: { id: true, vendor: true },
      })
    : [];
  const vendorById = new Map(devices.map((d) => [d.id, (d.vendor || '').toLowerCase()]));

  const now = Date.now();
  const staleIds: string[] = [];
  for (const job of running) {
    const base = STALE_MS[job.type] ?? DEFAULT_STALE_MS;
    const extra = vendorById.get(job.deviceId ?? '') === 'juniper'
      ? VENDOR_EXTRA_MS[job.type] ?? 0
      : 0;
    if (now - job.updatedAt.getTime() >= base + extra) {
      staleIds.push(job.id);
    }
  }

  if (staleIds.length === 0) {
    return 0;
  }

  await prisma.job.updateMany({
    where: { id: { in: staleIds }, status: JobStatus.RUNNING },
    data: {
      status: JobStatus.FAILED,
      error: 'Job timed out (worker restart or hung RPC)',
    },
  });
  console.log(`[jobs] reclaimed ${staleIds.length} stale RUNNING job(s)`);
  return staleIds.length;
}

export function scheduleJobWatchdog(intervalSeconds = 30) {
  const intervalMs = Math.max(intervalSeconds, 15) * 1000;
  const run = async () => {
    try {
      await reclaimStaleJobs();
    } catch (error) {
      console.error('[jobs] watchdog failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 3000);

  return setInterval(() => {
    void run();
  }, intervalMs);
}
