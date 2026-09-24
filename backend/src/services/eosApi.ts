/**
 * Arista EOS eAPI JSON-RPC 2.0 client for the backend fast-path.
 *
 * This module is the backend-side mirror of the worker's EOS backend.
 * It makes direct HTTP calls to the device's eAPI endpoint (port 443)
 * so that GET_CONFIG and GET_INTERFACES operations can complete without
 * going through the job queue — the result is written directly to the DB
 * in the same transaction as the job record, and the frontend receives the
 * result immediately (no worker poll / job queue latency).
 *
 * If eAPI is disabled on the device or the call fails, the caller falls
 * back to creating a PENDING job so the Python worker picks it up via SSH.
 */

function eosApiEnabled(): boolean {
  return process.env.EOS_API_ENABLED === 'true';
}

export function eosRestEnabled(): boolean {
  return eosApiEnabled();
}

function eosConfig() {
  return {
    scheme: process.env.EOS_API_SCHEME || 'https',
    port: Number(process.env.EOS_API_PORT ?? 443),
    verifyTls: process.env.EOS_API_VERIFY_TLS === 'true',
    username: process.env.EOS_API_USER || process.env.LAB_SSH_USER || 'admin',
    password: process.env.EOS_API_PASSWORD || process.env.LAB_SSH_PASSWORD || '',
  };
}

// ----------------------------------------------------------------
// eAPI JSON-RPC client
// ----------------------------------------------------------------

interface EosRpcResult {
  ok: boolean;
  result?: unknown[];
  error?: string;
  raw?: string;
}

async function eosRpc(host: string, cmds: unknown[], format = 'json'): Promise<EosRpcResult> {
  const cfg = eosConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/command-api`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'runCmds',
        params: {
          version: 1,
          cmds,
          format,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, error: `eAPI HTTP ${response.status}`, raw };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'eAPI JSON decode failed', raw };
    }

    if (data.error) {
      const err = data.error as Record<string, unknown>;
      return { ok: false, error: `${err.code ?? '?'}: ${err.message ?? 'unknown'}`, raw };
    }

    return { ok: true, result: data.result as unknown[], raw };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'eAPI call failed' };
  }
}

// ----------------------------------------------------------------
// Config serialization (same logic as worker/netconsole_worker/backends/eos.py)
// ----------------------------------------------------------------

function serializeEosJsonConfig(result: unknown[]): string {
  if (!result || !Array.isArray(result) || result.length === 0) return '';
  const first = result[0];
  if (!first || typeof first !== 'object') return String(first);

  const record = first as Record<string, unknown>;
  const lines: string[] = [];

  // 1. Header lines (already have `!` prefix).
  for (const h of record.header as string[] || []) {
    lines.push(String(h));
  }

  // 2. Comments.
  for (const c of record.comments as string[] || []) {
    const s = String(c);
    lines.push(s.startsWith('!') ? s : `!${s}`);
  }

  function emitCmds(cmds: Record<string, unknown>, indent = 0): void {
    const sub = cmds.cmds;
    if (!sub || typeof sub !== 'object') return;
    const prefix = ' '.repeat(indent);
    for (const [cmd, subval] of Object.entries(sub)) {
      lines.push(`${prefix}${cmd}`);
      if (subval && typeof subval === 'object') {
        emitCmds(subval as Record<string, unknown>, indent + 1);
      }
    }
  }

  // 3. Top-level commands.
  for (const [cmd, val] of Object.entries(record.cmds as Record<string, unknown> || {})) {
    lines.push(cmd);
    if (val && typeof val === 'object') {
      emitCmds(val as Record<string, unknown>, 1);
    }
  }

  return lines.join('\n');
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

export interface EosConfigResult {
  ok: boolean;
  config: string;
  collectMs: number;
  error?: string;
}

export async function fetchEosConfig(host: string): Promise<EosConfigResult> {
  if (!eosApiEnabled()) {
    return { ok: false, config: '', collectMs: 0, error: 'EOS_API_ENABLED=false' };
  }

  const cfg = eosConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/command-api`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'runCmds',
        params: {
          version: 1,
          cmds: [{ cmd: 'show running-config', format: 'json' }],
          format: 'json',
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    const collectMs = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      return { ok: false, config: '', collectMs, error: `eAPI HTTP ${response.status}` };
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, config: '', collectMs, error: 'eAPI JSON decode failed' };
    }

    if (data.error) {
      const err = data.error as Record<string, unknown>;
      return {
        ok: false,
        config: '',
        collectMs,
        error: `${err.code ?? '?'}: ${err.message ?? 'unknown error'}`,
      };
    }

    const result = data.result as unknown[] || [];
    let config = '';
    if (result.length > 0) {
      const first = result[0] as Record<string, unknown>;
      if ('output' in first) {
        config = String(first.output || '');
      } else {
        config = serializeEosJsonConfig(result);
      }
    }

    if (!config) {
      return { ok: false, config: '', collectMs, error: 'eAPI returned empty config' };
    }

    return { ok: true, config, collectMs };
  } catch (error) {
    return {
      ok: false,
      config: '',
      collectMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'eAPI call failed',
    };
  }
}

