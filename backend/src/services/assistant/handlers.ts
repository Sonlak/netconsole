/**
 * Tool handler implementations.
 *
 * Each handler takes the LLM-supplied arguments and the per-request
 * `ToolContext` and returns a compact `ToolResult` ready to be:
 *  1. Forwarded back to the LLM as a `tool` role message (for the
 *     `preview` field)
 *  2. Sent over SSE to the frontend (for the `preview` field, in
 *     the `tool_result` event)
 *  3. Persisted to the `AssistantMessage` table (the same preview,
 *     plus the full result if we want to log it)
 *
 * Handlers DO NOT raise on expected errors (MAC not found, device
 * not found, etc.) — they return `{ ok: false, error: '...' }` so
 * the LLM can recover. They DO raise on programmer errors (invalid
 * args, missing service) which the route layer catches.
 *
 * Why a single dispatch table? Easy to mock in tests, easy to gate
 * by role, easy to add new tools. The `ToolContext` carries the
 * authenticated user so handlers can attribute jobs to the right
 * operator (audit requirement).
 */

import { JobStatus, JobType } from '@prisma/client';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type {
  AssistantRole,
  AssistantToolName,
  ToolContext,
  ToolHandler,
  ToolResult,
} from './types.js';
import { getTool } from './prompts.js';

import { prisma } from '../../lib/prisma.js';
import { getMacAddressInventory } from '../macAddress.js';
import { getFabricTopology } from '../fabricTopology.js';
import { listDhcpLeases, getDhcpDashboard } from '../keaDhcp.js';
import { listLogs, queueLogsCollection } from '../logs.js';
import { listAlerts } from '../logAlerts.js';
import { getLatestInterfacesJob, queueInterfaceAction, parseInterfaceActionPayload } from '../interfaces.js';

const PREVIEW_BYTES = 4_000;

/**
 * Cap the preview payload so we don't blow the LLM context window.
 * If the JSON is too big, keep the first chunk + a marker so the LLM
 * knows it was truncated.
 */
function clip(value: unknown): unknown {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= PREVIEW_BYTES) return value;
  return {
    _truncated: true,
    _originalBytes: json.length,
    preview: json.slice(0, PREVIEW_BYTES),
  };
}

// ── READ handlers ─────────────────────────────────────────────────────────────

async function lookupMacHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const raw = String(args.mac ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'mac is required' };
  }
  // Normalize MAC to canonical lowercase colon form so we match the
  // inventory table. (Same algo as macAddress.ts::normalizeMac.)
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) {
    return { ok: false, error: `Invalid MAC format: ${raw}` };
  }
  const canonical = `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`;

  const inventory = await getMacAddressInventory();
  const matches = inventory.rows.filter(
    (row) => row.mac.toLowerCase() === canonical,
  );

  if (matches.length === 0) {
    return {
      ok: true,
      preview: {
        mac: canonical,
        found: 0,
        hint: 'Không tìm thấy trong bảng MAC inventory. Có thể MAC chưa được học (thiết bị offline, hoặc chưa có traffic từ MAC này).',
      },
    };
  }

  return {
    ok: true,
    preview: {
      mac: canonical,
      found: matches.length,
      entries: matches.map((m) => ({
        device: m.deviceName,
        deviceIp: m.deviceIp,
        port: m.interface,
        vlan: m.vlan,
        ip: m.ip,
        site: m.site,
        floor: m.floor,
        collectedAt: m.collectedAt,
      })),
    },
  };
}

async function getDeviceHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const q = String(args.query ?? '').trim();
  if (!q) return { ok: false, error: 'query is required' };

  const looksLikeIp = /^\d[\d.]*$/.test(q);
  const conditions: Record<string, unknown>[] = [
    { name: { equals: q, mode: 'insensitive' } },
    { serial: { contains: q, mode: 'insensitive' } },
    { description: { contains: q, mode: 'insensitive' } },
  ];
  if (looksLikeIp) {
    conditions.unshift({ ip: { startsWith: q } });
  } else {
    conditions.push({ name: { contains: q, mode: 'insensitive' } });
  }

  const devices = await prisma.device.findMany({
    where: { OR: conditions },
    take: 5,
    orderBy: { updatedAt: 'desc' },
  });

  if (devices.length === 0) {
    return { ok: true, preview: { found: 0, query: q } };
  }

  return {
    ok: true,
    preview: {
      found: devices.length,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        ip: d.ip,
        status: d.status,
        vendor: d.vendor,
        model: d.model,
        version: d.version,
        site: d.site,
        floor: d.floor,
        lastPingAt: d.lastPingAt,
        lastPingMs: d.lastPingMs,
      })),
    },
  };
}

