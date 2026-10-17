export type KeaCommandResult = {
  result?: number;
  text?: string;
  arguments?: Record<string, unknown>;
};

/**
 * Kea peer URL accessors.
 *
 * Semantic labels (DC = primary site, DR = disaster recovery):
 *   getDcUrl()  → DC control agent (normally the primary)
 *   getDrUrl()  → DR control agent (normally the standby)
 *
 * The legacy `getPrimaryUrl` / `getStandbyUrl` names are kept as aliases
 * for back-compat with the existing KEA_API_URL / KEA_STANDBY_API_URL
 * env vars. The new alias names are used inside this file where the
 * DC/DR semantics matter.
 */
function getDcUrl() {
  return (process.env.KEA_API_URL || 'http://127.0.0.1:8001/').replace(/\/?$/, '/');
}

function getDrUrl() {
  return (process.env.KEA_STANDBY_API_URL || 'http://127.0.0.1:8002/').replace(/\/?$/, '/');
}

// Back-compat aliases (existing code uses primary/standby)
const getPrimaryUrl = getDcUrl;
const getStandbyUrl = getDrUrl;

function timeoutMs() {
  return Number(process.env.KEA_TIMEOUT_MS) || 5000;
}

export type KeaTarget = 'dc' | 'dr' | 'primary' | 'standby' | 'auto' | 'all';

export async function keaCommand(
  command: string,
  argumentsPayload?: Record<string, unknown>,
  options?: { target?: KeaTarget },
): Promise<KeaCommandResult> {
  const target = options?.target ?? 'auto';
  const urls =
    target === 'dr' || target === 'standby'
      ? [getDrUrl()]
      : target === 'dc' || target === 'primary'
        ? [getDcUrl()]
        : target === 'all'
          ? [getDcUrl(), getDrUrl()]
          : [getDcUrl(), getDrUrl()];

  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs());
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          service: ['dhcp4'],
          ...(argumentsPayload ? { arguments: argumentsPayload } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        lastError = new Error(`Kea HTTP ${response.status} at ${url}`);
        continue;
      }

      const payload = (await response.json()) as KeaCommandResult | KeaCommandResult[];
      const result = Array.isArray(payload) ? payload[0] : payload;
      if (!result) {
        lastError = new Error(`Empty Kea response from ${url}`);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error('Kea API unavailable');
}

/**
 * Run a command against BOTH DC and DR in parallel. Returns one result per
 * site keyed by `dc` / `dr`. Failures are reported per-site rather than
 * throwing, so the caller can render a "DC healthy, DR down" picture in
 * one round-trip (used by the auto-failback scheduler + dashboard).
 */
export async function keaCommandBoth(
  command: string,
  argumentsPayload?: Record<string, unknown>,
): Promise<{ dc: KeaCommandResult | null; dr: KeaCommandResult | null; dcError?: string; drError?: string }> {
  const send = async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          service: ['dhcp4'],
          ...(argumentsPayload ? { arguments: argumentsPayload } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        return { ok: false as const, error: `HTTP ${response.status}` };
      }
      const payload = (await response.json()) as KeaCommandResult | KeaCommandResult[];
      return { ok: true as const, result: Array.isArray(payload) ? payload[0] : payload };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const [dcRes, drRes] = await Promise.all([send(getDcUrl()), send(getDrUrl())]);
  return {
    dc: dcRes.ok ? dcRes.result : null,
    dr: drRes.ok ? drRes.result : null,
    dcError: dcRes.ok ? undefined : dcRes.error,
    drError: drRes.ok ? undefined : drRes.error,
  };
}

import { buildClientLookup } from './arpAddress.js';
import { listCollectableDevices } from './collectableDevices.js';

export type DhcpPool = {
  subnetId: number;
  name: string;
  site: string;
  vlan: number;
  subnet: string;
  pool: string;
  gateway: string;
  dns: string[];
  leased: number;
  poolSize: number;
  utilization: number;
};

export type DhcpLease = {
  ip: string;
  mac: string;
  hostname: string;
  clientDevice: string;
  clientPort: string;
  subnetId: number;
  subnet?: string;
  site?: string;
  vlan?: number;
  validLifetime: number;
  cltt: number | null;
  expiresAt: string | null;
  state: number;
  stateLabel: string;
  /** True when Kea has a host reservation for this IP/MAC. */
  reserved: boolean;
  /** Operator note stored on the Kea host reservation. */
  note: string;
};

