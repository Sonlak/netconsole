import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const STALE_MS: Partial<Record<JobType, number>> = {
  GET_INTERFACES: 120_000,
  GET_MAC: 120_000,
  GET_ARP: 120_000,
  GET_CONFIG: 120_000,
  MANAGED_CHECK: 120_000,
  CONNECT_TEST: 120_000,
  DISCOVERY_PROBE: 120_000,
  INTERFACE_ACTION: 120_000,
  APPLY_CONFIG: 180_000,
  ROLLBACK_CONFIG: 180_000,
};

const DEFAULT_STALE_MS = 120_000;

export async function reclaimStaleJobs() {
  const running = await prisma.job.findMany({
    where: { status: JobStatus.RUNNING },
    select: { id: true, type: true, updatedAt: true, deviceId: true },
  });
  const now = Date.now();
  const staleIds = running
    .filter((job) => now - job.updatedAt.getTime() >= (STALE_MS[job.type] ?? DEFAULT_STALE_MS))
    .map((job) => job.id);

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
