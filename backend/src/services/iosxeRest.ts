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
 *
 *  IMPORTANT: IOS-XE RESTCONF does NOT expand the `switchport-config`
 *  leafref in the list response (`/native/interface`). The switchport
 *  subtree must be fetched separately via a per-interface request:
 *    GET /restconf/data/Cisco-IOS-XE-native:native/interface/GigabitEthernet=<id>
 *  This function fetches the interface list first (for basic info), then
 *  makes per-interface requests to fetch switchport data (up to 20 concurrent).
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

function parseIosxeNativeInterfaces(payload: unknown): IosxeInterfaceEntry[] {
  /**
   * Parse `Cisco-IOS-XE-native:native/interface` for interface list + switchport config.
   *
   * The native YANG model includes `switchport-config` which carries:
   *   - switchport.mode.access / switchport.mode.trunk
   *   - switchport.access.vlan.vlan (access VLAN number)
   *   - switchport.trunk.allowed.vlan.vlans (trunk allowed VLANs)
   *
   * This is richer than `ietf-interfaces:interfaces` which only has name/enabled/MTU.
   */
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;

  // The response is keyed by interface type (GigabitEthernet, TenGigabitEthernet, etc.)
  // Each key maps to an array of interface instances.
  const result: IosxeInterfaceEntry[] = [];

  for (const [, typeValue] of Object.entries(record)) {
    if (!typeValue || typeof typeValue !== 'object') continue;
    const ifaces = Array.isArray(typeValue) ? typeValue : [typeValue];
    for (const iface of ifaces) {
      if (!iface || typeof iface !== 'object') continue;
      const i = iface as Record<string, unknown>;
      const name = String(i.name ?? '');
      if (!name) continue;

      // Build full interface name: type prefix + name (e.g. "GigabitEthernet1/0/1")
      const typeName = String(Object.keys(record).find(k => record[k] === typeValue) ?? '');
      const fullName = typeName + name;

      // adminStatus from `enabled` leaf
      const enabled = i.enabled;
      const admin = enabled === false ? 'down' : 'up';

      // description from native model
      const description = String(i.description ?? '');

      // Parse switchport-config for mode + VLANs
      // switchport-config is a leafref to Cisco-IOS-XE-switch:switchport.
      // YANG paths (verified against Cisco-IOS-XE-switch.yang rev 2021-07-01):
      //   Mode:  mode.access  (presence container = access mode)
      //          mode.trunk   (presence container = trunk mode)
      //   Access VLAN:  access.vlan.vlan  (uint16, e.g. 10)
      //   Trunk VLANs:  trunk.allowed.vlan.vlans  (string, e.g. "1,2,10")
      //                 trunk.native.vlan.vlan-id  (uint16, native VLAN)
      let mode = '';
      let accessVlan = '';
      const swConfig = (i as Record<string, unknown>)['switchport-config'] as Record<string, unknown> | undefined;
      if (swConfig && typeof swConfig === 'object') {
        // switchport-config dereferences to the Cisco-IOS-XE-switch:switchport subtree
        const sw = swConfig['switchport'] as Record<string, unknown> | undefined;
        // Also check with namespace prefix (some IOS-XE versions include it)
        const swNs = (swConfig['Cisco-IOS-XE-switch:switchport'] ||
                      swConfig['switchport']) as Record<string, unknown> | undefined;
        const swEffective = (sw && typeof sw === 'object') ? sw :
                           (swNs && typeof swNs === 'object') ? swNs : null;
        if (swEffective) {
          // Mode: access or trunk (presence containers inside mode choice)
          const modeObj = (swEffective['mode'] ||
                          swEffective['Cisco-IOS-XE-switch:mode']) as Record<string, unknown> | undefined;
          if (modeObj && typeof modeObj === 'object') {
            if ('access' in modeObj) mode = 'access';
            else if ('trunk' in modeObj) mode = 'trunk';
            // Also check namespace-prefixed keys (some IOS-XE versions)
            else if ('Cisco-IOS-XE-switch:access' in modeObj) mode = 'access';
            else if ('Cisco-IOS-XE-switch:trunk' in modeObj) mode = 'trunk';
          }

          // Access VLAN — always extract (even VLAN 1) so the frontend shows it
          const accessObj = (swEffective['access'] ||
                            swEffective['Cisco-IOS-XE-switch:access']) as Record<string, unknown> | undefined;
          if (accessObj && typeof accessObj === 'object') {
            const vlanObj = (accessObj['vlan'] ||
                            accessObj['Cisco-IOS-XE-switch:vlan']) as Record<string, unknown> | undefined;
            if (vlanObj && typeof vlanObj === 'object') {
              const vlanNum = vlanObj['vlan'];
              if (vlanNum !== undefined && vlanNum !== null) {
                accessVlan = String(vlanNum);
              }
            }
          }

          // Trunk VLANs — extract when mode is trunk
          if (mode === 'trunk') {
            const trunkObj = (swEffective['trunk'] ||
                            swEffective['Cisco-IOS-XE-switch:trunk']) as Record<string, unknown> | undefined;
            if (trunkObj && typeof trunkObj === 'object') {
              const allowedObj = (trunkObj['allowed'] ||
                                trunkObj['Cisco-IOS-XE-switch:allowed']) as Record<string, unknown> | undefined;
              if (allowedObj && typeof allowedObj === 'object') {
                const vlanObj = (allowedObj['vlan'] ||
                                allowedObj['Cisco-IOS-XE-switch:vlan']) as Record<string, unknown> | undefined;
                if (vlanObj && typeof vlanObj === 'object') {
                  const vlans = vlanObj['vlans'];
                  if (vlans !== undefined && vlans !== null) {
                    accessVlan = String(vlans);
                  }
                }
              }
              // Also include native VLAN in trunk display
              const nativeObj = (trunkObj['native'] ||
                               trunkObj['Cisco-IOS-XE-switch:native']) as Record<string, unknown> | undefined;
              if (nativeObj && typeof nativeObj === 'object') {
                const nativeVlanId = nativeObj['vlan-id'];
                if (nativeVlanId !== undefined && nativeVlanId !== null && String(nativeVlanId) !== '1') {
                  // Append native VLAN to allowed VLANs if not already present
                  const nativeStr = String(nativeVlanId);
                  if (accessVlan && !accessVlan.split(',').includes(nativeStr)) {
                    accessVlan = `${nativeStr},${accessVlan}`;
                  }
                }
              }
            }
          }
        }
      }

      result.push({
        name: fullName,
        adminStatus: admin,
        operStatus: admin, // operStatus not in native model — use admin as proxy
        description,
        mode,
        accessVlan,
        address: '',
        mtu: String(i.mtu ?? ''),
        speed: '',
      });
    }
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

  // PASS 1: Get the interface list — gives us name, description, enabled, MTU
  const listResult = await rcGet(host, '/Cisco-IOS-XE-native:native/interface', 20000);
  if (!listResult.ok) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: listResult.error };
  }
  const basicInterfaces = parseIosxeNativeInterfaces(listResult.payload);
  if (basicInterfaces.length === 0) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: 'No interfaces in RESTCONF response' };
  }

  // PASS 2: Fetch switchport config for each interface (per-interface request).
  // IOS-XE RESTCONF does NOT expand the switchport-config leafref in the
  // list response. We must ask for each interface individually.
  // Run up to 20 concurrent requests to avoid overwhelming the device.
  const BATCH = 20;
  for (let i = 0; i < basicInterfaces.length; i += BATCH) {
    const batch = basicInterfaces.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (iface) => {
        // Split "GigabitEthernet4" → ("GigabitEthernet", "4")
        const m = /^([A-Za-z]+?)(\d.*)$/.exec(iface.name);
        if (!m) return { name: iface.name, swData: null };
        const type = m[1];
        const name = m[2];
        const path = `/Cisco-IOS-XE-native:native/interface/${type}=${encodeURIComponent(name)}`;
        const r = await rcGet(host, path, 10000);
        if (!r.ok) return { name: iface.name, swData: null };
        return { name: iface.name, swData: r.payload };
      }),
    );
    for (const br of batchResults) {
      if (!br.swData) continue;
      // Find the matching interface in basicInterfaces
      const match = basicInterfaces.find((b) => b.name === br.name);
      if (!match) continue;
      // Parse switchport from the per-interface response
      const sw = parseSwitchportFromInterfaceResponse(br.swData);
      if (sw) {
        match.mode = sw.mode;
        match.accessVlan = sw.accessVlan;
      }
    }
  }

  return { ok: true, interfaces: basicInterfaces, collectMs: Date.now() - started };
}

