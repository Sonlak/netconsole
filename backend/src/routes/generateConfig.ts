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

/**
 * Lightweight payload sanity check before we enqueue an APPLY_CONFIG or
 * ROLLBACK_CONFIG job. The worker has its own comment-stripping
 * (`_set_commands` in `worker/netconsole_worker/backends/juniper.py`)
 * but that runs AFTER the candidate database has already been opened
 * on the device. Catching obvious garbage here turns a confusing
 * "configuration database modified" failure on the device into a
 * clear 400 response so the operator can fix the input.
 */
// Single source of truth for Junos "set" verbs accepted by the device.
// Mirrors the whitelist in `worker/netconsole_worker/backends/juniper.py::_set_commands`
// — any verb outside this list will reach the Junos parser as
// "unknown command" and leave the candidate database in a modified
// state (then the next commit fails with "configuration database
// modified"). We surface the same whitelist at the API layer so the
// operator gets a clear 400 instead of a worker-side silent skip.
export const JUNIPER_SET_VERBS: ReadonlySet<string> = new Set([
  'set',
  'delete',
  'deactivate',
  'activate',
  'protect',
  'unprotect',
  'edit',
  'top',
  'up',
  'exit',
  'commit',
  'rollback',
  'show',
  'load',
  'save',
  'rename',
  'copy',
  'configure',
]);

const COMMENT_PREFIXES = ['#', '!'];
const BLOCK_COMMENT_START = '/*';
const BLOCK_COMMENT_END = '*/';

/** Strip the same constructs `_set_commands` strips in the worker, so the
 *  pre-check matches the worker whitelist line-for-line. Returns the
 *  remaining lines *with their original index* so we can report which
 *  source line was rejected. */
function stripJuniperNoise(
  content: string,
): Array<{ line: string; index: number }> {
  const out: Array<{ line: string; index: number }> = [];
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (!line) continue;
    if (inBlock) {
      const end = line.indexOf(BLOCK_COMMENT_END);
      if (end < 0) continue;
      line = line.slice(end + BLOCK_COMMENT_END.length).trim();
      inBlock = false;
      if (!line) continue;
    }
    if (line.startsWith(COMMENT_PREFIXES[0]) || line.startsWith(COMMENT_PREFIXES[1])) {
      continue;
    }
    if (line.startsWith(BLOCK_COMMENT_START)) {
      const end = line.indexOf(BLOCK_COMMENT_END, BLOCK_COMMENT_START.length);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + BLOCK_COMMENT_END.length).trim();
      if (!line) continue;
    }
    // Drop inline /* ... */
    const blockStart = line.indexOf(BLOCK_COMMENT_START);
    const blockEnd = line.indexOf(BLOCK_COMMENT_END);
    if (blockStart >= 0 && blockEnd > blockStart) {
      line = (line.slice(0, blockStart) + line.slice(blockEnd + BLOCK_COMMENT_END.length)).trim();
      if (!line) continue;
    }
    out.push({ line, index: i + 1 }); // 1-indexed for human messages
  }
  return out;
}

function validateJuniperSetLines(
  content: string,
): { ok: true } | { ok: false; error: string } {
  const cleaned = stripJuniperNoise(content);
  const bad: Array<{ line: string; index: number; verb: string }> = [];
  for (const { line, index } of cleaned) {
    const verb = line.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (!JUNIPER_SET_VERBS.has(verb)) {
      bad.push({ line, index, verb });
    }
  }
  if (bad.length === 0) return { ok: true };
  // Show up to 3 offenders so the operator can find them quickly without
  // dumping the whole config in the error toast.
  const sample = bad
    .slice(0, 3)
    .map((b) => `  dòng ${b.index}: "${b.verb}" (snippet: ${b.line.slice(0, 40)})`)
    .join('\n');
  const more = bad.length > 3 ? `\n  … và ${bad.length - 3} dòng khác.` : '';
  return {
    ok: false,
    error:
      `Juniper: ${bad.length} dòng không bắt đầu bằng verb hợp lệ (set/delete/deactivate/activate/edit/commit/...).\n` +
      `${sample}${more}\n` +
      `Mỗi dòng phải bắt đầu bằng "set …", "delete …", v.v. — kiểm tra lại nội dung trước khi commit.`,
  };
}

