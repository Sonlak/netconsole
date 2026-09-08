import { Router } from 'express';
import { JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware, verifyToken } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { applyManagedCheckResult } from '../services/managedCheck.js';
import { applyCollectedDeviceFacts } from '../services/deviceIdentity.js';
import { applyInterfaceActionSnapshot } from '../services/interfaces.js';
import { invalidateFabricCache } from '../services/fabricTopology.js';
import { isAllowedLogFilename } from '../lib/junosLogFiles.js';
import { persistLogsForJob } from '../services/logs.js';
import { tryCreateDeviceJob } from '../services/deviceOperations.js';

export const jobsRouter = Router();

/**
 * Worker-only auth. Accepts a Bearer JWT signed with JWT_SECRET whose payload
 * has `role: "worker"`. Returns 401 otherwise.
 */
const workerAuth = (req: AuthenticatedRequest, res: import('express').Response, next: import('express').NextFunction): void => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: worker credentials required' });
    return;
  }
  const token = header.slice(7);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'worker') {
    res.status(401).json({ error: 'Unauthorized: worker credentials required' });
    return;
  }
  req.user = payload;
  next();
};

const INTERACTIVE_JOB_TYPES: JobType[] = [
  JobType.INTERFACE_ACTION,
  JobType.APPLY_CONFIG,
  JobType.ROLLBACK_CONFIG,
  JobType.MANAGED_CHECK,
  JobType.CONNECT_TEST,
  JobType.DISCOVERY_PROBE,
];

const REFRESH_JOB_TYPES: JobType[] = [JobType.GET_CONFIG, JobType.GET_INTERFACES];