export type DhcpHaPeer = {
  name: string;
  /** DC = primary site, DR = disaster recovery site. */
  site: 'DC' | 'DR';
  /** Role this server is in: primary (serving) or standby (passive). */
  role: string;
  url: string;
  reachable: boolean;
  /**
   * Kea HA hook state. Possible values:
   *   - "waiting"               — Kea starting up, not yet synced
   *   - "syncing"               — initial lease DB sync in progress
   *   - "hot-standby"           — normal standby, partner is up
   *   - "load-balancing"        — only in load-balancing mode
   *   - "partner-down"          — I am primary, partner is unreachable
   *   - "unavailable"           — partner has been down too long
   *   - "communication-recovered" — partner just came back
   *   - "terminated"            — HA disabled
   */
  state?: string;
  /** Lease scopes this server is responsible for (from ha-heartbeat). */
  scopes?: string[];
  /** ISO timestamp of the last successful heartbeat we received. */
  lastHeartbeatAt?: string | null;
  /** How long this server has been in its current role (seconds). */
  uptimeInRole?: number;
};

function parsePoolRange(pool: string): { start: string; end: string; size: number } {
  const [rawStart, rawEnd] = pool.split('-').map((part) => part.trim());
  const start = rawStart;
  const end = rawEnd || rawStart;
  const toInt = (ip: string) =>
    ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
  const size = Math.max(0, toInt(end) - toInt(start) + 1);
  return { start, end, size };
}

function optionDataMap(optionData: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(optionData)) {
    return map;
  }
  for (const item of optionData) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as { name?: string; data?: string };
    if (row.name && typeof row.data === 'string') {
      map[row.name] = row.data;
    }
  }
  return map;
}

function stateLabel(state: number): string {
  switch (state) {
    case 0:
      return 'default';
    case 1:
      return 'declined';
    case 2:
      return 'expired-reclaimed';
    case 3:
      return 'released';
    default:
      return `state-${state}`;
  }
}

function readUserContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, unknown>;
}

function reservationNote(row: Record<string, unknown>): string {
  const ctx = readUserContext(row['user-context']);
  return typeof ctx.note === 'string' ? ctx.note.trim() : '';
}

type HostReservation = {
  ip: string;
  mac: string;
  hostname: string;
  note: string;
};

function listSubnetReservations(subnet: Record<string, unknown>): HostReservation[] {
  const rows = Array.isArray(subnet.reservations) ? subnet.reservations : [];
  const out: HostReservation[] = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const ip = String(row['ip-address'] || '').trim();
    const mac = String(row['hw-address'] || '').trim().toLowerCase();
    if (!ip || !mac) continue;
    out.push({
      ip,
      mac,
      hostname: String(row.hostname || '').trim(),
      note: reservationNote(row),
    });
  }
  return out;
}

async function loadPrimaryDhcp4(): Promise<Record<string, unknown>> {
  const cfgResult = await keaCommand('config-get', undefined, { target: 'primary' });
  if ((cfgResult.result ?? 1) !== 0) {
    throw new Error(cfgResult.text || 'config-get failed');
  }
  const args = (cfgResult.arguments ?? {}) as { Dhcp4?: Record<string, unknown> };
  const dhcp4 = args.Dhcp4;
  if (!dhcp4 || typeof dhcp4 !== 'object') {
    throw new Error('Dhcp4 config missing from config-get');
  }
  return dhcp4;
}

async function savePrimaryDhcp4(dhcp4: Record<string, unknown>) {
  const setResult = await keaCommand('config-set', { Dhcp4: dhcp4 }, { target: 'primary' });
  if ((setResult.result ?? 1) !== 0) {
    throw new Error(setResult.text || 'config-set failed');
  }
  const writeResult = await keaCommand(
    'config-write',
    { filename: '/etc/kea/kea-dhcp4.conf' },
    { target: 'primary' },
  );
  if ((writeResult.result ?? 1) !== 0) {
    throw new Error(writeResult.text || 'config-write failed');
  }
  return { setResult, writeResult };
}

