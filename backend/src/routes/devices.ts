import { Router } from 'express';
import { DeviceStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getDeviceById, registerDeviceOperationRoutes } from './deviceOperations.js';
import { devicePingRouter } from './devicePing.js';
import { pingAndUpdateDevice } from '../services/devicePing.js';

export const devicesRouter = Router();

function normalizeManualStatus(status: unknown): DeviceStatus {
  if (status === DeviceStatus.MAINTENANCE) {
    return DeviceStatus.MAINTENANCE;
  }
  return DeviceStatus.UNKNOWN;
}

function parseDeviceBody(body: Record<string, unknown>, isUpdate = false) {
  const {
    site,
    floor,
    name,
    ip,
    status,
    vendor,
    model,
    version,
    serial,
    description,
  } = body;

  if (
    typeof site !== 'string' ||
    typeof floor !== 'string' ||
    typeof name !== 'string' ||
    typeof ip !== 'string' ||
    typeof vendor !== 'string' ||
    typeof model !== 'string' ||
    typeof version !== 'string' ||
    typeof serial !== 'string'
  ) {
    return { error: 'Missing or invalid required fields' };
  }

  const normalizedStatus = isUpdate
    ? normalizeManualStatus(status)
    : DeviceStatus.UNKNOWN;

  return {
    data: {
      site: site.trim(),
      floor: floor.trim(),
      name: name.trim(),
      ip: ip.trim(),
      status: normalizedStatus,
      vendor: vendor.trim(),
      model: model.trim(),
      version: version.trim(),
      serial: serial.trim(),
      description:
        typeof description === 'string' && description.trim()
          ? description.trim()
          : null,
    },
  };
}

devicesRouter.get('/', async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: [{ site: 'asc' }, { floor: 'asc' }, { name: 'asc' }],
  });
  res.json(devices);
});

devicesRouter.use(devicePingRouter);
registerDeviceOperationRoutes(devicesRouter);

devicesRouter.get('/:id', getDeviceById);

devicesRouter.post('/', async (req, res) => {
  const parsed = parseDeviceBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const device = await prisma.device.create({ data: parsed.data });
    void pingAndUpdateDevice(device.id).catch((error) => {
      console.error(`[ping] initial check failed for ${device.id}`, error);
    });
    res.status(201).json(device);
  } catch {
    res.status(409).json({ error: 'IP or serial already exists' });
  }
});

devicesRouter.put('/:id', async (req, res) => {
  const parsed = parseDeviceBody(req.body, true);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const existing = await prisma.device.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    let nextStatus = existing.status;
    if (parsed.data.status === DeviceStatus.MAINTENANCE) {
      nextStatus = DeviceStatus.MAINTENANCE;
    } else if (
      existing.status === DeviceStatus.MAINTENANCE &&
      parsed.data.status === DeviceStatus.UNKNOWN
    ) {
      nextStatus = DeviceStatus.UNKNOWN;
    }

    const device = await prisma.device.update({
      where: { id: req.params.id },
      data: {
        ...parsed.data,
        status: nextStatus,
      },
    });

    if (
      existing.status === DeviceStatus.MAINTENANCE &&
      nextStatus === DeviceStatus.UNKNOWN
    ) {
      void pingAndUpdateDevice(device.id).catch((error) => {
        console.error(`[ping] resume check failed for ${device.id}`, error);
      });
    }

    res.json(device);
  } catch {
    res.status(404).json({ error: 'Device not found or duplicate IP/serial' });
  }
});

devicesRouter.delete('/:id', async (req, res) => {
  try {
    await prisma.device.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Device not found' });
  }
});
