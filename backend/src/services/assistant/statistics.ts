/**
 * Statistics module for the NetConsole Assistant.
 *
 * Every stat is a small named function in `STATS`. To add a new stat:
 *   1. Write `async function yourStat(ctx): Promise<unknown>`.
 *   2. Append `{ name, description, category, compute: yourStat }` to STATS.
 *
 * That's it — `get_statistics` will pick it up automatically, and
 * `describe_capabilities` will list it for the LLM.
 *
 * Why a registry instead of one giant handler?  Three reasons:
 *   - Adding a stat is a 1-line change (no handler edits, no test rewrites).
 *   - The LLM can call `describe_capabilities` to discover what's available
 *     without hardcoding the stat list in the system prompt.
 *   - Each stat is independently testable + cached in the future.
 */

import { prisma } from '../../lib/prisma.js';
import { getDhcpDashboard } from '../keaDhcp.js';
import { JobStatus, JobType } from '@prisma/client';

// ── Public types ─────────────────────────────────────────────────────────────

export interface StatScope {
  /** Restrict to one site (e.g. "LAB"). Tùy chọn. */
  site?: string;
  /** Restrict to one vendor (juniper/arista/cisco). Tùy chọn. */
  vendor?: string;
  /** Restrict to one status (ONLINE/OFFLINE/...). Tùy chọn. */
  status?: string;
}

export interface StatContext {
  scope?: StatScope;
  /** Time window in hours for time-series stats (default 24). */
  windowHours?: number;
}

export type StatCompute = (ctx: StatContext) => Promise<unknown>;

