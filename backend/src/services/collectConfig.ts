import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { applyCollectedDeviceFacts } from './deviceIdentity.js';
import { fetchConfigurationSet, junosRestEnabled } from './junosRest.js';
import { tryCreateDeviceJob } from './deviceOperations.js';

export async function collectDeviceConfig(deviceId: string, createdById: string | null) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  if (!junosRestEnabled()) {
    // Wrap the create in a transaction so the advisory lock is scoped to
    // the insert (we must NOT hold the lock during the long REST call
    // below). If another user already has a PENDING/RUNNING job for this
    // device, surface that with the same 409 shape used by /api/jobs.
    const outcome = await prisma.$transaction(async (tx) =>
      tryCreateDeviceJob(tx, device.id, JobType.GET_CONFIG, createdById),
    );

    if (outcome.kind === 'busy') {
      const err = new Error('Device busy');
      (err as Error & { code?: string; lockedBy?: unknown }).code = 'device_locked';
      (err as Error & { code?: string; lockedBy?: unknown }).lockedBy = outcome.error.blockingJob;
      throw err;
    }

    const job = await prisma.job.findUnique({
      where: { id: outcome.job.id },
      include: { device: true },
    });
    return { job: job!, device, queued: true as const };
  }

  // RESTCONF path: do the HTTP call OUTSIDE the lock (it can take seconds),
  // then commit a SUCCESS row. We still want device-lock semantics so a
  // second click can't run two parallel get-configuration RPCs against the
  // same device. Wrap the whole thing: take lock → check inflight →
  // REST → insert SUCCESS → release.
  const rest = await fetchConfigurationSet(device.ip);
  if (!rest.ok || !rest.config) {
    throw new Error(rest.error || 'Junos REST get-configuration failed');
  }

  const job = await prisma.$transaction(async (tx) => {
    const outcome = await tryCreateDeviceJob(tx, device.id, JobType.GET_CONFIG, createdById);
    if (outcome.kind === 'busy') {
      throw Object.assign(new Error('Device busy'), {
        code: 'device_locked',
        lockedBy: outcome.error.blockingJob,
      });
    }
    // Overwrite the PENDING row to SUCCESS in the same transaction so we
    // don't briefly hold a PENDING row visible to other lockers.
    return tx.job.update({
      where: { id: outcome.job.id },
      data: {
        status: JobStatus.SUCCESS,
        result: {
          implemented: true,
          source: 'junos-rest',
          config: rest.config,
          hostname: rest.identity.hostname || '',
          version: rest.identity.version || '',
          command: 'get-configuration format=set',
          message: `Collected running config from ${device.name}`,
          collectMs: rest.collectMs,
        },
      },
      include: { device: true },
    });
  });

  const updated = await applyCollectedDeviceFacts(job);
  console.log(`[config] ${device.ip} collected in ${rest.collectMs}ms (${rest.config.split('\n').length} lines)`);
  return { job, device: updated ?? device, queued: false as const };
}