async function getDeviceInterfacesHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };

  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, ip: true, vendor: true, status: true },
  });
  if (!device) {
    return { ok: false, error: `Device not found: ${name}` };
  }

  const job = await getLatestInterfacesJob(device.id);
  if (!job?.result || typeof job.result !== 'object' || Array.isArray(job.result)) {
    return {
      ok: true,
      preview: {
        device: device.name,
        message: 'Chưa có interface snapshot. Có thể trigger collect (write op).',
        lastCollectedAt: null,
      },
    };
  }

  const payload = job.result as { interfaces?: Array<Record<string, unknown>> };
  let interfaces = Array.isArray(payload.interfaces) ? payload.interfaces : [];

  const onlyUp = args.only_up === true;
  const onlyDown = args.only_down === true;
  if (onlyUp) {
    interfaces = interfaces.filter((i) => String(i.adminStatus ?? '').toLowerCase() === 'up' && String(i.operStatus ?? '').toLowerCase() === 'up');
  } else if (onlyDown) {
    interfaces = interfaces.filter((i) => String(i.adminStatus ?? '').toLowerCase() === 'down' || String(i.operStatus ?? '').toLowerCase() === 'down');
  }

  return {
    ok: true,
    preview: {
      device: device.name,
      total: interfaces.length,
      collectedAt: job.updatedAt,
      interfaces: clip(interfaces.slice(0, 100)),
    },
  };
}

async function listDhcpLeasesHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  let leases = await listDhcpLeases(
    typeof args.subnet_id === 'number' ? args.subnet_id : undefined,
  );

  if (typeof args.hostname_contains === 'string' && args.hostname_contains) {
    const needle = args.hostname_contains.toLowerCase();
    leases = leases.filter((l) => l.hostname.toLowerCase().includes(needle));
  }
  if (typeof args.state === 'string' && args.state) {
    const wanted = args.state.toLowerCase();
    leases = leases.filter((l) => l.stateLabel.toLowerCase() === wanted);
  }

  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 500);
  const truncated = leases.length > limit;
  const out = leases.slice(0, limit);

  return {
    ok: true,
    preview: {
      total: leases.length,
      returned: out.length,
      truncated,
      leases: out.map((l) => ({
        ip: l.ip,
        mac: l.mac,
        hostname: l.hostname || '(no hostname)',
        device: l.clientDevice || '(unknown)',
        port: l.clientPort || '',
        subnet: l.subnet,
        vlan: l.vlan,
        site: l.site,
        state: l.stateLabel,
        expiresAt: l.expiresAt,
      })),
    },
  };
}

async function getDhcpPoolStatusHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const dashboard = await getDhcpDashboard();
  let pools = dashboard.pools;

  if (typeof args.subnet_id === 'number') {
    pools = pools.filter((p) => p.subnetId === args.subnet_id);
  }
  if (args.only_high_utilization === true) {
    pools = pools.filter((p) => p.utilization >= 80);
  }

  return {
    ok: true,
    preview: {
      totals: dashboard.totals,
      ha: dashboard.ha,
      pools: pools.map((p) => ({
        subnetId: p.subnetId,
        name: p.name,
        site: p.site,
        vlan: p.vlan,
        subnet: p.subnet,
        pool: p.pool,
        gateway: p.gateway,
        leased: p.leased,
        poolSize: p.poolSize,
        utilization: p.utilization,
      })),
    },
  };
}