// ----------------------------------------------------------------
// Interface types
// ----------------------------------------------------------------

export interface EosInterfaceEntry {
  name: string;
  adminStatus: string;
  operStatus: string;
  description: string;
  mode: string;
  accessVlan: string;
  address: string;
  mtu: string;
  speed: string;
}

// ----------------------------------------------------------------
// EOS parsers (mirrors worker/netconsole_worker/backends/eos.py)
// ----------------------------------------------------------------

const EOS_STATUS_MAP: Record<string, string> = {
  connected: 'up',
  notconnect: 'down',
  errdisabled: 'down',
  disabled: 'down',
};

function eosStatus(raw: string | undefined): string {
  if (!raw) return 'unknown';
  return EOS_STATUS_MAP[raw.toLowerCase()] ?? raw.toLowerCase();
}

function parseEosInterfaces(result: unknown[]): EosInterfaceEntry[] {
  if (!result || !Array.isArray(result) || result.length === 0) return [];
  const first = result[0];
  if (!first || typeof first !== 'object') return [];

  const interfacesObj = (first as Record<string, unknown>).interfaces;
  if (!interfacesObj || typeof interfacesObj !== 'object') return [];

  const out: EosInterfaceEntry[] = [];
  for (const [name, body] of Object.entries(interfacesObj)) {
    if (!body || typeof body !== 'object') continue;
    const b = body as Record<string, unknown>;
    out.push({
      name,
      adminStatus: eosStatus(b.interfaceStatus as string | undefined),
      operStatus: eosStatus(b.lineProtocolStatus as string | undefined),
      description: String(b.description ?? ''),
      mode: '',
      accessVlan: '',
      address: '',
      mtu: String(b.mtu ?? ''),
      speed: String(b.bandwidth ?? ''),
    });
  }
  return out;
}

function parseEosDescriptions(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;

  // EOS 4.28+ emits `show interfaces description` with **space-padded
  // columns** (NOT tab-delimited) on the eAPI path:
  //   Interface                      Status         Protocol           Description
  //   Et1                            up             up                 LINK_TO_LAB-F6-DS-01_ge-0/0/1
  //   Et2                            up             up                 LINK_TO_VPC
  //
  // We split on 2+ spaces (the column gutter) and trim each cell. The
  // previous tab-split returned a single-column row, so the description
  // field always came back empty and the Ports panel showed nothing.
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().toLowerCase().startsWith('interface')) continue;
    const cols = line
      .split('  ')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cols.length < 4) continue;
    const rawName = cols[0];
    if (!rawName) continue;
    const longName = eosShortToLong(rawName);
    if (!longName.match(/^(Ethernet|Port-Channel|Management|Vxlan|Loopback|Et|Po|Ma|Vx|Lo)/i)) continue;
    // cols[3] = local Description (may be empty)
    const rawDesc = cols.length > 3 ? cols[3] : '';
    if (rawDesc) out[longName] = rawDesc;
  }
  return out;
}

function eosShortToLong(name: string): string {
  const n = name.trim();
  if (n.startsWith('Et') && n.slice(2).match(/^\d/)) return 'Ethernet' + n.slice(2);
  if (n.startsWith('Po') && n.slice(2).match(/^\d/)) return 'Port-Channel' + n.slice(2);
  if (n.startsWith('Ma') && n.slice(2).match(/^\d/)) return 'Management' + n.slice(2);
  if (n.startsWith('Vx') && n.slice(2).match(/^\d/)) return 'Vxlan' + n.slice(2);
  return n;
}

