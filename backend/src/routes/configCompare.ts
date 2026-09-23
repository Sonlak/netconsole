import { Router } from 'express';
import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const configCompareRouter = Router();

export type HistoryEntry = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  role: string;
  /** 'apply' = config pushed from web (APPLY_CONFIG job), 'snapshot' = periodic collection */
  entryType: 'apply' | 'snapshot';
  /** Who triggered the change. Null = scheduler (CLI/device-side change) */
  username: string | null;
  /** APPLY_CONFIG source: eos-api / ssh-cli / junos-rest / nxos-api / etc. Null for snapshots */
  source: string | null;
  /** Config role applied (core/dist/access/custom/template-xxx). Null for snapshots */
  configRole: string | null;
  /** Number of config lines applied. 0 for snapshots */
  lineCount: number;
};

/**
 * GET /api/config-snapshots/:deviceId/history
 * Returns a merged, time-sorted list of:
 *   - ConfigAuditLog entries  (web-applied configs, newest first)
 *   - GET_CONFIG SUCCESS jobs (periodic snapshots, newest first)
 *
 * The frontend uses this to build the "compare with previous" picker.
 * Each entry carries entryType so the UI can badge it as "apply" or "snapshot".
 */
configCompareRouter.get('/:deviceId/history', async (req, res) => {
  const { deviceId } = req.params;

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }

  // ── 1. APPLY_CONFIG audit entries (web pushes) ───────────────────────────
  const auditRows = await prisma.configAuditLog.findMany({
    where: { deviceId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  // ── 2. GET_CONFIG SUCCESS jobs (periodic snapshots) ──────────────────────
  const snapshotJobs = await prisma.job.findMany({
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
      createdById: true,
      createdBy: { select: { username: true } },
    },
  });

  // ── 3. Build merged entries ─────────────────────────────────────────────
  const auditEntries: HistoryEntry[] = auditRows.map((row) => {
    const dateStr = new Date(row.createdAt).toLocaleDateString('vi-VN');
    const timeStr = new Date(row.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const user = row.username ?? 'system';
    const roleLabel = row.configRole ? ` · ${row.configRole}` : '';
    return {
      id: row.jobId,
      label: `Apply config · ${dateStr} ${timeStr} · ${user}${roleLabel}`,
      content: row.config,
      timestamp: row.createdAt.toISOString(),
      role: user,
      entryType: 'apply',
      username: row.username,
      source: row.source,
      configRole: row.configRole,
      lineCount: row.lineCount,
    };
  });

  const snapshotEntries: HistoryEntry[] = [];
  for (const job of snapshotJobs) {
    // Skip jobs whose jobId already appears in audit (don't double-count
    // a GET_CONFIG that was collected right after an APPLY_CONFIG).
    const result = (job.result ?? {}) as Record<string, unknown>;
    const config = typeof result.config === 'string' ? result.config : '';
    if (!config) continue;

    const dateStr = new Date(job.updatedAt).toLocaleDateString('vi-VN');
    const timeStr = new Date(job.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    // Null createdById = scheduler/worker (CLI change detected by periodic collect)
    const user = job.createdBy?.username ?? null;
    const userLabel = user ?? 'CLI/scheduler';
    snapshotEntries.push({
      id: job.id,
      label: `Snapshot · ${dateStr} ${timeStr} · ${userLabel}`,
      content: config,
      timestamp: job.updatedAt.toISOString(),
      role: userLabel,
      entryType: 'snapshot',
      username: user,
      source: null,
      configRole: null,
      lineCount: config.split('\n').length,
    });
  }

  // ── 4. Merge and sort by timestamp descending ─────────────────────────────
  const allEntries = [...auditEntries, ...snapshotEntries];
  allEntries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Deduplicate by id (prefer the 'apply' entry if both exist for same id)
  const seen = new Set<string>();
  const deduped: HistoryEntry[] = [];
  for (const entry of allEntries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      deduped.push(entry);
    }
  }

  res.json({ entries: deduped });
});

/**
 * GET /api/config-snapshots/:deviceId/diff?from=id&to=id
 * Diff two configs. IDs can be either a Job ID (GET_CONFIG SUCCESS) or
 * a ConfigAuditLog jobId. Looks up whichever table contains the ID.
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

  async function loadEntry(id: string) {
    // Try ConfigAuditLog first (APPLY_CONFIG entries)
    const audit = await prisma.configAuditLog.findUnique({ where: { jobId: id } });
    if (audit) {
      const dateStr = new Date(audit.createdAt).toLocaleDateString('vi-VN');
      const user = audit.username ?? 'system';
      return {
        id,
        label: `Apply config · ${dateStr} · ${user}`,
        content: audit.config,
        timestamp: audit.createdAt.toISOString(),
        lineCount: audit.config.split('\n').length,
        entryType: 'apply' as const,
        username: audit.username,
        source: audit.source,
        configRole: audit.configRole,
      };
    }
    // Fall back to GET_CONFIG job
    const job = await prisma.job.findUnique({
      where: { id },
      select: { id: true, updatedAt: true, result: true, createdBy: { select: { username: true } } },
    });
    if (!job) return null;
    const result = (job.result ?? {}) as Record<string, unknown>;
    const content = typeof result.config === 'string' ? result.config : '';
    const dateStr = new Date(job.updatedAt).toLocaleDateString('vi-VN');
    const user = job.createdBy?.username ?? 'system';
    return {
      id,
      label: `Snapshot · ${dateStr} · ${user}`,
      content,
      timestamp: job.updatedAt.toISOString(),
      lineCount: content.split('\n').length,
      entryType: 'snapshot' as const,
      username: user,
      source: null,
      configRole: null,
    };
  }

  const [fromEntry, toEntry] = await Promise.all([loadEntry(from), loadEntry(to)]);

  if (!fromEntry) { res.status(404).json({ error: `Entry "${from}" not found` }); return; }
  if (!toEntry) { res.status(404).json({ error: `Entry "${to}" not found` }); return; }

  res.json({ from: fromEntry, to: toEntry });
});