/**
 * Parse switchport mode + VLAN from a per-interface RESTCONF response.
 *
 * The per-interface response looks like:
 * {
 *   "Cisco-IOS-XE-native:GigabitEthernet": {
 *     "id": "4",
 *     "name": "4",
 *     "description": "uplink",
 *     "shutdown": false,
 *     "switchport-config": {
 *       "switchport": {
 *         "mode": { "access": {} }  ← presence container
 *         "access": { "vlan": { "vlan": 10 } }
 *       }
 *     }
 *   }
 * }
 *
 * We look for `switchport-config.switchport` and extract mode + VLANs.
 */
function parseSwitchportFromInterfaceResponse(payload: unknown): { mode: string; accessVlan: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  // The response wraps the interface block under the type key
  for (const [, value] of Object.entries(root)) {
    if (!value || typeof value !== 'object') continue;
    const block = value as Record<string, unknown>;
    const swConfig = block['switchport-config'] as Record<string, unknown> | undefined;
    if (!swConfig || typeof swConfig !== 'object') continue;
    // Dereference the switchport-config leafref
    const sw = swConfig['switchport'] as Record<string, unknown> | undefined;
    const swNs = swConfig['Cisco-IOS-XE-switch:switchport'] as Record<string, unknown> | undefined;
    const swEffective = (sw && typeof sw === 'object') ? sw : (swNs && typeof swNs === 'object') ? swNs : null;
    if (!swEffective) continue;

    let mode = '';
    let accessVlan = '';

    // Mode: access or trunk (presence containers inside mode choice)
    const modeObj = (swEffective['mode'] ||
      swEffective['Cisco-IOS-XE-switch:mode']) as Record<string, unknown> | undefined;
    if (modeObj && typeof modeObj === 'object') {
      if ('access' in modeObj) mode = 'access';
      else if ('trunk' in modeObj) mode = 'trunk';
      else if ('Cisco-IOS-XE-switch:access' in modeObj) mode = 'access';
      else if ('Cisco-IOS-XE-switch:trunk' in modeObj) mode = 'trunk';
    }

    // Access VLAN — always extract (even VLAN 1)
    const accessObj = (swEffective['access'] ||
      swEffective['Cisco-IOS-XE-switch:access']) as Record<string, unknown> | undefined;
    if (accessObj && typeof accessObj === 'object') {
      const vlanObj = (accessObj['vlan'] ||
        accessObj['Cisco-IOS-XE-switch:vlan']) as Record<string, unknown> | undefined;
      if (vlanObj && typeof vlanObj === 'object') {
        const vlanNum = vlanObj['vlan'];
        if (vlanNum !== undefined && vlanNum !== null) {
          accessVlan = String(vlanNum);
        }
      }
    }

    // Trunk VLANs — extract when mode is trunk
    if (mode === 'trunk') {
      const trunkObj = (swEffective['trunk'] ||
        swEffective['Cisco-IOS-XE-switch:trunk']) as Record<string, unknown> | undefined;
      if (trunkObj && typeof trunkObj === 'object') {
        const allowedObj = (trunkObj['allowed'] ||
          trunkObj['Cisco-IOS-XE-switch:allowed']) as Record<string, unknown> | undefined;
        if (allowedObj && typeof allowedObj === 'object') {
          const vlanObj = (allowedObj['vlan'] ||
            allowedObj['Cisco-IOS-XE-switch:vlan']) as Record<string, unknown> | undefined;
          if (vlanObj && typeof vlanObj === 'object') {
            const vlans = vlanObj['vlans'];
            if (vlans !== undefined && vlans !== null) {
              accessVlan = String(vlans);
            }
          }
        }
        // Native VLAN
        const nativeObj = (trunkObj['native'] ||
          trunkObj['Cisco-IOS-XE-switch:native']) as Record<string, unknown> | undefined;
        if (nativeObj && typeof nativeObj === 'object') {
          const nativeVlanId = nativeObj['vlan-id'];
          if (nativeVlanId !== undefined && nativeVlanId !== null && String(nativeVlanId) !== '1') {
            const nativeStr = String(nativeVlanId);
            if (accessVlan && !accessVlan.split(',').includes(nativeStr)) {
              accessVlan = `${nativeStr},${accessVlan}`;
            }
          }
        }
      }
    }

    if (mode || accessVlan) {
      return { mode, accessVlan };
    }
  }
  return null;
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

  // The response wraps the interface block under the type key. The key
  // is a fully-qualified YANG element name like
  // `Cisco-IOS-XE-native:GigabitEthernet`. Just take the first object/
  // array value — there is only one.
  const block = Object.entries(root).find(
    ([, v]) => v && (typeof v === 'object'),
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

/**
 * Probe an IOS-XE device over RESTCONF to extract identity (hostname, vendor,
 * model, version, serial). Used by the discovery scanner so that non-Juniper
 * devices can be marked as `DISCOVERED` and then synced into inventory.
 *
 * Tries two YANG paths in order:
 *   1. `/Cisco-IOS-XE-device-hardware-oper:device-hardware-data` — serial /
 *      model / version (Cisco-specific, well-supported on IOS-XE 16+).
 *   2. `/ietf-system:system` — hostname (RFC 7317 standardized).
 *
 * Either path may be missing on older images; we accept partial identity as
 * long as at least one of hostname / serial / model is present.
 *
 * Gated on `IOSXE_API_ENABLED=true`. Returns ok=false immediately when the
 * flag is off so the parallel fan-out in `discoveryScan.ts` can skip us.
 */
export async function probeIosxeRestIdentity(host: string): Promise<{
  ok: boolean;
  fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } | null;
  raw?: string;
  error?: string;
}> {
  if (!iosxeRestEnabled()) {
    return { ok: false, fields: null, error: 'IOSXE_API_ENABLED=false' };
  }

  const fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } = {
    vendor: 'Cisco',
  };
  const rawParts: string[] = [];

  // Hardware YANG for serial / model / version
  const hw = await rcGet(host, '/Cisco-IOS-XE-device-hardware-oper:device-hardware-data', 15000);
  if (hw.raw) rawParts.push(hw.raw);
  if (hw.ok && hw.payload && typeof hw.payload === 'object') {
    const record = hw.payload as Record<string, unknown>;
    // The response may be wrapped in the YANG namespace key or sit at the top
    // level depending on the IOS-XE image.
    let data: unknown = record['Cisco-IOS-XE-device-hardware-oper:device-hardware-data'] ?? record;
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      // Try several common shapes (device-hardware list, device-data list, or a single record).
      const candidates: unknown[] = [];
      if (Array.isArray(obj['device-hardware'])) candidates.push(...(obj['device-hardware'] as unknown[]));
      else if (obj['device-hardware']) candidates.push(obj['device-hardware']);
      if (Array.isArray(obj['device-data'])) candidates.push(...(obj['device-data'] as unknown[]));
      else if (obj['device-data']) candidates.push(obj['device-data']);
      if (candidates.length === 0) candidates.push(obj);

      for (const entry of candidates) {
        if (!entry || typeof entry !== 'object') continue;
        const f = entry as Record<string, unknown>;
        if (!fields.serial) {
          const serial = f['device-serial-number'] ?? f['serial-number'] ?? f['serialNumber'];
          if (serial) fields.serial = String(serial).trim();
        }
        if (!fields.version) {
          const version = f['device-version'] ?? f['version'] ?? f['os-version'];
          if (version) fields.version = String(version).trim();
        }
        if (!fields.model) {
          const model = f['device-type'] ?? f['device-model'] ?? f['model'] ?? f['model-name'];
          if (model) fields.model = String(model).trim();
        }
        if (fields.serial && fields.version && fields.model) break;
      }
    }
  }

  // ietf-system:system for hostname (RFC 7317)
  const sys = await rcGet(host, '/ietf-system:system', 15000);
  if (sys.raw) rawParts.push(sys.raw);
  if (sys.ok && sys.payload && typeof sys.payload === 'object') {
    const record = sys.payload as Record<string, unknown>;
    let sysData: unknown = record['ietf-system:system'] ?? record;
    if (sysData && typeof sysData === 'object') {
      const hostname = (sysData as Record<string, unknown>)['hostname'];
      if (typeof hostname === 'string') {
        const trimmed = hostname.trim();
        if (trimmed) fields.hostname = trimmed;
      }
    }
  }

  const ok = Boolean(fields.hostname || fields.serial || fields.model);
  if (!ok) {
    return { ok: false, fields: null, raw: rawParts.join('\n'), error: 'IOS-XE RESTCONF identity empty' };
  }

  return { ok: true, fields, raw: rawParts.join('\n') };
}

