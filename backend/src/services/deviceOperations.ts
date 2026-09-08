import { JobStatus, JobType, Prisma } from '@prisma/client';
import type { Response } from 'express';
import { prisma } from '../lib/prisma.js';
import type { PrismaClient } from '@prisma/client';

export type DeviceBusyError = {
  code: 'device_locked';
  blockingJob: {
    id: string;
    type: JobType;
    status: JobStatus;
    createdAt: Date;
    createdByUsername: string | null;
  };
};

/**
 * Job types that originate from the Config Studio UI and MUST be picked up
 * by the worker ahead of any scheduled collection jobs. Config Studio jobs
 * are the ones an admin triggered interactively — they should never wait
 * behind a backlog of GET_ARP/GET_MAC scans.
 */
// Interactive / manual jobs always claim the front of the queue. These
// are the actions a user takes from the UI (commit, rollback, manage check,
// ping, fetch config, refresh interfaces) and MUST jump ahead of any
// background ARP/MAC sweep regardless of when the background job was
// queued.
//
// Background / scheduled collection (GET_ARP, GET_MAC) keeps the default
// priority of 0 so it never starves user actions.
const HIGH_PRIORITY_TYPES = new Set<JobType>([
  JobType.APPLY_CONFIG,
  JobType.ROLLBACK_CONFIG,
  JobType.MANAGED_CHECK,
  JobType.INTERFACE_ACTION,
  JobType.CONNECT_TEST,
  JobType.DISCOVERY_PROBE,
  JobType.GET_CONFIG,
  JobType.GET_INTERFACES,
]);

// "Urgent" priority: only used by jobs created by a user-driven action
// (manual collect, manual interface refresh, commit, rollback, managed
// check, interface action). These need to win over background collections
// AND over a previously-queued auto-scheduled GET_CONFIG / GET_INTERFACES
// from the same device so the user does not see "Device busy" because of
// a 30-second-old background poll.
const URGENT_PRIORITY_TYPES = new Set<JobType>([
  JobType.APPLY_CONFIG,
  JobType.ROLLBACK_CONFIG,
  JobType.MANAGED_CHECK,
  JobType.INTERFACE_ACTION,
  JobType.CONNECT_TEST,
  JobType.DISCOVERY_PROBE,
  JobType.GET_CONFIG,
]);

export function jobPriority(type: JobType): number {
  if (URGENT_PRIORITY_TYPES.has(type)) return 200;
  if (HIGH_PRIORITY_TYPES.has(type)) return 100;
  return 0;
}

/**
 * Try to create a job for a device, serialised by Postgres advisory lock.
 * Returns either { kind: 'created', job } or { kind: 'busy', error }.
 * Caller decides how to map the busy case to HTTP (POST /api/jobs uses 409,
 * POST /api/devices/:id/xxx uses 409 too but with a slightly different shape).
 *
 * IMPORTANT: `tx` must be a transaction handle — advisory locks are
 * scoped to the transaction and released automatically on commit/rollback.
 */
export async function tryCreateDeviceJob(
  tx: Prisma.TransactionClient | PrismaClient,
  deviceId: string,
  type: JobType,
  createdById: string | null,
  payload?: Prisma.InputJsonValue,
): Promise<
  | { kind: 'created'; job: { id: string; type: JobType; status: JobStatus; createdAt: Date; deviceId: string | null } }
  | { kind: 'busy'; error: DeviceBusyError }
