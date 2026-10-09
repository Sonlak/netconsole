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

import { JobStatus, JobType, Prisma } from '@prisma/client';
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
import {
  addDhcpReservation,
  addDhcpSubnet,
  deleteDhcpLease,
  fixStaticReservation,
  getDhcpDashboard,
  listDhcpLeases,
  unfixStaticReservation,
  wipeDhcpSubnet,
} from '../keaDhcp.js';
import { listLogs, queueLogsCollection } from '../logs.js';
import { acknowledgeAlert, listAlertRules, listAlerts } from '../logAlerts.js';
import { getLatestInterfacesJob, queueInterfaceAction, parseInterfaceActionPayload } from '../interfaces.js';
import { tryCreateDeviceJob } from '../deviceOperations.js';
import { collectArpForDevice } from '../arpAddress.js';
import { collectMacForDevice } from '../macAddress.js';
import { collectDeviceConfig } from '../collectConfig.js';
import { diffConfigs, getDeviceSnapshots, getSnapshotConfig } from '../configCompare.js';
import { startDiscoveryScan, syncDiscoveryResults } from '../discoveryScan.js';
import { pingAndUpdateDevice } from '../devicePing.js';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

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
    // Kea stateLabel values are 'default' / 'expired-reclaimed' /
    // 'released' / 'declined'. LLM often asks for the human-friendly
    // 'active' (which is Kea's 'default') or 'expired' (which is
    // 'expired-reclaimed'). Normalize aliases so the filter works.
    const wanted = args.state.toLowerCase();
    const aliases: Record<string, string[]> = {
      active: ['default', 'static'],
      'expired-reclaimed': ['expired-reclaimed'],
      expired: ['expired-reclaimed'],
      released: ['released'],
      declined: ['declined'],
      default: ['default'],
      static: ['static'],
    };
    const matchLabels = (aliases[wanted] ?? [wanted]).map((s) => s.toLowerCase());
    leases = leases.filter((l) => matchLabels.includes(l.stateLabel.toLowerCase()));
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

// ── READ handlers (new) ──────────────────────────────────────────────────────

async function listDevicesHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const where: Record<string, unknown> = {};
  if (typeof args.site === 'string' && args.site) where.site = args.site;
  if (typeof args.status === 'string') where.status = args.status;
  if (typeof args.vendor === 'string' && args.vendor) {
    where.vendor = { contains: args.vendor, mode: 'insensitive' };
  }
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 500);

  const devices = await prisma.device.findMany({
    where,
    take: limit,
    orderBy: [{ site: 'asc' }, { floor: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, ip: true, status: true, vendor: true, model: true,
      version: true, site: true, floor: true, lastPingAt: true, lastPingMs: true,
    },
  });
  return {
    ok: true,
    preview: {
      total: devices.length,
      devices: devices.map((d) => ({
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

async function listDhcpSubnetsHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const dashboard = await getDhcpDashboard();
  let pools = dashboard.pools;
  if (typeof args.site === 'string' && args.site) {
    pools = pools.filter((p) => p.site === args.site);
  }
  if (args.only_high_utilization === true) {
    pools = pools.filter((p) => p.utilization >= 80);
  }
  return {
    ok: true,
    preview: {
      total: pools.length,
      pools: pools.map((p) => ({
        subnetId: p.subnetId,
        name: p.name,
        site: p.site,
        vlan: p.vlan,
        subnet: p.subnet,
        pool: p.pool,
        gateway: p.gateway,
        dns: p.dns,
        leased: p.leased,
        poolSize: p.poolSize,
        utilization: p.utilization,
      })),
    },
  };
}

async function getDhcpSubnetHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const subnetId = typeof args.subnet_id === 'number' ? args.subnet_id : Number(args.subnet_id);
  if (!Number.isFinite(subnetId)) return { ok: false, error: 'subnet_id is required (number)' };

  const dashboard = await getDhcpDashboard();
  const pool = dashboard.pools.find((p) => p.subnetId === subnetId);
  if (!pool) return { ok: true, preview: { subnetId, found: false } };

  const leases = await listDhcpLeases(subnetId);
  return {
    ok: true,
    preview: {
      subnetId,
      found: true,
      name: pool.name,
      site: pool.site,
      vlan: pool.vlan,
      subnet: pool.subnet,
      pool: pool.pool,
      gateway: pool.gateway,
      dns: pool.dns,
      utilization: pool.utilization,
      leases: {
        total: leases.length,
        active: leases.filter((l) => l.stateLabel === 'default' || l.stateLabel === 'static').length,
        reserved: leases.filter((l) => l.reserved).length,
      },
    },
  };
}

async function getJobDetailHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(args.job_id ?? '').trim();
  if (!id) return { ok: false, error: 'job_id is required' };
  const job = await prisma.job.findUnique({
    where: { id },
    include: {
      device: { select: { name: true, ip: true, site: true, vendor: true } },
      createdBy: { select: { username: true } },
    },
  });
  if (!job) return { ok: true, preview: { jobId: id, found: false } };
  return {
    ok: true,
    preview: {
      jobId: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      device: job.device?.name ?? null,
      deviceIp: job.device?.ip ?? null,
      createdBy: job.createdBy?.username ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error ? job.error.slice(0, 500) : null,
      payload: clip(job.payload),
      result: clip(job.result),
    },
  };
}

async function listAlertRulesHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const includeDisabled = args.include_disabled === true;
  const rules = await listAlertRules(includeDisabled);
  return {
    ok: true,
    preview: {
      total: rules.length,
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        deviceId: r.deviceId,
        minSeverity: r.minSeverity,
        messagePattern: r.messagePattern,
        facility: r.facility,
        enabled: r.enabled,
        alertCount: r.alertCount,
        unacknowledgedCount: r.unacknowledgedCount,
        createdAt: r.createdAt,
      })),
    },
  };
}

