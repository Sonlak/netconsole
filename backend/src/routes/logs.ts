import { Router, type Request, type Response } from 'express';
import { LogFacility, LogSeverity } from '@prisma/client';
import { strictRateLimit, moderateRateLimit } from '../middleware/rateLimit.js';
import { isAllowedLogFilename, JUNOS_LOG_FILES } from '../lib/junosLogFiles.js';
import {
  deleteLogsForDevice,
  listLogs,
  queueLogsCollection,
  type LogsInventory,
} from '../services/logs.js';
import {
  acknowledgeAlert,
  acknowledgeAlerts,
  createAlertRule,
  deleteAlert,
  deleteAlertRule,
  listAlertRules,
  listAlerts,
  updateAlertRule,
} from '../services/logAlerts.js';

export const logsRouter = Router();

function parseSeverityList(value: string | undefined): LogSeverity[] {
  if (!value) return [];
  const valid = Object.values(LogSeverity) as string[];
  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => valid.includes(item)) as LogSeverity[];
}

function parseFacility(value: string | undefined): LogFacility | undefined {
  if (!value) return undefined;
  const upper = value.trim().toUpperCase();
  const valid = Object.values(LogFacility) as string[];
  return valid.includes(upper) ? (upper as LogFacility) : undefined;
}

function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 5000);
}

async function getInventory(req: Request, res: Response<LogsInventory | { error: string }>) {
  const severities = parseSeverityList(typeof req.query.severity === 'string' ? req.query.severity : undefined);
  const facility = parseFacility(typeof req.query.facility === 'string' ? req.query.facility : undefined);
  const since = parseSince(typeof req.query.since === 'string' ? req.query.since : undefined);
  const until = parseSince(typeof req.query.until === 'string' ? req.query.until : undefined);
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const limit = parseLimit(typeof req.query.limit === 'string' ? req.query.limit : undefined);
  const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined;

  // The UI passes `filename` as a UX hint (which log file to show). Backend
  // log rows are not currently partitioned by filename, but we record the
  // value into the inventory so the page can show "Showing: configuration".
  // Reject unknown filenames up front so a typo gives a clear 400.
  let logFile: string | undefined;
  if (filename) {
    if (!isAllowedLogFilename(filename)) {
      res.status(400).json({ error: `Unknown log filename: ${filename}` });
      return;
    }
    logFile = filename;
  }

  try {
    const inventory = await listLogs({ severities, facility, since, until, deviceId, q, limit });
    if (logFile) {
      (inventory as LogsInventory & { filename?: string }).filename = logFile;
    }
    res.json(inventory);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load logs';
    res.status(500).json({ error: message });
  }
}

logsRouter.get('/', strictRateLimit, getInventory);
logsRouter.get('/inventory', strictRateLimit, getInventory);

logsRouter.get('/files', strictRateLimit, (_req, res) => {
  res.json({ files: JUNOS_LOG_FILES, default: 'messages' });
});

logsRouter.post('/collect', moderateRateLimit, async (req, res) => {
  const body = (req.body ?? {}) as { filename?: unknown; deviceIds?: unknown; force?: unknown };
  const filename = typeof body.filename === 'string' && body.filename ? body.filename : 'messages';
  if (!isAllowedLogFilename(filename)) {
    res.status(400).json({ error: `Unknown log filename: ${filename}` });
    return;
  }
  const deviceIds = Array.isArray(body.deviceIds)
    ? body.deviceIds.filter((id): id is string => typeof id === 'string')
    : undefined;
  const force = body.force === true;
  const result = await queueLogsCollection({ deviceIds, force, filename });
  res.status(202).json(result);
});

logsRouter.delete('/device/:deviceId', moderateRateLimit, async (req, res) => {
  const result = await deleteLogsForDevice(String(req.params.deviceId));
  res.json(result);
});

// ── Alert rules ────────────────────────────────────────────────────────────────

// GET  /api/logs/rules
logsRouter.get('/rules', strictRateLimit, async (req, res) => {
  const includeDisabled = req.query.includeDisabled === 'true';
  const rules = await listAlertRules(includeDisabled);
  res.json({ rules });
});

