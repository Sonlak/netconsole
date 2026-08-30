export type KeaCommandResult = {
  result?: number;
  text?: string;
  arguments?: Record<string, unknown>;
};

function getPrimaryUrl() {
  return (process.env.KEA_API_URL || 'http://127.0.0.1:8001/').replace(/\/?$/, '/');
}

function getStandbyUrl() {
  return (process.env.KEA_STANDBY_API_URL || 'http://127.0.0.1:8002/').replace(/\/?$/, '/');
}

function timeoutMs() {
  return Number(process.env.KEA_TIMEOUT_MS) || 5000;
}

export async function keaCommand(
  command: string,
  argumentsPayload?: Record<string, unknown>,
  options?: { target?: 'primary' | 'standby' | 'auto' },
): Promise<KeaCommandResult> {
  const target = options?.target ?? 'auto';
  const urls =
    target === 'standby'
      ? [getStandbyUrl()]
      : target === 'primary'
        ? [getPrimaryUrl()]
        : [getPrimaryUrl(), getStandbyUrl()];

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
  role: string;
  url: string;
  reachable: boolean;
  state?: string;
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

  const peers: DhcpHaPeer[] = [
    {
      name: 'kea-primary',
      role: 'primary',
      url: getPrimaryUrl(),
      reachable: Boolean(haPrimary && (haPrimary.result ?? 1) === 0),
      state: String((haPrimary?.arguments as { state?: string } | undefined)?.state || ''),
    },
    {
      name: 'kea-standby',
      role: 'standby',
      url: getStandbyUrl(),
      reachable: Boolean(haStandby && (haStandby.result ?? 1) === 0),
      state: String((haStandby?.arguments as { state?: string } | undefined)?.state || ''),
    },
  ];

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
      active:
        peers.find((peer) => peer.reachable && peer.role === 'primary')?.name ||
        peers.find((peer) => peer.reachable)?.name ||
        null,
    },
    totals: {
      sites: sites.length,
      pools: pools.length,
      leased: pools.reduce((sum, pool) => sum + pool.leased, 0),
      poolSize: pools.reduce((sum, pool) => sum + pool.poolSize, 0),
    },
  };
}

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
