import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

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

function linkId(a: string, aPort: string, b: string, bPort: string) {
  const left = `${a}:${aPort || '?'}`;
  const right = `${b}:${bPort || '?'}`;
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
  const devices = await prisma.device.findMany({
    where: site
      ? {
          OR: [{ site }, { name: { startsWith: `${site}-` } }],
        }
      : undefined,
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
  });

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

  const jobs = nodes.length
    ? await prisma.job.findMany({
        where: {
          deviceId: { in: nodes.map((node) => node.id) },
          type: JobType.GET_INTERFACES,
          status: JobStatus.SUCCESS,
        },
        orderBy: { updatedAt: 'desc' },
        select: { deviceId: true, result: true, updatedAt: true },
      })
    : [];

  const latest = new Map<string, { result: unknown; updatedAt: Date }>();
  for (const job of jobs) {
    if (!job.deviceId || latest.has(job.deviceId)) continue;
    latest.set(job.deviceId, { result: job.result, updatedAt: job.updatedAt });
  }

  const merged = new Map<string, FabricLink>();

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

      const id = linkId(node.id, localPort, peer.id, parsed.remotePort);
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

  const collectedAt = [...latest.values()]
    .map((item) => item.updatedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const links = [...merged.values()].sort((a, b) => {
    const left = `${a.fromName}:${a.fromPort}`;
    const right = `${b.fromName}:${b.fromPort}`;
    return left.localeCompare(right, undefined, { numeric: true });
  });

  return {
    site: site || null,
    nodes,
    links,
    collectedAt: collectedAt ? collectedAt.toISOString() : null,
    nodeCount: nodes.length,
    linkCount: links.length,
    devicesWithPorts: latest.size,
  };
}