function validateConfigPayload(
  content: string,
  vendor: string,
): { ok: true } | { ok: false; error: string } {
  if (!content.trim()) {
    return { ok: false, error: 'Config rỗng — nhập nội dung trước khi commit' };
  }
  // Disallow characters/sequences that no vendor accepts in config and
  // that would leave the device in a half-loaded state if sent through.
  if (content.includes('\u0000')) {
    return { ok: false, error: 'Config chứa ký tự NULL (0x00) — không hợp lệ' };
  }
  if (/<\s*script\b/i.test(content) || /<\?xml/i.test(content)) {
    return { ok: false, error: 'Config chứa markup HTML/XML nguyên — không gửi được xuống thiết bị' };
  }
  // Juniper-specific: `/* ... */` C-style comments are not valid in set
  // format and produce a fatal parser error mid-load.
  if (vendor.toLowerCase() === 'juniper') {
    if (/\/\*/.test(content) || /\*\//.test(content)) {
      return {
        ok: false,
        error:
          'Juniper không chấp nhận comment C-style (/* ... */). Dùng # hoặc xoá comment đó trước khi commit.',
      };
    }
    const setCheck = validateJuniperSetLines(content);
    if (!setCheck.ok) {
      return setCheck;
    }
  }
  return { ok: true };
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

  const validation = validateConfigPayload(content, device.vendor);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
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

/**
 * Recovery endpoint for Juniper devices stuck in
 * "configuration database modified" state (e.g. after a botched
 * commit or repeated syntax-error retries). Enqueues an APPLY_CONFIG
 * job with `recover: 'discard-junos'`; the worker detects the sentinel
 * in `tasks/registry.py::ApplyConfigTask.run` and short-circuits to
 * `JuniperBackend.recover_junos()` which posts `<discard-changes/>`
 * over RESTCONF (SSH fallback).
 *
 * Response shape is the same as `/devices/:id/rollback`: `{ job }`.
 */
generateConfigRouter.post('/devices/:id/recover-junos', async (req, res) => {
  const device = await prisma.device.findUnique({
    where: { id: req.params.id },
  });
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  if (device.vendor.toLowerCase() !== 'juniper') {
    res.status(409).json({ error: 'recover-junos chỉ hỗ trợ thiết bị Juniper' });
    return;
  }
  await enqueue(
    device.id,
    JobType.APPLY_CONFIG,
    { recover: 'discard-junos' },
    res,
  );
});

/**
 * Bulk-deploy a config (either a rendered template or a literal draft) to
 * many devices at once.
 *
 * Body shape (one of):
 *   { deviceIds: string[], role: 'core' | 'dist' | 'access' }
 *     → render the template per device (each gets its own hostname/IP)
 *   { deviceIds: string[], content: string, role?: 'custom' }
 *     → apply the SAME literal `content` to every selected device
 *
 * In both cases we upsert DeviceSavedConfig (so a rollback is possible
 * later) and enqueue one APPLY_CONFIG job per device. Worker runs them
 * in parallel via the normal job queue.
 *
 * Response 202: { jobs: [...], skipped: [{ deviceId, reason }] }
 *
 * Caps at 64 devices per request to keep the response bounded.
 */
generateConfigRouter.post('/bulk-commit', async (req, res) => {
  const rawIds = req.body?.deviceIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    res.status(400).json({ error: 'deviceIds must be a non-empty array' });
    return;
  }
  if (rawIds.length > 64) {
    res.status(400).json({ error: 'deviceIds cap is 64 per request' });
    return;
  }

  const literalContent = typeof req.body?.content === 'string' ? req.body.content : '';
  const templateRole = asRole(req.body?.role);

  if (!literalContent.trim() && !templateRole) {
    res.status(400).json({ error: 'Either content (literal draft) or role (template) is required' });
    return;
  }
  // Literal-draft mode stores role as 'custom' on DeviceSavedConfig.
  // The DB column is plain String, so 'custom' is fine even though it's
  // outside the ConfigRole union used by template rendering.
  const useLiteral = literalContent.trim().length > 0;
  const effectiveRole: string = useLiteral && !templateRole ? 'custom' : templateRole!;

  // Drop non-string ids and dedupe (caller may double-tap a checkbox).
  const deviceIds = Array.from(
    new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.length > 0)),
  );

  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds } },
    select: {
      id: true,
      name: true,
      ip: true,
      status: true,
      vendor: true,
      savedConfig: { select: { committedContent: true } },
    },
  });

  const found = new Map(devices.map((d) => [d.id, d]));
  const jobs: Array<{ id: string; deviceId: string; deviceName: string; deviceIp: string }> = [];
  const skipped: Array<{ deviceId: string; reason: string }> = [];

  for (const deviceId of deviceIds) {
    const device = found.get(deviceId);
    if (!device) {
      skipped.push({ deviceId, reason: 'Device not found' });
      continue;
    }
    if (device.status !== DeviceStatus.MANAGED) {
      skipped.push({ deviceId, reason: 'Thiết bị phải MANAGED trước khi commit' });
      continue;
    }

    // Either use the literal draft verbatim (same for every device) or
    // render the chosen template per-device so hostname/IP stay correct.
    // In literal mode there's no template role to render with.
    const content = useLiteral
      ? literalContent
      : renderConfigTemplate(effectiveRole as ConfigRole, device);

    // Reject the whole bulk deploy early if the payload would crash the
    // Junos parser on any Juniper target in the selection. Catching it
    // here means the operator sees the failure once instead of having
    // half the batch land and the other half leave the candidate
    // database in a "modified" state on every remaining device.
    if (useLiteral) {
      const validation = validateConfigPayload(content, device.vendor);
      if (!validation.ok) {
        skipped.push({ deviceId, reason: validation.error });
        continue;
      }
    }
    const previous = device.savedConfig?.committedContent ?? '';

    await prisma.deviceSavedConfig.upsert({
      where: { deviceId: device.id },
      create: { deviceId: device.id, role: effectiveRole, content },
      update: { role: effectiveRole, content },
    });

    const job = await prisma.job.create({
      data: {
        deviceId: device.id,
        type: JobType.APPLY_CONFIG,
        status: JobStatus.PENDING,
        payload: {
          config: content,
          role: effectiveRole,
          previous,
          bulk: true,
          bulkRole: effectiveRole,
          bulkTotal: deviceIds.length,
          bulkMode: useLiteral ? 'literal' : 'template',
        },
      },
      include: {
        device: { select: { id: true, name: true, ip: true } },
      },
    });

    if (!job.device) {
      skipped.push({ deviceId: device.id, reason: 'Device disappeared after job create' });
      continue;
    }

    jobs.push({
      id: job.id,
      deviceId: device.id,
      deviceName: job.device.name,
      deviceIp: job.device.ip,
    });
  }

  res.status(202).json({ jobs, skipped });
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