> {
  // Serialize every concurrent POST that targets this device. hashtext
  // maps UUID -> int4 -> bigint so identical deviceIds always collide on
  // the same lock; different devices never block each other.
  // `$executeRaw` (not `$queryRaw`) because pg_advisory_xact_lock returns
  // void — Prisma cannot deserialize a void column on $queryRaw.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceId})::bigint)`;

  const blocking = await tx.job.findFirst({
    where: {
      deviceId,
      status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { username: true } },
    },
  });

  if (blocking) {
    // Pre-emption: a URGENT (user-driven) job is allowed to cancel a
    // lower-priority blocking job from the same device. Background ARP /
    // MAC sweeps that are still PENDING get dropped here; an in-flight
    // RUNNING job gets marked FAILED with a clear message so the worker
    // either notices it before it does damage, or the operator sees why
    // the previous job was aborted when they open the Jobs page.
    const incomingPriority = jobPriority(type);
    if (URGENT_PRIORITY_TYPES.has(type) && (blocking.priority ?? 0) < incomingPriority) {
      if (blocking.status === JobStatus.PENDING) {
        // Background collection not yet picked up — safe to delete.
        await tx.job.delete({ where: { id: blocking.id } });
      } else {
        // RUNNING — we can't safely kill the worker's socket, but we
        // mark the row FAILED so it stops blocking the queue. The worker
        // will see the row has already been terminalised when it tries
        // to claim the next job and will drop the (already-done) work.
        await tx.job.update({
          where: { id: blocking.id },
          data: {
            status: JobStatus.FAILED,
            error: `Pre-empted by ${type} job (higher priority)`,
          },
        });
      }
    } else {
      return {
        kind: 'busy',
        error: {
          code: 'device_locked',
          blockingJob: {
            id: blocking.id,
            type: blocking.type,
            status: blocking.status,
            createdAt: blocking.createdAt,
            createdByUsername: blocking.createdBy?.username ?? null,
          },
        },
      };
    }
  }

  const job = await tx.job.create({
    data: {
      deviceId,
      type,
      status: JobStatus.PENDING,
      priority: jobPriority(type),
      ...(createdById ? { createdById } : {}),
      ...(payload !== undefined ? { payload } : {}),
    },
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
      deviceId: true,
    },
  });

  return { kind: 'created', job };
}

export async function getLatestJobResult(
  deviceId: string,
  type: JobType,
) {
  return prisma.job.findFirst({
    where: { deviceId, type, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function createDeviceJob(
  deviceId: string,
  type: JobType,
  res: Response,
  createdById?: string,
) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }

  const outcome = await prisma.$transaction(async (tx) =>
    tryCreateDeviceJob(tx, deviceId, type, createdById ?? null),
  );

  if (outcome.kind === 'busy') {
    res.status(409).json({
      error: 'Device busy',
      code: 'device_locked',
      lockedBy: {
        jobId: outcome.error.blockingJob.id,
        jobType: outcome.error.blockingJob.type,
        jobStatus: outcome.error.blockingJob.status,
        jobCreatedAt: outcome.error.blockingJob.createdAt,
        username: outcome.error.blockingJob.createdByUsername,
      },
    });
    return null;
  }

  // Re-fetch with device relation for the existing 202 response shape.
  const job = await prisma.job.findUnique({
    where: { id: outcome.job.id },
    include: { device: true },
  });
  return job;
}

export function stubPayload(type: JobType, deviceName: string) {
  const base = {
    implemented: false,
    message: 'Worker chưa kết nối lab. Endpoint đã sẵn sàng để tích hợp.',
    deviceName,
  };

  switch (type) {
    case JobType.CONNECT_TEST:
      return { ...base, connected: false };
    case JobType.GET_CONFIG:
      return { ...base, config: `# Configuration for ${deviceName}\n# TODO: worker + aionet` };
    case JobType.GET_ARP:
      return {
        ...base,
        entries: [
          { ip: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', interface: 'Vlan10', age: '-' },
        ],
      };
    case JobType.GET_MAC:
      return {
        ...base,
        entries: [
          {
            mac: 'aa:bb:cc:00:02:01',
            vlan: '10',
            tag: '-',
            interface: 'ge-0/0/1.0',
            flags: 'D',
            type: 'dynamic',
            sessId: '0',
          },
        ],
      };
    case JobType.GET_INTERFACES:
      return {
        ...base,
        interfaces: [
          {
            name: 'ge-0/0/0',
            adminStatus: 'up',
            operStatus: 'up',
            description: 'mgmt',
            mode: 'inet',
            accessVlan: '',
            address: '',
            mtu: '1514',
            speed: '1000mbps',
          },
        ],
      };
    default:
      return base;
  }
}