export interface Stat {
  /** Stable name — used as key in the response. Snake_case, e.g. "devices_by_site". */
  name: string;
  /** Short human label for the LLM. */
  label: string;
  /** One-line description. The LLM uses this to decide which stat to call. */
  description: string;
  /** Group for `describe_capabilities`: "devices" | "jobs" | "dhcp" | "alerts" | "logs" | "interfaces" | "mac" | "arp" | "discovery" | "system" */
  category: string;
  /** True if the stat supports `scope` filtering. */
  scoped: boolean;
  /** Compute function. */
  compute: StatCompute;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deviceWhere(ctx: StatContext) {
  const w: Record<string, unknown> = {};
  if (ctx.scope?.site) w.site = ctx.scope.site;
  if (ctx.scope?.vendor) w.vendor = ctx.scope.vendor;
  if (ctx.scope?.status) w.status = ctx.scope.status;
  return w;
}

function windowStart(ctx: StatContext): Date {
  const hours = ctx.windowHours ?? 24;
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

/**
 * Fetch the latest SUCCESS job result of a given type per device using a
 * single DISTINCT ON query. Returns Map<deviceId, { result, updatedAt }>.
 *
 * Why a raw query: Prisma's findMany has no DISTINCT ON, and pulling the
 * full Job table is wasteful. Prisma.join is the documented way to safely
 * parameterize an IN list (no SQL injection, no string concat).
 */
async function fetchLatestJobResultsByDevice(
  type: JobType,
  deviceIds: string[],
): Promise<Map<string, { result: unknown; updatedAt: Date }>> {
  const out = new Map<string, { result: unknown; updatedAt: Date }>();
  if (deviceIds.length === 0) return out;
  const { Prisma: P } = await import('@prisma/client');
  const rows = await prisma.$queryRaw<
    Array<{ deviceId: string; result: unknown; updatedAt: Date }>
  >`
    SELECT DISTINCT ON ("deviceId")
           "deviceId", result, "updatedAt"
    FROM "Job"
    WHERE type = ${type}::"JobType"
      AND status = 'SUCCESS'::"JobStatus"
      AND "deviceId" IN (${P.join(deviceIds)})
    ORDER BY "deviceId", "updatedAt" DESC
  `;
  for (const row of rows) {
    out.set(row.deviceId, { result: row.result, updatedAt: row.updatedAt });
  }
  return out;
}

// ── Devices ──────────────────────────────────────────────────────────────────

const devicesTotal: Stat = {
  name: 'devices_total',
  label: 'Tổng thiết bị',
  description: 'Tổng số thiết bị trong inventory, hỗ trợ filter site/vendor/status.',
  category: 'devices',
  scoped: true,
  compute: async (ctx) => {
    const count = await prisma.device.count({ where: deviceWhere(ctx) });
    return count;
  },
};

const devicesBySite: Stat = {
  name: 'devices_by_site',
  label: 'Thiết bị theo site',
  description: 'Đếm thiết bị theo từng site (vd LAB: 8, NKKN: 12).',
  category: 'devices',
  scoped: false,
  compute: async () => {
    const rows = await prisma.device.groupBy({
      by: ['site'],
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
    });
    return rows.map((r) => ({ site: r.site, count: r._count._all }));
  },
};

const devicesByFloor: Stat = {
  name: 'devices_by_floor',
  label: 'Thiết bị theo tầng',
  description: 'Đếm thiết bị theo từng tầng (floor) trong 1 site. Hỗ trợ scope=site.',
  category: 'devices',
  scoped: true,
  compute: async (ctx) => {
    const rows = await prisma.device.groupBy({
      by: ['site', 'floor'],
      where: deviceWhere(ctx),
      _count: { _all: true },
      orderBy: [{ site: 'asc' }, { floor: 'asc' }],
    });
    return rows.map((r) => ({ site: r.site, floor: r.floor, count: r._count._all }));
  },
};

const devicesByVendor: Stat = {
  name: 'devices_by_vendor',
  label: 'Thiết bị theo vendor',
  description: 'Đếm thiết bị theo vendor (juniper/arista/cisco).',
  category: 'devices',
  scoped: true,
  compute: async (ctx) => {
    const rows = await prisma.device.groupBy({
      by: ['vendor'],
      where: deviceWhere(ctx),
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
    });
    return rows.map((r) => ({ vendor: r.vendor, count: r._count._all }));
  },
};

const devicesByStatus: Stat = {
  name: 'devices_by_status',
  label: 'Thiết bị theo trạng thái',
  description: 'Đếm thiết bị theo status (ONLINE/OFFLINE/MANAGED/MAINTENANCE/UNKNOWN).',
  category: 'devices',
  scoped: true,
  compute: async (ctx) => {
    const rows = await prisma.device.groupBy({
      by: ['status'],
      where: deviceWhere(ctx),
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
    });
    return rows.map((r) => ({ status: r.status, count: r._count._all }));
  },
};

const devicesByRack: Stat = {
  name: 'devices_by_rack',
  label: 'Thiết bị theo rack',
  description: 'Đếm thiết bị theo rack. Hỗ trợ scope=site.',
  category: 'devices',
  scoped: true,
  compute: async (ctx) => {
    const where = deviceWhere(ctx);
    if (!where.rack && ctx.scope?.site) {
      // No rack filter — just group
    }
    const rows = await prisma.device.groupBy({
      by: ['site', 'rack'],
      where: { ...where, rack: { not: null } },
      _count: { _all: true },
      orderBy: [{ site: 'asc' }, { rack: 'asc' }],
    });
    return rows.map((r) => ({ site: r.site, rack: r.rack, count: r._count._all }));
  },
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

const jobsLast24h: Stat = {
  name: 'jobs_last_24h',
  label: 'Job 24h gần nhất',
  description: 'Tổng số job trong window (mặc định 24h), theo type và status.',
  category: 'jobs',
  scoped: false,
  compute: async (ctx) => {
    const since = windowStart(ctx);
    const [byType, byStatus, failed] = await Promise.all([
      prisma.job.groupBy({
        by: ['type'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.job.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.job.count({
        where: { createdAt: { gte: since }, status: JobStatus.FAILED },
      }),
    ]);
    return {
      windowHours: ctx.windowHours ?? 24,
      byType: byType.map((r) => ({ type: r.type, count: r._count._all })),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      failedCount: failed,
    };
  },
};

const jobsSuccessRate: Stat = {
  name: 'jobs_success_rate',
  label: 'Tỷ lệ job SUCCESS',
  description: 'Tỷ lệ SUCCESS / tổng (last window). Cảnh báo nếu < 90%.',
  category: 'jobs',
  scoped: false,
  compute: async (ctx) => {
    const since = windowStart(ctx);
    const [total, success] = await Promise.all([
      prisma.job.count({ where: { createdAt: { gte: since } } }),
      prisma.job.count({ where: { createdAt: { gte: since }, status: JobStatus.SUCCESS } }),
    ]);
    const rate = total === 0 ? null : Math.round((success / total) * 1000) / 10;
    return {
      windowHours: ctx.windowHours ?? 24,
      total,
      success,
      successRatePct: rate,
      alert: rate !== null && rate < 90,
    };
  },
};

// ── Alerts ───────────────────────────────────────────────────────────────────

const alertsUnacknowledged: Stat = {
  name: 'alerts_unacknowledged',
  label: 'Alert chưa acknowledge',
  description: 'Số alert chưa ack, theo severity. Severity cao trước.',
  category: 'alerts',
  scoped: false,
  compute: async () => {
    const [total, bySeverity, oldest] = await Promise.all([
      prisma.logAlert.count({ where: { acknowledged: false } }),
      prisma.logAlert.groupBy({
        by: ['severity'],
        where: { acknowledged: false },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.logAlert.findFirst({
        where: { acknowledged: false },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, hostname: true, message: true },
      }),
    ]);
    return {
      total,
      bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: r._count._all })),
      oldest: oldest
        ? { createdAt: oldest.createdAt, hostname: oldest.hostname, message: oldest.message.slice(0, 100) }
        : null,
    };
  },
};

// ── Logs ─────────────────────────────────────────────────────────────────────

const logsLast24h: Stat = {
  name: 'logs_last_24h',
  label: 'Log/syslog 24h gần nhất',
  description: 'Tổng số log entry trong window, theo severity và facility.',
  category: 'logs',
  scoped: false,
  compute: async (ctx) => {
    const since = windowStart(ctx);
    const [total, bySeverity, byFacility] = await Promise.all([
      prisma.deviceLog.count({ where: { timestamp: { gte: since } } }),
      prisma.deviceLog.groupBy({
        by: ['severity'],
        where: { timestamp: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.deviceLog.groupBy({
        by: ['facility'],
        where: { timestamp: { gte: since } },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);
    return {
      windowHours: ctx.windowHours ?? 24,
      total,
      bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: r._count._all })),
      topFacilities: byFacility.map((r) => ({ facility: r.facility, count: r._count._all })),
    };
  },
};

// ── Interfaces ───────────────────────────────────────────────────────────────

const interfacesLatest: Stat = {
  name: 'interfaces_latest',
  label: 'Tổng interfaces (snapshot gần nhất)',
  description:
    'Tổng interface từ GET_INTERFACES job SUCCESS gần nhất của MỖI thiết bị. ' +
    'Đếm theo admin/oper status. Có thể không phản ánh real-time nếu nhiều thiết bị chưa được collect.',
  category: 'interfaces',
  scoped: true,
  compute: async (ctx) => {
    const devices = await prisma.device.findMany({
      where: deviceWhere(ctx),
      select: { id: true, name: true, site: true },
    });
    if (devices.length === 0) {
      return { devicesScanned: 0, devicesWithData: 0, total: 0, byOper: {}, byAdmin: {} };
    }
    const deviceIds = devices.map((d) => d.id);
    const latest = await fetchLatestJobResultsByDevice(JobType.GET_INTERFACES, deviceIds);
    let total = 0;
    let up = 0;
    let down = 0;
    let adminUp = 0;
    let adminDown = 0;
    let devicesWithData = 0;
    for (const dev of devices) {
      const job = latest.get(dev.id);
      if (!job) continue;
      const result = (job.result ?? {}) as { interfaces?: Array<{ operStatus?: string; adminStatus?: string }> };
      const ifs = result.interfaces ?? [];
      if (ifs.length > 0) devicesWithData++;
      for (const i of ifs) {
        total++;
        if (i.operStatus === 'UP' || i.operStatus === 'up') up++;
        else if (i.operStatus === 'DOWN' || i.operStatus === 'down') down++;
        if (i.adminStatus === 'UP' || i.adminStatus === 'up') adminUp++;
        else if (i.adminStatus === 'DOWN' || i.adminStatus === 'down') adminDown++;
      }
    }
    return {
      devicesScanned: devices.length,
      devicesWithData,
      total,
      byOper: { up, down, other: total - up - down },
      byAdmin: { up: adminUp, down: adminDown, other: total - adminUp - adminDown },
    };
  },
};

// ── MAC ──────────────────────────────────────────────────────────────────────

const macLatest: Stat = {
  name: 'mac_latest',
  label: 'Tổng MAC entries (snapshot gần nhất)',
  description:
    'Tổng MAC table entries từ GET_MAC job SUCCESS gần nhất của MỖI thiết bị. ' +
    'Đếm theo VLAN. KHÔNG real-time — phụ thuộc lần collect gần nhất.',
  category: 'mac',
  scoped: true,
  compute: async (ctx) => {
    const devices = await prisma.device.findMany({
      where: deviceWhere(ctx),
      select: { id: true, name: true },
    });
    if (devices.length === 0) {
      return { devicesScanned: 0, devicesWithData: 0, total: 0, byVlan: [] };
    }
    const deviceIds = devices.map((d) => d.id);
    const latest = await fetchLatestJobResultsByDevice(JobType.GET_MAC, deviceIds);
    let total = 0;
    let devicesWithData = 0;
    const byVlan = new Map<string, number>();
    for (const dev of devices) {
      const job = latest.get(dev.id);
      if (!job) continue;
      const result = (job.result ?? {}) as { entries?: Array<{ vlan?: string | number }> };
      const entries = result.entries ?? [];
      if (entries.length > 0) devicesWithData++;
      for (const e of entries) {
        total++;
        const vlan = String(e.vlan ?? 'unknown');
        byVlan.set(vlan, (byVlan.get(vlan) ?? 0) + 1);
      }
    }
    return {
      devicesScanned: devices.length,
      devicesWithData,
      total,
      byVlan: Array.from(byVlan.entries())
        .map(([vlan, count]) => ({ vlan, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
    };
  },
};

// ── ARP ──────────────────────────────────────────────────────────────────────

const arpLatest: Stat = {
  name: 'arp_latest',
  label: 'Tổng ARP entries (snapshot gần nhất)',
  description:
    'Tổng ARP table entries từ GET_ARP job SUCCESS gần nhất của MỖI thiết bị.',
  category: 'arp',
  scoped: true,
  compute: async (ctx) => {
    const devices = await prisma.device.findMany({
      where: deviceWhere(ctx),
      select: { id: true, name: true },
    });
    if (devices.length === 0) {
      return { devicesScanned: 0, devicesWithData: 0, total: 0 };
    }
    const deviceIds = devices.map((d) => d.id);
    const latest = await fetchLatestJobResultsByDevice(JobType.GET_ARP, deviceIds);
    let total = 0;
    let devicesWithData = 0;
    for (const dev of devices) {
      const job = latest.get(dev.id);
      if (!job) continue;
      const result = (job.result ?? {}) as { entries?: unknown[] };
      const entries = result.entries ?? [];
      if (entries.length > 0) devicesWithData++;
      total += entries.length;
    }
    return { devicesScanned: devices.length, devicesWithData, total };
  },
};

// ── DHCP ─────────────────────────────────────────────────────────────────────

const dhcpOverview: Stat = {
  name: 'dhcp_overview',
  label: 'Tổng quan DHCP (Kea live)',
  description:
    'Số subnet/pool, tổng lease, HA status, top subnets theo utilization.',
  category: 'dhcp',
  scoped: false,
  compute: async () => {
    const dashboard = await getDhcpDashboard();
    const top = [...dashboard.pools]
      .sort((a, b) => b.utilization - a.utilization)
      .slice(0, 5)
      .map((p) => ({ subnetId: p.subnetId, name: p.name, utilization: p.utilization, leased: p.leased }));
    return {
      ha: dashboard.ha,
      totals: dashboard.totals,
      subnetCount: dashboard.pools.length,
      topUtilized: top,
    };
  },
};

// ── Discovery ────────────────────────────────────────────────────────────────

const discoveryOverview: Stat = {
  name: 'discovery_overview',
  label: 'Tổng quan discovery',
  description: 'Số scan theo status, tổng discovered/synced.',
  category: 'discovery',
  scoped: false,
  compute: async () => {
    const [byStatus, total, synced] = await Promise.all([
      prisma.discoveryScan.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.discoveryScan.count(),
      prisma.discoveryResult.count({ where: { status: 'SYNCED' } }),
    ]);
    return {
      totalScans: total,
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      totalSynced: synced,
    };
  },
};

// ── System (cost, sessions) ─────────────────────────────────────────────────

const assistantCostLast7d: Stat = {
  name: 'assistant_cost_last_7d',
  label: 'Chi phí assistant 7 ngày',
  description: 'Tổng USD cost + tổng token, theo model.',
  category: 'system',
  scoped: false,
  compute: async (ctx) => {
    const since = windowStart({ ...ctx, windowHours: 24 * 7 });
    const [agg, byModel] = await Promise.all([
      prisma.assistantUsageLog.aggregate({
        where: { createdAt: { gte: since } },
        _sum: {
          costMicrodollars: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
        },
        _count: { _all: true },
      }),
      prisma.assistantUsageLog.groupBy({
        by: ['model'],
        where: { createdAt: { gte: since } },
        _sum: { costMicrodollars: true, totalTokens: true },
        _count: { _all: true },
      }),
    ]);
    return {
      windowDays: 7,
      totalCostUsd: (agg._sum.costMicrodollars ?? 0) / 1_000_000,
      totalCalls: agg._count._all,
      totalInputTokens: agg._sum.inputTokens ?? 0,
      totalOutputTokens: agg._sum.outputTokens ?? 0,
      byModel: byModel.map((r) => ({
        model: r.model,
        calls: r._count._all,
        costUsd: (r._sum.costMicrodollars ?? 0) / 1_000_000,
        tokens: r._sum.totalTokens ?? 0,
      })),
    };
  },
};

const systemInfo: Stat = {
  name: 'system_info',
  label: 'Thông tin hệ thống',
  description: 'Version NetConsole, git commit, Node env. Tổng quát.',
  category: 'system',
  scoped: false,
  compute: async () => ({
    version: process.env.NETCONSOLE_VERSION ?? 'unknown',
    gitCommit: process.env.NETCONSOLE_GIT_COMMIT ?? 'unknown',
    nodeEnv: process.env.NODE_ENV ?? 'production',
  }),
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const STATS: readonly Stat[] = [
  devicesTotal,
  devicesBySite,
  devicesByFloor,
  devicesByVendor,
  devicesByStatus,
  devicesByRack,
  jobsLast24h,
  jobsSuccessRate,
  alertsUnacknowledged,
  logsLast24h,
  interfacesLatest,
  macLatest,
  arpLatest,
  dhcpOverview,
  discoveryOverview,
  assistantCostLast7d,
  systemInfo,
];

/**
 * Compute a subset of stats by name. If `names` is empty/missing,
 * compute ALL stats (still subject to `scope`).
 */
export async function computeStatistics(
  names: string[] | undefined,
  ctx: StatContext,
): Promise<{ computed: Record<string, unknown>; missing: string[] }> {
  const wanted = names && names.length > 0
    ? STATS.filter((s) => names.includes(s.name))
    : STATS;
  const missing = (names ?? []).filter((n) => !STATS.some((s) => s.name === n));
  const entries = await Promise.all(
    wanted.map(async (s) => [s.name, await s.compute(ctx)] as const),
  );
  return {
    computed: Object.fromEntries(entries),
    missing,
  };
}

/** Static, JSON-serialisable list — for `describe_capabilities`. */
export function listStatDescriptors(): Array<{
  name: string;
  label: string;
  description: string;
  category: string;
  scoped: boolean;
}> {
  return STATS.map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    category: s.category,
    scoped: s.scoped,
  }));
}
