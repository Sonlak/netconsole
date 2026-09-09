import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

type CacheEntry = { value: unknown; expiresAt: number };
const TTL_MS = 15_000;
const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value as T;
}

function setCached<T>(key: string, value: T) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

export function invalidateFabricCache() {
  cache.clear();
}

export type FabricRole = 'core' | 'dist' | 'access';
export type FabricLinkKind = 'trunk' | 'peer' | 'l3' | 'uplink';

export type FabricNode = {
  id: string;
  name: string;
  shortName: string;
  ip: string;
  site: string;
  floor: string;
  floorNumber: number | null;
  role: FabricRole;
  status: string;
  model: string;
};

export type FabricLink = {
  id: string;
  fromDeviceId: string;
  fromName: string;
  fromPort: string;
  toDeviceId: string;
  toName: string;
  toPort: string;
  kind: FabricLinkKind;
  note: string;
  mode: string;
  operStatus: string;
};

const PORT_RE = /((?:ge|xe|et|ae)-\d+\/\d+\/\d+)/i;
const PEER_RE = /(?:TO|PEER)[_-](?:SW[_-])?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i;
const SW_RE = /SW-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i;
const HOST_FLOOR = /(?:^|[-_])F0*([1-9]\d?)(?:[-_]|$)/i;

export function inferDeviceRole(name: string, floor: string): FabricRole {
  const key = `${name} ${floor}`.toLowerCase();
  if (key.includes('core')) return 'core';
  if (key.includes('dist') || /(?:^|[-_])ds(?:[-_]|\d|$)/i.test(key)) return 'dist';
  if (key.includes('access') || /(?:^|[-_])as(?:[-_]|\d|$)/i.test(key)) return 'access';
  return 'access';
}

