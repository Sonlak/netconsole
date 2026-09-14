import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { applyCollectedDeviceFacts } from './deviceIdentity.js';
import { fetchConfigurationSet, junosRestEnabled } from './junosRest.js';
import { fetchEosConfig, eosRestEnabled } from './eosApi.js';
import { blockingJobToLockedBy, tryCreateDeviceJob } from './deviceOperations.js';

/** Fallback: enqueue a GET_CONFIG job and return. */
async function enqueueConfigJob(deviceId: string, createdById: string | null, deviceName: string) {
  const outcome = await prisma.$transaction(async (tx) =>
    tryCreateDeviceJob(tx, deviceId, JobType.GET_CONFIG, createdById),
  );

  if (outcome.kind === 'busy') {
    const err = new Error('Device busy');
    (err as Error & { code?: string; lockedBy?: unknown }).code = 'device_locked';
    (err as Error & { code?: string; lockedBy?: unknown }).lockedBy = blockingJobToLockedBy(outcome.error.blockingJob);
    throw err;
  }

  const job = await prisma.job.findUnique({
    where: { id: outcome.job.id },
    include: { device: true },
  });
  return { job: job!, queued: true as const };
}

export async function collectDeviceConfig(deviceId: string, createdById: string | null) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  // ── EOS eAPI fast path ──────────────────────────────────────────────
  if (eosRestEnabled()) {
    const eos = await fetchEosConfig(device.ip);
    if (eos.ok && eos.config) {
      const job = await prisma.$transaction(async (tx) => {
        const outcome = await tryCreateDeviceJob(tx, device.id, JobType.GET_CONFIG, createdById);
        if (outcome.kind === 'busy') {
          throw Object.assign(new Error('Device busy'), {
            code: 'device_locked',
            lockedBy: blockingJobToLockedBy(outcome.error.blockingJob),
          });
        }
        return tx.job.update({
          where: { id: outcome.job.id },
          data: {
            status: JobStatus.SUCCESS,
            result: {
              implemented: true,
              source: 'eos-api',
              config: eos.config,
              command: 'show running-config',
              message: `Collected running config from ${device.name}`,
              collectMs: eos.collectMs,
            },
          },
          include: { device: true },
        });
      });

      console.log(`[config] ${device.ip} (EOS) collected in ${eos.collectMs}ms (${eos.config.split('\n').length} lines)`);
      return { job, device, queued: false as const };
    }
    // eAPI failed or returned empty — fall through to job queue below.
    console.log(`[config] ${device.ip} (EOS) eAPI failed (${eos.error}), falling back to job queue`);
  }

  // ── Junos RESTCONF fast path ─────────────────────────────────────────
  if (junosRestEnabled()) {
    const rest = await fetchConfigurationSet(device.ip);
    if (!rest.ok || !rest.config) {
      // REST failed — fall back to job queue.
      console.log(`[config] ${device.ip} (Junos) REST failed (${rest.error}), falling back to job queue`);
      const { job: j } = await enqueueConfigJob(device.id, createdById, device.name);
      return { job: j, device, queued: true as const };
    }

    // REST succeeded — commit the result directly.
    const job = await prisma.$transaction(async (tx) => {
      const outcome = await tryCreateDeviceJob(tx, device.id, JobType.GET_CONFIG, createdById);
      if (outcome.kind === 'busy') {
        throw Object.assign(new Error('Device busy'), {
          code: 'device_locked',
          lockedBy: blockingJobToLockedBy(outcome.error.blockingJob),
        });
      }
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
    console.log(`[config] ${device.ip} (Junos) collected in ${rest.collectMs}ms (${rest.config.split('\n').length} lines)`);
    return { job, device: updated ?? device, queued: false as const };
  }

  // ── No fast path available — fall back to job queue ───────────────────
  const { job } = await enqueueConfigJob(device.id, createdById, device.name);
  return { job, device, queued: true as const };
}