function parseEosSwitchportJson(result: unknown[]): Record<string, { mode: string; accessVlan: string; trunkVlans: string }> {
  const out: Record<string, { mode: string; accessVlan: string; trunkVlans: string }> = {};

  // EOS eAPI JSON format for `show interfaces switchport`:
  // Single-command request returns { "result": [{ switchports: {...} }] }
  // i.e. result[0].switchports contains the data (NOT result[1]).
  // Verified against real EOS (10.10.20.131) on 2026-09-15.
  if (!result || !Array.isArray(result) || result.length < 1) return out;

  const data = result[0] as Record<string, unknown>;
  if (!data || typeof data !== 'object') return out;
  
  const switchports = (data as Record<string, unknown>).switchports as Record<string, unknown> | undefined;
  if (!switchports || typeof switchports !== 'object') return out;
  
  for (const [name, info] of Object.entries(switchports)) {
    if (!info || typeof info !== 'object') continue;
    
    const switchportInfo = (info as Record<string, unknown>).switchportInfo as Record<string, unknown> | undefined;
    if (!switchportInfo || typeof switchportInfo !== 'object') continue;
    
    const mode = String(switchportInfo.mode || '').toLowerCase();
    const accessVlanId = switchportInfo.accessVlanId;
    const trunkAllowedVlans = String(switchportInfo.trunkAllowedVlans || '');
    
    const entry: { mode: string; accessVlan: string; trunkVlans: string } = {
      mode: '',
      accessVlan: '',
      trunkVlans: ''
    };
    
    // Set mode if valid
    if (mode === 'access' || mode === 'trunk') {
      entry.mode = mode;
    }
    
    // Set access VLAN (always capture, including VLAN 1 — the default).
    // We previously skipped VLAN 1 here (`> 1`) under the (wrong) assumption
    // that "VLAN 1 = default = uninteresting". That hid the access VLAN on
    // any port sitting on the default VLAN — e.g. Ethernet5-8 on F1-AS-01.
    // Real device reports `accessVlanId=1` for those ports; the parser was
    // dropping the field and the Ports panel showed them as "VLAN —".
    if (typeof accessVlanId === 'number' && accessVlanId >= 1) {
      entry.accessVlan = String(accessVlanId);
    }

    // Set trunk VLANs (always capture; the parser caller decides if "ALL"
    // / "1" is informative enough to overwrite an existing accessVlan)
    if (trunkAllowedVlans) {
      entry.trunkVlans = trunkAllowedVlans;
    }
    
    // Only add if we have some data
    if (entry.mode || entry.accessVlan || entry.trunkVlans) {
      out[name] = entry;
    }
  }
  
  return out;
}

function parseEosSwitchport(text: string): Record<string, { mode: string; accessVlan: string; trunkVlans: string }> {
  const out: Record<string, { mode: string; accessVlan: string; trunkVlans: string }> = {};
  if (!text) return out;

  let currentName = '';
  let current: { mode: string; accessVlan: string; trunkVlans: string } = { mode: '', accessVlan: '', trunkVlans: '' };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (currentName) {
        out[currentName] = current;
        currentName = '';
        current = { mode: '', accessVlan: '', trunkVlans: '' };
      }
      continue;
    }

    if (line.toLowerCase().startsWith('name:')) {
      if (currentName) out[currentName] = current;
      const rawName = line.split(':', 1)[1].trim();
      currentName = eosShortToLong(rawName);
      current = { mode: '', accessVlan: '', trunkVlans: '' };
      continue;
    }

    if (line.toLowerCase().startsWith('switchport mode:')) {
      const mode = line.split(':', 1)[1].trim().toLowerCase();
      if (mode === 'access' || mode === 'trunk') current.mode = mode;
      continue;
    }

    if (line.toLowerCase().startsWith('access mode vlan:')) {
      const vlan = line.split(':', 1)[1].trim();
      if (vlan) current.accessVlan = vlan;
      continue;
    }

    if (line.toLowerCase().startsWith('trunking vlans allowed:')) {
      const vlans = line.split(':', 1)[1].trim();
      if (vlans) current.trunkVlans = vlans;
      continue;
    }

    if (line.toLowerCase().startsWith('trunking native mode vlan:')) {
      const native = line.split(':', 1)[1].trim();
      if (native && native !== '1') {
        if (current.trunkVlans && !current.trunkVlans.split(',').includes(native)) {
          current.trunkVlans = `${native},${current.trunkVlans}`;
        } else if (!current.trunkVlans) {
          current.trunkVlans = native;
        }
      }
      continue;
    }
  }

  if (currentName) out[currentName] = current;
  return out;
}