export function parseFloorNumber(value: string): number | null {
  const host = (value || '').trim().match(HOST_FLOOR);
  if (host) return Number(host[1]);
  const match = (value || '').trim().match(/^F?0*([1-9]\d?)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

export function parsePeerFromDescription(description: string): {
  token: string;
  remotePort: string;
  kind: FabricLinkKind;
} | null {
  const text = (description || '').trim();
  if (!text) return null;
  if (!/(to|peer|uplink)/i.test(text)) return null;

  const upper = text.toUpperCase();
  let kind: FabricLinkKind = 'uplink';
  if (upper.includes('PEER')) kind = 'peer';
  else if (upper.includes('TRUNK')) kind = 'trunk';
  else if (upper.includes('LINK_TO') || /\bl3\b/i.test(text)) kind = 'l3';

  let remotePort = '';
  let rest = text;
  const portAtEnd = text.match(new RegExp(`${PORT_RE.source}\\s*$`, 'i'));
  if (portAtEnd) {
    remotePort = portAtEnd[1];
    rest = text.slice(0, portAtEnd.index).replace(/[_-\s]+$/, '');
  }

  const peerMatch = rest.match(PEER_RE) || rest.match(SW_RE);
  if (!peerMatch) return null;
  return { token: peerMatch[1], remotePort, kind };
}

function shortName(name: string, site: string): string {
  const prefix = `${site}-`;
  if (name.toUpperCase().startsWith(prefix.toUpperCase())) {
    return name.slice(prefix.length);
  }
  return name;
}

function matchDevice(nodes: FabricNode[], token: string): FabricNode | null {
  const key = token.replace(/^SW[-_]/i, '').replace(/_/g, '-').toUpperCase();
  const candidates = nodes.filter((node) => {
    const n = node.name.toUpperCase().replace(/_/g, '-');
    const short = node.shortName.toUpperCase().replace(/_/g, '-');
    return n === key || n.endsWith(`-${key}`) || short === key || short.endsWith(`-${key}`);
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const exact = candidates.find((node) => node.shortName.toUpperCase() === key);
    return exact || candidates.sort((a, b) => b.name.length - a.name.length)[0];
  }
  return null;
}

/**
 * Deterministic link dedup key for merging two interface descriptions that
 * point to the same physical cable.
 *
 * Problem: if the far-end device's description omits the remote port
 * (e.g. `Eth1` instead of `ge-0/0/1`), the two sides produce different
 * keys (`DS01:ge-0/0/1__AS01:?` vs `DS01:ge-0/0/1__AS01:Ethernet1`)
 * and the records are not merged — causing duplicate links in the topology.
 *
 * Fix: when either port is empty, normalise both sides to `?` so the key
 * reflects only the device pair. The complete record (with both ports set)
 * will overwrite the incomplete one, and both sides get merged on the
 * next rebuild.
 */
function linkId(a: string, aPort: string, b: string, bPort: string): string {
  const safeA = aPort || '?';
  const safeB = bPort || '?';
  // When either side has an unknown port the physical link identity
  // collapses to the device pair — any further port detail is just
  // additional metadata, not a distinct link.
  if (!aPort || !bPort) {
    const [hi, lo] = a < b ? [b, a] : [a, b];
    return `${lo}__${hi}`;
  }
  const left = `${a}:${safeA}`;
  const right = `${b}:${safeB}`;
  return left < right ? `${left}__${right}` : `${right}__${left}`;
}

type IfaceRow = {
  name?: string;
  description?: string;
  mode?: string;
  operStatus?: string;
  adminStatus?: string;
};

export async function getFabricTopology(site?: string) {
  const cacheKey = `fabric:${site || ''}`;
  const cached = getCached<unknown>(cacheKey);
  if (cached) return cached;

  const where = site
    ? {
        OR: [{ site }, { name: { startsWith: `${site}-` } }],
      }
    : undefined;

  const [devices, jobs] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        ip: true,
        site: true,
        floor: true,
        status: true,
        model: true,
      },
    }),
    prisma.job.findMany({
      where: {
        type: JobType.GET_INTERFACES,
        status: JobStatus.SUCCESS,
      },
      orderBy: { updatedAt: 'desc' },
      select: { deviceId: true, result: true, updatedAt: true },
    }),
  ]);

  const deviceIds = new Set(devices.map((d) => d.id));
  const latest = new Map<string, { result: unknown; updatedAt: Date }>();
  for (const job of jobs) {
    if (!job.deviceId || !deviceIds.has(job.deviceId)) continue;
    if (latest.has(job.deviceId)) continue;
    latest.set(job.deviceId, { result: job.result, updatedAt: job.updatedAt });
  }

  const nodes: FabricNode[] = devices.map((device) => {
    const floorNumber = parseFloorNumber(device.name) ?? parseFloorNumber(device.floor);
    return {
      id: device.id,
      name: device.name,
      shortName: shortName(device.name, device.site),
      ip: device.ip,
      site: device.site,
      floor: device.floor,
      floorNumber,
      role: inferDeviceRole(device.name, device.floor),
      status: device.status,
      model: device.model || '',
    };
  });

  /** Fast device-id → role lookup used by the role-based kind override. */
  const nodeRoleById = new Map<string, FabricRole>(nodes.map((n) => [n.id, n.role]));

  const pairMap = new Map<string, FabricLink>(); // device-pair → best incomplete entry
  const merged  = new Map<string, FabricLink>(); // full linkId → complete entry

  for (const node of nodes) {
    const job = latest.get(node.id);
    const payload = (job?.result ?? null) as { interfaces?: IfaceRow[] } | null;
    const ifaces = Array.isArray(payload?.interfaces) ? payload.interfaces : [];
    for (const iface of ifaces) {
      const localPort = String(iface.name || '').trim();
      const parsed = parsePeerFromDescription(String(iface.description || ''));
      if (!localPort || !parsed) continue;
      const peer = matchDevice(nodes, parsed.token);
      if (!peer || peer.id === node.id) continue;

      // Determine canonical from/to (sorted by device id).
      const fromIsLex = `${node.id}:${localPort}` < `${peer.id}:${parsed.remotePort || '?'}`;
      const from      = fromIsLex ? node : peer;
      const to        = fromIsLex ? peer : node;
      const fromPort = fromIsLex ? localPort : parsed.remotePort;
      const toPort   = fromIsLex ? parsed.remotePort : localPort;

      const devicePairKey = from.id < to.id ? `${from.id}__${to.id}` : `${to.id}__${from.id}`;
      const completeKey   = `${from.id}:${fromPort}__${to.id}:${toPort}`;
      const isComplete    = !!fromPort && !!toPort;

      if (isComplete) {
        // Complete entry: deduplicate by full (device + port) key.
        const existing = merged.get(completeKey);
        if (!existing) {
          merged.set(completeKey, {
            id:          completeKey,
            fromDeviceId: from.id,
            fromName:     from.shortName,
            fromPort:     fromPort,
            toDeviceId:   to.id,
            toName:       to.shortName,
            toPort:       toPort,
            kind:         parsed.kind,
            note:         String(iface.description || '').trim(),
            mode:         String(iface.mode || ''),
            operStatus:   String(iface.operStatus || ''),
          });
        } else {
          // Merge: fill empty fields, upgrade kind.
          if (!existing.toPort   && toPort)   existing.toPort   = toPort;
          if (!existing.fromPort && fromPort) existing.fromPort = fromPort;
          if (parsed.kind === 'peer' || (parsed.kind === 'trunk' && existing.kind === 'uplink')) {
            existing.kind = parsed.kind;
          }
          if (iface.description && !existing.note.includes(String(iface.description))) {
            existing.note = `${existing.note} · ${iface.description}`.replace(/^ · /, '');
          }
          if (iface.operStatus === 'down') existing.operStatus = 'down';
        }
      } else {
        // Incomplete entry: accumulate into pairMap.
        const existing = pairMap.get(devicePairKey);
        if (!existing) {
          pairMap.set(devicePairKey, {
            id:          devicePairKey,
            fromDeviceId: from.id,
            fromName:     from.shortName,
            fromPort:     fromPort || localPort,
            toDeviceId:   to.id,
            toName:       to.shortName,
            toPort:       toPort   || parsed.remotePort,
            kind:         parsed.kind,
            note:         String(iface.description || '').trim(),
            mode:         String(iface.mode || ''),
            operStatus:   String(iface.operStatus || ''),
          });
        } else {
          // Fill missing ports from the new entry.
          if (!existing.fromPort && fromPort) existing.fromPort = fromPort;
          if (!existing.toPort   && toPort)   existing.toPort   = toPort;
          // Upgrade kind like the original merge.
          if (parsed.kind === 'peer' || (parsed.kind === 'trunk' && existing.kind === 'uplink')) {
            existing.kind = parsed.kind;
          }
          if (iface.description && !existing.note.includes(String(iface.description))) {
            existing.note = `${existing.note} · ${iface.description}`.replace(/^ · /, '');
          }
          if (iface.operStatus === 'down') existing.operStatus = 'down';
        }
      }
    }
  }

  // Promote incomplete pair entries to merged using the device-pair key as id.
  for (const link of pairMap.values()) {
    merged.set(link.id, link);
  }

  /**
   * Role-based kind override — per the fabric diagram contract:
   *   core ↔ core   = peer  (management / L3 redundancy)
   *   core ↔ dist   = l3   (uplink tier-to-tier)
   *   dist ↔ dist   = peer  (IR/Aggregation ring)
   *   dist ↔ access = trunk (layer-2 downlink / VLAN trunk)
   *   access ↔ access = peer (horizontal stacking links)
   *
   * The description-based `parsed.kind` is kept as-is when it carries
   * useful semantic information (e.g. description explicitly says "TRUNK"
   * or "PEER"), but the role pair is the authoritative signal when
   * description is generic (e.g. "LINK_TO_…").
   *
   * We apply this after the merge so the override runs on every record
   * regardless of which interface side originally populated it.
   */
  for (const link of merged.values()) {
    const fromRole = nodeRoleById.get(link.fromDeviceId) ?? 'access';
    const toRole   = nodeRoleById.get(link.toDeviceId)   ?? 'access';
    if (fromRole === toRole) {
      link.kind = 'peer';
    } else if (
      (fromRole === 'core' && toRole === 'dist') ||
      (fromRole === 'dist'  && toRole === 'core')
    ) {
      link.kind = 'l3';
    } else if (
      (fromRole === 'dist'   && toRole === 'access') ||
      (fromRole === 'access' && toRole === 'dist')
    ) {
      link.kind = 'trunk';
    }
  }

  /**
   * Role-based kind override — per the fabric diagram contract:
   *   core ↔ core   = peer  (management / L3 redundancy)
   *   core ↔ dist   = l3   (uplink tier-to-tier)
   *   dist ↔ dist   = peer  (IR/Aggregation ring)
   *   dist ↔ access = trunk (layer-2 downlink / VLAN trunk)
   *   access ↔ access = peer (horizontal stacking links)
   *
   * The description-based `parsed.kind` is kept as-is when it carries
   * useful semantic information (e.g. description explicitly says "TRUNK"
   * or "PEER"), but the role pair is the authoritative signal when
   * description is generic (e.g. "LINK_TO_…").
   *
   * We apply this after the merge so the override runs on every record
   * regardless of which interface side originally populated it.
   */
  for (const link of merged.values()) {
    const fromRole = nodeRoleById.get(link.fromDeviceId) ?? 'access';
    const toRole   = nodeRoleById.get(link.toDeviceId)   ?? 'access';
    if (fromRole === toRole) {
      link.kind = 'peer';
    } else if (
      (fromRole === 'core' && toRole === 'dist') ||
      (fromRole === 'dist'  && toRole === 'core')
    ) {
      link.kind = 'l3';
    } else if (
      (fromRole === 'dist'   && toRole === 'access') ||
      (fromRole === 'access' && toRole === 'dist')
    ) {
      link.kind = 'trunk';
    }
  }

  const collectedAt = [...latest.values()]
    .map((item) => item.updatedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const links = [...merged.values()].sort((a, b) => {
    const left = `${a.fromName}:${a.fromPort}`;
    const right = `${b.fromName}:${b.fromPort}`;
    return left.localeCompare(right, undefined, { numeric: true });
  });

  const payload = {
    site: site || null,
    nodes,
    links,
    collectedAt: collectedAt ? collectedAt.toISOString() : null,
    nodeCount: nodes.length,
    linkCount: links.length,
    devicesWithPorts: latest.size,
  };
  setCached(cacheKey, payload);
  return payload;
}
