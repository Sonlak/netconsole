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

  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (!stripped || stripped.toLowerCase().startsWith('interface')) continue;
    // Format: Et1  up  up  LINK_TO_FOO
    const parts = stripped.split(/\s+/);
    if (parts.length < 4) continue;
    const shortName = parts[0];
    const longName = eosShortToLong(shortName);
    const desc = parts.slice(3).join(' ').trim();
    if (desc) out[longName] = desc;
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
    if (!sp) continue;

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
  if (descResult.ok && descResult.raw) {
    const descByName = parseEosDescriptions(descResult.raw);
    for (const iface of interfaces) {
      const desc = descByName[iface.name];
      if (desc && !iface.description) iface.description = desc;
    }
  }

  // Step 3: Get switchport mode and VLANs via text
  const swResult = await eosRpc(host, [{ cmd: 'show interfaces switchport', format: 'text' }]);
  if (swResult.ok && swResult.raw) {
    const switchport = parseEosSwitchport(swResult.raw);
    mergeEosSwitchport(interfaces, switchport);
  }

  return { ok: true, interfaces, collectMs: Date.now() - started };
}
