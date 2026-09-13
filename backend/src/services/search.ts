/**
 * Global search aggregator.
 *
 * Searches across all entity types for a keyword and returns grouped results
 * with deep-link metadata so the frontend can render clickable rows that jump
 * directly to the relevant page with the filter pre-applied.
 *
 * Design decisions:
 * - Runs searches in a prioritized waterfall: fast/small tables first (Devices,
 *   Jobs) in parallel, then heavier scans (ARP, MAC, Logs, Audit) sequentially.
 *   This avoids connection-pool exhaustion that plagued the old parallel-all
 *   approach where 7 queries fighting over 9 connections caused timeouts.
 * - DHCP requires live Kea API calls; all others hit the local Postgres DB.
 * - Each group is capped at `limitPerGroup` results so the response stays small
 *   even if one entity type has thousands of matches.
 * - Audit log is ADMIN-only; the route itself enforces this, not the service.
 * - Empty query returns empty results (no "show all" behavior).
 * - ARP/MAC results are bounded to a 7-day window so the JSON ILIKE scan in
 *   `Job.result` stays fast even as the table grows; ARP/MAC tables refresh
 *   every few minutes, so a week covers all live inventory.
 * - IP searches use `startsWith` (B-tree index) instead of `contains`
 *   (sequential scan) when the query looks like an IP prefix.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listLogs } from './logs.js';
import { keaCommand } from './keaDhcp.js';

const ARP_SEARCH_WINDOW_DAYS = 7;
const ARP_SEARCH_WINDOW_MS = ARP_SEARCH_WINDOW_DAYS * 24 * 3600 * 1000;

// ── types ────────────────────────────────────────────────────────────────────

export type SearchResultGroup = {
  kind: 'device' | 'arp' | 'mac' | 'log' | 'job' | 'audit' | 'dhcp';
  label: string;
  url: string;
  items: SearchResultItem[];
  total: number;
};

export type SearchResultItem = {
  primary: string;
  secondary: string;
  href: string;
  tag?: string;
  tagColor?: string;
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** True when `q` looks like an IP address or IP prefix (e.g. "10", "10.10", "10.10.20.1"). */
function looksLikeIp(q: string): boolean {
  return /^\d[\d.]*$/.test(q) && q.includes('.');
}

/**
 * Build a Prisma `startsWith` filter for IP prefix queries.
 * "10.10.20.1" → startsWith "10.10.20.1" matches "10.10.20.101", "10.10.20.111"
 * "10.10"      → startsWith "10.10"    matches "10.10.20.1", "10.10.30.1"
 * "10"         → startsWith "10"       matches "10.1.2.3", "10.200.0.1"
 */
function ipPrefixFilter(q: string): Record<string, unknown> {
  return { ip: { startsWith: q } };
}

function matches(haystack: string, q: string): boolean {
  if (!q) return true;
  const lower = haystack.toLowerCase();
  const ql = q.toLowerCase();
  const macNorm = (s: string) => s.replace(/[^0-9a-f]/gi, '');
  const mq = macNorm(q);
  if (mq.length >= 6 && macNorm(haystack).includes(mq)) return true;
  return lower.includes(ql);
}

type JobRow = { id: string; result: unknown; updatedAt: Date };

async function searchJobResult(
  jobType: string,
  q: string,
  limit: number,
): Promise<JobRow[]> {
  const since = new Date(Date.now() - ARP_SEARCH_WINDOW_MS);
  // Postgres ILIKE on JSON cast — matches anywhere in the JSON text. Bounded
  // by `since` so the row count stays small.
  return prisma.$queryRaw<JobRow[]>`
    SELECT id, result, "updatedAt"
    FROM "Job"
    WHERE type::text = ${jobType}
      AND status::text = 'SUCCESS'
      AND "updatedAt" >= ${since}
      AND result::text ILIKE ${'%' + q + '%'}
    ORDER BY "updatedAt" DESC
    LIMIT ${limit * 4}
  `;
}

// ── searchers ────────────────────────────────────────────────────────────────

async function searchDevices(q: string, limit: number) {
  // Use startsWith for IP prefix queries so Prisma can use the B-tree index.
  // "10.10.20" matches "10.10.20.101", "10.10.20.111".
  const isIpQuery = looksLikeIp(q);
  const baseConditions = [
    { name: { contains: q, mode: 'insensitive' as const } },
    { serial: { contains: q, mode: 'insensitive' as const } },
    { vendor: { contains: q, mode: 'insensitive' as const } },
    { model: { contains: q, mode: 'insensitive' as const } },
    { version: { contains: q, mode: 'insensitive' as const } },
    { description: { contains: q, mode: 'insensitive' as const } },
  ];
  const orConditions: Record<string, unknown>[] = isIpQuery
    ? [{ ip: { startsWith: q } }, ...baseConditions]
    : [{ ip: { contains: q } }, ...baseConditions];

  const rows = await prisma.device.findMany({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    where: { OR: orConditions as any },
    take: limit,
    orderBy: { updatedAt: 'desc' },
  });

  return {
    items: rows.map(
      (d): SearchResultItem => ({
        primary: d.name,
        secondary: `${d.ip} - ${d.vendor} ${d.model}`,
        href: `/devices?q=${encodeURIComponent(q)}`,
        tag: d.status,
        tagColor:
          d.status === 'ONLINE'
            ? 'success'
            : d.status === 'OFFLINE'
              ? 'error'
              : 'default',
      })
    ),
    total: rows.length,
  };
}