async function listUsersHandler(
  _args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const users = await prisma.user.findMany({
    select: {
      id: true, username: true, email: true, role: true, active: true,
      lastLoginAt: true, lastLoginIp: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return {
    ok: true,
    preview: {
      total: users.length,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        active: u.active,
        lastLoginAt: u.lastLoginAt,
        lastLoginIp: u.lastLoginIp,
        createdAt: u.createdAt,
      })),
    },
  };
}

async function getConfigHistoryHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };

  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 30, 150);
  const entryTypeFilter = String(args.entry_type ?? 'all');

  // Reuse the route logic inline — we need the same merge (audit + snapshots).
  const auditRows = await prisma.configAuditLog.findMany({
    where: { deviceId: device.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const snapshotJobs = await prisma.job.findMany({
    where: { deviceId: device.id, type: JobType.GET_CONFIG, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    select: {
      id: true, updatedAt: true, result: true,
      createdBy: { select: { username: true } },
    },
  });

  type Entry = {
    id: string;
    label: string;
    timestamp: string;
    entryType: 'apply' | 'snapshot';
    username: string | null;
    source: string | null;
    configRole: string | null;
    lineCount: number;
  };
  const entries: Entry[] = [];
  for (const row of auditRows) {
    entries.push({
      id: row.jobId,
      label: `Apply · ${row.createdAt.toISOString().slice(0, 16).replace('T', ' ')} · ${row.username ?? 'system'}`,
      timestamp: row.createdAt.toISOString(),
      entryType: 'apply',
      username: row.username,
      source: row.source,
      configRole: row.configRole,
      lineCount: row.lineCount,
    });
  }
  for (const job of snapshotJobs) {
    const result = (job.result ?? {}) as Record<string, unknown>;
    const config = typeof result.config === 'string' ? result.config : '';
    if (!config) continue;
    entries.push({
      id: job.id,
      label: `Snapshot · ${job.updatedAt.toISOString().slice(0, 16).replace('T', ' ')} · ${job.createdBy?.username ?? 'CLI/scheduler'}`,
      timestamp: job.updatedAt.toISOString(),
      entryType: 'snapshot',
      username: job.createdBy?.username ?? null,
      source: null,
      configRole: null,
      lineCount: config.split('\n').length,
    });
  }
  const filtered = entryTypeFilter === 'all' ? entries : entries.filter((e) => e.entryType === entryTypeFilter);
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    ok: true,
    preview: {
      device: device.name,
      total: filtered.length,
      returned: Math.min(filtered.length, limit),
      entries: filtered.slice(0, limit),
    },
  };
}

async function getConfigDiffHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  const fromId = String(args.from_id ?? '').trim();
  const toId = String(args.to_id ?? '').trim();
  if (!name || !fromId || !toId) {
    return { ok: false, error: 'device_name, from_id, to_id are all required' };
  }
  if (fromId === toId) return { ok: false, error: 'from_id and to_id must be different' };
  const maxLines = Math.min(typeof args.max_lines === 'number' ? args.max_lines : 200, 2000);

  async function loadConfig(id: string): Promise<{ content: string; label: string; entryType: string } | null> {
    const audit = await prisma.configAuditLog.findUnique({ where: { jobId: id } });
    if (audit) {
      return { content: audit.config, label: `Apply · ${audit.createdAt.toISOString().slice(0, 16)} · ${audit.username ?? 'system'}`, entryType: 'apply' };
    }
    const content = await getSnapshotConfig(id);
    if (content !== null) {
      const job = await prisma.job.findUnique({
        where: { id },
        select: { updatedAt: true, createdBy: { select: { username: true } } },
      });
      return {
        content,
        label: `Snapshot · ${job?.updatedAt?.toISOString().slice(0, 16) ?? '?'} · ${job?.createdBy?.username ?? 'scheduler'}`,
        entryType: 'snapshot',
      };
    }
    return null;
  }

  const [from, to] = await Promise.all([loadConfig(fromId), loadConfig(toId)]);
  if (!from) return { ok: false, error: `Entry "${fromId}" not found` };
  if (!to) return { ok: false, error: `Entry "${toId}" not found` };

  const diff = diffConfigs(from.content, to.content);
  const totalLines = diff.lines.length;
  const lines = diff.lines.slice(0, maxLines);
  const truncated = totalLines > maxLines;

  return {
    ok: true,
    preview: {
      device: name,
      from: { id: fromId, label: from.label, entryType: from.entryType },
      to: { id: toId, label: to.label, entryType: to.entryType },
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
      totalDiffLines: totalLines,
      truncated,
      diffLines: lines,
    },
  };
}

async function applyConfigDryRunHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };

  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    include: { savedConfig: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };

  // Resolve target content: arg override > DeviceSavedConfig.content
  const targetContent = typeof args.content === 'string' && args.content.trim()
    ? args.content
    : device.savedConfig?.content ?? '';
  if (!targetContent.trim()) {
    return { ok: false, error: 'Không có config để so sánh. Cần truyền content hoặc lưu DeviceSavedConfig trước.' };
  }

  // Fetch latest running config (GET_CONFIG SUCCESS) for diff baseline.
  const latest = await prisma.job.findFirst({
    where: { deviceId: device.id, type: JobType.GET_CONFIG, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
    select: { result: true, updatedAt: true },
  });
  const result = (latest?.result ?? {}) as Record<string, unknown>;
  const running = typeof result.config === 'string' ? result.config : '';

  const diff = diffConfigs(running, targetContent);
  const maxLines = Math.min(typeof args.max_lines === 'number' ? args.max_lines : 100, 1000);
  const lines = diff.lines.slice(0, maxLines);

  // Threshold warning: large diff (> 200 lines) is normal for full config replacement
  // (the saved content is the full device config, not a delta). We do NOT block —
  // the user may intentionally want to replace the entire config. We just warn.
  const isLargeDiff = diff.added + diff.removed > 200;
  const warning = isLargeDiff
    ? `Diff > 200 dòng (${diff.added} added, ${diff.removed} removed). `
        + 'Đây là BÌNH THƯỜNG khi replace full config. '
        + 'Nếu chỉ muốn THÊM dòng mới mà không thay đổi phần còn lại, '
        + 'dùng Config Studio để merge config thay vì thay thế toàn bộ.'
    : null;

  return {
    ok: true,
    preview: {
      device: device.name,
      vendor: device.vendor,
      role: device.savedConfig?.role ?? 'custom',
      runningCollectedAt: latest?.updatedAt ?? null,
      targetLineCount: targetContent.split('\n').length,
      runningLineCount: running.split('\n').length,
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
      truncated: diff.lines.length > maxLines,
      diffLines: lines,
      warning,
      instruction: isLargeDiff
        ? 'Đây là config replace (thay thế toàn bộ config hiện tại). '
            + 'Nếu muốn chỉ thêm dòng, hãy dùng Config Studio thay vì assistant. '
            + 'Nếu muốn replace toàn bộ config, gọi queue_apply_config để queue job.'
        : 'Có thể gọi queue_apply_config để queue job apply config.',
    },
  };
}

