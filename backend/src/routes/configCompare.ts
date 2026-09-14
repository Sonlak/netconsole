import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { getDeviceSnapshots, getSnapshotConfig, diffConfigs, type DiffResult } from '../services/configCompare.js';

export const configCompareRouter = Router();

// GET /api/config-snapshots/:deviceId
// Returns list of config snapshots available for comparison.
configCompareRouter.get('/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const snapshots = await getDeviceSnapshots(deviceId);
  res.json({ snapshots });
});

// GET /api/config-snapshots/:deviceId/diff?from=jobId&to=jobId
// Returns diff between two snapshots.
configCompareRouter.get('/:deviceId/diff', async (req, res) => {
  const { deviceId } = req.params;
  const { from, to } = req.query as Record<string, string | undefined>;

  if (!from || !to) {
    res.status(400).json({ error: 'Both "from" and "to" job IDs are required' });
    return;
  }

  if (from === to) {
    res.status(400).json({ error: '"from" and "to" must be different' });
    return;
  }

  const [leftConfig, rightConfig] = await Promise.all([
    getSnapshotConfig(from),
    getSnapshotConfig(to),
  ]);

  if (leftConfig === null) {
    res.status(404).json({ error: `Snapshot "${from}" not found or not a GET_CONFIG SUCCESS job` });
    return;
  }
  if (rightConfig === null) {
    res.status(404).json({ error: `Snapshot "${to}" not found or not a GET_CONFIG SUCCESS job` });
    return;
  }

  // Fetch metadata for both snapshots
  const [fromJob, toJob] = await Promise.all([
    prisma.job.findUnique({
      where: { id: from },
      select: { updatedAt: true, createdBy: { select: { username: true } }, result: true },
    }),
    prisma.job.findUnique({
      where: { id: to },
      select: { updatedAt: true, createdBy: { select: { username: true } }, result: true },
    }),
  ]);

  const fromResult = (fromJob?.result ?? {}) as Record<string, unknown>;
  const toResult = (toJob?.result ?? {}) as Record<string, unknown>;

  const diff: DiffResult = diffConfigs(leftConfig, rightConfig);

  res.json({
    from: {
      jobId: from,
      collectedAt: fromJob?.updatedAt.toISOString() ?? null,
      username: fromJob?.createdBy?.username ?? null,
      collectMs: typeof fromResult.collectMs === 'number' ? (fromResult.collectMs as number) : 0,
      lineCount: leftConfig.split('\n').length,
    },
    to: {
      jobId: to,
      collectedAt: toJob?.updatedAt.toISOString() ?? null,
      username: toJob?.createdBy?.username ?? null,
      collectMs: typeof toResult.collectMs === 'number' ? (toResult.collectMs as number) : 0,
      lineCount: rightConfig.split('\n').length,
    },
    diff,
  });
});
