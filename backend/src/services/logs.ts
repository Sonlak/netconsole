import {
  JobStatus,
  JobType,
  LogFacility,
  LogSeverity,
  type DeviceLog,
  Prisma,
} from '@prisma/client';
import { canonicalFloor, canonicalSite } from '../lib/deviceFloor.js';
import { prisma } from '../lib/prisma.js';
import { listCollectableDevices } from './collectableDevices.js';

export type DeviceLogRow = {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceIp: string | null;
  site: string;
  floor: string;
  hostname: string;
  severity: LogSeverity;
  facility: LogFacility;
  timestamp: string;
  receivedAt: string;
  program: string | null;
  pid: number | null;
  tag: string | null;
  message: string;
  jobId: string | null;
};

export type LogsInventory = {
  rows: DeviceLogRow[];
  managedDevices: number;
  devicesWithData: number;
  lastUpdatedAt: string | null;
  severities: LogSeverity[];
};

export type LogEntry = {
  timestamp: string;
  severity: LogSeverity | string;
  facility: LogFacility | string;
  hostname: string;
  program?: string | null;
  pid?: number | null;
  tag?: string | null;
  message: string;
};

type GetLogsJobResult = {
  implemented?: boolean;
  source?: string;
  hostname?: string;
  message?: string;
  entries?: LogEntry[];
  raw?: string;
};

const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_ROWS = 5000;

export async function listLogs(params: {
  deviceId?: string;
  severities?: LogSeverity[];
  facility?: LogFacility;
  q?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}): Promise<LogsInventory> {
  const devices = await listCollectableDevices();
  const limit = Math.min(Math.max(params.limit ?? 1000, 1), MAX_ROWS);
  const since = params.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000);

  const where: Prisma.DeviceLogWhereInput = {
    timestamp: { gte: since },
  };
  if (params.until) {
    where.timestamp = { gte: since, lte: params.until };
  }
  if (params.deviceId) {
    where.deviceId = params.deviceId;
  } else {
    where.deviceId = { in: devices.map((d) => d.id) };
  }
  if (params.severities && params.severities.length > 0) {
    where.severity = { in: params.severities };
  }
  if (params.facility) {
    where.facility = params.facility;
  }
  if (params.q && params.q.trim()) {
    const needle = params.q.trim();
    where.OR = [
      { message: { contains: needle, mode: 'insensitive' } },
      { hostname: { contains: needle, mode: 'insensitive' } },
      { program: { contains: needle, mode: 'insensitive' } },
      { tag: { contains: needle, mode: 'insensitive' } },
    ];
  }

  const [entries, totalRows] = await Promise.all([
    prisma.deviceLog.findMany({
      where,
      include: {
        device: { select: { id: true, name: true, ip: true, site: true, floor: true } },
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
    }),
    prisma.deviceLog.groupBy({
      by: ['deviceId'],
      where: { deviceId: { in: devices.map((d) => d.id) } },
      _count: { _all: true },
    }),
  ]);

  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const rows: DeviceLogRow[] = entries.map((entry) => toRow(entry, deviceById));

  return {
    rows,
    managedDevices: devices.length,
    devicesWithData: totalRows.length,
    lastUpdatedAt: rows[0]?.timestamp ?? null,
    severities: countBySeverity(rows),
  };
}

function toRow(entry: DeviceLog & { device?: { id: string; name: string; ip: string; site: string; floor: string } | null }, deviceById: Map<string, { id: string; name: string; ip: string; site: string; floor: string }>) {
  const dev = entry.device ? deviceById.get(entry.device.id) ?? entry.device : null;
  return {
    id: entry.id,
    deviceId: entry.deviceId ?? dev?.id ?? null,
    deviceName: dev?.name ?? null,
    deviceIp: dev?.ip ?? null,
    site: dev ? canonicalSite(dev.name, dev.site) : 'unknown',
    floor: dev ? canonicalFloor(dev.name, dev.floor) : 'unknown',
    hostname: entry.hostname,
    severity: entry.severity,
    facility: entry.facility,
    timestamp: entry.timestamp.toISOString(),
    receivedAt: entry.receivedAt.toISOString(),
    program: entry.program,
    pid: entry.pid,
    tag: entry.tag,
    message: entry.message,
    jobId: entry.jobId,
  };
}

function countBySeverity(rows: DeviceLogRow[]): LogSeverity[] {
  const present = new Set<LogSeverity>();
  for (const row of rows) present.add(row.severity);
  return [...present];
}