// User-facing: list recent jobs for the dashboard/jobs page. Requires any authenticated user.
jobsRouter.get('/', authMiddleware, async (req, res) => {
  const status =
    typeof req.query.status === 'string' && req.query.status in JobStatus
      ? (req.query.status as JobStatus)
      : undefined;

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

// Worker-only: claim the next pending job(s). Requires `role: "worker"`.
//
// Priority order (config-studio jobs MUST be picked up before collection jobs
// even if they were created later):
//   1. Config Studio interactive: APPLY_CONFIG / ROLLBACK_CONFIG / MANAGED_CHECK
//      / INTERFACE_ACTION / CONNECT_TEST / DISCOVERY_PROBE (priority HIGH)
//   2. Manual refresh: GET_CONFIG / GET_INTERFACES (priority HIGH)
//   3. Scheduled collection: GET_ARP / GET_MAC / scheduled GET_CONFIG
//      (priority NORMAL — uses the index [status, priority, createdAt])
//
// Device lock: a device with an existing RUNNING job is skipped so two workers
// never operate on the same device concurrently. This mirrors the advisory-lock
// check in tryCreateDeviceJob so the queue and the job-creation path agree.
jobsRouter.get('/queue', workerAuth, async (req, res) => {
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
      // Priority DESC then FIFO so config-studio jobs ALWAYS jump the queue
      // ahead of any backlogged collection jobs.
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: take - picked.length,
    });
    // Filter out PENDING jobs whose device already has a RUNNING job.
    // We check ALL running job deviceIds at once (single query) so the
    // filter is cheap even for a large pending queue.
    const runningDeviceIds = new Set(
      (
        await prisma.job.findMany({
          where: { status: JobStatus.RUNNING },
          select: { deviceId: true },
        })
      )
        .map((r) => r.deviceId)
        .filter((id): id is string => id !== null),
    );
    for (const row of rows) {
      // Skip if this device has an active (RUNNING) job — device is busy.
      if (row.deviceId && runningDeviceIds.has(row.deviceId)) continue;
      seen.push(row.id);
      picked.push(row);
    }
  };

  await pull(INTERACTIVE_JOB_TYPES);
  await pull(REFRESH_JOB_TYPES);
  await pull();
  res.json(picked);
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

jobsRouter.patch('/:id/claim', workerAuth, async (req, res) => {
  try {
    const job = await prisma.job.update({
      where: { id: String(req.params.id), status: JobStatus.PENDING },
      data: { status: JobStatus.RUNNING },
      include: { device: true },
    });
    res.json(job);
  } catch {
    res.status(409).json({ error: 'Job is not pending' });
  }
});

jobsRouter.patch('/:id/complete', workerAuth, async (req, res) => {
  const { result, error } = req.body as { result?: unknown; error?: string };

  try {
    const job = await prisma.job.update({
      where: { id: String(req.params.id), status: JobStatus.RUNNING },
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
          // NOTE: queueGetInterfaces auto-refresh removed — snapshot already
          // patches adminStatus/operStatus in the job result so the UI updates
          // immediately.  A full interfaces re-fetch can still be triggered
          // manually via POST /api/interfaces/:id/collect.
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

    let persistedLogs = 0;
    if (job.type === JobType.GET_LOGS && job.status === JobStatus.SUCCESS && job.deviceId) {
      try {
        const result = (job.result ?? {}) as { entries?: unknown[]; hostname?: string };
        const entries = Array.isArray(result.entries) ? (result.entries as Parameters<typeof persistLogsForJob>[1]) : [];
        persistedLogs = await persistLogsForJob(job.id, entries, result.hostname ?? '');
      } catch (logError) {
        console.error('[logs] persist failed', logError);
      }
    }

    res.json({ job, device, persistedLogs });
    if (job.type === JobType.GET_INTERFACES) invalidateFabricCache();
  } catch {
    res.status(409).json({ error: 'Job is not running' });
  }
});

jobsRouter.post('/', authMiddleware, async (req: AuthenticatedRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const userId = req.user.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized: missing user id in token' });
    return;
  }

  const { deviceId, type, payload } = req.body as {
    deviceId?: string;
    type?: JobType;
    payload?: Record<string, unknown> | { filename?: unknown };
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

  // Sanitize GET_LOGS payloads: validate the optional `filename` against
  // our whitelist so users can't ask the worker for arbitrary paths.
  let safePayload: Prisma.InputJsonValue | undefined;
  if (payload !== undefined && payload !== null) {
    if (type === JobType.GET_LOGS && 'filename' in payload) {
      const filename = payload.filename;
      if (typeof filename === 'string' && filename) {
        if (!isAllowedLogFilename(filename)) {
          res.status(400).json({ error: `Unknown log filename: ${filename}` });
          return;
        }
        safePayload = { filename } as Prisma.InputJsonValue;
      } else if (filename == null) {
        safePayload = { filename: 'messages' } as Prisma.InputJsonValue;
      }
    } else {
      safePayload = payload as Prisma.InputJsonValue;
    }
  } else if (type === JobType.GET_LOGS) {
    safePayload = { filename: 'messages' } as Prisma.InputJsonValue;
  }

  // Device lock + cross-user attribution via the shared helper. See
  // services/deviceOperations.ts → tryCreateDeviceJob for the advisory
  // lock semantics. POST /api/jobs and POST /api/devices/:id/xxx share
  // this code path so the lock is enforced uniformly across all entry
  // points.
  const outcome = await prisma.$transaction(async (tx) =>
    tryCreateDeviceJob(tx, deviceId, type, userId, safePayload),
  );

  if (outcome.kind === 'busy') {
    const b = outcome.error.blockingJob;
    res.status(409).json({
      error: 'Device busy',
      code: 'device_locked',
      lockedBy: {
        jobId: b.id,
        jobType: b.type,
        jobStatus: b.status,
        jobCreatedAt: b.createdAt,
        username: b.createdByUsername,
      },
    });
    return;
  }

  // Re-fetch with device relation so the response shape is unchanged
  // for existing clients (they expect job.device).
  const job = await prisma.job.findUnique({
    where: { id: outcome.job.id },
    include: { device: true },
  });

  res.status(201).json(job);
});
