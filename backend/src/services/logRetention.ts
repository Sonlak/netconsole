/**
 * Daily log retention cleanup.
 *
 * Prunes `DeviceLog` rows older than `LOG_RETENTION_DAYS` so the table does
 * not grow without bound. Runs once on startup then every 24 h thereafter.
 *
 * The `@unique` index on `DeviceLog.jobId` means a syslog batch can only have
 * one set of rows per synthetic job. Deleting by `receivedAt` is safe: it
 * removes both job-based and UDP-batched rows without affecting the job table.
 */

import { prisma } from '../lib/prisma.js';

export function startLogRetentionCleanup(retentionDays: number): NodeJS.Timeout {
  if (retentionDays <= 0) {
    return { ref: 0, unref: () => {} } as unknown as NodeJS.Timeout;
  }

  const ms24h = 24 * 3600 * 1000;

  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
      const result = await prisma.deviceLog.deleteMany({
        where: { receivedAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        console.log(
          `[logs] retention cleanup: deleted ${result.count} rows older than ${retentionDays} days (cutoff ${cutoff.toISOString()})`,
        );
      }
    } catch (error) {
      console.error('[logs] retention cleanup failed:', error);
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
