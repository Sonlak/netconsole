import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { pingAllDevices, pingAndUpdateDevice } from '../services/devicePing.js';
import { startManagedCheck, startManagedCheckAll } from '../services/managedCheck.js';

export const devicePingRouter = Router();

devicePingRouter.post('/check-ping', async (_req, res) => {
  try {
    const summary = await pingAllDevices();
    res.json(summary);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Ping check failed',
    });
  }
});

devicePingRouter.post('/check-managed', async (_req, res) => {
  try {
    const summary = await startManagedCheckAll();
    res.status(202).json(summary);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Managed check all failed',
    });
  }
});

devicePingRouter.post('/:id/check-managed', async (req, res) => {
  try {
    const result = await startManagedCheck(String(req.params.id));
    if ('reason' in result && result.skipped) {
      res.status(409).json({ error: result.reason, device: result.device });
      return;
    }

    res.status(result.job ? 202 : 200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Managed check failed';
    const status = message === 'Device not found' ? 404 : 500;
    res.status(status).json({ error: message });
  }
});

devicePingRouter.post('/:id/ping', async (req, res) => {
  try {
    const deviceId = String(req.params.id);
    const outcome = await pingAndUpdateDevice(deviceId);
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    res.json({ outcome, device });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ping failed';
    const status = message === 'Device not found' ? 404 : 500;
    res.status(status).json({ error: message });
  }
});