export async function queueLogsCollection(options?: { deviceIds?: string[]; force?: boolean; filename?: string }) {
  const devices = await listCollectableDevices(options?.deviceIds);

  if (devices.length === 0) {
    return { jobs: [], deviceCount: 0, queued: 0, message: 'No managed devices' as const };
  }

  // Default filename: messages (the Junos default syslog file)
  const filename = options?.filename ?? 'messages';
  const payload = { filename } satisfies Prisma.InputJsonValue;

  const jobs = [];
  for (const device of devices) {
    if (!options?.force) {
      const inflight = await prisma.job.findFirst({
        where: {
          deviceId: device.id,
          type: JobType.GET_LOGS,
          status: { in: [JobStatus.PENDING, JobStatus.RUNNING] },
        },
      });
      if (inflight) continue;
    }

    const job = await prisma.job.create({
      data: {
        deviceId: device.id,
        type: JobType.GET_LOGS,
        status: JobStatus.PENDING,
        payload,
      },
      include: {
        device: { select: { id: true, name: true, ip: true, site: true } },
      },
    });
    jobs.push(job);
  }

  return { jobs, deviceCount: devices.length, queued: jobs.length, filename };
}

export async function collectLogsForManagedDevices(options?: { filename?: string }) {
  return queueLogsCollection({ force: true, filename: options?.filename });
}

export function scheduleLogsCollection(intervalSeconds: number) {
  const intervalMs = Math.max(intervalSeconds, 60) * 1000;
  const run = async () => {
    try {
      const result = await queueLogsCollection();
      console.log(
        `[logs] managed=${result.deviceCount} queued=${result.queued}${result.message ? ` (${result.message})` : ''}`,
      );
    } catch (error) {
      console.error('[logs] scheduler failed', error);
    }
  };

  setTimeout(() => {
    void run();
  }, 20000);
  return setInterval(() => {
    void run();
  }, intervalMs);
}

/**
 * Persist log entries from a finished GET_LOGS job. Idempotent on (jobId).
 * Drops existing rows for the same jobId before re-inserting so retries don't dup.
 */

const SEVERITY_MAP: Record<string, LogSeverity> = {
  emergency: 'EMERGENCY',
  emerg: 'EMERGENCY',
  alert: 'ALERT',
  critical: 'CRITICAL',
  crit: 'CRITICAL',
  error: 'ERROR',
  err: 'ERROR',
  warning: 'WARNING',
  warn: 'WARNING',
  notice: 'NOTICE',
  informational: 'INFORMATIONAL',
  info: 'INFORMATIONAL',
  debug: 'DEBUG',
};

const FACILITY_MAP: Record<string, LogFacility> = {
  kern: 'KERNEL',
  kernel: 'KERNEL',
  user: 'USER',
  mail: 'MAIL',
  daemon: 'DAEMON',
  auth: 'AUTHORIZATION',
  authorization: 'AUTHORIZATION',
  authpriv: 'AUTH_PRIVATE',
  'auth-private': 'AUTH_PRIVATE',
  syslog: 'SYSLOG',
  ntp: 'NTP',
  clock: 'CLOCK',
  security: 'SECURITY',
  console: 'CONSOLE',
  local0: 'LOCAL0',
  local1: 'LOCAL1',
  local2: 'LOCAL2',
  local3: 'LOCAL3',
  local4: 'LOCAL4',
  local5: 'LOCAL5',
  local6: 'LOCAL6',
  local7: 'LOCAL7',
  pfe: 'PFE',
  firewall: 'FIREWALL',
  'change-log': 'CHANGE_LOG',
  changelog: 'CHANGE_LOG',
  'interactive-commands': 'INTERACTIVE_COMMANDS',
  interactivecommands: 'INTERACTIVE_COMMANDS',
  'conflict-log': 'CONFLICT_LOG',
  conflictlog: 'CONFLICT_LOG',
  dfc: 'DFC',
  external: 'EXTERNAL',
  ftp: 'FTP',
  printer: 'PRINTER',
  lpr: 'PRINTER',
  news: 'NEWS',
  uucp: 'UUCP',
};

function normalizeSeverity(value: unknown): LogSeverity {
  if (typeof value !== 'string') return 'INFORMATIONAL';
  const upper = value.toUpperCase() as LogSeverity;
  if (Object.values(SEVERITY_MAP).includes(upper)) return upper;
  const lower = value.toLowerCase();
  return SEVERITY_MAP[lower] ?? 'INFORMATIONAL';
}

