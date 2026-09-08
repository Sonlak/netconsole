import { Router } from 'express';
import {
  collectInterfacesForDevice,
  getLatestInterfacesJob,
  parseInterfaceActionPayload,
  queueInterfaceAction,
} from '../services/interfaces.js';
import { prisma } from '../lib/prisma.js';

export const interfacesRouter = Router();

interfacesRouter.get('/devices', async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: [{ site: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      ip: true,
      site: true,
      floor: true,
      status: true,
      vendor: true,
      model: true,
    },
  });
  res.json({ devices });
});

interfacesRouter.get('/:deviceId', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const job = await getLatestInterfacesJob(deviceId);
  const result = (job?.result ?? null) as Record<string, unknown> | null;
  const interfaces = Array.isArray(result?.interfaces) ? result.interfaces : [];

  res.json({
    device: {
      id: device.id,
      name: device.name,
      ip: device.ip,
      site: device.site,
      floor: device.floor,
      status: device.status,
    },
    interfaces,
    jobId: job?.id ?? null,
    collectedAt: job?.updatedAt?.toISOString() ?? null,
    source: result?.source ?? null,
  });
});

interfacesRouter.post('/:deviceId/collect', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  try {
    const result = await collectInterfacesForDevice(deviceId);
    res.status(result.queued ? 202 : 200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Interface collection failed';
    const status = message === 'Device not found' ? 404 : 502;
    res.status(status).json({ error: message });
  }
});

interfacesRouter.post('/:deviceId/actions', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const payload = parseInterfaceActionPayload(req.body);
  if (!payload) {
    res.status(400).json({
      error:
        'Invalid body. Expected { action: shut|no-shut|show-run|set-access-vlan, interface, vlan? }',
    });
    return;
  }

  const job = await queueInterfaceAction(deviceId, payload);
  if (!job) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  res.status(202).json({ job, message: `INTERFACE_ACTION ${payload.action} queued` });
});
