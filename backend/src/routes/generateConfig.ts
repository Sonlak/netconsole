import { Router } from 'express';
import { DeviceStatus, JobStatus, JobType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  CONFIG_TEMPLATES,
  renderConfigTemplate,
  suggestRole,
  type ConfigRole,
} from '../services/labConfigTemplates.js';

export const generateConfigRouter = Router();

const ROLES = new Set<ConfigRole>(['core', 'dist', 'access']);

function asRole(value: unknown): ConfigRole | null {
  return typeof value === 'string' && ROLES.has(value as ConfigRole)
    ? (value as ConfigRole)
    : null;
}

generateConfigRouter.get('/templates', (_req, res) => {
  res.json(CONFIG_TEMPLATES);
});

generateConfigRouter.get('/templates/:role', async (req, res) => {
  const role = asRole(req.params.role);
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  if (!role) {
    res.status(400).json({ error: 'role must be core, dist, or access' });
    return;
  }
  if (!deviceId) {
    res.status(400).json({ error: 'deviceId is required' });
    return;
  }

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  res.json({
    role,
    deviceId: device.id,
    deviceName: device.name,
    content: renderConfigTemplate(role, device),
  });
});

generateConfigRouter.get('/devices/:id', async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
    include: { savedConfig: true },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const latest = await prisma.job.findFirst({
    where: { deviceId: device.id, type: JobType.GET_CONFIG, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });

  const result = (latest?.result ?? null) as { config?: string } | null;
  const suggestedRole = suggestRole(device);

  res.json({
    device: {
      id: device.id,
      name: device.name,
      ip: device.ip,
      site: device.site,
      floor: device.floor,
      status: device.status,
      model: device.model,
    },
    suggestedRole,
    saved: device.savedConfig,
    running: {
      source: latest ? 'job' : 'none',
      jobId: latest?.id ?? null,
      collectedAt: latest?.updatedAt ?? null,
      config: result?.config ?? '',
    },
  });
});

generateConfigRouter.put('/devices/:id', async (req, res) => {
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const role = asRole(req.body?.role) ?? 'custom';

  const saved = await prisma.deviceSavedConfig.upsert({
    where: { deviceId: device.id },
    create: {
      deviceId: device.id,
      role,
      content,
    },
    update: {
      role,
      content,
    },
  });

  res.json(saved);
});

async function enqueue(
  deviceId: string,
  type: JobType,
  payload: Prisma.InputJsonValue | undefined,
  res: import('express').Response,
) {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    include: { savedConfig: true },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  if (device.status !== DeviceStatus.MANAGED) {
    res.status(409).json({ error: 'Thiết bị phải MANAGED trước khi commit/rollback' });
    return;
  }

  const job = await prisma.job.create({
    data: {
      deviceId,
      type,
      status: JobStatus.PENDING,
      ...(payload !== undefined ? { payload } : {}),
    },
    include: { device: true },
  });

  res.status(202).json({ job, saved: device.savedConfig });
}

generateConfigRouter.post('/devices/:id/commit', async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
    include: { savedConfig: true },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  if (device.status !== DeviceStatus.MANAGED) {
    res.status(409).json({ error: 'Thiết bị phải MANAGED trước khi commit' });
    return;
  }

  const content =
    (typeof req.body?.content === 'string' && req.body.content.trim()
      ? req.body.content
      : device.savedConfig?.content) ?? '';
  if (!content.trim()) {
    res.status(400).json({ error: 'Chưa có config để commit — lưu trên tool trước' });
    return;
  }

  const role = asRole(req.body?.role) ?? device.savedConfig?.role ?? 'custom';
  await prisma.deviceSavedConfig.upsert({
    where: { deviceId: device.id },
    create: { deviceId: device.id, role, content },
    update: { role, content },
  });

  const latest = await prisma.job.findFirst({
    where: { deviceId: device.id, type: JobType.GET_CONFIG, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });
  const previous =
    device.savedConfig?.committedContent ||
    ((latest?.result ?? {}) as { config?: string }).config ||
    '';

  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.APPLY_CONFIG,
      status: JobStatus.PENDING,
      payload: { config: content, role, previous },
    },
    include: { device: true },
  });

  res.status(202).json({ job });
});

generateConfigRouter.post('/devices/:id/rollback', async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
    include: { savedConfig: true },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  await enqueue(
    device.id,
    JobType.ROLLBACK_CONFIG,
    { rollback: 1, previous: device.savedConfig?.rollbackContent ?? '' },
    res,
  );
});

generateConfigRouter.post('/jobs/:jobId/ack-commit', async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });
  if (!job?.deviceId || job.type !== JobType.APPLY_CONFIG || job.status !== JobStatus.SUCCESS) {
    res.status(400).json({ error: 'Job commit không hợp lệ' });
    return;
  }

  const payload = (job.payload ?? {}) as { config?: string };
  const result = (job.result ?? {}) as { previous?: string; config?: string };
  const saved = await prisma.deviceSavedConfig.findUnique({ where: { deviceId: job.deviceId } });
  if (!saved) {
    res.status(404).json({ error: 'No saved config' });
    return;
  }

  const updated = await prisma.deviceSavedConfig.update({
    where: { deviceId: job.deviceId },
    data: {
      rollbackContent: result.previous ?? saved.committedContent ?? saved.rollbackContent,
      committedContent: payload.config ?? result.config ?? saved.content,
      committedAt: new Date(),
    },
  });

  res.json(updated);
});

generateConfigRouter.post('/jobs/:jobId/ack-rollback', async (req, res) => {
  const job = await prisma.job.findUnique({ where: { id: req.params.jobId } });
  if (!job?.deviceId || job.type !== JobType.ROLLBACK_CONFIG || job.status !== JobStatus.SUCCESS) {
    res.status(400).json({ error: 'Job rollback không hợp lệ' });
    return;
  }

  const result = (job.result ?? {}) as { config?: string };
  const saved = await prisma.deviceSavedConfig.findUnique({ where: { deviceId: job.deviceId } });
  if (!saved) {
    res.status(404).json({ error: 'No saved config' });
    return;
  }

  const updated = await prisma.deviceSavedConfig.update({
    where: { deviceId: job.deviceId },
    data: {
      rollbackContent: saved.committedContent ?? saved.content,
      committedContent: result.config ?? saved.rollbackContent,
      content: result.config ?? saved.rollbackContent ?? saved.content,
      committedAt: new Date(),
    },
  });

  res.json(updated);
});