function mergeEosSwitchport(interfaces: EosInterfaceEntry[], switchport: Record<string, { mode: string; accessVlan: string; trunkVlans: string }>): void {
  for (const iface of interfaces) {
    const sp = switchport[iface.name];
    if (!sp) {
      console.log(`[eosApi] merge: no switchport data for ${iface.name}`);
      continue;
    }

    console.log(`[eosApi] merge: ${iface.name} -> sp=${JSON.stringify(sp)}`);

    if (sp.mode) iface.mode = sp.mode;

    if (sp.mode === 'trunk' && sp.trunkVlans) {
      iface.accessVlan = sp.trunkVlans;
    } else if (sp.mode === 'access' && sp.accessVlan) {
      iface.accessVlan = sp.accessVlan;
    } else if (sp.trunkVlans && !sp.mode) {
      iface.mode = 'trunk';
      iface.accessVlan = sp.trunkVlans;
    } else if (sp.accessVlan && !sp.mode) {
      iface.mode = 'access';
      iface.accessVlan = sp.accessVlan;
    }
    console.log(`[eosApi] merge: ${iface.name} final -> mode=${iface.mode}, accessVlan=${iface.accessVlan}`);
  }
}

// ----------------------------------------------------------------
// Public API - Interfaces
// ----------------------------------------------------------------

export async function fetchEosInterfaceList(host: string): Promise<{
  ok: boolean;
  interfaces: EosInterfaceEntry[];
  collectMs: number;
  error?: string;
}> {
  if (!eosApiEnabled()) {
    return { ok: false, interfaces: [], collectMs: 0, error: 'EOS_API_ENABLED=false' };
  }

  const started = Date.now();

  // Step 1: Get interface status via JSON
  const statusResult = await eosRpc(host, [{ cmd: 'show interfaces', format: 'json' }]);
  if (!statusResult.ok) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: statusResult.error };
  }

  const interfaces = parseEosInterfaces(statusResult.result ?? []);
  if (interfaces.length === 0) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: 'No interfaces in eAPI response' };
  }

  // Step 2: Get descriptions via text (JSON description is often empty on EOS 4.28+)
  const descResult = await eosRpc(host, [{ cmd: 'show interfaces description', format: 'text' }]);
  if (descResult.ok && descResult.result) {
    const arr = descResult.result;
    const text = Array.isArray(arr) && arr.length > 0 && (arr[0] as Record<string, unknown>)?.output
      ? String((arr[0] as Record<string, unknown>).output)
      : '';
    if (text) {
      const descByName = parseEosDescriptions(text);
      // Always prefer the text-derived description. The `show interfaces`
      // JSON description field is unreliable on EOS 4.28+ (can be empty or
      // stale). The previous `!iface.description` guard meant periodic jobs
      // never updated a stale cached value from a previous run, while manual
      // collect happened to succeed only because the job row was fresh.
      for (const iface of interfaces) {
        const desc = descByName[iface.name];
        if (desc) iface.description = desc;
      }
    }
  }

  // Step 3: Get switchport mode and VLANs via JSON (preferred over text)
  const swResult = await eosRpc(host, [{ cmd: 'show interfaces switchport', format: 'json' }]);
  if (swResult.ok && swResult.result) {
    const switchport = parseEosSwitchportJson(swResult.result);
    console.log(`[eosApi] parsed JSON switchport for ${host}:`, JSON.stringify(switchport).substring(0, 1500));
    mergeEosSwitchport(interfaces, switchport);
  } else {
    // Fallback to text format if JSON fails
    console.warn(`[eosApi] switchport JSON fetch failed for ${host}:`, swResult.error, "Trying text format...");
    const swTextArr = swResult.result;
    const swText = Array.isArray(swTextArr) && swTextArr.length > 0 && (swTextArr[0] as Record<string, unknown>)?.output
      ? String((swTextArr[0] as Record<string, unknown>).output)
      : '';
    if (swText) {
      const switchport = parseEosSwitchport(swText);
      console.log(`[eosApi] parsed TEXT switchport for ${host}:`, JSON.stringify(switchport).substring(0, 1500));
      mergeEosSwitchport(interfaces, switchport);
    }
  }

  return { ok: true, interfaces, collectMs: Date.now() - started };
}