// POST /api/logs/rules
logsRouter.post('/rules', moderateRateLimit, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { name, description, deviceId, minSeverity, messagePattern, facility } = body;

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!Object.values(LogSeverity).includes(minSeverity as LogSeverity)) {
    res.status(400).json({ error: 'valid minSeverity required (EMERGENCY..DEBUG)' });
    return;
  }
  if (messagePattern != null && typeof messagePattern !== 'string') {
    res.status(400).json({ error: 'messagePattern must be a string' });
    return;
  }
  // Validate regex
  if (typeof messagePattern === 'string' && messagePattern) {
    try {
      new RegExp(messagePattern);
    } catch {
      res.status(400).json({ error: 'messagePattern is not a valid regex' });
      return;
    }
  }
  if (facility != null && !Object.values(LogFacility).includes(facility as LogFacility)) {
    res.status(400).json({ error: 'invalid facility' });
    return;
  }

  try {
    const rule = await createAlertRule({
      name: name.trim(),
      description: typeof description === 'string' ? description : undefined,
      deviceId: typeof deviceId === 'string' ? deviceId : undefined,
      minSeverity: minSeverity as LogSeverity,
      messagePattern: typeof messagePattern === 'string' ? messagePattern : undefined,
      facility: facility as LogFacility | undefined,
    });
    res.status(201).json({ rule });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create rule';
    res.status(500).json({ error: message });
  }
});

// PUT /api/logs/rules/:id
logsRouter.put('/rules/:id', moderateRateLimit, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { name, description, deviceId, minSeverity, messagePattern, facility, enabled } = body;

  if (messagePattern != null && typeof messagePattern !== 'string') {
    res.status(400).json({ error: 'messagePattern must be a string' });
    return;
  }
  if (typeof messagePattern === 'string' && messagePattern) {
    try {
      new RegExp(messagePattern);
    } catch {
      res.status(400).json({ error: 'messagePattern is not a valid regex' });
      return;
    }
  }
  if (minSeverity != null && !Object.values(LogSeverity).includes(minSeverity as LogSeverity)) {
    res.status(400).json({ error: 'invalid minSeverity' });
    return;
  }
  if (facility != null && !Object.values(LogFacility).includes(facility as LogFacility)) {
    res.status(400).json({ error: 'invalid facility' });
    return;
  }

  const input: Parameters<typeof updateAlertRule>[1] = {};
  if (name !== undefined) input.name = String(name);
  if (description !== undefined) input.description = description === null ? null : String(description ?? '');
  if (deviceId !== undefined) input.deviceId = deviceId === null ? null : String(deviceId ?? '');
  if (minSeverity !== undefined) input.minSeverity = minSeverity as LogSeverity;
  if (messagePattern !== undefined) input.messagePattern = messagePattern === null ? null : String(messagePattern);
  if (facility !== undefined) input.facility = facility === null ? null : (facility as LogFacility);
  if (enabled !== undefined) input.enabled = Boolean(enabled);

  const rule = await updateAlertRule(String(req.params.id), input);
  if (!rule) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ rule });
});

// DELETE /api/logs/rules/:id
logsRouter.delete('/rules/:id', moderateRateLimit, async (req, res) => {
  const ok = await deleteAlertRule(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  res.json({ deleted: true });
});

// ── Alerts ────────────────────────────────────────────────────────────────────

// GET /api/logs/alerts
logsRouter.get('/alerts', strictRateLimit, async (req, res) => {
  const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined;
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  const acknowledged =
    req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined;
  const since = parseSince(typeof req.query.since === 'string' ? req.query.since : undefined);
  const limit = parseLimit(typeof req.query.limit === 'string' ? req.query.limit : undefined);

  const alerts = await listAlerts({ ruleId, deviceId, acknowledged, since, limit });
  res.json({ alerts });
});

// POST /api/logs/alerts/acknowledge  { ids: string[] }
logsRouter.post('/alerts/acknowledge', moderateRateLimit, async (req, res) => {
  const body = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
  if (!ids.length) {
    res.status(400).json({ error: 'ids[] is required' });
    return;
  }
  const count = await acknowledgeAlerts(ids);
  res.json({ acknowledged: count });
});

// POST /api/logs/alerts/:id/acknowledge
logsRouter.post('/alerts/:id/acknowledge', moderateRateLimit, async (req, res) => {
  const ok = await acknowledgeAlert(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  res.json({ acknowledged: true });
});

// DELETE /api/logs/alerts/:id
logsRouter.delete('/alerts/:id', moderateRateLimit, async (req, res) => {
  const ok = await deleteAlert(String(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  res.json({ deleted: true });
});
