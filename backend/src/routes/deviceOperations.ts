import { JobType } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { collectDeviceConfig } from '../services/collectConfig.js';
import {
  createDeviceJob,
  getLatestJobResult,
  stubPayload,
} from '../services/deviceOperations.js';
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
    void triggerOperation(idParam(req), JobType.GET_ARP, res, userId(req)),
  );
  router.get('/:id/mac', (req, res) =>
    void readOperation(idParam(req), JobType.GET_MAC, res),
  );
  router.post('/:id/mac', authMiddleware, (req, res) =>
    void triggerOperation(idParam(req), JobType.GET_MAC, res, userId(req)),
  );
  router.post('/:id/connect', authMiddleware, (req, res) =>
    void triggerOperation(idParam(req), JobType.CONNECT_TEST, res, userId(req)),
  );
}

export async function getDeviceById(req: Request, res: Response) {
  const device = await prisma.device.findUnique({ where: { id: String(req.params.id) } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json(device);
}