async function getFabricTopologyHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const site = typeof args.site === 'string' && args.site.trim() ? args.site.trim() : undefined;
  const topology = (await getFabricTopology(site)) as { nodes?: unknown[]; links?: unknown[] };
  return {
    ok: true,
    preview: {
      site: site ?? 'all',
      nodeCount: Array.isArray(topology.nodes) ? topology.nodes.length : 0,
      linkCount: Array.isArray(topology.links) ? topology.links.length : 0,
      topology,
    },
  };
}

async function searchRecentJobsHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
  const where: Record<string, unknown> = {};
  if (typeof args.device_name === 'string' && args.device_name) {
    where.device = { name: { contains: args.device_name, mode: 'insensitive' } };
  }
  if (typeof args.job_type === 'string') {
    where.type = args.job_type as JobType;
  }
  if (typeof args.status === 'string') {
    where.status = args.status as JobStatus;
  }

  const jobs = await prisma.job.findMany({
    where,
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      device: { select: { name: true, ip: true } },
      createdBy: { select: { username: true } },
    },
  });

  return {
    ok: true,
    preview: {
      total: jobs.length,
      jobs: jobs.map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        device: j.device?.name ?? '(deleted)',
        deviceIp: j.device?.ip ?? null,
        createdBy: j.createdBy?.username ?? null,
        createdAt: j.createdAt,
        error: j.error ? j.error.slice(0, 200) : null,
      })),
    },
  };
}

async function getRecentLogsHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };

  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!device) {
    return { ok: false, error: `Device not found: ${name}` };
  }

  const severities = parseSeverityFloor(String(args.min_severity ?? 'ERROR'));
  const since = args.since
    ? new Date(String(args.since))
    : new Date(Date.now() - 60 * 60 * 1000); // last 1h default
  if (Number.isNaN(since.getTime())) {
    return { ok: false, error: 'since must be a valid ISO timestamp' };
  }
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 500);

  const inventory = await listLogs({
    severities,
    since,
    deviceId: device.id,
    limit,
  });

  return {
    ok: true,
    preview: {
      device: device.name,
      since: since.toISOString(),
      minSeverity: String(args.min_severity ?? 'ERROR'),
      returned: inventory.rows.length,
      lastUpdatedAt: inventory.lastUpdatedAt,
      logs: inventory.rows.slice(0, 50).map((row) => ({
        timestamp: row.timestamp,
        severity: row.severity,
        facility: row.facility,
        program: row.program,
        message: row.message.slice(0, 300),
      })),
    },
  };
}

async function getUnacknowledgedAlertsHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
  const alerts = await listAlerts({ acknowledged: false, limit });
  return {
    ok: true,
    preview: {
      total: alerts.length,
      alerts: alerts.map((a) => ({
        id: a.id,
        ruleId: a.ruleId,
        ruleName: a.ruleName ?? null,
        hostname: a.hostname,
        deviceIp: a.deviceIp,
        severity: a.severity,
        message: a.message.slice(0, 300),
        timestamp: a.timestamp,
      })),
    },
  };
}

// ── WRITE handlers (require confirmation upstream) ───────────────────────────

async function queueInterfaceActionHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  const iface = String(args.interface ?? '').trim();
  if (!name || !iface) {
    return { ok: false, error: 'device_name and interface are required' };
  }

  // Resolve the friendly name → deviceId.
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, ip: true, status: true },
  });
  if (!device) {
    return { ok: false, error: `Device not found: ${name}` };
  }
  if (device.status === 'OFFLINE') {
    return { ok: false, error: `Device ${device.name} is OFFLINE — cannot queue interface action. Wait for managed check to mark it online again.` };
  }

  const payload = parseInterfaceActionPayload({
    action: args.action,
    interface: args.interface,
    vlan: args.vlan,
    description: args.description,
  });
  if (!payload) {
    return { ok: false, error: 'Invalid action payload (action, interface, and (vlan|description) as appropriate are required)' };
  }

  const result = await queueInterfaceAction(device.id, payload, ctx.userId);
  if (!result) {
    return { ok: false, error: `Device not found: ${name}` };
  }
  if (result.kind === 'busy') {
    return {
      ok: false,
      error: `Device busy — another job is in flight (${result.error.blockingJob.type}, status ${result.error.blockingJob.status}). Try again in a moment.`,
    };
  }
  return {
    ok: true,
    preview: {
      action: payload.action,
      device: device.name,
      interface: payload.interface,
      vlan: payload.vlan ?? null,
      description: payload.description ?? null,
      jobId: result.job.id,
      jobStatus: result.job.status,
      message: 'Đã queue INTERFACE_ACTION job. Worker sẽ chạy trong vài giây. Track ở /jobs.',
    },
  };
}