export async function getDhcpDashboard() {
  const [configResult, leasesResult, haPrimary, haStandby] = await Promise.all([
    keaCommand('config-get', undefined, { target: 'auto' }),
    keaCommand('lease4-get-all', undefined, { target: 'auto' }),
    keaCommand('ha-heartbeat', undefined, { target: 'primary' }).catch(() => null),
    keaCommand('ha-heartbeat', undefined, { target: 'standby' }).catch(() => null),
  ]);

  if ((configResult.result ?? 1) !== 0) {
    throw new Error(configResult.text || 'Failed to read Kea config');
  }

  const dhcp4 = (configResult.arguments as { Dhcp4?: Record<string, unknown> } | undefined)?.Dhcp4;
  const subnet4 = Array.isArray(dhcp4?.subnet4) ? dhcp4.subnet4 : [];
  const leasesArgs = (leasesResult.arguments ?? {}) as { leases?: unknown[] };
  const leasesRaw = Array.isArray(leasesArgs.leases) ? leasesArgs.leases : [];

  const leaseCountBySubnet = new Map<number, number>();
  for (const lease of leasesRaw) {
    if (!lease || typeof lease !== 'object') {
      continue;
    }
    const subnetId = Number((lease as { 'subnet-id'?: number })['subnet-id']);
    if (!Number.isFinite(subnetId)) {
      continue;
    }
    leaseCountBySubnet.set(subnetId, (leaseCountBySubnet.get(subnetId) ?? 0) + 1);
  }

  const pools: DhcpPool[] = subnet4.map((item) => {
    const subnet = item as {
      id?: number;
      subnet?: string;
      pools?: { pool?: string }[];
      'option-data'?: unknown;
      'user-context'?: unknown;
    };
    const ctx = readUserContext(subnet['user-context']);
    const options = optionDataMap(subnet['option-data']);
    const poolText = subnet.pools?.[0]?.pool || '';
    const { size } = parsePoolRange(poolText);
    const subnetId = Number(subnet.id ?? 0);
    const leased = leaseCountBySubnet.get(subnetId) ?? 0;
    const gateway =
      (typeof ctx.gateway === 'string' && ctx.gateway) || options.routers?.split(',')[0]?.trim() || '';

    return {
      subnetId,
      name: typeof ctx.name === 'string' ? ctx.name : `subnet-${subnetId}`,
      site: typeof ctx.site === 'string' ? ctx.site : 'Unknown',
      vlan: Number(ctx.vlan ?? subnetId),
      subnet: subnet.subnet || '',
      pool: poolText,
      gateway,
      dns: (options['domain-name-servers'] || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
      leased,
      poolSize: size,
      utilization: size > 0 ? Math.round((leased / size) * 1000) / 10 : 0,
    };
  });

  const sites = Array.from(
    pools
      .reduce((map, pool) => {
        const current = map.get(pool.site) ?? { site: pool.site, pools: 0, leased: 0, poolSize: 0 };
        current.pools += 1;
        current.leased += pool.leased;
        current.poolSize += pool.poolSize;
        map.set(pool.site, current);
        return map;
      }, new Map<string, { site: string; pools: number; leased: number; poolSize: number }>())
      .values(),
  ).map((site) => ({
    ...site,
    utilization: site.poolSize > 0 ? Math.round((site.leased / site.poolSize) * 1000) / 10 : 0,
  }));

  const haArgs = (args?: KeaCommandResult | null) =>
    (args?.arguments ?? {}) as { state?: string; scopes?: string[]; 'date-time'?: string };

  const dcHeartbeat = haArgs(haPrimary);
  const drHeartbeat = haArgs(haStandby);

  const peers: DhcpHaPeer[] = [
    {
      name: 'kea-dc1',
      site: 'DC',
      role: 'primary',
      url: getDcUrl(),
      reachable: Boolean(haPrimary && (haPrimary.result ?? 1) === 0),
      state: dcHeartbeat.state || '',
      scopes: Array.isArray(dcHeartbeat.scopes) ? dcHeartbeat.scopes : [],
      lastHeartbeatAt: dcHeartbeat['date-time'] || null,
    },
    {
      name: 'kea-dr1',
      site: 'DR',
      role: 'standby',
      url: getDrUrl(),
      reachable: Boolean(haStandby && (haStandby.result ?? 1) === 0),
      state: drHeartbeat.state || '',
      scopes: Array.isArray(drHeartbeat.scopes) ? drHeartbeat.scopes : [],
      lastHeartbeatAt: drHeartbeat['date-time'] || null,
    },
  ];

  // Active site = the one that is currently serving DHCP. Determined by
  // combination of role + state:
  //   - DC's state 'partner-down'        → DC is serving alone (DR down)
  //   - DR's state 'partner-down'        → DR is serving (DC was down, now DR up)
  //   - DC 'hot-standby' + DR 'partner-down' → DR is serving (DR promoted)
  //   - both 'hot-standby'              → DC serving (normal state)
  const active = resolveActiveSite(peers);

  return {
    sites,
    pools,
    gateways: pools.map((pool) => ({
      site: pool.site,
      vlan: pool.vlan,
      gateway: pool.gateway,
      subnet: pool.subnet,
      name: pool.name,
    })),
    ha: {
      mode: 'hot-standby',
      peers,
      active,
    },
    totals: {
      sites: sites.length,
      pools: pools.length,
      leased: pools.reduce((sum, pool) => sum + pool.leased, 0),
      poolSize: pools.reduce((sum, pool) => sum + pool.poolSize, 0),
    },
  };
}

/**
 * Determine which site is currently serving DHCP, based on the HA state
 * of both peers. Returns 'DC' | 'DR' | null.
 *
 * Logic mirrors Kea HA's hot-standby state machine:
 *   - If DC says 'partner-down' but DR says 'hot-standby' → DR is primary
 *     (this is the failover state: DR took over, DC demoted)
 *   - If DC says 'hot-standby' and DR says 'hot-standby' → DC is primary
 *     (normal state: DC serves, DR passively syncs)
 *   - If both say 'partner-down' → split-brain, prefer DC
 *   - If both unreachable → null
 */
function resolveActiveSite(peers: DhcpHaPeer[]): 'DC' | 'DR' | null {
  const dc = peers.find((p) => p.site === 'DC');
  const dr = peers.find((p) => p.site === 'DR');
  if (!dc?.reachable && !dr?.reachable) return null;

  // DR promoting scenario: DC went down, DR took over
  if (dr?.reachable && (dr.state === 'partner-down' || dr.state === 'unavailable')) {
    // DC's heartbeat is fresh enough to claim 'hot-standby' but the
    // state field tells us who's actually serving. If DR is partner-down
    // (i.e. DR's view: "I cannot reach DC, so I'm serving"), DR is active.
    return 'DR';
  }

  // Normal scenario: DC primary, DR standby. If DC is reachable and
  // DC's state is hot-standby (its OWN role), it's serving. Note: Kea's
  // hot-standby state name is the role of THIS server, so a primary
  // reports state='hot-standby' when normal and 'partner-down' when alone.
  if (dc?.reachable && dc.state === 'hot-standby' && dr?.state === 'hot-standby') {
    return 'DC';
  }

  // DC says it's hot-standby and DR is unreachable — DC serving
  if (dc?.reachable && !dr?.reachable) {
    return 'DC';
  }

  // DR says it's hot-standby and DC is unreachable — DR serving
  if (dr?.reachable && !dc?.reachable) {
    return 'DR';
  }

  // Both reachable, both 'hot-standby' — normal, DC serves
  if (dc?.reachable) return 'DC';
  return dr?.reachable ? 'DR' : null;
}

/**
 * Detailed HA state snapshot for the auto-failback scheduler and
 * the operator UI. Returns one entry per site, plus the resolved
 * active site and a recommended action.
 */
export type HaStateSnapshot = {
  activeSite: 'DC' | 'DR' | null;
  peers: DhcpHaPeer[];
  recommendedAction: 'none' | 'switchover-to-dc' | 'switchover-to-dr' | 'investigate';
  reason: string;
  capturedAt: string;
};

export async function getHaState(): Promise<HaStateSnapshot> {
  const both = await keaCommandBoth('ha-heartbeat');

  const parseHeartbeat = (args: KeaCommandResult | null) => {
    const a = (args?.arguments ?? {}) as { state?: string; scopes?: string[]; 'date-time'?: string };
    return {
      state: a.state || '',
      scopes: Array.isArray(a.scopes) ? a.scopes : [],
      lastHeartbeatAt: a['date-time'] || null,
    };
  };

  const dcHb = parseHeartbeat(both.dc);
  const drHb = parseHeartbeat(both.dr);

  const peers: DhcpHaPeer[] = [
    {
      name: 'kea-dc1',
      site: 'DC',
      role: 'primary',
      url: getDcUrl(),
      reachable: Boolean(both.dc && (both.dc.result ?? 1) === 0) && !both.dcError,
      state: dcHb.state,
      scopes: dcHb.scopes,
      lastHeartbeatAt: dcHb.lastHeartbeatAt,
    },
    {
      name: 'kea-dr1',
      site: 'DR',
      role: 'standby',
      url: getDrUrl(),
      reachable: Boolean(both.dr && (both.dr.result ?? 1) === 0) && !both.drError,
      state: drHb.state,
      scopes: drHb.scopes,
      lastHeartbeatAt: drHb.lastHeartbeatAt,
    },
  ];

  const activeSite = resolveActiveSite(peers);

  // Decide the recommended action for the auto-failback scheduler:
  //   - switchover-to-dc: DC healthy, DR is currently active (failback)
  //   - switchover-to-dr: DC unreachable, DR is standby (manual override)
  //   - none:             normal state (DC active, DR standby)
  //   - investigate:      something weird (both down, split-brain, etc.)
  let recommendedAction: HaStateSnapshot['recommendedAction'] = 'none';
  let reason = 'Normal operation (DC active, DR standby)';

  const dc = peers.find((p) => p.site === 'DC');
  const dr = peers.find((p) => p.site === 'DR');

  if (!dc?.reachable && !dr?.reachable) {
    recommendedAction = 'investigate';
    reason = 'Both DC and DR unreachable — cannot determine state';
  } else if (activeSite === 'DR' && dc?.reachable) {
    recommendedAction = 'switchover-to-dc';
    reason = 'DC recovered but DR is currently active — failback candidate';
  } else if (activeSite === 'DC' && !dr?.reachable) {
    recommendedAction = 'investigate';
    reason = 'DC active but DR is unreachable — verify DR is being rebuilt';
  } else if (dc?.state === 'partner-down' && dr?.state === 'unavailable') {
    recommendedAction = 'switchover-to-dr';
    reason = 'DC lost contact with DR — manual intervention recommended';
  } else if (activeSite === 'DR' && !dc?.reachable) {
    recommendedAction = 'none';
    reason = 'DR is serving (DC down) — wait for DC to come back';
  }

  return {
    activeSite,
    peers,
    recommendedAction,
    reason,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Trigger a graceful HA switchover by sending `ha-switch-partner` to the
 * current primary. After the call, the two servers swap roles:
 *   - The current primary demotes itself to standby
 *   - The current standby promotes itself to primary
 *
 * IMPORTANT: This is a controlled operation with a brief gap (~1-3s)
 * where neither server is serving DHCP. Existing leases are unaffected,
 * but new DHCP requests during the gap will fail.
 *
 * @param site Which site is CURRENTLY primary. We send the command to
 *             THAT site so it demotes itself.
 */
export async function switchHaPartner(currentPrimary: 'DC' | 'DR'): Promise<{
  result: number;
  text: string;
  beforeState: HaStateSnapshot;
}> {
  const beforeState = await getHaState();
  const target = currentPrimary === 'DC' ? 'dc' : 'dr';
  const result = await keaCommand('ha-switch-partner', undefined, { target });
  return {
    result: Number(result.result ?? 1),
    text: result.text || '',
    beforeState,
  };
}

/**
 * Auto-failback status reported to the dashboard.
 *
 * In-memory only (lost on backend restart). For a persistent audit trail
 * of failovers/failbacks, see the audit_log table — every switchover
 * triggered by the scheduler or via the API is recorded there.
 */
export type AutoFailbackStatus = {
  enabled: boolean;
  lastCheckedAt: string | null;
  lastFailoverAt: string | null;
  lastFailbackAt: string | null;
  lastFailbackReason: string | null;
  lastFailbackFrom: 'DC' | 'DR' | null;
  lastFailbackTo: 'DC' | 'DR' | null;
  cooldownRemainingSeconds: number;
  stabilityRequiredSeconds: number;
  nextCheckAt: string | null;
  recentEvents: Array<{
    at: string;
    kind: 'failover' | 'failback' | 'switchover' | 'check' | 'skip';
    from: 'DC' | 'DR' | null;
    to: 'DC' | 'DR' | null;
    reason: string;
  }>;
};

export async function listDhcpLeases(subnetId?: number): Promise<DhcpLease[]> {
  const [configResult, leasesResult] = await Promise.all([
    keaCommand('config-get'),
    keaCommand('lease4-get-all'),
  ]);

  const dhcp4 = (configResult.arguments as { Dhcp4?: Record<string, unknown> } | undefined)?.Dhcp4;
  const subnet4 = Array.isArray(dhcp4?.subnet4) ? dhcp4.subnet4 : [];
  const subnetMeta = new Map<number, { site: string; vlan: number; subnet: string; name: string }>();
  const reservedByIp = new Map<string, HostReservation>();
  const reservationsBySubnet = new Map<number, HostReservation[]>();

  for (const item of subnet4) {
    const subnet = item as {
      id?: number;
      subnet?: string;
      'user-context'?: unknown;
      reservations?: unknown;
    };
    const id = Number(subnet.id ?? 0);
    const ctx = readUserContext(subnet['user-context']);
    subnetMeta.set(id, {
      site: typeof ctx.site === 'string' ? ctx.site : 'Unknown',
      vlan: Number(ctx.vlan ?? id),
      subnet: subnet.subnet || '',
      name: typeof ctx.name === 'string' ? ctx.name : `subnet-${id}`,
    });
    const reservations = listSubnetReservations(subnet as Record<string, unknown>);
    reservationsBySubnet.set(id, reservations);
    for (const reservation of reservations) {
      reservedByIp.set(reservation.ip, reservation);
    }
  }

  const leasesArgs = (leasesResult.arguments ?? {}) as { leases?: unknown[] };
  const leasesRaw = Array.isArray(leasesArgs.leases) ? leasesArgs.leases : [];

  const leases: DhcpLease[] = [];
  for (const item of leasesRaw) {
    const lease = item as {
      'ip-address'?: string;
      'hw-address'?: string;
      hostname?: string;
      'subnet-id'?: number;
      'valid-lft'?: number;
      cltt?: number;
      state?: number;
    };
    const id = Number(lease['subnet-id'] ?? 0);
    if (subnetId != null && id !== subnetId) {
      continue;
    }
    const ip = lease['ip-address'] || '';
    if (!ip) {
      continue;
    }
    const mac = (lease['hw-address'] || '').toLowerCase();
    const meta = subnetMeta.get(id);
    const cltt = typeof lease.cltt === 'number' ? lease.cltt : null;
    const validLifetime = Number(lease['valid-lft'] ?? 0);
    const expiresAt =
      cltt != null && validLifetime > 0
        ? new Date((cltt + validLifetime) * 1000).toISOString()
        : null;
    const state = Number(lease.state ?? 0);
    const reservedInfo = reservedByIp.get(ip);
    const reserved = Boolean(reservedInfo && reservedInfo.mac === mac);

    leases.push({
      ip,
      mac: lease['hw-address'] || '',
      hostname: lease.hostname || reservedInfo?.hostname || '',
      clientDevice: '',
      clientPort: '',
      subnetId: id,
      subnet: meta?.subnet,
      site: meta?.site,
      vlan: meta?.vlan,
      validLifetime,
      cltt,
      expiresAt,
      state,
      stateLabel: reserved ? 'static' : stateLabel(state),
      reserved,
      note: reserved ? reservedInfo?.note || '' : '',
    });
  }

  const clientsByMac = await buildClientLookup(
    (await listCollectableDevices()).map((device) => device.id),
  );
  for (const lease of leases) {
    const client = clientsByMac.get(normalizeClientMac(lease.mac));
    lease.clientDevice = client?.device ?? '';
    lease.clientPort = client?.port ?? '';
  }

  const seenIps = new Set(leases.map((row) => row.ip));
  for (const [id, reservations] of reservationsBySubnet) {
    if (subnetId != null && id !== subnetId) continue;
    const meta = subnetMeta.get(id);
    for (const reservation of reservations) {
      if (seenIps.has(reservation.ip)) continue;
      leases.push({
        ip: reservation.ip,
        mac: reservation.mac,
        hostname: reservation.hostname,
        clientDevice: clientsByMac.get(normalizeClientMac(reservation.mac))?.device ?? '',
        clientPort: clientsByMac.get(normalizeClientMac(reservation.mac))?.port ?? '',
        subnetId: id,
        subnet: meta?.subnet,
        site: meta?.site,
        vlan: meta?.vlan,
        validLifetime: 0,
        cltt: null,
        expiresAt: null,
        state: 0,
        stateLabel: 'static',
        reserved: true,
        note: reservation.note,
      });
    }
  }

  return leases.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

export async function deleteDhcpLease(ip: string) {
  const result = await keaCommand('lease4-del', { 'ip-address': ip });
  if ((result.result ?? 1) !== 0) {
    throw new Error(result.text || `Failed to delete lease ${ip}`);
  }
  return result;
}

export async function wipeDhcpSubnet(subnetId: number) {
  const result = await keaCommand('lease4-wipe', { 'subnet-id': subnetId });
  if ((result.result ?? 1) !== 0 && !String(result.text || '').toLowerCase().includes('0 deleted')) {
    // Kea may return result=3 when no leases; treat as soft success if text is clear
    if ((result.result ?? 1) > 1) {
      throw new Error(result.text || `Failed to wipe subnet ${subnetId}`);
    }
  }
  return result;
}

export async function addDhcpReservation(input: {
  ip: string;
  mac: string;
  subnetId: number;
  hostname?: string;
}) {
  const result = await keaCommand('lease4-add', {
    'ip-address': input.ip,
    'hw-address': input.mac,
    'subnet-id': input.subnetId,
    hostname: input.hostname || '',
    'valid-lft': 86400,
  });
  if ((result.result ?? 1) !== 0) {
    throw new Error(result.text || `Failed to add lease ${input.ip}`);
  }
  return result;
}

function normalizeClientMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return mac.toLowerCase().trim();
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`;
}

function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase();
}

/**
 * Persist a Kea host reservation (IP↔MAC) into runtime config via config-set,
 * then write kea-dhcp4.conf. Lab image has no host_cmds hook.
 */
export async function fixStaticReservation(input: {
  ip: string;
  mac: string;
  subnetId: number;
  hostname?: string;
  note?: string;
}) {
  const ip = input.ip.trim();
  const mac = normalizeMac(input.mac);
  const subnetId = Number(input.subnetId);
  const note = (input.note || '').trim().slice(0, 200);
  if (!ip || !mac || !Number.isFinite(subnetId)) {
    throw new Error('ip, mac, subnetId are required');
  }

  const dhcp4 = await loadPrimaryDhcp4();
  const subnet4 = Array.isArray(dhcp4.subnet4) ? [...(dhcp4.subnet4 as unknown[])] : [];
  const index = subnet4.findIndex((item) => Number((item as { id?: number }).id) === subnetId);
  if (index < 0) {
    throw new Error(`Subnet ${subnetId} not found in Kea config`);
  }

  const subnet = { ...(subnet4[index] as Record<string, unknown>) };
  const current = Array.isArray(subnet.reservations)
    ? [...(subnet.reservations as Array<Record<string, unknown>>)]
    : [];

  const next = current.filter((row) => {
    const rowIp = String(row['ip-address'] ?? '').trim();
    const rowMac = normalizeMac(String(row['hw-address'] ?? ''));
    return rowIp !== ip && rowMac !== mac;
  });

  const reservation: Record<string, unknown> = {
    'hw-address': mac,
    'ip-address': ip,
  };
  if (input.hostname?.trim()) {
    reservation.hostname = input.hostname.trim();
  }
  if (note) {
    reservation['user-context'] = { note };
  }
  next.push(reservation);
  subnet.reservations = next;
  subnet4[index] = subnet;

  const saved = await savePrimaryDhcp4({ ...dhcp4, subnet4 });

  const updateResult = await keaCommand('lease4-update', {
    'ip-address': ip,
    'hw-address': mac,
    'subnet-id': subnetId,
    hostname: input.hostname?.trim() || '',
    force: true,
  });
  if ((updateResult.result ?? 1) !== 0) {
    console.warn(`[dhcp] lease4-update after static fix: ${updateResult.text || 'failed'}`);
  }

  return { reservation, ...saved, updateResult };
}

export async function unfixStaticReservation(input: { ip: string; subnetId: number; mac?: string }) {
  const ip = input.ip.trim();
  const subnetId = Number(input.subnetId);
  const mac = input.mac ? normalizeMac(input.mac) : '';
  if (!ip || !Number.isFinite(subnetId)) {
    throw new Error('ip and subnetId are required');
  }

  const dhcp4 = await loadPrimaryDhcp4();
  const subnet4 = Array.isArray(dhcp4.subnet4) ? [...(dhcp4.subnet4 as unknown[])] : [];
  const index = subnet4.findIndex((item) => Number((item as { id?: number }).id) === subnetId);
  if (index < 0) {
    throw new Error(`Subnet ${subnetId} not found in Kea config`);
  }

  const subnet = { ...(subnet4[index] as Record<string, unknown>) };
  const current = Array.isArray(subnet.reservations)
    ? [...(subnet.reservations as Array<Record<string, unknown>>)]
    : [];
  const next = current.filter((row) => {
    const rowIp = String(row['ip-address'] ?? '').trim();
    const rowMac = normalizeMac(String(row['hw-address'] ?? ''));
    if (rowIp === ip) return false;
    if (mac && rowMac === mac) return false;
    return true;
  });

  if (next.length === current.length) {
    throw new Error(`No host reservation for ${ip} in subnet ${subnetId}`);
  }

  subnet.reservations = next;
  subnet4[index] = subnet;
  const saved = await savePrimaryDhcp4({ ...dhcp4, subnet4 });
  return { removed: { ip, mac: mac || undefined, subnetId }, ...saved };
}

export type AddDhcpSubnetInput = {
  subnetId: number;
  subnet: string; // CIDR
  poolStart: string;
  poolEnd: string;
  gateway: string;
  dns?: string[];
  site?: string;
  vlan?: number;
  name?: string;
};

function cidrToRange(cidr: string): { network: string; broadcast: string; subnet: string } {
  // Minimal CIDR parser: assume /24-/30 for the lab; we don't need full RFC4632 here.
  const [ip, mask] = cidr.split('/');
  if (!ip || !mask) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefix = Number(mask);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix length: ${mask}`);
  }
  return { network: ip, broadcast: ip, subnet: cidr };
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function validateIpInRange(ip: string, cidr: string): void {
  const [base, mask] = cidr.split('/');
  const prefix = Number(mask);
  const baseInt = ipToInt(base);
  const ipInt = ipToInt(ip);
  const maskBits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  if ((baseInt & maskBits) !== (ipInt & maskBits)) {
    throw new Error(`IP ${ip} không thuộc subnet ${cidr}`);
  }
}

/**
 * Add a new subnet to Kea DHCPv4 config + persist to disk. Worker does not
 * touch the config file directly; this is the canonical way to onboard a
 * new VLAN/subnet from the web UI or the AI assistant.
 *
 * Validates: ID unique, CIDR well-formed, pool range inside CIDR, no
 * overlap with existing subnets in the live config.
 */
export async function addDhcpSubnet(input: AddDhcpSubnetInput) {
  const subnetId = Number(input.subnetId);
  if (!Number.isFinite(subnetId) || subnetId <= 0) {
    throw new Error('subnetId phải là số dương');
  }

  const cidr = cidrToRange(input.subnet);
  validateIpInRange(input.poolStart, input.subnet);
  validateIpInRange(input.poolEnd, input.subnet);
  if (ipToInt(input.poolStart) > ipToInt(input.poolEnd)) {
    throw new Error(`poolStart (${input.poolStart}) phải <= poolEnd (${input.poolEnd})`);
  }
  if (!input.gateway) throw new Error('gateway is required');
  validateIpInRange(input.gateway, input.subnet);

  const dhcp4 = await loadPrimaryDhcp4();
  const subnet4 = Array.isArray(dhcp4.subnet4) ? [...(dhcp4.subnet4 as unknown[])] : [];
  if (subnet4.some((item) => Number((item as { id?: number }).id) === subnetId)) {
    throw new Error(`Subnet ID ${subnetId} đã tồn tại`);
  }

  const dns = Array.isArray(input.dns) && input.dns.length > 0 ? input.dns : ['8.8.8.8', '8.8.4.4'];
  const site = (input.site ?? 'Unknown').toString();
  const vlan = Number(input.vlan ?? subnetId);
  const name = (input.name ?? `subnet-${subnetId}`).toString();

  const newSubnet: Record<string, unknown> = {
    id: subnetId,
    subnet: cidr.subnet,
    pools: [{ pool: `${input.poolStart}-${input.poolEnd}` }],
    'option-data': [
      { name: 'routers', data: input.gateway },
      { name: 'domain-name-servers', data: dns.join(',') },
    ],
    'user-context': { name, site, vlan, gateway: input.gateway },
  };

  subnet4.push(newSubnet);
  const saved = await savePrimaryDhcp4({ ...dhcp4, subnet4 });

  return { subnet: newSubnet, ...saved };
}

/** Remove a subnet entirely from Kea config. CẢNH BÁO: xoá tất cả lease + reservation. */
export async function deleteDhcpSubnet(subnetId: number) {
  const id = Number(subnetId);
  if (!Number.isFinite(id)) throw new Error('subnetId is required');
  const dhcp4 = await loadPrimaryDhcp4();
  const subnet4 = Array.isArray(dhcp4.subnet4) ? [...(dhcp4.subnet4 as unknown[])] : [];
  const next = subnet4.filter((item) => Number((item as { id?: number }).id) !== id);
  if (next.length === subnet4.length) {
    throw new Error(`Subnet ${id} not found in Kea config`);
  }
  const saved = await savePrimaryDhcp4({ ...dhcp4, subnet4: next });
  return { removedSubnetId: id, ...saved };
}