/**
 * Probe a Cisco IOS / IOS-XE device over its legacy HTTPS server's exec
 * endpoint to extract identity. Used as a fallback path when:
 *
 *   - RESTCONF is not enabled (older IOS 15.x without `restconf` config), OR
 *   - RESTCONF responds but returns empty identity, OR
 *   - The device is IOS classic (15.x), which has no RESTCONF/NETCONF at all.
 *
 * Endpoint: `GET https://<host>:<port>/level/15/exec/-/show/version` with
 * HTTP Basic auth (level 15 / privileged exec). The IOS HTTP server returns
 * an HTML page; the command output lives inside a single `<PRE>...</PRE>`
 * block, which we extract and parse.
 *
 * Tested against IOS 15.2 vios_l2 (LAB-F3-AS-01 / 10.10.20.211) on
 * 2026-09-16. The HTML has the structure:
 *
 *   <TITLE>LAB-F3-AS-01 /level/15/exec/-/show/version</TITLE>
 *   ...
 *   <PRE>
 *   Cisco IOS Software, vios_l2 Software (vios_l2-ADVENTERPRISEK9-M), ...
 *   Copyright (c) 1986-2020 by Cisco Systems, Inc.
 *   ...
 *   ROM: Bootstrap program is IOSv
 *   LAB-F3-AS-01 uptime is 1 hour, 6 minutes
 *   System returned to ROM by reload
 *   System image file is "flash0:/vios_l2-adventerprisek9-m"
 *   ...
 *   </PRE>
 *
 * No RESTCONF is invoked. Works on IOS 12.x, 15.x, and IOS-XE 16/17
 * whenever `ip http secure-server` is enabled. Gated on
 * `IOSXE_API_ENABLED=true` (same env as RESTCONF — shares creds).
 */
