import { Router } from 'express';
import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const configCompareRouter = Router();

/**
 * GET /api/config-snapshots/:deviceId/history
 * Returns running configs collected by GET_CONFIG SUCCESS jobs, sorted newest first.
 * This feeds the "compare with previous days" picker on the device detail page.
 */
configCompareRouter.get('/:deviceId/history', async (req, res) => {
  const { deviceId } = req.params;

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const jobs = await prisma.job.findMany({
    where: {
      deviceId,
      type: JobType.GET_CONFIG,
      status: JobStatus.SUCCESS,
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      updatedAt: true,
      result: true,
      createdBy: { select: { username: true } },
    },
  });

  type Entry = {
    id: string;
    label: string;
    content: string;
    timestamp: string;
    role: string;
  };

  const entries: Entry[] = [];
  for (const job of jobs) {
    const result = (job.result ?? {}) as Record<string, unknown>;
    const config = typeof result.config === 'string' ? result.config : '';
    if (!config) continue;
    const dateStr = new Date(job.updatedAt).toLocaleDateString('vi-VN');
    const timeStr = new Date(job.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const user = job.createdBy?.username ?? 'system';
    entries.push({
      id: job.id,
      label: `Running config · ${dateStr} ${timeStr} · ${user}`,
      content: config,
      timestamp: job.updatedAt.toISOString(),
      role: user,
    });
  }

  res.json({ entries });
});

/**
 * GET /api/config-snapshots/:deviceId/diff?from=id&to=id
 * Diff two configs. IDs are Job IDs (GET_CONFIG SUCCESS jobs).
 */
configCompareRouter.get('/:deviceId/diff', async (req, res) => {
  const { deviceId } = req.params;
  const { from, to } = req.query as Record<string, string | undefined>;

  if (!from || !to) {
    res.status(400).json({ error: 'Both "from" and "to" are required' });
    return;
  }

  if (from === to) {
    res.status(400).json({ error: '"from" and "to" must be different' });
    return;
  }

  const [fromJob, toJob] = await Promise.all([
    prisma.job.findUnique({
      where: { id: from },
      select: { id: true, updatedAt: true, result: true, createdBy: { select: { username: true } } },
    }),
    prisma.job.findUnique({
      where: { id: to },
      select: { id: true, updatedAt: true, result: true, createdBy: { select: { username: true } } },
    }),
  ]);

  if (!fromJob) { res.status(404).json({ error: `Config "${from}" not found` }); return; }
  if (!toJob) { res.status(404).json({ error: `Config "${to}" not found` }); return; }

  const fromResult = (fromJob.result ?? {}) as Record<string, unknown>;
  const toResult = (toJob.result ?? {}) as Record<string, unknown>;
  const fromContent = typeof fromResult.config === 'string' ? fromResult.config : '';
  const toContent = typeof toResult.config === 'string' ? toResult.config : '';
  const fromUser = fromJob.createdBy?.username ?? 'system';
  const toUser = toJob.createdBy?.username ?? 'system';

  const fromDate = new Date(fromJob.updatedAt).toLocaleDateString('vi-VN');
  const toDate = new Date(toJob.updatedAt).toLocaleDateString('vi-VN');

  res.json({
    from: {
      id: from,
      label: `Running config · ${fromDate} · ${fromUser}`,
      content: fromContent,
      timestamp: fromJob.updatedAt.toISOString(),
      lineCount: fromContent.split('\n').length,
    },
    to: {
      id: to,
      label: `Running config · ${toDate} · ${toUser}`,
      content: toContent,
      timestamp: toJob.updatedAt.toISOString(),
      lineCount: toContent.split('\n').length,
    },
  });
});
