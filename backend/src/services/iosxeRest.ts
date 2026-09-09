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
    verifyTls: process.env.IOSXE_API_VERIFY_TLS === 'true', // default false = skip cert verify for lab self-signed
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
 * about (description, switchport, shutdown, spanning-tree, channel-group,
 * ip address, negotiation).
 *
 * Format rules:
 *   - boolean `true` → just the keyword (presence container)
 *   - boolean `false` → skip entirely
 *   - ip.address.primary → `ip address <addr> <mask>` (no indent)
 *   - namespace-prefixed keys → strip prefix before printing
 *   - bare numeric leafs (name) → skip (already shown as interface header)
 */
export function iosxeInterfaceConfigToText(tree: unknown, iface: string): string {
  if (!tree || typeof tree !== 'object') return '';
  const root = tree as Record<string, unknown>;

  // The response wraps the interface block under the type key.
  // Find the first non-namespace key that is itself an object/array.
  const block = Object.entries(root).find(
    ([k]) => !k.includes(':') || k.startsWith('GigabitEthernet'),
  );
  if (!block) return '';
  const entry = (block[1] as Record<string, unknown>) ?? {};
  const data = Array.isArray(entry) ? (entry[0] as Record<string, unknown>) : entry;
  if (!data || typeof data !== 'object') return '';

  const lines: string[] = [`interface ${iface}`];

  for (const [k, v] of Object.entries(data)) {
    if (k === 'name') continue; // already in header
    if (v === null || v === undefined) continue;

    // Strip YANG namespace prefix e.g. "Cisco-IOS-XE-ethernet:negotiation" → "negotiation"
    const key = k.includes(':') ? k.replace(/^[^:]+:/, '') : k;

    if (typeof v === 'boolean') {
      if (v) lines.push(key); // presence container → just the keyword
      continue;
    }
    if (typeof v === 'string' && v !== '') {
      lines.push(`${key} ${v}`);
      continue;
    }
    if (typeof v === 'number') {
      lines.push(`${key} ${v}`);
      continue;
    }
    if (typeof v !== 'object') continue;

    // Handle nested blocks
    if (key === 'ip') {
      const ip = v as Record<string, unknown>;
      const addr = ip['address'] as Record<string, unknown> | undefined;
      if (addr) {
        const primary = addr['primary'] as Record<string, unknown> | undefined;
        if (primary) {
          const ipAddr = String(primary['address'] ?? '');
          const mask = String(primary['mask'] ?? '');
          if (ipAddr && mask) lines.push(`ip address ${ipAddr} ${mask}`);
        }
      }
      // Handle secondary addresses
      const secondary = addr?.['secondary'] as Array<Record<string, unknown>> | undefined;
      if (secondary) {
        for (const sec of secondary) {
          const ipAddr = String(sec['address'] ?? '');
          const mask = String(sec['mask'] ?? '');
          if (ipAddr && mask) lines.push(`ip address ${ipAddr} ${mask} secondary`);
        }
      }
      // Remaining IP options (helper, ospf, etc.) — render as block
      const remaining = {...addr};
      delete remaining['primary'];
      delete remaining['secondary'];
      const leftover = Object.keys(remaining);
      if (leftover.length) {
        lines.push('ip');
        for (const lk of leftover) {
          const lv = (remaining as Record<string, unknown>)[lk];
          if (typeof lv === 'string') lines.push(`  ${lk} ${lv}`);
          else if (typeof lv === 'boolean' && lv) lines.push(`  ${lk}`);
        }
      }
      continue;
    }

    if (key === 'negotiation') {
      const neg = v as Record<string, unknown>;
      const auto = neg['auto'];
      if (typeof auto === 'boolean') {
        lines.push(`negotiation ${auto ? 'auto' : 'auto'}`);
      }
      continue;
    }

    if (key === 'switchport') {
      lines.push('switchport');
      const sw = v as Record<string, unknown>;
      for (const [sk, sv] of Object.entries(sw)) {
        const skClean = sk.includes(':') ? sk.replace(/^[^:]+:/, '') : sk;
        if (typeof sv === 'string' && sv !== '') lines.push(`  ${skClean} ${sv}`);
        else if (typeof sv === 'boolean' && sv) lines.push(`  ${skClean}`);
        else if (Array.isArray(sv)) {
          for (const item of sv as unknown[]) {
            if (typeof item === 'object' && item !== null) {
              const itemObj = item as Record<string, unknown>;
              const vlan = String(itemObj['vlan'] ?? '');
              if (vlan) lines.push(`  ${skClean} vlan ${vlan}`);
              else {
                const val = String(Object.values(itemObj)[0] ?? '');
                if (val) lines.push(`  ${skClean} ${val}`);
              }
            }
          }
        }
      }
      continue;
    }

    if (key === 'description') {
      lines.push(`description ${v}`);
      continue;
    }

    // Generic nested block — render as indented block
    if (typeof v === 'object') {
      lines.push(key);
      const inner = v as Record<string, unknown>;
      for (const [ik, iv] of Object.entries(inner)) {
        const ikClean = ik.includes(':') ? ik.replace(/^[^:]+:/, '') : ik;
        if (typeof iv === 'string' && iv !== '') lines.push(`  ${ikClean} ${iv}`);
        else if (typeof iv === 'boolean' && iv) lines.push(`  ${ikClean}`);
        else if (Array.isArray(iv)) {
          for (const arrItem of iv as unknown[]) {
            if (typeof arrItem === 'object' && arrItem !== null) {
              const arrObj = arrItem as Record<string, unknown>;
              const val = String(Object.values(arrObj)[0] ?? '');
              if (val) lines.push(`  ${ikClean} ${val}`);
            }
          }
        }
      }
    }
  }

  lines.push('!');
  return lines.join('\n');
}
