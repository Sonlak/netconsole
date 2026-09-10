/**
 * Global search aggregator.
 *
 * Searches across all entity types for a keyword and returns grouped results
 * with deep-link metadata so the frontend can render clickable rows that jump
 * directly to the relevant page with the filter pre-applied.
 *
 * Design decisions:
 * - Runs all searches in parallel (Promise.allSettled) so one slow source
 *   (e.g. DHCP/Kea) does not block the rest.
 * - DHCP requires live Kea API calls; all others hit the local Postgres DB.
 * - Each group is capped at `limitPerGroup` results so the response stays small
 *   even if one entity type has thousands of matches.
 * - Audit log is ADMIN-only; the route itself enforces this, not the service.
 * - Empty query returns empty results (no "show all" behavior).
 * - ARP/MAC results are bounded to a 7-day window so the JSON ILIKE scan in
 *   `Job.result` stays fast even as the table grows; ARP/MAC tables refresh
 *   every few minutes, so a week covers all live inventory.
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
  const rows = await prisma.device.findMany({
    where: {
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { ip: { contains: q } },
        { serial: { contains: q, mode: 'insensitive' } },
        { vendor: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
        { version: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    },
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
    // Push the filter down to Postgres so we don't pull every ARP row into
    // memory before filtering in JS. JSON ILIKE in `result::text` is bounded
    // by the 7-day window and the per-job row count.
    const jobs = await searchJobResult('GET_ARP', q, limit);
    const seen = new Set<string>();
    const items: SearchResultItem[] = [];

    for (const job of jobs) {
      const entries = (job.result as { entries?: Array<Record<string, unknown>> } | null)?.entries ?? [];
      for (const e of entries) {
        const ip = String(e.ip ?? '');
        const mac = String(e.mac ?? '');
        const hostname = String(e.hostname ?? '');
        if (!matches(ip, q) && !matches(mac, q) && !matches(hostname, q)) continue;
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
  // Job.type is an enum; substring filter on enum values is meaningless.
  // Match against error / device name / device IP / device serial instead.
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

async function searchDhcp(q: string, limit: number) {
  try {
    const dashResult = await keaCommand('query4', { query: 'subnet4-get-all' });
    const subnets = ((dashResult.arguments as Record<string, unknown>)?.subnets as Array<{ id: number }>) ?? [];
    if (subnets.length === 0) return { items: [], total: 0 };

    const allLeaseResults = await Promise.allSettled(
      subnets.map((s) =>
        keaCommand('query4', { query: 'lease4-get-all', subnetId: s.id })
      )
    );

    const matched: Array<{ ip: string; mac: string; hostname: string; subnetId: number }> = [];
    for (const r of allLeaseResults) {
      if (r.status !== 'fulfilled') continue;
      const leases = ((r.value.arguments as Record<string, unknown>)?.leases as Array<{
        ip?: string;
        hwaddr?: string;
        hostname?: string;
        subnetId?: number;
      }>) ?? [];
      for (const lease of leases) {
        const ip = lease.ip ?? '';
        const mac = (lease.hwaddr ?? '').toLowerCase();
        const hostname = lease.hostname ?? '';
        if (matches(ip, q) || matches(mac, q) || matches(hostname, q)) {
          matched.push({
            ip,
            mac,
            hostname,
            subnetId: lease.subnetId ?? 0,
          });
          if (matched.length >= limit) break;
        }
      }
      if (matched.length >= limit) break;
    }

    return {
      items: matched.map(
        (m): SearchResultItem => ({
          primary: m.ip,
          secondary: `${m.mac} - ${m.hostname || '-'} - pool ${m.subnetId}`,
          href: `/dhcp?pool=${m.subnetId}`,
        })
      ),
      total: matched.length,
    };
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
  const tAll = Date.now();
  const mkTimer = () => Date.now();

  const tasks: Array<{
    kind: SearchResultGroup['kind'];
    label: string;
    url: string;
    p: Promise<{ items: SearchResultItem[]; total: number }>;
    tStart: number;
  }> = [
    { kind: 'device', label: 'Devices', url: '/devices', p: searchDevices(trimmed, limit), tStart: mkTimer() },
    { kind: 'arp', label: 'ARP', url: '/arp-addresses', p: searchArp(trimmed, limit), tStart: mkTimer() },
    { kind: 'mac', label: 'MAC', url: '/mac-addresses', p: searchMac(trimmed, limit), tStart: mkTimer() },
    { kind: 'log', label: 'Logs', url: '/logs', p: searchLogs(trimmed, limit), tStart: mkTimer() },
    { kind: 'job', label: 'Jobs', url: '/jobs', p: searchJobs(trimmed, limit), tStart: mkTimer() },
    { kind: 'audit', label: 'Audit', url: '/logs', p: searchAudit(trimmed, limit), tStart: mkTimer() },
    { kind: 'dhcp', label: 'DHCP Leases', url: '/dhcp', p: searchDhcp(trimmed, limit), tStart: mkTimer() },
  ];

  const settled = await Promise.allSettled(tasks.map((t) => t.p));

  const groups: SearchResultGroup[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = settled[i];
    const ms = Date.now() - task.tStart;
    if (result.status !== 'fulfilled') {
      console.warn(`[search] ${task.label}=${ms}ms status=rejected reason=${String(result.reason)}`);
      continue;
    }
    const { items, total } = result.value;
    console.log(`[search] ${task.label}=${ms}ms hits=${total}`);
    if (total === 0) continue;
    groups.push({ kind: task.kind, label: task.label, items, total, url: task.url });
  }

  console.log(`[search] total=${Date.now() - tAll}ms groups=${groups.length} q=${trimmed}`);
  return groups;
}

// silence unused Prisma import warning if build target drops it
void Prisma;