async function searchArp(q: string, limit: number) {
  try {
    const jobs = await searchJobResult('GET_ARP', q, limit);
    const seen = new Set<string>();
    const items: SearchResultItem[] = [];

    for (const job of jobs) {
      const entries = (job.result as { entries?: Array<Record<string, unknown>> } | null)?.entries ?? [];
      for (const e of entries) {
        const ip = String(e.ip ?? '');
        const mac = String(e.mac ?? '');
        const hostname = String(e.hostname ?? '');
        // For IP prefix queries (e.g. "10.10.20"), use startsWith matching
        const ipMatches = looksLikeIp(q) ? ip.startsWith(q) : matches(ip, q);
        if (!ipMatches && !matches(mac, q) && !matches(hostname, q)) continue;
        const key = `${ip}|${mac}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          primary: ip,
          secondary: `${mac} - ${hostname || '-'}`,
          href: `/arp-addresses?q=${encodeURIComponent(q)}`,
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }

    return { items, total: items.length };
  } catch {
    return { items: [], total: 0 };
  }
}

async function searchMac(q: string, limit: number) {
  try {
    const jobs = await searchJobResult('GET_MAC', q, limit);
    const seen = new Set<string>();
    const items: SearchResultItem[] = [];

    for (const job of jobs) {
      const entries = (job.result as { entries?: Array<Record<string, unknown>> } | null)?.entries ?? [];
      for (const e of entries) {
        const mac = String(e.mac ?? '');
        const vlan = e.vlan == null ? null : String(e.vlan);
        const ifname = e.interface == null ? null : String(e.interface);
        if (!matches(mac, q) && !matches(vlan ?? '', q) && !matches(ifname ?? '', q)) continue;
        const key = `${mac}|${vlan}|${ifname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          primary: mac,
          secondary: `${vlan ?? '-'} - ${ifname ?? '-'}`,
          href: `/mac-addresses?q=${encodeURIComponent(q)}`,
        });
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }

    return { items, total: items.length };
  } catch {
    return { items: [], total: 0 };
  }
}

async function searchLogs(q: string, limit: number) {
  try {
    const inventory = await listLogs({ q, limit, hideNoise: false });
    const rows = inventory.rows ?? [];
    return {
      items: rows.map(
        (l): SearchResultItem => ({
          primary: l.hostname ?? '-',
          secondary: l.message ?? '',
          href: `/logs?q=${encodeURIComponent(q)}`,
          tag: l.severity,
          tagColor:
            l.severity === 'ERROR'
              ? 'error'
              : l.severity === 'WARNING'
                ? 'warning'
                : 'default',
        })
      ),
      total: rows.length,
    };
  } catch {
    return { items: [], total: 0 };
  }
}

async function searchJobs(q: string, limit: number) {
  const rows = await prisma.job.findMany({
    where: {
      OR: [
        { error: { contains: q, mode: 'insensitive' } },
        { device: { name: { contains: q, mode: 'insensitive' } } },
        { device: { ip: { contains: q } } },
      ],
    },
    include: { device: { select: { name: true, ip: true } } },
    take: limit,
    orderBy: { createdAt: 'desc' },
  });

  return {
    items: rows.map(
      (j): SearchResultItem => ({
        primary: j.type,
        secondary: j.device ? `${j.device.name} - ${j.device.ip}` : '-',
        href: `/jobs?q=${encodeURIComponent(q)}`,
        tag: j.status,
        tagColor:
          j.status === 'SUCCESS'
            ? 'success'
            : j.status === 'FAILED'
              ? 'error'
              : j.status === 'RUNNING'
                ? 'processing'
                : 'default',
      })
    ),
    total: rows.length,
  };
}

