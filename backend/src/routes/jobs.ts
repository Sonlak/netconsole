import { Router } from 'express';
import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { applyManagedCheckResult } from '../services/managedCheck.js';
import { applyCollectedDeviceFacts } from '../services/deviceIdentity.js';
import { applyInterfaceActionSnapshot, queueGetInterfaces } from '../services/interfaces.js';

export const jobsRouter = Router();

const INTERACTIVE_JOB_TYPES: JobType[] = [
  JobType.INTERFACE_ACTION,
  JobType.APPLY_CONFIG,
  JobType.ROLLBACK_CONFIG,
  JobType.MANAGED_CHECK,
  JobType.CONNECT_TEST,
  JobType.DISCOVERY_PROBE,
];

const REFRESH_JOB_TYPES: JobType[] = [JobType.GET_CONFIG, JobType.GET_INTERFACES];

jobsRouter.get('/', async (req, res) => {
  const status =
    typeof req.query.status === 'string' && req.query.status in JobStatus
      ? (req.query.status as JobStatus)
      : undefined;
  const forWorker = req.query.forWorker === '1' || req.query.forWorker === 'true';

  if (forWorker) {
    const include = {
      device: {
        select: { id: true, name: true, ip: true, site: true, vendor: true, model: true },
      },
    };
    const take = Math.min(Math.max(Number(req.query.limit) || 1, 1), 16);
    const picked: Array<{ id: string }> = [];
    const seen: string[] = [];

    const pull = async (typeFilter?: JobType[]) => {
      if (picked.length >= take) return;
      const rows = await prisma.job.findMany({
        where: {
          status: JobStatus.PENDING,
          ...(typeFilter ? { type: { in: typeFilter } } : {}),
          ...(seen.length ? { id: { notIn: seen } } : {}),
        },
        include,
        orderBy: { createdAt: 'asc' },
        take: take - picked.length,
      });
      for (const row of rows) {
        seen.push(row.id);
        picked.push(row);
      }
    };

    await pull(INTERACTIVE_JOB_TYPES);
    await pull(REFRESH_JOB_TYPES);
    await pull();
    res.json(picked);
    return;
  }

  const jobs = await prisma.job.findMany({
    where: status ? { status } : undefined,
    include: {
      device: {
        select: { id: true, name: true, ip: true, site: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.json(jobs);
});

jobsRouter.get('/:id', async (req, res) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      device: {
        select: { id: true, name: true, ip: true, site: true, vendor: true, model: true },
      },
    },
  });

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
});

jobsRouter.patch('/:id/claim', async (req, res) => {
  try {
    const job = await prisma.job.update({
      where: { id: req.params.id, status: JobStatus.PENDING },
      data: { status: JobStatus.RUNNING },
      include: { device: true },
    });
    res.json(job);
  } catch {
    res.status(409).json({ error: 'Job is not pending' });
  }
});

jobsRouter.patch('/:id/complete', async (req, res) => {
  const { result, error } = req.body as { result?: unknown; error?: string };

  try {
    const job = await prisma.job.update({
      where: { id: req.params.id, status: JobStatus.RUNNING },
      data: {
        status: error ? JobStatus.FAILED : JobStatus.SUCCESS,
        result:
          result === undefined
            ? undefined
            : (result as Prisma.InputJsonValue),
        error: error ?? null,
      },
      include: { device: true },
    });

    let device = null;
    try {
      device = await applyManagedCheckResult(job);
      if (!device) {
        device = await applyCollectedDeviceFacts(job);
      }
      if (
        job.type === JobType.INTERFACE_ACTION &&
        job.status === JobStatus.SUCCESS &&
        job.deviceId
      ) {
        const result = (job.result ?? {}) as {
          action?: string;
          interface?: string;
          adminStatus?: string | null;
          accessVlan?: string | null;
        };
        if (result.action && result.action !== 'show-run') {
          await applyInterfaceActionSnapshot(job.deviceId, result).catch((error) => {
            console.error(`[interfaces] snapshot after ${result.action} failed`, error);
          });
          void queueGetInterfaces(job.deviceId, { force: true }).catch((error) => {
            console.error(`[interfaces] refresh after ${result.action} failed`, error);
          });
        }
      }
    } catch (applyError) {
      console.error('[jobs] apply device facts failed', applyError);
      res.status(500).json({
        error: applyError instanceof Error ? applyError.message : 'Failed to apply managed check',
        job,
      });
      return;
    }

    res.json({ job, device });
  } catch {
    res.status(409).json({ error: 'Job is not running' });
  }
});

jobsRouter.post('/', async (req, res) => {
  const { deviceId, type, payload } = req.body as {
    deviceId?: string;
    type?: JobType;
    payload?: unknown;
  };

  if (!deviceId || !type || !Object.values(JobType).includes(type)) {
    res.status(400).json({ error: 'deviceId and valid type are required' });
    return;
  }

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const job = await prisma.job.create({
    data: {
      deviceId,
      type,
      status: JobStatus.PENDING,
      ...(payload !== undefined ? { payload: payload as Prisma.InputJsonValue } : {}),
    },
    include: { device: true },
  });

  res.status(201).json(job);
});
