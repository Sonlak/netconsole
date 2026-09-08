/** IOS-XE RESTCONF client — mirrors the pattern in junosRest.ts.
 *
 *  Backend calls device RESTCONF directly (no job queue) for read operations.
 *  Write operations (apply_config, interface_action) stay on the job queue
 *  and are handled by the worker via SSH/NETCONF.
 *
 *  Caveats:
 *  - ARP table YANG (`Cisco-IOS-XE-arp-oper:arp-data`) is often empty on lab
 *    images even when the ARP table is populated — backend will fall back to
 *    the job queue so the worker (which has SSH) can collect via CLI.
 *  - MAC table has no stable YANG model on IOS-XE — backend always falls
 *    back to the job queue for MAC.
 *  - Interface list via `ietf-interfaces:interfaces` is sparse (no MTU/speed
 *    on some images) but usable.
 */

function iosxeRestEnabled(): boolean {
  return process.env.IOSXE_API_ENABLED === 'true';
}

function iosxeConfig() {
  return {
    scheme: process.env.IOSXE_API_SCHEME || 'https',
    port: Number(process.env.IOSXE_API_PORT ?? 443),
    verifyTls: process.env.IOSXE_API_VERIFY_TLS !== 'true', // default true = skip cert verify for lab
    username: process.env.IOSXE_API_USER || process.env.LAB_SSH_USER || 'admin',
    password: process.env.IOSXE_API_PASSWORD || process.env.LAB_SSH_PASSWORD || 'Admin@123',
  };
}

type IosxeArpEntry = {
  ip: string;
  mac: string;
  hostname: string;
  interface: string;
  flags: string;
};

type IosxeMacEntry = {
  mac: string;
  vlan: string;
  tag: string;
  interface: string;
  flags: string;
  type: string;
  sessId: string;
};

type IosxeInterfaceEntry = {
  name: string;
  adminStatus: string;
  operStatus: string;
  description: string;
  mode: string;
  accessVlan: string;
  address: string;
  mtu: string;
  speed: string;
};

async function rcGet(
  host: string,
  path: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; payload: unknown; raw: string; error?: string; status?: number }> {
  const cfg = iosxeConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/restconf/data${path}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/yang-data+json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, payload: null, raw, error: `HTTP ${response.status}`, status: response.status };
    }
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    return { ok: true, payload, raw, status: response.status };
  } catch (error) {
    return {
      ok: false,
      payload: null,
      raw: '',
      error: error instanceof Error ? error.message : 'IOS-XE RESTCONF failed',
    };
  }
}

function normalizeMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return mac;
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`.toLowerCase();
}

function parseIosxeArpEntries(payload: unknown): IosxeArpEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const arpData = record['Cisco-IOS-XE-arp-oper:arp-data'];
  if (!arpData || typeof arpData !== 'object') return [];
  const dataObj = arpData as Record<string, unknown>;
  const entries = Array.isArray(dataObj['arp-entry']) ? dataObj['arp-entry'] : [dataObj['arp-entry']].filter(Boolean);
  const result: IosxeArpEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const ip = String(e.address ?? '').trim();
    const macRaw = String(e.hardware ?? e.mac ?? '').trim();
    const mac = normalizeMac(macRaw);
    if (!ip || !mac) continue;
    // Skip loopback / link-local
    if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
    result.push({
      ip,
      mac,
      hostname: String(e.hostname ?? ip),
      interface: String(e.interface ?? '-'),
      flags: 'none',
    });
  }
  return result;
}

function parseIosxeInterfaceEntries(payload: unknown): IosxeInterfaceEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const ifacesData = record['ietf-interfaces:interfaces'];
  if (!ifacesData || typeof ifacesData !== 'object') return [];
  const ifacesObj = ifacesData as Record<string, unknown>;
  const ifaces = Array.isArray(ifacesObj['interface']) ? ifacesObj['interface'] : [ifacesObj['interface']].filter(Boolean);
  const result: IosxeInterfaceEntry[] = [];
  for (const iface of ifaces) {
    if (!iface || typeof iface !== 'object') continue;
    const i = iface as Record<string, unknown>;
    const name = String(i.name ?? '');
    if (!name) continue;
    const enabled = i.enabled;
    const admin = enabled === false ? 'down' : 'up';
    const oper = i['oper-status'] ? String(i['oper-status']) : admin;
    result.push({
      name,
      adminStatus: admin,
      operStatus: oper,
      description: String(i.description ?? ''),
      mode: '',
      accessVlan: '',
      address: '',
      mtu: String(i['nsci:mtu'] ?? i.mtu ?? ''),
      speed: '', // ietf-interfaces doesn't carry speed
    });
  }
  return result;
}

export async function fetchIosxeArpTable(host: string): Promise<{
  ok: boolean;
  entries: IosxeArpEntry[];
  collectMs: number;
  error?: string;
}> {
  if (!iosxeRestEnabled()) {
    return { ok: false, entries: [], collectMs: 0, error: 'IOSXE_API_ENABLED=false' };
  }
  const started = Date.now();
  const result = await rcGet(host, '/Cisco-IOS-XE-arp-oper:arp-data', 20000);
  if (!result.ok) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: result.error };
  }
  const entries = parseIosxeArpEntries(result.payload);
  // YANG ARP is often empty on lab images — treat empty as "needs SSH fallback"
  if (entries.length === 0) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: 'ARP YANG empty (try SSH fallback via job queue)' };
  }
  return { ok: true, entries, collectMs: Date.now() - started };
}

export async function fetchIosxeMacTable(host: string): Promise<{
  ok: boolean;
  entries: IosxeMacEntry[];
  collectMs: number;
  error?: string;
}> {
  // No stable IOS-XE YANG model for MAC table. Always return empty so the
  // backend falls back to the job queue (worker uses SSH `show mac address-table`).
  return { ok: false, entries: [], collectMs: 0, error: 'No IOS-XE YANG for MAC table (use job queue + SSH fallback)' };
}

export async function fetchIosxeInterfaceList(host: string): Promise<{
  ok: boolean;
  interfaces: IosxeInterfaceEntry[];
  collectMs: number;
  error?: string;
}> {
  if (!iosxeRestEnabled()) {
    return { ok: false, interfaces: [], collectMs: 0, error: 'IOSXE_API_ENABLED=false' };
  }
  const started = Date.now();
  const result = await rcGet(host, '/ietf-interfaces:interfaces', 20000);
  if (!result.ok) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: result.error };
  }
  const interfaces = parseIosxeInterfaceEntries(result.payload);
  if (interfaces.length === 0) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: 'No interfaces in RESTCONF response' };
  }
  return { ok: true, interfaces, collectMs: Date.now() - started };
}
