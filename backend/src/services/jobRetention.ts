/**
 * Daily job retention cleanup.
 *
 * Prunes `Job` rows older than `JOB_RETENTION_DAYS` so the auto-collect sweeps
 * (GET_MAC / GET_ARP / GET_INTERFACES / GET_CONFIG / MANAGED_CHECK) don't
 * accumulate ~280k rows/month once Tier-B 5-minute intervals are enabled.
 *
 * Policy:
 *   - Delete rows where `createdAt < cutoff` AND status IN (SUCCESS, FAILED).
 *   - NEVER touch PENDING/RUNNING rows. A stuck PENDING > retention days is a
 *     real bug we want to see, not auto-prune.
 *   - With 5-min sweep × 8 devices × 4 collect types × 30 days ≈ 276k rows
 *     pruned per cycle. Run once at startup (5 s delay), then every 24 h.
 *   - `DISTINCT ON (... updatedAt DESC)` queries on the Job table always have
 *     at least one fresh SUCCESS row per (deviceId, type) — 30 days × 12/h ≈
 *     8.6k rows per device-type, way above the floor we need.
 *
 * The `Job.result` JSON column is where MAC/ARP/interface snapshots live; we
 * do NOT archive to disk before delete. If you need a long-term audit trail,
 * point `scripts/backup_postgres.sh` at a remote target BEFORE turning on
 * retention, or extend this file to copy `result` into S3/B2 first.
 */

import { JobStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export function startJobRetentionCleanup(retentionDays: number): NodeJS.Timeout {
  if (retentionDays <= 0) {
    return { ref: 0, unref: () => {} } as unknown as NodeJS.Timeout;
  }

  const ms24h = 24 * 3600 * 1000;

  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
      const result = await prisma.job.deleteMany({
        where: {
          createdAt: { lt: cutoff },
          status: { in: [JobStatus.SUCCESS, JobStatus.FAILED] },
        },
      });
      if (result.count > 0) {
        console.log(
          `[jobs] retention cleanup: deleted ${result.count} terminal rows older than ${retentionDays} days (cutoff ${cutoff.toISOString()})`,
        );
      }
    } catch (error) {
      // P2003 = foreign key violation; safe to ignore here (no FK to Job).
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        console.error(`[jobs] retention cleanup failed (${error.code}):`, error.message);
      } else {
        console.error('[jobs] retention cleanup failed:', error);
      }
    }
  };

  // Run once at startup, then every 24 h.
  setTimeout(() => {
    void run();
  }, 5000);

  return setInterval(() => {
    void run();
  }, ms24h);
}
