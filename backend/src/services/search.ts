/**
 * Global search aggregator.
 *
 * Searches across all entity types for a keyword and returns grouped results
 * with deep-link metadata so the frontend can render clickable rows that jump
 * directly to the relevant page with the filter pre-applied.
 *
 * Design decisions:
 * - Runs searches in parallel where possible: Devices + Jobs + ARP/MAC all fire
 *   at once via Promise.allSettled. Each has its own fast query path.
 * - IP prefix queries use `startsWith` so Prisma can use the B-tree index.
 * - ARP/MAC use raw SQL with PostgreSQL JSONB operators (jsonb_array_elements)
 *   to search inside Job.result without a full-table ILIKE scan.
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

type ArpSearchRow = { ip: string; mac: string; deviceName: string };

/**
 * Search ARP entries inside Job.result JSON.
 *
 * Uses `jsonb_array_elements(result->'entries')` so PostgreSQL unnests the
 * JSON array and filters on the IP/MAC string inside — no full-table ILIKE
 * on the result column. The WHERE on type+status restricts rows to the
 * ~15k GET_ARP SUCCESS jobs.
 */
async function searchArp(q: string, limit: number): Promise<{ items: SearchResultItem[]; total: number }> {
  // Escape special LIKE chars in q, then build ILIKE pattern
  const escaped = q.replace(/[%_\\]/g, '\\$&');
  const likePattern = `%${escaped}%`;

  // jsonb_array_elements returns one row per ARP entry.
  // Filter IP or MAC field, join with device name, dedupe by IP.
  const rows = await prisma.$queryRaw<
    Array<{ ip: string; mac: string; deviceName: string }>
  >`
    SELECT DISTINCT ON (entry->>'ip')
           entry->>'ip'    AS ip,
           entry->>'mac'   AS mac,
           d.name          AS "deviceName"
    FROM "Job" j
    JOIN "Device" d ON d.id = j."deviceId"
    CROSS JOIN LATERAL jsonb_array_elements(j.result->'entries') AS entry
    WHERE j.type    = 'GET_ARP'
      AND j.status  = 'SUCCESS'
      AND (
           entry->>'ip' ILIKE ${likePattern}
        OR entry->>'mac' ILIKE ${likePattern}
        OR entry->>'hostname' ILIKE ${likePattern}
      )
    ORDER BY entry->>'ip', j."updatedAt" DESC
    LIMIT ${limit}
  `;

  return {
    items: rows.map(
      (r): SearchResultItem => ({
        primary: r.ip,
        secondary: r.mac ? `${r.mac} - ${r.deviceName}` : r.deviceName,
        href: `/arp-addresses?q=${encodeURIComponent(q)}`,
      })
    ),
    total: rows.length,
  };
}

type MacSearchRow = { mac: string; vlan: string; interface: string; deviceName: string };

/**
 * Search MAC entries inside Job.result JSON (same JSONB approach as ARP).
 */
async function searchMac(q: string, limit: number): Promise<{ items: SearchResultItem[]; total: number }> {
  const escaped = q.replace(/[%_\\]/g, '\\$&');
  const likePattern = `%${escaped}%`;

  const rows = await prisma.$queryRaw<
    Array<{ mac: string; vlan: string; interface: string; deviceName: string }>
  >`
    SELECT DISTINCT ON (entry->>'mac')
           entry->>'mac'        AS mac,
           COALESCE(entry->>'vlan', '-')  AS vlan,
           COALESCE(entry->>'interface', '-') AS interface,
           d.name               AS "deviceName"
    FROM "Job" j
    JOIN "Device" d ON d.id = j."deviceId"
    CROSS JOIN LATERAL jsonb_array_elements(j.result->'entries') AS entry
    WHERE j.type    = 'GET_MAC'
      AND j.status  = 'SUCCESS'
      AND entry->>'mac' ILIKE ${likePattern}
    ORDER BY entry->>'mac', j."updatedAt" DESC
    LIMIT ${limit}
  `;

  return {
    items: rows.map(
      (r): SearchResultItem => ({
        primary: r.mac,
        secondary: `${r.interface} / VLAN ${r.vlan} - ${r.deviceName}`,
        href: `/mac-addresses?q=${encodeURIComponent(q)}`,
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

  // All searches run in parallel — each has its own efficient query path.
  const [devicesResult, jobsResult, arpResult, macResult] = await Promise.allSettled([
    searchDevices(trimmed, limit),
    searchJobs(trimmed, limit),
    searchArp(trimmed, limit),
    searchMac(trimmed, limit),
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

  const a = arpResult.status === 'fulfilled' ? arpResult.value : { items: [], total: 0 };
  add('arp', 'ARP', '/arp-addresses', a.items, a.total);

  const m = macResult.status === 'fulfilled' ? macResult.value : { items: [], total: 0 };
  add('mac', 'MAC', '/mac-addresses', m.items, m.total);

  console.log(`[search] groups=${groups.length} q=${trimmed}`);
  return groups;
}

// silence unused Prisma import warning if build target drops it
void Prisma;