async function listDiscoveryScansHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
  const scans = await prisma.discoveryScan.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { _count: { select: { results: true } } },
  });
  return {
    ok: true,
    preview: {
      total: scans.length,
      scans: scans.map((s) => ({
        id: s.id,
        subnet: s.subnet,
        site: s.site,
        floor: s.floor,
        status: s.status,
        totalHosts: s.totalHosts,
        scanned: s.scanned,
        reachable: s.reachable,
        discovered: s.discovered,
        resultCount: s._count.results,
        error: s.error,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    },
  };
}

async function getDiscoveryScanHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(args.scan_id ?? '').trim();
  if (!id) return { ok: false, error: 'scan_id is required' };
  const scan = await prisma.discoveryScan.findUnique({
    where: { id },
    include: { results: { orderBy: [{ status: 'asc' }, { ip: 'asc' }] } },
  });
  if (!scan) return { ok: true, preview: { scanId: id, found: false } };
  return {
    ok: true,
    preview: {
      id: scan.id,
      subnet: scan.subnet,
      site: scan.site,
      floor: scan.floor,
      status: scan.status,
      totalHosts: scan.totalHosts,
      scanned: scan.scanned,
      reachable: scan.reachable,
      discovered: scan.discovered,
      error: scan.error,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
      resultCount: scan.results.length,
      results: scan.results.slice(0, 200).map((r) => ({
        id: r.id,
        ip: r.ip,
        status: r.status,
        name: r.name,
        vendor: r.vendor,
        model: r.model,
        version: r.version,
        pingOk: r.pingOk,
        pingMs: r.pingMs,
        sshOk: r.sshOk,
        serial: r.serial,
      })),
    },
  };
}

// ── WRITE handlers (new) ────────────────────────────────────────────────────

async function queueApplyConfigHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };

  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    include: { savedConfig: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };
  if (device.status !== 'MANAGED') {
    return { ok: false, error: `Thiết bị phải MANAGED trước khi commit (hiện tại: ${device.status})` };
  }

  // Resolve content.
  const content = typeof args.content === 'string' && args.content.trim()
    ? args.content
    : device.savedConfig?.content ?? '';
  if (!content.trim()) return { ok: false, error: 'Không có config để commit. Cần truyền content hoặc lưu DeviceSavedConfig trước.' };

  // Vendor validation (mirror routes/generateConfig.ts::validateConfigPayload).
  if (content.includes('\u0000')) {
    return { ok: false, error: 'Config chứa ký tự NULL (0x00) — không hợp lệ' };
  }
  if (/<\s*script\b/i.test(content) || /<\?xml/i.test(content)) {
    return { ok: false, error: 'Config chứa markup HTML/XML — không gửi được xuống thiết bị' };
  }
  if (device.vendor.toLowerCase() === 'juniper') {
    if (/\/\*/.test(content) || /\*\//.test(content)) {
      return {
        ok: false,
        error:
          'Juniper không chấp nhận comment C-style (/* ... */). Dùng # hoặc xoá comment đó trước khi commit.',
      };
    }
  }

  // Compute diff for informational warning (large diff is normal for full config replace).
  const latest = await prisma.job.findFirst({
    where: { deviceId: device.id, type: JobType.GET_CONFIG, status: JobStatus.SUCCESS },
    orderBy: { updatedAt: 'desc' },
    select: { result: true },
  });
  const runningConfig = ((latest?.result ?? {}) as { config?: string }).config ?? '';
  const diff = diffConfigs(runningConfig, content);
  const isLargeDiff = diff.added + diff.removed > 200;

  // NOTE: threshold check removed. Config Studio replaces the full config (it is
  // intentional to send the complete device config). Large diff = normal behavior
  // for config replace. The dry_run handler already warns the LLM; we just queue.

  // Persist DeviceSavedConfig (mirrors routes/generateConfig.ts).
  const role = (typeof args.role === 'string' ? args.role : device.savedConfig?.role ?? 'custom') as string;
  await prisma.deviceSavedConfig.upsert({
    where: { deviceId: device.id },
    create: { deviceId: device.id, role, content },
    update: { role, content },
  });

  // Queue job.
  const outcome = await prisma.$transaction((tx) =>
    tryCreateDeviceJob(tx, device.id, JobType.APPLY_CONFIG, ctx.userId, {
      config: content,
      role,
      previous: runningConfig,
    }),
  );
  if (outcome.kind === 'busy') {
    return {
      ok: false,
      error: `Device busy — ${outcome.error.blockingJob.type} ${outcome.error.blockingJob.status}. Try again in a moment.`,
    };
  }

  return {
    ok: true,
    preview: {
      device: device.name,
      role,
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
      isLargeDiff,
      warning: isLargeDiff
        ? `CẢNH BÁO: Full config replace (${diff.added} added, ${diff.removed} removed). `
            + 'Đây là hành vi BÌNH THƯỜNG của Config Studio.'
        : null,
      jobId: outcome.job.id,
      jobStatus: outcome.job.status,
      message: `Apply config queued (added=${diff.added} removed=${diff.removed}). Worker sẽ commit trong vài giây.`,
    },
  };
}

