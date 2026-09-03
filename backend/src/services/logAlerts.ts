/**
 * Log alert rules + alert management.
 *
 * Rules are evaluated whenever logs arrive (via job completion or UDP syslog).
 * A rule matches a log entry when:
 *   - the rule is enabled
 *   - deviceId matches (null rule = all devices)
 *   - severity is >= minSeverity (using severity rank)
 *   - facility matches if set
 *   - messagePattern (regex) matches if set
 *
 * Each rule is evaluated at most once per (rule, device, 60-second window) to avoid
 * flooding when the same error repeats. This "dedup window" is controlled by
 * `alertCooldownMs` below.
 */

import {
  LogAlert,
  LogAlertRule,
  LogSeverity,
  LogFacility,
  Prisma,
} from '@prisma/client';
import { severityFromJunos } from '../lib/logSeverity.js';
import { prisma } from '../lib/prisma.js';
import type { LogEntry } from './logs.js';

// Dedup window: don't fire the same rule for the same device more than once per minute.
const ALERT_COOLDOWN_MS = 60_000;

const SEVERITY_RANK: Record<string, number> = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFORMATIONAL: 6,
  DEBUG: 7,
};

function severityRank(s: LogSeverity | string): number {
  return SEVERITY_RANK[String(s)] ?? 99;
}

function minSeverityFires(minSeverity: LogSeverity, actualSeverity: LogSeverity): boolean {
  return severityRank(actualSeverity) <= severityRank(minSeverity);
}

type LogAlertRuleWithAlerts = Prisma.LogAlertRuleGetPayload<object>;

export type AlertRuleRow = {
  id: string;
  name: string;
  description: string | null;
  deviceId: string | null;
  minSeverity: LogSeverity;
  messagePattern: string | null;
  facility: LogFacility | null;
  enabled: boolean;
  createdAt: string;
  alertCount: number;
  unacknowledgedCount: number;
};

export type LogAlertRow = {
  id: string;
  ruleId: string;
  ruleName: string;
  deviceId: string | null;
  deviceIp: string | null;
  severity: LogSeverity;
  hostname: string;
  program: string | null;
  message: string;
  timestamp: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
};

// ── Rules CRUD ────────────────────────────────────────────────────────────────

export async function listAlertRules(includeDisabled = false): Promise<AlertRuleRow[]> {
  const where: Prisma.LogAlertRuleWhereInput = includeDisabled ? {} : { enabled: true };
  const rules = await prisma.logAlertRule.findMany({
    where,
    include: {
      _count: { select: { alerts: true } },
      alerts: { where: { acknowledged: false }, select: { id: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    deviceId: rule.deviceId,
    minSeverity: rule.minSeverity,
    messagePattern: rule.messagePattern,
    facility: rule.facility,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    alertCount: rule._count.alerts,
    unacknowledgedCount: rule.alerts.length,
  }));
}

export async function createAlertRule(input: {
  name: string;
  description?: string;
  deviceId?: string;
  minSeverity: LogSeverity;
  messagePattern?: string;
  facility?: LogFacility;
}): Promise<AlertRuleRow> {
  const rule = await prisma.logAlertRule.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      deviceId: input.deviceId ?? null,
      minSeverity: input.minSeverity,
      messagePattern: input.messagePattern ?? null,
      facility: input.facility ?? null,
      enabled: true,
    },
  });
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    deviceId: rule.deviceId,
    minSeverity: rule.minSeverity,
    messagePattern: rule.messagePattern,
    facility: rule.facility,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    alertCount: 0,
    unacknowledgedCount: 0,
  };
}