async function queueLogCollectHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const names = Array.isArray(args.device_names)
    ? (args.device_names.filter((n): n is string => typeof n === 'string' && n.length > 0))
    : [];
  const force = args.force === true;

  let deviceIds: string[] | undefined;
  if (names.length > 0) {
    const devices = await prisma.device.findMany({
      where: { name: { in: names, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (devices.length === 0) {
      return { ok: false, error: `No matching devices for: ${names.join(', ')}` };
    }
    deviceIds = devices.map((d) => d.id);
  }

  const result = await queueLogsCollection({ deviceIds, force });
  return {
    ok: true,
    preview: {
      requested: names.length || 'all',
      matched: result.deviceCount,
      queued: result.queued,
      message: result.message ?? `Đã queue ${result.queued} GET_LOGS job.`,
    },
  };
}

async function queueManagedCheckHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };

  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, ip: true },
  });
  if (!device) {
    return { ok: false, error: `Device not found: ${name}` };
  }

  // createDeviceJob writes the response — we don't want that here. Use
  // a small shim that returns the job row directly.
  const job = await prisma.job.create({
    data: {
      deviceId: device.id,
      type: JobType.MANAGED_CHECK,
      status: JobStatus.PENDING,
      priority: 200, // URGENT — see deviceOperations.ts
      ...(ctx.userId ? { createdById: ctx.userId } : {}),
    },
    select: { id: true, type: true, status: true, createdAt: true, deviceId: true },
  });

  return {
    ok: true,
    preview: {
      device: device.name,
      jobId: job.id,
      jobStatus: job.status,
      message: 'Đã queue MANAGED_CHECK job. Worker sẽ chạy probe trong vài giây.',
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a minimum-severity string into the list of severities we
 * want to return. Mirrors the LogSeverity enum in Prisma.
 */
function parseSeverityFloor(min: string): ('EMERGENCY' | 'ALERT' | 'CRITICAL' | 'ERROR' | 'WARNING' | 'NOTICE' | 'INFORMATIONAL' | 'DEBUG')[] {
  const order = ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFORMATIONAL', 'DEBUG'] as const;
  const idx = order.indexOf(min.toUpperCase() as typeof order[number]);
  if (idx < 0) return ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING'];
  return [...order.slice(0, idx + 1)];
}

// ── dispatch table ────────────────────────────────────────────────────────────

export const HANDLERS: Record<AssistantToolName, ToolHandler> = {
  lookup_mac: lookupMacHandler,
  get_device: getDeviceHandler,
  get_device_interfaces: getDeviceInterfacesHandler,
  list_dhcp_leases: listDhcpLeasesHandler,
  get_dhcp_pool_status: getDhcpPoolStatusHandler,
  get_fabric_topology: getFabricTopologyHandler,
  search_recent_jobs: searchRecentJobsHandler,
  get_recent_logs: getRecentLogsHandler,
  get_unacknowledged_alerts: getUnacknowledgedAlertsHandler,
  queue_interface_action: queueInterfaceActionHandler,
  queue_log_collect: queueLogCollectHandler,
  queue_managed_check: queueManagedCheckHandler,
};

/** Map backend UserRole → assistant role. Worker = VIEWER + specific tools. */
export function mapRole(role: string | null | undefined): AssistantRole {
  const r = (role ?? '').toUpperCase();
  if (r === 'ADMIN') return 'ADMIN';
  if (r === 'OPERATOR') return 'OPERATOR';
  if (r === 'WORKER') return 'WORKER';
  return 'VIEWER';
}