/**
 * Probe an Arista EOS device over eAPI (JSON-RPC over HTTPS) to extract
 * identity (hostname, vendor, model, version, serial). Used by the discovery
 * scanner so Arista switches can be marked as `DISCOVERED` and then synced
 * into inventory without going through the SSH job queue.
 *
 * Runs `show version` JSON and pulls `hostname`, `modelName`, `version`,
 * `serialNumber`. If `hostname` is absent from `show version` (some EOS
 * builds omit it) we fall back to `show hostname` which always returns a
 * hostname string on any eAPI-enabled EOS version.
 *
 * Gated on `EOS_API_ENABLED=true`. Returns ok=false immediately when the
 * flag is off so the parallel fan-out in `discoveryScan.ts` can skip us.
 */
export async function probeEosApiIdentity(host: string): Promise<{
  ok: boolean;
  fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } | null;
  raw?: string;
  error?: string;
}> {
  if (!eosApiEnabled()) {
    return { ok: false, fields: null, error: 'EOS_API_ENABLED=false' };
  }

  const result = await eosRpc(host, [{ cmd: 'show version', format: 'json' }]);
  if (!result.ok) {
    return { ok: false, fields: null, raw: result.raw, error: result.error ?? 'EOS eAPI failed' };
  }

  const rawParts = [result.raw ?? ''];
  const arr = result.result ?? [];

  // The eAPI JSON-RPC result is an array of one element per cmd. Some EOS
  // versions wrap the show version payload in `{ output: {...} }`; others
  // return the fields directly. Handle both.
  let data: Record<string, unknown> | null = null;
  if (arr.length > 0 && arr[0] && typeof arr[0] === 'object') {
    const first = arr[0] as Record<string, unknown>;
    if ('output' in first && first.output && typeof first.output === 'object') {
      data = first.output as Record<string, unknown>;
    } else {
      data = first;
    }
  }

  if (!data) {
    return { ok: false, fields: null, raw: rawParts.join('\n'), error: 'EOS show version empty' };
  }

  const fields: { hostname?: string; vendor: string; model?: string; version?: string; serial?: string } = {
    vendor: 'Arista',
  };

  const hostname = data['hostname'];
  if (typeof hostname === 'string' && hostname.trim()) {
    fields.hostname = hostname.trim();
  } else {
    // Fallback: `show hostname` is guaranteed to return { hostname: "..." }
    // on any EOS version with eAPI. Some EOS builds omit `hostname` from
    // `show version` but always expose it via `show hostname`.
    const hostnameResult = await eosRpc(host, [{ cmd: 'show hostname', format: 'json' }]);
    if (hostnameResult.ok && hostnameResult.result && hostnameResult.result.length > 0) {
      const hnData = hostnameResult.result[0] as Record<string, unknown>;
      const hn = hnData['hostname'];
      if (typeof hn === 'string' && hn.trim()) {
        fields.hostname = hn.trim();
      }
    }
  }

  const model = data['modelName'] ?? data['model'];
  if (typeof model === 'string' && model.trim()) fields.model = model.trim();

  const version = data['version'] ?? data['softwareImageVersion'];
  if (typeof version === 'string' && version.trim()) fields.version = version.trim();

  const serial = data['serialNumber'];
  if (typeof serial === 'string' && serial.trim()) fields.serial = serial.trim();

  const ok = Boolean(fields.hostname || fields.serial || fields.model);
  if (!ok) {
    return { ok: false, fields: null, raw: rawParts.join('\n'), error: 'EOS identity empty' };
  }

  return { ok: true, fields, raw: rawParts.join('\n') };
}
