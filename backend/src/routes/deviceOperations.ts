import { JobType } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { collectDeviceConfig } from '../services/collectConfig.js';
import {
  createDeviceJob,
  getLatestJobResult,
  stubPayload,
} from '../services/deviceOperations.js';
import { collectArpForDevice } from '../services/arpAddress.js';
import { collectMacForDevice } from '../services/macAddress.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

async function readOperation(deviceId: string, type: JobType, res: Response) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const latest = await getLatestJobResult(deviceId, type);
  if (latest?.result) {
    res.json({
      source: 'job',
      jobId: latest.id,
      collectedAt: latest.updatedAt,
      data: latest.result,
    });
    return;
  }

  res.json({
    source: 'stub',
    collectedAt: null,
    data: stubPayload(type, device.name),
  });
}

async function triggerOperation(deviceId: string, type: JobType, res: Response, createdById: string | null) {
  const job = await createDeviceJob(deviceId, type, res, createdById ?? undefined);
  if (!job) {
    return;
  }

  res.status(202).json({
    job,
    message: 'Job created. Python worker will process when lab integration is ready.',
  });
}

export function registerDeviceOperationRoutes(router: import('express').Router) {
  const idParam = (req: Request) => String(req.params.id);
  const userId = (req: AuthenticatedRequest) => req.user?.userId ?? null;

  router.get('/:id/config', (req, res) =>
    void readOperation(idParam(req), JobType.GET_CONFIG, res),
  );
  router.post('/:id/config', authMiddleware, (req, res) =>
    void (async () => {
      try {
        const result = await collectDeviceConfig(idParam(req), userId(req));
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Config collection failed';
        const lockedBy = (error as { lockedBy?: unknown }).lockedBy;
        if (message === 'Device busy' && lockedBy) {
          res.status(409).json({
            error: 'Device busy',
            code: 'device_locked',
            lockedBy,
          });
          return;
        }
        const status = message === 'Device not found' ? 404 : 502;
        res.status(status).json({ error: message });
      }
    })(),
  );
  router.get('/:id/arp', (req, res) =>
    void readOperation(idParam(req), JobType.GET_ARP, res),
  );
  router.post('/:id/arp', authMiddleware, (req, res) =>
    void (async () => {
      try {
        const result = await collectArpForDevice(idParam(req), userId(req));
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ARP collection failed';
        const status = message === 'Device not found' ? 404 : 502;
        res.status(status).json({ error: message });
      }
    })(),
  );
  router.get('/:id/mac', (req, res) =>
    void readOperation(idParam(req), JobType.GET_MAC, res),
  );
  router.post('/:id/mac', authMiddleware, (req, res) =>
    void (async () => {
      try {
        const result = await collectMacForDevice(idParam(req), userId(req));
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'MAC collection failed';
        const status = message === 'Device not found' ? 404 : 502;
        res.status(status).json({ error: message });
      }
    })(),
  );
  router.post('/:id/connect', authMiddleware, (req, res) =>
    void triggerOperation(idParam(req), JobType.CONNECT_TEST, res, userId(req)),
  );

  /**
   * POST /api/devices/:id/sync-netbox
   * Enqueue a NETBOX_SYNC_DEVICE job to push this device's inventory to
   * NetBox. Workers will call back to GET /api/devices/:id to get the
   * full Device row (serial, description, version, etc.) and then upsert
   * it to NetBox via REST API.
   *
   * Response 202: job created, worker will process asynchronously.
   * Response 404: device not found.
   * Response 409: device already has a pending NETBOX_SYNC_DEVICE job.
   */
  router.post('/:id/sync-netbox', authMiddleware, (req, res) =>
    void (async () => {
      const deviceId = idParam(req);
      const requestUserId = userId(req);
      try {
        const result = await triggerNetboxSync(deviceId, requestUserId);
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'NetBox sync failed';
        const lockedBy = (error as { lockedBy?: unknown }).lockedBy;
        if (message === 'Device busy' && lockedBy) {
          res.status(409).json({
            error: 'Device busy',
            code: 'device_locked',
            lockedBy,
          });
          return;
        }
        const status = message === 'Device not found' ? 404 : 502;
        res.status(status).json({ error: message });
      }
    })(),
  );
}

/**
 * Enqueue a NETBOX_SYNC_DEVICE job for a single device.
 *
 * Reuses the standard `tryCreateDeviceJob` path so the device lock and
 * cross-user attribution logic stay consistent with the rest of the
 * job-creating endpoints.
 */
async function triggerNetboxSync(deviceId: string, userId: string | null) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    throw new Error('Device not found');
  }

  const { tryCreateDeviceJob } = await import('../services/deviceOperations.js');
  const outcome = await prisma.$transaction((tx) =>
    tryCreateDeviceJob(tx, deviceId, JobType.NETBOX_SYNC_DEVICE, userId, {}),
  );
  if (outcome.kind === 'busy') {
    const b = outcome.error.blockingJob;
    const error = new Error('Device busy') as Error & { lockedBy?: unknown };
    error.lockedBy = {
      jobId: b.id,
      jobType: b.type,
      jobStatus: b.status,
      jobCreatedAt: b.createdAt,
      username: b.createdByUsername,
    };
    throw error;
  }

  return {
    queued: true,
    job: outcome.job,
  };
}

export async function getDeviceById(req: Request, res: Response) {
  const device = await prisma.device.findUnique({ where: { id: String(req.params.id) } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json(device);
}