export async function updateAlertRule(
  id: string,
  input: Partial<{
    name: string;
    description: string | null;
    deviceId: string | null;
    minSeverity: LogSeverity;
    messagePattern: string | null;
    facility: LogFacility | null;
    enabled: boolean;
  }>,
): Promise<AlertRuleRow | null> {
  const rule = await prisma.logAlertRule.update({
    where: { id },
    data: input,
    include: {
      _count: { select: { alerts: true } },
      alerts: { where: { acknowledged: false }, select: { id: true } },
    },
  });
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    deviceId: rule.deviceId,
    minSeverity: rule.minSeverity,
    messagePattern: rule.messagePattern,
    facility: rule.facility,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    alertCount: rule._count.alerts,
    unacknowledgedCount: rule.alerts.length,
  };
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  try {
    await prisma.logAlertRule.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// ── Alert evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluate all enabled rules against a batch of incoming log entries.
 * Called from:
 *   - `persistLogsForJob()` (job-based collection)
 *   - `syslogReceiver.flushPacket()` (UDP syslog)
 *
 * Runs inside a transaction; a rule is evaluated at most once per device per
 * `ALERT_COOLDOWN_MS` window to prevent flooding.
 */
export async function emitAlertsForLogs(
  deviceId: string | null,
  entries: LogEntry[],
): Promise<number> {
  if (!entries.length) return 0;

  const rules = await prisma.logAlertRule.findMany({ where: { enabled: true } });
  if (!rules.length) return 0;

  // Resolve device IP if we have a deviceId
  let deviceIp: string | null = null;
  if (deviceId) {
    const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { ip: true } });
    deviceIp = device?.ip ?? null;
  }

  // Find the most recent log entry timestamp as the alert timestamp
  let latestTs = new Date(0);
  for (const entry of entries) {
    const ts = new Date(entry.timestamp);
    if (!Number.isNaN(ts.getTime()) && ts > latestTs) latestTs = ts;
  }
  if (latestTs.getTime() === 0) latestTs = new Date();

  // Pick the most-severe entry for the alert message
  let worstEntry: LogEntry | null = null;
  let worstRank = 99;
  for (const entry of entries) {
    const rank = severityRank(entry.severity as LogSeverity);
    if (rank < worstRank) {
      worstRank = rank;
      worstEntry = entry;
    }
  }
  const alertMessage = worstEntry?.message ?? '';
  const alertSeverity = (worstEntry?.severity as LogSeverity) ?? 'WARNING';
  const alertProgram = worstEntry?.program ?? null;
  const alertHostname = worstEntry?.hostname ?? deviceIp ?? 'unknown';
  const alertTimestamp = worstEntry?.timestamp ? new Date(worstEntry.timestamp) : latestTs;
  if (Number.isNaN(alertTimestamp.getTime())) latestTs;

  const alerts: Prisma.LogAlertCreateManyInput[] = [];
  const now = new Date();
  const cooldownCutoff = new Date(now.getTime() - ALERT_COOLDOWN_MS);

  for (const rule of rules) {
    // Device filter
    if (rule.deviceId !== null && rule.deviceId !== deviceId) continue;

    // Severity filter
    if (!minSeverityFires(rule.minSeverity, alertSeverity)) continue;

    // Facility filter
    if (rule.facility !== null && worstEntry?.facility !== rule.facility) continue;

    // Message pattern filter
    let patternOk = true;
    if (rule.messagePattern) {
      try {
        const re = new RegExp(rule.messagePattern, 'i');
        patternOk = re.test(alertMessage);
      } catch {
        patternOk = false;
      }
    }
    if (!patternOk) continue;

    // Cooldown check: has an alert for this rule+device fired recently?
    const recentAlert = await prisma.logAlert.findFirst({
      where: {
        ruleId: rule.id,
        deviceId: deviceId ?? null,
        createdAt: { gte: cooldownCutoff },
      },
      select: { id: true },
    });
    if (recentAlert) continue;

    alerts.push({
      ruleId: rule.id,
      deviceId: deviceId ?? null,
      deviceIp: deviceIp ?? null,
      severity: alertSeverity,
      hostname: alertHostname,
      program: alertProgram,
      message: alertMessage.slice(0, 4000),
      timestamp: alertTimestamp,
      acknowledged: false,
      createdAt: now,
    });
  }

  if (!alerts.length) return 0;

  const result = await prisma.logAlert.createMany({ data: alerts });
  return result.count;
}

// ── Alert list & acknowledge ─────────────────────────────────────────────────

export async function listAlerts(params: {
  ruleId?: string;
  deviceId?: string;
  acknowledged?: boolean;
  since?: Date;
  limit?: number;
}): Promise<LogAlertRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const where: Prisma.LogAlertWhereInput = {};
  if (params.ruleId) where.ruleId = params.ruleId;
  if (params.deviceId) where.deviceId = params.deviceId;
  if (typeof params.acknowledged === 'boolean') where.acknowledged = params.acknowledged;
  if (params.since) where.createdAt = { gte: params.since };

  const rows = await prisma.logAlert.findMany({
    where,
    include: { rule: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    ruleName: row.rule.name,
    deviceId: row.deviceId,
    deviceIp: row.deviceIp,
    severity: row.severity,
    hostname: row.hostname,
    program: row.program,
    message: row.message,
    timestamp: row.timestamp.toISOString(),
    acknowledged: row.acknowledged,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function acknowledgeAlert(id: string): Promise<boolean> {
  try {
    await prisma.logAlert.update({
      where: { id },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

export async function acknowledgeAlerts(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const result = await prisma.logAlert.updateMany({
    where: { id: { in: ids } },
    data: { acknowledged: true, acknowledgedAt: new Date() },
  });
  return result.count;
}

export async function deleteAlert(id: string): Promise<boolean> {
  try {
    await prisma.logAlert.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
