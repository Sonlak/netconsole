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

/**
 * Fetch the running-config subtree for a single IOS-XE interface.
 *
 * Equivalent to `show running-config interface <name>` but via the structured
 * YANG model (`Cisco-IOS-XE-native`). Returned `config` is a JSON tree so
 * the worker/frontend can format it as needed (the worker renders IOS CLI
 * text from the tree for parity with the SSH-fallback path).
 *
 * This path works from the backend container because it can reach
 * 10.10.20.x; the worker container often can't open outbound connections
 * to lab devices (no NAT/route), so we expose this through the backend and
 * have the worker call back into us instead of SSHing directly.
 */
export async function fetchIosxeInterfaceRunningConfig(
  host: string,
  iface: string,
): Promise<{
  ok: boolean;
  config: unknown;
  raw: string;
  error?: string;
}> {
  if (!iosxeRestEnabled()) {
    return { ok: false, config: null, raw: '', error: 'IOSXE_API_ENABLED=false' };
  }
  // Split "GigabitEthernet4" → ("GigabitEthernet", "4")
  const m = /^([A-Za-z]+?)(\d.*)$/.exec(iface);
  if (!m) {
    return { ok: false, config: null, raw: '', error: `Cannot parse interface name: ${iface}` };
  }
  const type = m[1];
  const name = m[2];
  const path = `/Cisco-IOS-XE-native:native/interface/${type}=${encodeURIComponent(name)}`;
  const result = await rcGet(host, path, 15000);
  if (!result.ok) {
    return { ok: false, config: null, raw: '', error: result.error };
  }
  return { ok: true, config: result.payload, raw: result.raw };
}

/**
 * Convert the Cisco-IOS-XE-native YANG tree returned by RESTCONF into
 * IOS-CLI-style text so it renders identically to `show running-config
 * interface X`. Best-effort — covers the interface-block keywords we care
 * about (description, switchport, shutdown, spanning-tree, channel-group).
 */
export function iosxeInterfaceConfigToText(tree: unknown, iface: string): string {
  if (!tree || typeof tree !== 'object') return '';
  // Native YANG wraps the interface list under `Cisco-IOS-XE-native:interface`.
  const root = tree as Record<string, unknown>;
  const nativeIface = root['Cisco-IOS-XE-native:interface'];
  if (!nativeIface || typeof nativeIface !== 'object') {
    // ietf-interfaces fallback (sparse)
    return jsonToLines(tree as Record<string, unknown>, `interface ${iface}`, 0);
  }
  const ifaceObj = nativeIface as Record<string, unknown>;
  const firstKey = Object.keys(ifaceObj)[0] ?? '';
  const block =
    (ifaceObj as Record<string, unknown>)['GigabitEthernet'] ??
    (firstKey ? (ifaceObj as Record<string, unknown>)[firstKey] : undefined);
  if (!block) return '';
  const blockObj = block as Record<string, unknown>;
  const entry = Object.values(blockObj)[0] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== 'object') return '';
  const lines: string[] = [`interface ${iface}`];
  walk(entry, lines, 1);
  lines.push('!');
  return lines.join('\n');
}

function walk(node: unknown, lines: string[], depth: number): void {
  if (!node || typeof node !== 'object') {
    if (node !== '' && node !== undefined && node !== null) {
      // append to last line
      lines[lines.length - 1] += ` ${String(node)}`;
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('xmlns')) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      // nested block keyword
      const inner = Object.values(value as Record<string, unknown>);
      if (inner.length === 1 && typeof inner[0] !== 'object') {
        lines.push(`${' '.repeat(depth * 2)}${key} ${inner[0]}`);
      } else {
        lines.push(`${' '.repeat(depth * 2)}${key}`);
        walk(value, lines, depth + 1);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          lines.push(`${' '.repeat(depth * 2)}${key}`);
          walk(item, lines, depth + 1);
        } else {
          lines.push(`${' '.repeat(depth * 2)}${key} ${String(item)}`);
        }
      }
    } else if (typeof value === 'boolean') {
      // IOS-XE presence containers serialize as ""; treat boolean true as presence
      if (value) lines.push(`${' '.repeat(depth * 2)}${key}`);
    } else if (value !== '') {
      lines.push(`${' '.repeat(depth * 2)}${key} ${String(value)}`);
    } else {
      // empty string from YANG = presence container
      lines.push(`${' '.repeat(depth * 2)}${key}`);
    }
  }
}

function jsonToLines(node: Record<string, unknown>, prefix: string, depth: number): string {
  const lines: string[] = [prefix];
  walk(node, lines, depth + 1);
  lines.push('!');
  return lines.join('\n');
}