function normalizeFacility(value: unknown): LogFacility {
  if (typeof value !== 'string') return 'UNKNOWN';
  const upper = value.toUpperCase() as LogFacility;
  if (upper === 'UNKNOWN') return 'UNKNOWN';
  if (Object.values(FACILITY_MAP).includes(upper)) return upper;
  const lower = value.toLowerCase();
  return FACILITY_MAP[lower] ?? 'UNKNOWN';
}

export async function persistLogsForJob(jobId: string, entries: LogEntry[], hostnameFallback: string): Promise<number> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { device: true } });
  if (!job) return 0;

  await prisma.deviceLog.deleteMany({ where: { jobId } });
  if (!entries.length) return 0;

  // Build the (deviceId, timestamp, hostname, message) tuples we'll insert.
  // Then drop any that already exist in the DB so re-runs of GET_LOGS don't
  // pile up identical auth.log lines. The Junos auth.log returns the same N
  // entries every time `show log messages` runs, so without cross-job dedup
  // a single SSH login ends up as 3-5 rows in the logs page.
  const candidateRows: Prisma.DeviceLogCreateManyInput[] = [];
  const candidateKeys = new Set<string>();
  for (const entry of entries) {
    const timestamp = parseTimestamp(entry.timestamp);
    if (!timestamp) continue;
    const severity = normalizeSeverity(entry.severity);
    const facility = normalizeFacility(entry.facility);
    const hostname = (entry.hostname || hostnameFallback || job.device?.name || 'unknown').slice(0, 128);
    const message = (entry.message || '').slice(0, 4000);
    const key = [
      job.deviceId ?? 'unknown',
      timestamp.toISOString(),
      hostname,
      message,
    ].join('\u0000');
    if (candidateKeys.has(key)) continue;
    candidateKeys.add(key);
    candidateRows.push({
      deviceId: job.deviceId ?? null,
      hostname,
      severity,
      facility,
      timestamp,
      message,
      program: entry.program ?? null,
      pid: entry.pid ?? null,
      tag: entry.tag ?? null,
      jobId,
    });
  }

  if (!candidateRows.length) return 0;

  // Filter out rows whose (deviceId, timestamp, hostname, message) already
  // exists in the DB from a previous job. Use OR of equality predicates
  // rather than `in` tuples because Prisma's findMany doesn't support
  // composite-key `in`.
  const existing = await prisma.deviceLog.findMany({
    where: {
      deviceId: job.deviceId ?? null,
      OR: candidateRows.map((row) => ({
        timestamp: row.timestamp as Date,
        hostname: row.hostname as string,
        message: row.message as string,
      })),
    },
    select: { timestamp: true, hostname: true, message: true },
  });
  const existingKeys = new Set(
    existing.map((row) =>
      [
        row.timestamp.toISOString(),
        row.hostname,
        row.message,
      ].join('\u0000'),
    ),
  );

  const data = candidateRows.filter((row) => {
    const key = [
      (row.timestamp as Date).toISOString(),
      row.hostname as string,
      row.message as string,
    ].join('\u0000');
    return !existingKeys.has(key);
  });

  if (!data.length) return 0;

  const result = await prisma.deviceLog.createMany({ data });
  return result.count;
}

function parseTimestamp(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export async function latestLogsForDevice(deviceId: string): Promise<DeviceLogRow[]> {
  const job = await prisma.job.findFirst({
    where: { deviceId, type: JobType.GET_LOGS, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
  });
  if (!job?.result) return [];
  const result = job.result as GetLogsJobResult;
  if (!result.entries) return [];

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return [];

  return result.entries
    .map((entry, idx) => ({
      id: `${job.id}-${idx}`,
      deviceId: device.id,
      deviceName: device.name,
      deviceIp: device.ip,
      site: canonicalSite(device.name, device.site),
      floor: canonicalFloor(device.name, device.floor),
      hostname: entry.hostname || result.hostname || device.name,
      severity: (entry.severity as LogSeverity) ?? 'INFORMATIONAL',
      facility: (entry.facility as LogFacility) ?? 'UNKNOWN',
      timestamp: parseTimestamp(entry.timestamp)?.toISOString() ?? job.updatedAt.toISOString(),
      receivedAt: job.updatedAt.toISOString(),
      program: entry.program ?? null,
      pid: entry.pid ?? null,
      tag: entry.tag ?? null,
      message: entry.message,
      jobId: job.id,
    }));
}

export async function deleteLogsForDevice(deviceId: string): Promise<{ count: number }> {
  const result = await prisma.deviceLog.deleteMany({ where: { deviceId } });
  return { count: result.count };
}