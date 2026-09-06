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
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${deviceId})::bigint)`;

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

  const job = await tx.job.create({
    data: {
      deviceId,
      type,
      status: JobStatus.PENDING,
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