async function queueRollbackConfigHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    include: { savedConfig: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };

  const rollbackContent = device.savedConfig?.rollbackContent;
  if (!rollbackContent) {
    return { ok: false, error: 'Không có rollbackContent. Không thể rollback.' };
  }

  const outcome = await prisma.$transaction((tx) =>
    tryCreateDeviceJob(tx, device.id, JobType.ROLLBACK_CONFIG, ctx.userId, {
      rollback: 1,
      previous: rollbackContent,
    }),
  );
  if (outcome.kind === 'busy') {
    return { ok: false, error: `Device busy — ${outcome.error.blockingJob.type} ${outcome.error.blockingJob.status}.` };
  }
  return {
    ok: true,
    preview: {
      device: device.name,
      jobId: outcome.job.id,
      jobStatus: outcome.job.status,
      message: 'Rollback queued. Worker sẽ chạy trong vài giây.',
    },
  };
}

async function createDeviceHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const required = ['name', 'ip', 'vendor', 'model', 'version', 'serial', 'site', 'floor'];
  for (const field of required) {
    if (typeof args[field] !== 'string' || !(args[field] as string).trim()) {
      return { ok: false, error: `${field} is required` };
    }
  }
  try {
    const device = await prisma.device.create({
      data: {
        name: String(args.name).trim(),
        ip: String(args.ip).trim(),
        vendor: String(args.vendor).trim(),
        model: String(args.model).trim(),
        version: String(args.version).trim(),
        serial: String(args.serial).trim(),
        site: String(args.site).trim(),
        floor: String(args.floor).trim(),
        description: typeof args.description === 'string' && (args.description as string).trim()
          ? String(args.description).trim() : null,
        rack: typeof args.rack === 'string' && (args.rack as string).trim() ? String(args.rack).trim() : null,
        unit: typeof args.unit === 'string' && (args.unit as string).trim() ? String(args.unit).trim() : null,
        status: 'UNKNOWN',
      },
    });
    // Fire-and-forget probe
    void pingAndUpdateDevice(device.id).catch((err) => console.error('[assistant] ping failed', err));
    return {
      ok: true,
      preview: {
        deviceId: device.id,
        name: device.name,
        ip: device.ip,
        message: 'Đã tạo thiết bị. Probe MANAGED_CHECK tự động đang chạy.',
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    if (msg.includes('Unique constraint') || msg.includes('unique')) {
      return { ok: false, error: 'IP hoặc serial đã tồn tại trong inventory' };
    }
    return { ok: false, error: msg };
  }
}

async function updateDeviceHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };

  const data: Record<string, unknown> = {};
  for (const field of ['name', 'ip', 'vendor', 'model', 'version', 'serial', 'site', 'floor', 'description', 'rack', 'unit']) {
    if (typeof args[field] === 'string' && (args[field] as string).trim()) {
      data[field] = (args[field] as string).trim();
    }
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, error: 'Không có field nào để update' };
  }
  try {
    const updated = await prisma.device.update({ where: { id: device.id }, data });
    return {
      ok: true,
      preview: {
        deviceId: updated.id,
        name: updated.name,
        changedFields: Object.keys(data),
        message: 'Đã cập nhật thiết bị.',
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function deleteDeviceHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, ip: true, site: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };
  try {
    await prisma.device.delete({ where: { id: device.id } });
    return {
      ok: true,
      preview: {
        deleted: { name: device.name, ip: device.ip, site: device.site },
        message: 'Đã xoá thiết bị (cascade jobs, logs, snapshots).',
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function setDeviceStatusHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  const status = String(args.status ?? '').toUpperCase();
  if (!name) return { ok: false, error: 'device_name is required' };
  if (status !== 'MAINTENANCE' && status !== 'UNKNOWN') {
    return { ok: false, error: 'status chỉ chấp nhận MAINTENANCE hoặc UNKNOWN' };
  }
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, status: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };
  await prisma.device.update({ where: { id: device.id }, data: { status: status as 'MAINTENANCE' | 'UNKNOWN' } });
  return {
    ok: true,
    preview: { device: device.name, previousStatus: device.status, newStatus: status, message: 'Đã đổi status.' },
  };
}

async function queueCollectHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  const typeStr = String(args.collect_type ?? '').toUpperCase();
  if (!name) return { ok: false, error: 'device_name is required' };
  if (!['ARP', 'MAC', 'CONFIG', 'INTERFACES'].includes(typeStr)) {
    return { ok: false, error: 'collect_type phải là ARP / MAC / CONFIG / INTERFACES' };
  }
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };

  const jobType = ({
    ARP: JobType.GET_ARP,
    MAC: JobType.GET_MAC,
    CONFIG: JobType.GET_CONFIG,
    INTERFACES: JobType.GET_INTERFACES,
  } as const)[typeStr as 'ARP' | 'MAC' | 'CONFIG' | 'INTERFACES'];

  let result: { queued: boolean; job?: { id: string; status: string }; data?: unknown };
  try {
    if (jobType === JobType.GET_ARP) {
      result = await collectArpForDevice(device.id, ctx.userId);
    } else if (jobType === JobType.GET_MAC) {
      result = await collectMacForDevice(device.id, ctx.userId);
    } else if (jobType === JobType.GET_CONFIG) {
      result = await collectDeviceConfig(device.id, ctx.userId);
    } else {
      // GET_INTERFACES
      const outcome = await prisma.$transaction((tx) =>
        tryCreateDeviceJob(tx, device.id, JobType.GET_INTERFACES, ctx.userId, {}),
      );
      if (outcome.kind === 'busy') {
        return { ok: false, error: `Device busy — ${outcome.error.blockingJob.type} ${outcome.error.blockingJob.status}.` };
      }
      result = { queued: true, job: outcome.job };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
  if (!result.queued) {
    return {
      ok: true,
      preview: {
        device: device.name,
        collectType: typeStr,
        queued: false,
        message: 'Đã có snapshot gần đây (không cần collect lại).',
      },
    };
  }
  return {
    ok: true,
    preview: {
      device: device.name,
      collectType: typeStr,
      jobId: result.job?.id,
      jobStatus: result.job?.status,
      message: `Collect ${typeStr} queued.`,
    },
  };
}

async function addDhcpReservationHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const ip = String(args.ip ?? '').trim();
  const mac = String(args.mac ?? '').trim();
  const subnetId = Number(args.subnet_id);
  const hostname = typeof args.hostname === 'string' ? args.hostname : undefined;
  if (!ip || !mac || !Number.isFinite(subnetId)) {
    return { ok: false, error: 'ip, mac, subnet_id are required' };
  }
  try {
    const result = await addDhcpReservation({ ip, mac, subnetId, hostname });
    return {
      ok: true,
      preview: { ip, mac, subnetId, result, message: `Đã thêm DHCP lease ${mac} → ${ip}.` },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function deleteDhcpLeaseHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const ip = String(args.ip ?? '').trim();
  if (!ip) return { ok: false, error: 'ip is required' };
  try {
    const result = await deleteDhcpLease(ip);
    return { ok: true, preview: { ip, result, message: `Đã xoá DHCP lease ${ip}.` } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function fixStaticReservationHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const ip = String(args.ip ?? '').trim();
  const mac = String(args.mac ?? '').trim();
  const subnetId = Number(args.subnet_id);
  const hostname = typeof args.hostname === 'string' ? args.hostname : undefined;
  const note = typeof args.note === 'string' ? args.note : undefined;
  if (!ip || !mac || !Number.isFinite(subnetId)) {
    return { ok: false, error: 'ip, mac, subnet_id are required' };
  }
  try {
    const result = await fixStaticReservation({ ip, mac, subnetId, hostname, note });
    return {
      ok: true,
      preview: { ip, mac, subnetId, result, message: `Đã ghim static ${mac} → ${ip}.` },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function wipeDhcpSubnetHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const subnetId = Number(args.subnet_id);
  if (!Number.isFinite(subnetId)) return { ok: false, error: 'subnet_id is required' };
  try {
    const result = await wipeDhcpSubnet(subnetId);
    return { ok: true, preview: { subnetId, result, message: `Đã WIPE tất cả lease trong subnet ${subnetId}.` } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function addDhcpSubnetHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const subnetId = Number(args.subnet_id);
  const subnet = String(args.subnet ?? '').trim();
  const poolStart = String(args.pool_start ?? '').trim();
  const poolEnd = String(args.pool_end ?? '').trim();
  const gateway = String(args.gateway ?? '').trim();
  if (!Number.isFinite(subnetId) || !subnet || !poolStart || !poolEnd || !gateway) {
    return { ok: false, error: 'subnet_id, subnet, pool_start, pool_end, gateway are required' };
  }
  try {
    const dns = Array.isArray(args.dns) ? (args.dns as unknown[]).filter((d): d is string => typeof d === 'string') : undefined;
    const result = await addDhcpSubnet({
      subnetId, subnet, poolStart, poolEnd, gateway, dns,
      site: typeof args.site === 'string' ? args.site : undefined,
      vlan: typeof args.vlan === 'number' ? args.vlan : undefined,
      name: typeof args.name === 'string' ? args.name : undefined,
    });
    return {
      ok: true,
      preview: {
        subnetId, subnet, poolStart, poolEnd, gateway, result,
        message: `Đã thêm subnet ${subnetId} (${subnet}) vào Kea config.`,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function startDiscoveryScanHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const subnet = String(args.subnet ?? '').trim();
  if (!subnet) return { ok: false, error: 'subnet is required (CIDR)' };
  try {
    const scan = await startDiscoveryScan({
      subnet,
      site: typeof args.site === 'string' ? args.site : undefined,
      floor: typeof args.floor === 'string' ? args.floor : undefined,
    });
    return {
      ok: true,
      preview: {
        scanId: scan.id,
        subnet,
        status: scan.status,
        message: 'Discovery scan đã bắt đầu. Theo dõi bằng list_discovery_scans.',
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function syncDiscoveryResultsHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const scanId = String(args.scan_id ?? '').trim();
  const resultIds = Array.isArray(args.result_ids) ? (args.result_ids as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  if (!scanId || resultIds.length === 0) {
    return { ok: false, error: 'scan_id and result_ids (array) are required' };
  }
  try {
    const summary = await syncDiscoveryResults(scanId, resultIds, {
      site: typeof args.site === 'string' ? args.site : undefined,
      floor: typeof args.floor === 'string' ? args.floor : undefined,
    });
    return {
      ok: true,
      preview: { ...summary, message: `Đã sync ${resultIds.length} result thành Device.` },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown error' };
  }
}

async function acknowledgeAlertHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(args.alert_id ?? '').trim();
  if (!id) return { ok: false, error: 'alert_id is required' };
  const ok = await acknowledgeAlert(id);
  return { ok, preview: { alertId: id, acknowledged: ok, message: ok ? 'Đã acknowledge alert.' : 'Alert không tồn tại.' } };
}

async function syncToNetboxHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const name = String(args.device_name ?? '').trim();
  if (!name) return { ok: false, error: 'device_name is required' };
  const device = await prisma.device.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!device) return { ok: false, error: `Device not found: ${name}` };
  const outcome = await prisma.$transaction((tx) =>
    tryCreateDeviceJob(tx, device.id, JobType.NETBOX_SYNC_DEVICE, ctx.userId, {}),
  );
  if (outcome.kind === 'busy') {
    return { ok: false, error: `Device busy — ${outcome.error.blockingJob.type} ${outcome.error.blockingJob.status}.` };
  }
  return {
    ok: true,
    preview: { device: device.name, jobId: outcome.job.id, message: 'NETBOX_SYNC_DEVICE job queued.' },
  };
}

async function syncAllToNetboxHandler(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.userId) return { ok: false, error: 'Authentication required' };
  const job = await prisma.job.create({
    data: {
      deviceId: null,
      type: JobType.NETBOX_SYNC_ALL,
      status: JobStatus.PENDING,
      priority: 0,
      createdById: ctx.userId,
    },
  });
  return {
    ok: true,
    preview: { jobId: job.id, message: 'NETBOX_SYNC_ALL job queued. Worker sẽ sync toàn bộ thiết bị.' },
  };
}

// ── Admin user handlers ─────────────────────────────────────────────────────

async function createUserHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const username = String(args.username ?? '').trim();
  const email = String(args.email ?? '').trim();
  const password = String(args.password ?? '');
  const role = String(args.role ?? '').toUpperCase();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return { ok: false, error: 'Username phải 3-32 chars (a-z, 0-9, ._ -)' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Email không hợp lệ' };
  }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, error: 'Password >= 8 chars, có chữ hoa, thường, số' };
  }
  if (!['ADMIN', 'OPERATOR', 'VIEWER'].includes(role)) {
    return { ok: false, error: 'Role phải là ADMIN, OPERATOR hoặc VIEWER' };
  }
  const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
  if (existing) return { ok: false, error: 'Username hoặc email đã tồn tại' };
  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: { username, email, password: hashed, role: role as 'ADMIN' | 'OPERATOR' | 'VIEWER' },
    select: { id: true, username: true, email: true, role: true, createdAt: true },
  });
  return { ok: true, preview: { user, message: `Đã tạo user ${username} (${role}).` } };
}

async function updateUserRoleHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const username = String(args.username ?? '').trim();
  const role = String(args.role ?? '').toUpperCase();
  if (!['ADMIN', 'OPERATOR', 'VIEWER'].includes(role)) {
    return { ok: false, error: 'Role không hợp lệ' };
  }
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return { ok: false, error: `User not found: ${username}` };
  if (user.id === ctx.userId && role !== 'ADMIN') {
    return { ok: false, error: 'Không thể tự demote chính mình' };
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: role as 'ADMIN' | 'OPERATOR' | 'VIEWER' },
    select: { id: true, username: true, email: true, role: true },
  });
  return { ok: true, preview: { user: updated, message: `Đã đổi role ${username} → ${role}.` } };
}

async function setUserActiveHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const username = String(args.username ?? '').trim();
  const active = args.active === true;
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return { ok: false, error: `User not found: ${username}` };
  if (user.id === ctx.userId && !active) {
    return { ok: false, error: 'Không thể tự deactivate chính mình' };
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { active },
    select: { id: true, username: true, email: true, role: true, active: true },
  });
  return {
    ok: true,
    preview: { user: updated, message: `Đã ${active ? 'activate' : 'deactivate'} user ${username}.` },
  };
}

async function resetUserPasswordHandler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const username = String(args.username ?? '').trim();
  const newPassword = String(args.new_password ?? '');
  if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return { ok: false, error: 'Password >= 8 chars, có chữ hoa, thường, số' };
  }
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return { ok: false, error: `User not found: ${username}` };
  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
  return { ok: true, preview: { username, message: `Đã reset password cho ${username}. Truyền password tạm qua kênh secure (1 lần).` } };
}

async function deleteUserHandler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const username = String(args.username ?? '').trim();
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return { ok: false, error: `User not found: ${username}` };
  if (user.id === ctx.userId) return { ok: false, error: 'Không thể tự xoá chính mình' };
  await prisma.user.delete({ where: { id: user.id } });
  return { ok: true, preview: { username, message: `Đã xoá user ${username} (KHÔNG UNDO).` } };
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
  // Original READ
  lookup_mac: lookupMacHandler,
  get_device: getDeviceHandler,
  get_device_interfaces: getDeviceInterfacesHandler,
  list_dhcp_leases: listDhcpLeasesHandler,
  get_dhcp_pool_status: getDhcpPoolStatusHandler,
  get_fabric_topology: getFabricTopologyHandler,
  search_recent_jobs: searchRecentJobsHandler,
  get_recent_logs: getRecentLogsHandler,
  get_unacknowledged_alerts: getUnacknowledgedAlertsHandler,
  // Original WRITE
  queue_interface_action: queueInterfaceActionHandler,
  queue_log_collect: queueLogCollectHandler,
  queue_managed_check: queueManagedCheckHandler,
  // New READ
  list_devices: listDevicesHandler,
  list_dhcp_subnets: listDhcpSubnetsHandler,
  get_dhcp_subnet: getDhcpSubnetHandler,
  get_job_detail: getJobDetailHandler,
  list_alert_rules: listAlertRulesHandler,
  list_users: listUsersHandler,
  get_config_history: getConfigHistoryHandler,
  get_config_diff: getConfigDiffHandler,
  apply_config_dry_run: applyConfigDryRunHandler,
  list_discovery_scans: listDiscoveryScansHandler,
  get_discovery_scan: getDiscoveryScanHandler,
  // New WRITE
  queue_apply_config: queueApplyConfigHandler,
  queue_rollback_config: queueRollbackConfigHandler,
  create_device: createDeviceHandler,
  update_device: updateDeviceHandler,
  delete_device: deleteDeviceHandler,
  set_device_status: setDeviceStatusHandler,
  queue_collect: queueCollectHandler,
  add_dhcp_reservation: addDhcpReservationHandler,
  delete_dhcp_lease: deleteDhcpLeaseHandler,
  fix_static_reservation: fixStaticReservationHandler,
  wipe_dhcp_subnet: wipeDhcpSubnetHandler,
  add_dhcp_subnet: addDhcpSubnetHandler,
  start_discovery_scan: startDiscoveryScanHandler,
  sync_discovery_results: syncDiscoveryResultsHandler,
  acknowledge_alert: acknowledgeAlertHandler,
  sync_to_netbox: syncToNetboxHandler,
  sync_all_to_netbox: syncAllToNetboxHandler,
  create_user: createUserHandler,
  update_user_role: updateUserRoleHandler,
  set_user_active: setUserActiveHandler,
  reset_user_password: resetUserPasswordHandler,
  delete_user: deleteUserHandler,
};

/** Map backend UserRole → assistant role. Worker = VIEWER + specific tools. */
export function mapRole(role: string | null | undefined): AssistantRole {
  const r = (role ?? '').toUpperCase();
  if (r === 'ADMIN') return 'ADMIN';
  if (r === 'OPERATOR') return 'OPERATOR';
  if (r === 'WORKER') return 'WORKER';
  return 'VIEWER';
}
