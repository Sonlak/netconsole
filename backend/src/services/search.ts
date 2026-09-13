/**
 * Global search aggregator.
 *
 * Searches across all entity types for a keyword and returns grouped results
 * with deep-link metadata so the frontend can render clickable rows that jump
 * directly to the relevant page with the filter pre-applied.
 *
 * Design decisions:
 * - Runs Devices and Jobs in parallel — both are small tables with B-tree
 *   indexes and return in < 1 s even on a large dataset.
 * - Skips heavy sequential scans (ARP/MAC/Logs/Audit/DHCP) entirely from the
 *   global search. These tables require full-table JSON ILIKE scans that take
 *   10+ seconds on the 200 k-row Job table and make the search feel unusable.
 *   Users who need ARP/MAC/Logs data should search directly on those pages.
 * - IP prefix queries use `startsWith` so Prisma can use the B-tree index.
 * - Empty query returns empty results (no "show all" behavior).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orConditions: any[] = isIpQuery
    ? [{ ip: { startsWith: q } }, ...baseConditions]
    : [{ ip: { contains: q } }, ...baseConditions];

  const rows = await prisma.device.findMany({
    where: { OR: orConditions },
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

async function searchJobs(q: string, limit: number) {
  const rows = await prisma.job.findMany({
    where: {
      OR: [
        { error: { contains: q, mode: 'insensitive' as const } },
        { device: { name: { contains: q, mode: 'insensitive' as const } } },
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

// ── public API ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 3;

export async function searchAll(
  q: string,
  options?: { limitPerGroup?: number }
): Promise<SearchResultGroup[]> {
  if (!q || !q.trim()) return [];

  const limit = Math.min(Math.max(options?.limitPerGroup ?? DEFAULT_LIMIT, 1), 10);
  const trimmed = q.trim();

  // Run Devices and Jobs in parallel — both are small tables with indexes.
  // Skips heavy sequential scans (ARP/MAC/Logs/Audit/DHCP) that require
  // full-table JSON ILIKE on the 200 k-row Job table (10+ seconds).
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

  console.log(`[search] groups=${groups.length} q=${trimmed}`);
  return groups;
}

// silence unused Prisma import warning if build target drops it
void Prisma;
