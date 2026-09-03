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
export async function persistLogsForJob(jobId: string, entries: LogEntry[], hostnameFallback: string): Promise<number> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { device: true } });
  if (!job) return 0;

  await prisma.deviceLog.deleteMany({ where: { jobId } });
  if (!entries.length) return 0;

  const data: Prisma.DeviceLogCreateManyInput[] = [];
  for (const entry of entries) {
    const timestamp = parseTimestamp(entry.timestamp);
    if (!timestamp) continue;
    const severity = (typeof entry.severity === 'string' ? entry.severity : 'INFORMATIONAL') as LogSeverity;
    const facility = (typeof entry.facility === 'string' ? entry.facility : 'UNKNOWN') as LogFacility;
    data.push({
      deviceId: job.deviceId ?? null,
      hostname: (entry.hostname || hostnameFallback || job.device?.name || 'unknown').slice(0, 128),
      severity,
      facility,
      timestamp,
      message: (entry.message || '').slice(0, 4000),
      program: entry.program ?? null,
      pid: entry.pid ?? null,
      tag: entry.tag ?? null,
      jobId,
    });
  }

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