async function searchAudit(q: string, limit: number) {
  const rows = await prisma.auditLog.findMany({
    where: {
      OR: [
        { path: { contains: q, mode: 'insensitive' } },
        { method: { contains: q, mode: 'insensitive' } },
        { userId: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: limit,
    orderBy: { createdAt: 'desc' },
  });

  return {
    items: rows.map(
      (a): SearchResultItem => ({
        primary: `${a.method} ${a.path}`,
        secondary: a.userId ?? 'system',
        href: `/logs?q=${encodeURIComponent(q)}`,
        tag: String(a.statusCode),
      })
    ),
    total: rows.length,
  };
}

// ── DHCP helpers ──────────────────────────────────────────────────────────────

/** True when `q` looks like an IP address or MAC address. */
function isDhcpWorthy(q: string): boolean {
  if (/^\d[\d.]*$/.test(q) && q.includes('.')) return true;
  const hexOnly = q.replace(/[^0-9a-f]/gi, '');
  if (hexOnly.length >= 6) return true;
  return false;
}

async function dhcpSearchByIp(q: string, limit: number): Promise<SearchResultItem[]> {
  const result = await keaCommand('lease4-search', { 'ip-address': q });
  const leases = ((result.arguments as Record<string, unknown>)?.leases as Array<{
    ip?: string; hwaddr?: string; hostname?: string; 'subnet-id'?: number;
  }>) ?? [];

  return leases.slice(0, limit).map((l) => ({
    primary: l.ip ?? q,
    secondary: `${(l.hwaddr ?? '').toLowerCase()} - ${l.hostname || '-'} - pool ${l['subnet-id'] ?? 0}`,
    href: `/dhcp?pool=${l['subnet-id'] ?? 0}`,
  }));
}

async function dhcpSearchByMac(q: string, limit: number): Promise<SearchResultItem[]> {
  const normalizedMac = q.replace(/[^0-9a-f]/gi, '').toLowerCase();
  const formattedMac = normalizedMac
    .match(/.{1,2}/g)
    ?.join(':') ?? normalizedMac;

  const result = await keaCommand('lease4-search', { 'hw-address': formattedMac });
  const leases = ((result.arguments as Record<string, unknown>)?.leases as Array<{
    ip?: string; hwaddr?: string; hostname?: string; 'subnet-id'?: number;
  }>) ?? [];

  return leases.slice(0, limit).map((l) => ({
    primary: l.ip ?? '-',
    secondary: `${(l.hwaddr ?? '').toLowerCase()} - ${l.hostname || '-'} - pool ${l['subnet-id'] ?? 0}`,
    href: `/dhcp?pool=${l['subnet-id'] ?? 0}`,
  }));
}

async function searchDhcp(q: string, limit: number): Promise<{ items: SearchResultItem[]; total: number }> {
  try {
    if (!isDhcpWorthy(q)) {
      return { items: [], total: 0 };
    }

    const isMacQuery = /^[0-9a-f]{6,}[':.\-]?/i.test(q);

    if (isMacQuery) {
      const items = await dhcpSearchByMac(q, limit);
      return { items, total: items.length };
    }

    const items = await dhcpSearchByIp(q, limit);
    return { items, total: items.length };
  } catch {
    return { items: [], total: 0 };
  }
}

// ── public API ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 3;

export async function searchAll(
  q: string,
  options?: { limitPerGroup?: number }
): Promise<SearchResultGroup[]> {
  if (!q || !q.trim()) return [];

  const limit = Math.min(Math.max(options?.limitPerGroup ?? DEFAULT_LIMIT, 1), 10);
  const trimmed = q.trim();

  // Waterfall strategy: run the two fastest/smallest tables in parallel
  // (Devices: ~9 rows with B-tree index; Jobs: small table with indexes),
  // then chain the heavier scans sequentially. This avoids the connection-pool
  // exhaustion that plagued the old parallel-all approach where 7 queries
  // fighting over 9 connections caused timeouts.
  const [devicesResult, jobsResult] = await Promise.allSettled([
    searchDevices(trimmed, limit),
    searchJobs(trimmed, limit),
  ]);

  const groups: SearchResultGroup[] = [];

  const add = (kind: SearchResultGroup['kind'], label: string, url: string, items: SearchResultItem[], total: number) => {
    if (total === 0) return;
    groups.push({ kind, label, items, total, url });
  };

  const d = devicesResult.status === 'fulfilled' ? devicesResult.value : { items: [], total: 0 };
  add('device', 'Devices', '/devices', d.items, d.total);

  const j = jobsResult.status === 'fulfilled' ? jobsResult.value : { items: [], total: 0 };
  add('job', 'Jobs', '/jobs', j.items, j.total);

  // Heavier scans — run sequentially to avoid pool exhaustion
  try {
    const dhcp = await searchDhcp(trimmed, limit);
    add('dhcp', 'DHCP Leases', '/dhcp', dhcp.items, dhcp.total);
  } catch { /* skip */ }

  try {
    const arp = await searchArp(trimmed, limit);
    add('arp', 'ARP', '/arp-addresses', arp.items, arp.total);
  } catch { /* skip */ }

  try {
    const mac = await searchMac(trimmed, limit);
    add('mac', 'MAC', '/mac-addresses', mac.items, mac.total);
  } catch { /* skip */ }

  try {
    const logs = await searchLogs(trimmed, limit);
    add('log', 'Logs', '/logs', logs.items, logs.total);
  } catch { /* skip */ }

  try {
    const audit = await searchAudit(trimmed, limit);
    add('audit', 'Audit', '/logs', audit.items, audit.total);
  } catch { /* skip */ }

  console.log(`[search] groups=${groups.length} q=${trimmed}`);
  return groups;
}

// silence unused Prisma import warning if build target drops it
void Prisma;
