import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

export const configCompareRouter = Router();

/**
 * GET /api/config-snapshots/:deviceId/history
 * Returns full commit history — ALL saved configs (draft + committed + rollback)
 * sorted by timestamp, newest first. This feeds the "commit history" picker.
 */
configCompareRouter.get('/:deviceId/history', async (req, res) => {
  const { deviceId } = req.params;

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  const savedConfigs = await prisma.deviceSavedConfig.findMany({
    where: { deviceId },
    orderBy: { updatedAt: 'desc' },
  });

  type Entry = {
    id: string;
    label: string;
    content: string;
    timestamp: string;
    role: string;
  };

  const entries: Entry[] = [];

  for (const sc of savedConfigs) {
    // Draft / current content
    if (sc.content) {
      entries.push({
        id: `${sc.id}:draft`,
        label: `Draft · ${sc.role} · ${sc.updatedAt.toLocaleDateString('vi-VN')}`,
        content: sc.content,
        timestamp: sc.updatedAt.toISOString(),
        role: sc.role,
      });
    }

    // Committed snapshot
    if (sc.committedContent) {
      entries.push({
        id: `${sc.id}:committed`,
        label: `Đã commit · ${sc.role} · ${sc.committedAt ? new Date(sc.committedAt).toLocaleDateString('vi-VN') : '—'}`,
        content: sc.committedContent,
        timestamp: sc.committedAt ? new Date(sc.committedAt).toISOString() : sc.createdAt.toISOString(),
        role: sc.role,
      });
    }

    // Rollback snapshot
    if (sc.rollbackContent && sc.rollbackContent !== sc.committedContent) {
      entries.push({
        id: `${sc.id}:rollback`,
        label: `Rollback · ${sc.role} · ${sc.updatedAt.toLocaleDateString('vi-VN')}`,
        content: sc.rollbackContent,
        timestamp: sc.updatedAt.toISOString(),
        role: sc.role,
      });
    }
  }

  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json({ entries });
});

/**
 * GET /api/config-snapshots/:deviceId/diff?from=id&to=id
 * Diff two saved configs by their IDs.
 * ID format: "savedConfigId:slot" where slot is draft|committed|rollback.
 * Special value "__current__" is handled by the frontend (current running config).
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

  function parseId(id: string): { savedConfigId: string; slot: string } {
    const colonIdx = id.lastIndexOf(':');
    if (colonIdx === -1) return { savedConfigId: id, slot: 'content' };
    return { savedConfigId: id.slice(0, colonIdx), slot: id.slice(colonIdx + 1) };
  }

  function getSlotContent(
    sc: { content: string | null; committedContent: string | null; rollbackContent: string | null },
    slot: string,
  ): string {
    switch (slot) {
      case 'committed': return sc.committedContent ?? '';
      case 'rollback':  return sc.rollbackContent ?? '';
      default:          return sc.content ?? '';
    }
  }

  const [fromParsed, toParsed] = [parseId(from), parseId(to)];

  const [fromSc, toSc] = await Promise.all([
    prisma.deviceSavedConfig.findUnique({
      where: { id: fromParsed.savedConfigId },
      select: {
        id: true, role: true, committedAt: true, updatedAt: true,
        content: true, committedContent: true, rollbackContent: true,
      },
    }),
    prisma.deviceSavedConfig.findUnique({
      where: { id: toParsed.savedConfigId },
      select: {
        id: true, role: true, committedAt: true, updatedAt: true,
        content: true, committedContent: true, rollbackContent: true,
      },
    }),
  ]);

  if (!fromSc) { res.status(404).json({ error: `Config "${from}" not found` }); return; }
  if (!toSc) { res.status(404).json({ error: `Config "${to}" not found` }); return; }

  const fromContent = getSlotContent(fromSc, fromParsed.slot);
  const toContent   = getSlotContent(toSc, toParsed.slot);

  const fromLabel = fromParsed.slot === 'committed' ? 'Đã commit' : fromParsed.slot === 'rollback' ? 'Rollback' : 'Draft';
  const toLabel   = toParsed.slot === 'committed'   ? 'Đã commit' : toParsed.slot === 'rollback'   ? 'Rollback' : 'Draft';

  res.json({
    from: {
      id: from,
      label: `${fromLabel} · ${fromSc.role}`,
      content: fromContent,
      timestamp: fromSc.committedAt ? fromSc.committedAt.toISOString() : fromSc.updatedAt.toISOString(),
      lineCount: fromContent.split('\n').length,
    },
    to: {
      id: to,
      label: `${toLabel} · ${toSc.role}`,
      content: toContent,
      timestamp: toSc.committedAt ? toSc.committedAt.toISOString() : toSc.updatedAt.toISOString(),
      lineCount: toContent.split('\n').length,
    },
  });
});