export async function probeIosHttpExecIdentity(host: string): Promise<{
  ok: boolean;
  fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } | null;
  raw?: string;
  error?: string;
}> {
  if (!iosxeRestEnabled()) {
    return { ok: false, fields: null, error: 'IOSXE_API_ENABLED=false' };
  }

  const cfg = iosxeConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/level/15/exec/-/show/version`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  let html: string;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      return { ok: false, fields: null, error: `IOS HTTP exec HTTP ${resp.status}` };
    }
    html = await resp.text();
  } catch (error) {
    return {
      ok: false,
      fields: null,
      error: error instanceof Error ? error.message : 'IOS HTTP exec failed',
    };
  }

  // Extract the first <PRE>...</PRE> block — that holds the command output.
  const preMatch = /<PRE>([\s\S]*?)<\/PRE>/i.exec(html);
  if (!preMatch) {
    return { ok: false, fields: null, raw: html.slice(0, 500), error: 'IOS HTTP exec: no <PRE> in response' };
  }
  const output = preMatch[1];

  // The HTML <TITLE> reliably holds the hostname followed by the request path:
  //   `<TITLE>LAB-F3-AS-01 /level/15/exec/-/show/version</TITLE>`
  // This is more reliable than parsing the command output, which on some
  // IOS versions starts with the platform token (`cisco ISR4331 uptime is...`)
  // or lacks an `uptime is` line at all.
  let hostnameFromTitle: string | undefined;
  const titleMatch = /<TITLE>\s*([^<\s/][^<]*?)\s*\/level\/15\/exec/i.exec(html);
  if (titleMatch) {
    const candidate = titleMatch[1].trim();
    if (candidate && !/^(System|Router|Switch|Building|Configuration|cisco|Cisco)$/i.test(candidate)) {
      hostnameFromTitle = candidate;
    }
  }

  const fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } = {
    vendor: 'Cisco',
  };

  // Prefer TITLE hostname; fall back to "<host> uptime is" line.
  if (hostnameFromTitle) {
    fields.hostname = hostnameFromTitle;
  } else {
    const hostnameMatch = output.match(/^(\S+)\s+uptime is/m);
    if (hostnameMatch) {
      const candidate = hostnameMatch[1].trim();
      if (candidate && !/^(System|Router|Switch|Building|Configuration|cisco|Cisco)$/i.test(candidate)) {
        fields.hostname = candidate;
      }
    }
  }

  // Version — `Version 15.2` / `Version 17.6.1` / `Version 15.5(3)M`.
  // Handle nested parens: "Version 15.2(20200924:215240)" should yield "15.2(20200924:215240)".
  const versionMatch = output.match(/Version\s+([\d.()A-Za-z0-9:]+)/);
  if (versionMatch) fields.version = versionMatch[1].trim();

  // Model — try physical-chassis banner first (`Cisco IOS Software, C2900
  // Software (...)`), then fall back to `Bootstrap program is <MODEL>`
  // for IOSv / virtual images.
  const bannerLine = output
    .split('\n')
    .find((l) => /Cisco Internetwork Operating System|Cisco IOS Software/i.test(l));
  if (bannerLine) {
    const modelTok = bannerLine.match(/,\s+([A-Z][\w-]+)\s+Software\s+\(/);
    if (modelTok) fields.model = modelTok[1];
  }
  if (!fields.model) {
    const bootMatch = output.match(/Bootstrap program is (\S+)/);
    if (bootMatch) fields.model = bootMatch[1];
  }

  // Serial — physical devices only. IOSv has none.
  const boardId = output.match(/Processor board ID\s+(\S+)/i);
  if (boardId) fields.serial = boardId[1];
  if (!fields.serial) {
    const sysSerial = output.match(/System serial number[:\s]+(\S+)/i);
    if (sysSerial) fields.serial = sysSerial[1];
  }

  const ok = Boolean(fields.hostname || fields.serial || fields.model);
  if (!ok) {
    return { ok: false, fields: null, raw: output, error: 'IOS HTTP exec: empty identity' };
  }

  return { ok: true, fields, raw: output };
}
