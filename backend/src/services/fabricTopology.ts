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

/** Normalize an LLDP remote port name to lowercase-with-hyphens for display.
 *
 * Vendors return different formats:
 *   Juniper  → "ge-0/0/1"      (already hyphenated, just lowercase)
 *   IOS-XE   → "Gi0/0/1"       → "gi0/0/1"
 *   EOS      → "Ethernet1"      → "et1"
 *   generic  → "Port-channel1"  → "port-channel1"
 *
 * This is best-effort: we show the raw value if no known prefix matches.
 */
function normalizeLldpPort(port: string): string {
  const p = (port || '').trim().toLowerCase();
  // EOS: EthernetN → etN
  const eosMatch = p.match(/^ethernet(\d+)$/);
  if (eosMatch) return `et${eosMatch[1]}`;
  // IOS-XE: GigabitEthernetN → giN, TenGigabitEthernetN → teN
  const giMatch = p.match(/^(gigabitethernet)(\d.*)$/);
  if (giMatch) return `gi${giMatch[2]}`;
  const tiMatch = p.match(/^(tengigabitethernet)(\d.*)$/);
  if (tiMatch) return `te${tiMatch[2]}`;
  const fiMatch = p.match(/^(fastethernet)(\d.*)$/);
  if (fiMatch) return `fa${fiMatch[2]}`;
  const twogiMatch = p.match(/^(twogigabitethernet)(\d.*)$/);
  if (twogiMatch) return `twogi${twogiMatch[2]}`;
  // Leave everything else (ge-, xe-, et-, ae-, po-, etc.) as-is
  return p;
}

/**
 * Deterministic link dedup key for merging two interface descriptions that
 * point to the same physical cable.
 *
 * The key MUST be the same whether the link was discovered via
 * `interface description` (which usually carries only the LOCAL port)
 * or via `LLDP` (which carries both sides' ports). Otherwise the same
 * physical cable produces two records and shows up as a duplicate
 * line on the topology.
 *
 * Strategy: key by canonical (sorted) device pair. Ports are part of
 * the displayed record but not the dedup key — the canonical case is
 * exactly one physical link per device pair. Multi-link redundancy
 * (e.g. dual-homing with two ports per pair) is rare enough that
 * surfacing a single representative link is better than the current
 * duplicate-line mess. If you ever need multi-link support, add a
 * `(device-pair, sorted-ports)` key and merge in the UI.
 */
function linkId(a: string, _aPort: string, b: string, _bPort: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}__${hi}`;
}

type LldpNeighbor = {
  localPort: string;
  remoteDeviceId: string;
  remotePort: string;
  chassisId: string;
};

type IfaceRow = {
  name?: string;
  description?: string;
  mode?: string;
  operStatus?: string;
  adminStatus?: string;
};

type JobPayload = {
  interfaces?: IfaceRow[];
  lldpNeighbors?: LldpNeighbor[];
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

  const merged = new Map<string, FabricLink>();

  for (const node of nodes) {
    const job = latest.get(node.id);
    const payload = (job?.result ?? null) as JobPayload | null;
    const ifaces = Array.isArray(payload?.interfaces) ? payload.interfaces : [];
    for (const iface of ifaces) {
      const localPort = String(iface.name || '').trim();
      const parsed = parsePeerFromDescription(String(iface.description || ''));
      if (!localPort || !parsed) continue;
      const peer = matchDevice(nodes, parsed.token);
      if (!peer || peer.id === node.id) continue;

      const id = linkId(node.id, localPort, peer.id, normalizeLldpPort(parsed.remotePort));
      const existing = merged.get(id);
      const fromIsLex = `${node.id}:${localPort}` < `${peer.id}:${parsed.remotePort || '?'}`;
      const from = fromIsLex ? node : peer;
      const to = fromIsLex ? peer : node;
      const fromPort = fromIsLex ? localPort : parsed.remotePort;
      const toPort = fromIsLex ? parsed.remotePort : localPort;

      if (!existing) {
        merged.set(id, {
          id,
          fromDeviceId: from.id,
          fromName: from.shortName,
          fromPort: fromPort || localPort,
          toDeviceId: to.id,
          toName: to.shortName,
          toPort: toPort || parsed.remotePort,
          kind: parsed.kind,
          note: String(iface.description || '').trim(),
          mode: String(iface.mode || ''),
          operStatus: String(iface.operStatus || ''),
        });
        continue;
      }

      if (!existing.toPort && parsed.remotePort) existing.toPort = parsed.remotePort;
      if (!existing.fromPort) existing.fromPort = localPort;
      if (parsed.kind === 'peer' || (parsed.kind === 'trunk' && existing.kind === 'uplink')) {
        existing.kind = parsed.kind;
      }
      if (iface.description && !existing.note.includes(String(iface.description))) {
        existing.note = `${existing.note} · ${iface.description}`.replace(/^ · /, '');
      }
      if (iface.operStatus === 'down') existing.operStatus = 'down';
    }
  }

  /**
   * LLDP neighbour loop — the authoritative source for physical links.
   *
   * LLDP is populated by the protocol itself (not human-typed descriptions),
   * so it is more reliable than `interface description`.  We process it after
   * the description loop so LLDP ports can fill in unknown port details from
   * description-only links, and description kind overrides can supplement
   * LLDP-only links that have no explicit kind signal.
   *
   * Remote device matching uses `matchDevice()` — same logic as description
   * parsing, so "LAB-F1-DS01" in LLDP matches the device with `shortName="DS01"`.
   */
  for (const node of nodes) {
    const job = latest.get(node.id);
    const payload = (job?.result ?? null) as JobPayload | null;
    const neighbors: LldpNeighbor[] = Array.isArray(payload?.lldpNeighbors)
      ? payload.lldpNeighbors
      : [];
    for (const n of neighbors) {
      const localPort = (n.localPort || '').trim();
      if (!localPort) continue;

      // Try to match the remote device by hostname
      const peer = matchDevice(nodes, n.remoteDeviceId);
      if (!peer || peer.id === node.id) continue;

      const remotePort = normalizeLldpPort(n.remotePort);
      const id = linkId(node.id, localPort, peer.id, remotePort);
      const existing = merged.get(id);
      const fromIsLex = `${node.id}:${localPort}` < `${peer.id}:${remotePort || '?'}`;
      const from = fromIsLex ? node : peer;
      const to = fromIsLex ? peer : node;
      const fromPort = fromIsLex ? localPort : remotePort;
      const toPort = fromIsLex ? remotePort : localPort;

      if (!existing) {
        merged.set(id, {
          id,
          fromDeviceId: from.id,
          fromName: from.shortName,
          fromPort,
          toDeviceId: to.id,
          toName: to.shortName,
          toPort,
          kind: 'uplink',   // LLDP links default to uplink; role-pair override refines
          note: `LLDP: ${n.remoteDeviceId}`,
          mode: '',
          operStatus: '',
        });
        continue;
      }

      // LLDP is more trustworthy than description — fill in missing port details
      if (!existing.toPort && remotePort) existing.toPort = remotePort;
      if (!existing.fromPort) existing.fromPort = localPort;
      if (!existing.note.startsWith('LLDP:') && n.remoteDeviceId) {
        existing.note = `LLDP: ${n.remoteDeviceId}`;
      }
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
