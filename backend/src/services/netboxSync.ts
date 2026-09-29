/**
 * NetBox periodic sync scheduler.
 *
 * Runs on a fixed interval (NETBOX_SYNC_INTERVAL_SECONDS) and enqueues a
 * single NETBOX_SYNC_ALL job. The job is created without a deviceId so it
 * is NOT subject to the per-device lock — the worker iterates over all
 * devices inside the job and reports per-device status in the job result.
 *
 * - If the previous NETBOX_SYNC_ALL job is still PENDING or RUNNING, we
 *   skip the cycle (don't pile up sync work).
 * - If a sync cycle fails entirely (e.g. NetBox unreachable), the job
 *   row will be FAILED with the error message; the next cycle still runs.
 * - The scheduler does not retry on its own — that's the worker's job
 *   plus the next scheduled tick.
 *
 * Phase-1 scope: device-level sync (site, vendor, model, serial, status,
 * description, custom_fields.netconsole_id, oob_ip).
 *
 * Phase 2 (deferred): per-device NETBOX_SYNC_DEVICE jobs instead of one
 * bulk job — so a single NetBox 4xx doesn't fail the whole sweep and the
 * queue can parallelize the work across the worker pool.
 */

import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const DEFAULT_INTERVAL_SECONDS = 300;  // 5 min between cycles
const MIN_INTERVAL_SECONDS = 60;        // never more often than 1/min
const STALE_AFTER_MS = 30 * 60 * 1000;  // 30 min — job is considered "stuck"

let timer: NodeJS.Timeout | null = null;
let isRunning = false;

export interface ScheduleNetboxSyncOptions {
  intervalSeconds?: number;
  force?: boolean;
}

/**
 * Enqueue a NETBOX_SYNC_ALL job. Returns the new job (or null if a
 * recent cycle is still in flight).
 *
 * Public so the manual `POST /api/jobs/netbox-sync-all` endpoint can
 * reuse the same gating logic.
 */
export async function enqueueNetboxSyncAll(
  options: { createdById?: string | null; force?: boolean } = {},
): Promise<{ job: { id: string; type: string; status: string } | null; skipped: boolean; reason?: string }> {
  const force = options.force ?? false;

  // Don't pile up — only create a new sync job if no PENDING/RUNNING
  // job exists OR the most-recent in-flight job is older than STALE_AFTER_MS.
  if (!force) {
    const inflight = await prisma.job.findFirst({
      where: {
        type: JobType.NETBOX_SYNC_ALL,
        status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (inflight) {
      const age = Date.now() - new Date(inflight.createdAt).getTime();
      if (age < STALE_AFTER_MS) {
        return {
          job: null,
          skipped: true,
          reason: `in-flight NETBOX_SYNC_ALL job ${inflight.id} (age=${Math.round(age / 1000)}s)`,
        };
      }
      // Older than STALE_AFTER_MS — log a warning and proceed (the
      // job watchdog should have caught this; if it hasn't we don't
      // want to wait forever).
      console.warn(
        `[netbox-sync] in-flight NETBOX_SYNC_ALL job ${inflight.id} is ${Math.round(age / 1000)}s old — proceeding with a new cycle`,
      );
    }
  }

  const job = await prisma.job.create({
    data: {
      deviceId: null,
      type: JobType.NETBOX_SYNC_ALL,
      status: JobStatus.PENDING,
      priority: 0,
      createdById: options.createdById ?? null,
    },
  });

  console.log(
    `[netbox-sync] enqueued NETBOX_SYNC_ALL job=${job.id} (createdById=${options.createdById ?? 'system'})`,
  );
  return { job: { id: job.id, type: job.type, status: job.status }, skipped: false };
}

/**
 * Schedule the periodic sync. The scheduler fires every `intervalSeconds`
 * (default 300s, i.e. 5 min) and enqueues a single NETBOX_SYNC_ALL job.
 * Initial run is delayed by 30s so the rest of the backend has time to
 * come up.
 */
export function scheduleNetboxSync(options: ScheduleNetboxSyncOptions = {}): void {
  const interval = Math.max(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
  const intervalMs = interval * 1000;

  const run = async () => {
    if (isRunning) {
      return;  // overlap guard for slow callbacks
    }
    isRunning = true;
    try {
      const result = await enqueueNetboxSyncAll();
      if (result.skipped) {
        console.log(`[netbox-sync] periodic: skipped — ${result.reason}`);
      } else if (result.job) {
        console.log(`[netbox-sync] periodic: enqueued job=${result.job.id}`);
      }
    } catch (error) {
      console.error('[netbox-sync] periodic: failed to enqueue', error);
    } finally {
      isRunning = false;
    }
  };

  // First run after 30s — give the worker time to start polling too.
  setTimeout(() => {
    void run();
  }, 30_000);

  // Then every intervalMs.
  timer = setInterval(() => {
    void run();
  }, intervalMs);

  console.log(`[netbox-sync] scheduler enabled (every ${interval}s)`);
}

export function stopNetboxSync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Re-export the type the route handler may need
export type NetboxSyncJob = Prisma.JobGetPayload<{
  include: { device: true; createdBy: { select: { id: true; username: true } } };
}>;
