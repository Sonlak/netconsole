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
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listLogs } from './logs.js';
import { keaCommand } from './keaDhcp.js';
import { getArpInventory } from './arpAddress.js';
import { getMacAddressInventory } from './macAddress.js';

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
    const inventory = await getArpInventory();
    const matchesList: Array<{ ip: string; mac: string; hostname: string; deviceName: string }> = [];
    for (const row of inventory.rows) {
      if (
        matches(row.ip, q) ||
        matches(row.mac, q) ||
        matches(row.hostname, q) ||
        matches(row.deviceName, q)
      ) {
        matchesList.push({
          ip: row.ip,
          mac: row.mac,
          hostname: row.hostname,
          deviceName: row.deviceName,
        });
        if (matchesList.length >= limit) break;
      }
    }
    return {
      items: matchesList.map(
        (m): SearchResultItem => ({
          primary: m.ip,
          secondary: `${m.mac} - ${m.hostname || '-'} - ${m.deviceName}`,
          href: `/arp-addresses?q=${encodeURIComponent(q)}`,
        })
      ),
      total: matchesList.length,
    };
  } catch {
    return { items: [], total: 0 };
  }
}

async function searchMac(q: string, limit: number) {
  try {
    const inventory = await getMacAddressInventory();
    const rows: Array<{ mac: string; vlan: string | null; interface: string | null; deviceName: string }> = [];
    for (const row of inventory.rows ?? []) {
      const mac = (row as { mac?: string }).mac ?? '';
      const vlan = (row as { vlan?: string }).vlan ?? null;
      const ifname = (row as { interface?: string }).interface ?? null;
      const deviceName = (row as { device?: { name?: string } }).device?.name ?? '';
      if (matches(mac, q) || matches(vlan ?? '', q) || matches(ifname ?? '', q)) {
        rows.push({ mac, vlan, interface: ifname, deviceName });
        if (rows.length >= limit) break;
      }
    }
    return {
      items: rows.map(
        (m): SearchResultItem => ({
          primary: m.mac,
          secondary: `${m.vlan ?? '-'} - ${m.interface ?? '-'} - ${m.deviceName}`,
          href: `/mac-addresses?q=${encodeURIComponent(q)}`,
        })
      ),
      total: rows.length,
    };
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

  const [deviceResult, arpResult, macResult, logResult, jobResult, auditResult, dhcpResult] =
    await Promise.allSettled([
      searchDevices(trimmed, limit),
      searchArp(trimmed, limit),
      searchMac(trimmed, limit),
      searchLogs(trimmed, limit),
      searchJobs(trimmed, limit),
      searchAudit(trimmed, limit),
      searchDhcp(trimmed, limit),
    ]);

  const toGroup = (
    kind: SearchResultGroup['kind'],
    label: string,
    result: PromiseSettledResult<{ items: SearchResultItem[]; total: number }>
  ): SearchResultGroup | null => {
    if (result.status !== 'fulfilled') return null;
    const { items, total } = result.value;
    if (total === 0) return null;
    return { kind, label, items, total, url: '' };
  };

  const groups: SearchResultGroup[] = [];
  const d = toGroup('device', 'Devices', deviceResult);
  if (d) groups.push(d);
  const a = toGroup('arp', 'ARP', arpResult);
  if (a) groups.push(a);
  const m = toGroup('mac', 'MAC', macResult);
  if (m) groups.push(m);
  const l = toGroup('log', 'Logs', logResult);
  if (l) groups.push(l);
  const j = toGroup('job', 'Jobs', jobResult);
  if (j) groups.push(j);
  const au = toGroup('audit', 'Audit', auditResult);
  if (au) groups.push(au);
  const dhcp = toGroup('dhcp', 'DHCP Leases', dhcpResult);
  if (dhcp) groups.push(dhcp);

  return groups;
}

// silence unused Prisma import warning if build target drops it
void Prisma;
