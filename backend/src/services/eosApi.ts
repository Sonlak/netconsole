/**
 * Arista EOS eAPI JSON-RPC 2.0 client for the backend fast-path.
 *
 * This module is the backend-side mirror of the worker's EOS backend.
 * It makes direct HTTP calls to the device's eAPI endpoint (port 443)
 * so that GET_CONFIG operations can complete without going through the
 * job queue — the result is written directly to the DB in the same
 * transaction as the job record, and the frontend receives the result
 * immediately (no worker poll / job queue latency).
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
