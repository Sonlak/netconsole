/**
 * Interface counter poller + history store.
 *
 * Pulls traffic counters (octets/packets/errors/discards/CRC) per interface
 * from each managed device, persists them as cumulative 64-bit samples, and
 * exposes the time series to the frontend so the bandwidth chart can render
 * in/out bps over the last hour.
 *
 * Why not SNMP?
 *   - Per the gotchas + vendor-API survey, RESTCONF / eAPI / RESTCONF return
 *     the same cumulative counters (Cisco `ietf-interfaces:interfaces-state`
 *     `statistics/`, Arista `show interfaces counters` JSON, Junos
 *     `<traffic-statistics>` from `get-interface-information`).
 *   - No extra `snmp` daemon in compose, no per-vendor MIB rewrites.
 *   - We follow the *same backend-direct REST pattern* used by
 *     `interfaces.ts` / `iosxeRest.ts` / `eosApi.ts` / `junosRest.ts`.
 *
 * Vendor routing (mirrors `interfaces.ts`):
 *   - juniper  -> RESTCONF `<get-interface-information>` (no terse=), XML
 *   - arista   -> eAPI JSON `show interfaces counters`
 *   - cisco    -> RESTCONF `ietf-interfaces:interfaces-state/statistics`
 *   - ios (plain IOS 15.x) -> SSH `show interfaces` (no RESTCONF/NETCONF).
 *
 * Rates are *derived*, not stored: when the API returns history, it
 *   rate = (delta_octets * 8) / delta_seconds  -> bits/second
 * so the chart can be re-rendered / re-sampled without losing precision in
 * the raw counters.
 */

import type { Device, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runIosxeSshCommand } from './labSsh.js';

// ---------------------------------------------------------------------------
// Config (mirrors the *_API_ENABLED flags used by the other REST clients)
// ---------------------------------------------------------------------------

const FEATURE_ENABLED = process.env.INTERFACE_COUNTERS_ENABLED !== 'false';
const POLL_INTERVAL_SECONDS = Math.max(
  Number(process.env.INTERFACE_COUNTERS_INTERVAL_SECONDS ?? 30),
  10,
);
const RETENTION_HOURS = Math.max(
  Number(process.env.INTERFACE_COUNTERS_RETENTION_HOURS ?? 24),
  1,
);
const PARALLEL_DEVICES = Math.max(Number(process.env.INTERFACE_COUNTERS_PARALLEL ?? 4), 1);
export const LAB_SSH_USER = process.env.LAB_SSH_USER ?? 'netconsole';
export const LAB_SSH_PASSWORD = process.env.LAB_SSH_PASSWORD ?? 'Admin@123';
export const LAB_SSH_PORT = Number.parseInt(process.env.LAB_SSH_PORT ?? '22', 10);
export const JUNOS_SSH_PORT = Number.parseInt(process.env.JUNOS_SSH_PORT ?? '22', 10);
export const JUNOS_API_USER = process.env.JUNOS_API_USER ?? 'netconsole';
export const JUNOS_API_PASSWORD = process.env.JUNOS_API_PASSWORD ?? 'Admin@123';
const IOSXE_API_USER = process.env.IOSXE_API_USER ?? LAB_SSH_USER;
const IOSXE_API_PASSWORD = process.env.IOSXE_API_PASSWORD ?? LAB_SSH_PASSWORD;
const IOSXE_API_SCHEME = process.env.IOSXE_API_SCHEME ?? 'https';
const IOSXE_API_PORT = Number(process.env.IOSXE_API_PORT ?? 443);
const IOSXE_API_ENABLED = process.env.IOSXE_API_ENABLED === 'true';
const JUNOS_API_SCHEME = process.env.JUNOS_REST_SCHEME ?? 'https';
const JUNOS_API_PORT = Number(process.env.JUNOS_REST_PORT ?? 3443);
const JUNOS_API_ENABLED = process.env.JUNOS_REST_ENABLED === 'true';
const EOS_API_USER = process.env.EOS_API_USER ?? LAB_SSH_USER;
const EOS_API_PASSWORD = process.env.EOS_API_PASSWORD ?? LAB_SSH_PASSWORD;
const EOS_API_SCHEME = process.env.EOS_API_SCHEME ?? 'https';
const EOS_API_PORT = Number(process.env.EOS_API_PORT ?? 443);
const EOS_API_ENABLED = process.env.EOS_API_ENABLED === 'true';

// ---------------------------------------------------------------------------
// Vendor fetchers
// ---------------------------------------------------------------------------

export type InterfaceCounters = {
  name: string;
  inOctets?: bigint;
  outOctets?: bigint;
  inPackets?: bigint;
  outPackets?: bigint;
  inErrors?: bigint;
  outErrors?: bigint;
  inDiscards?: bigint;
  outDiscards?: bigint;
  inCrcErrors?: bigint;
};

type FetchResult = {
  ok: boolean;
  source: string;
  interfaces: InterfaceCounters[];
  error?: string;
  collectMs: number;
};

// --- Juniper RESTCONF -----------------------------------------------------

async function fetchJunosCounters(host: string): Promise<FetchResult> {
  const started = Date.now();
  const collectMs = () => Date.now() - started;
  if (!JUNOS_API_ENABLED) {
    return { ok: false, source: 'junos-rest', interfaces: [], error: 'JUNOS_REST_ENABLED=false', collectMs: collectMs() };
  }
  // Use the same GET-RPC pattern as interfaces.ts / callRpc() in junosRest.ts.
  // Tested 2026-09-19: returning 0 interfaces from this path means either the
  // RPC name is wrong OR the device returned an error envelope instead of the
  // interface-information payload. The `[junosRest] pullJunosConfig` path uses
  // GET /rpc/<rpc> with no body, so we follow that.
  const cfg = { scheme: JUNOS_API_SCHEME, port: JUNOS_API_PORT, username: JUNOS_API_USER, password: JUNOS_API_PASSWORD };
  const url = `${cfg.scheme}://${host}:${cfg.port}/rpc/get-interface-information`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  try {
    // GET first (matches interfaces.ts / callRpc pattern). If response is
    // empty/terse, fall back to POST with `<detail/>` which is the canonical
    // RPC form for traffic-statistics per Junos docs.
    let resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/xml' },
      signal: AbortSignal.timeout(20000),
    });
    let raw = await resp.text();
    let usedPost = false;
    // If the body has no traffic-statistics at all, try POST <detail/>.
    // cRPD (and some Junos versions) only emit counters when the RPC
    // explicitly asks for the detail view.
    if (resp.ok && !/<(?:\w+:)?traffic-statistics/i.test(raw)) {
      const postResp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/xml',
          'Content-Type': 'application/xml',
        },
        body: '<get-interface-information><detail/></get-interface-information>',
        signal: AbortSignal.timeout(20000),
      });
      const postRaw = await postResp.text();
      if (postResp.ok && /<(?:\w+:)?traffic-statistics/i.test(postRaw)) {
        raw = postRaw;
        usedPost = true;
      } else if (postResp.ok && postRaw.length > raw.length) {
        // Keep the longer response if neither had stats -- preserves the
        // most-detailed output for the warning path below.
        raw = postRaw;
        usedPost = true;
      }
    }
    if (!resp.ok && !(usedPost && raw)) {
      return { ok: false, source: 'junos-rest', interfaces: [], error: `HTTP ${resp.status}`, collectMs: collectMs() };
    }
    if (/xnm:error|<error-message>|<rpc-reply[^>]*>\s*<xnm:error/i.test(raw)) {
      return { ok: false, source: 'junos-rest', interfaces: [], error: 'Junos RPC error', collectMs: collectMs() };
    }
    const interfaces = parseJunosTrafficStats(raw);
    return { ok: true, source: 'junos-rest', interfaces, collectMs: collectMs() };
  } catch (err) {
    return {
      ok: false,
      source: 'junos-rest',
      interfaces: [],
      error: err instanceof Error ? err.message : 'Junos RESTCONF failed',
      collectMs: collectMs(),
    };
  }
}

const _PHYS_IFACE_RE = /<(?:\w+:)?physical-interface>([\s\S]*?)<\/(?:\w+:)?physical-interface>/g;

function parseJunosTrafficStats(xml: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  if (!xml) return out;
  _PHYS_IFACE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = _PHYS_IFACE_RE.exec(xml)) !== null) {
    const block = match[1];
    const name = jcTag(block, 'name');
    if (!name) continue;
    // Some Junos versions split counters into input-/output-statistics; the
    // newer detail form nests them under a unified <traffic-statistics>.
    // Try unified first, then concat the split form.
    const stats =
      jcBlock(block, 'traffic-statistics') ||
      `${jcBlock(block, 'input-statistics')}\n${jcBlock(block, 'output-statistics')}`;
    if (!stats) continue;
    out.push({
      name,
      inOctets: jcNum(stats, 'input-octets') ?? jcNum(stats, 'input-bytes'),
      outOctets: jcNum(stats, 'output-octets') ?? jcNum(stats, 'output-bytes'),
      inPackets: jcNum(stats, 'input-packets'),
      outPackets: jcNum(stats, 'output-packets'),
      inErrors: jcNum(stats, 'input-errors'),
      outErrors: jcNum(stats, 'output-errors'),
      inDiscards: jcNum(stats, 'input-drops') ?? jcNum(stats, 'input-discards'),
      outDiscards: jcNum(stats, 'output-drops') ?? jcNum(stats, 'output-discards'),
      inCrcErrors: jcNum(stats, 'input-crc-errors'),
    });
  }
  return out;
}

function jcBlock(xml: string, tag: string): string {
  const re = new RegExp(`<(?:\w+:)?${tag}>([\\s\\S]*?)</(?:\w+:)?${tag}>`, 'i');
  return re.exec(xml)?.[1] ?? '';
}

function jcTag(xml: string, tag: string): string {
  const re = new RegExp(`<(?:\w+:)?${tag}>([\\s\\S]*?)</(?:\w+:)?${tag}>`, 'i');
  return re.exec(xml)?.[1]?.trim() ?? '';
}

function jcNum(xml: string, tag: string): bigint | undefined {
  const text = jcTag(xml, tag);
  if (!text) return undefined;
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

// --- Arista EOS eAPI ------------------------------------------------------

async function fetchEosCounters(host: string): Promise<FetchResult> {
  const started = Date.now();
  const collectMs = () => Date.now() - started;
  if (!EOS_API_ENABLED) {
    return { ok: false, source: 'eos-api', interfaces: [], error: 'EOS_API_ENABLED=false', collectMs: collectMs() };
  }
  const url = `${EOS_API_SCHEME}://${host}:${EOS_API_PORT}/command-api`;
  const auth = Buffer.from(`${EOS_API_USER}:${EOS_API_PASSWORD}`).toString('base64');
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'runCmds',
        params: { version: 1, cmds: [{ cmd: 'show interfaces counters', format: 'json' }], format: 'json' },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      return { ok: false, source: 'eos-api', interfaces: [], error: `HTTP ${resp.status}`, collectMs: collectMs() };
    }
    let parsed: { result?: unknown[]; error?: { message?: string } } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, source: 'eos-api', interfaces: [], error: 'eAPI JSON decode failed', collectMs: collectMs() };
    }
    if (parsed?.error?.message) {
      return { ok: false, source: 'eos-api', interfaces: [], error: parsed.error.message, collectMs: collectMs() };
    }
    const arr = Array.isArray(parsed?.result) ? (parsed!.result as unknown[]) : [];
    const interfaces = parseEosCounters(arr);
    return { ok: true, source: 'eos-api', interfaces, collectMs: collectMs() };
  } catch (err) {
    return {
      ok: false,
      source: 'eos-api',
      interfaces: [],
      error: err instanceof Error ? err.message : 'eAPI call failed',
      collectMs: collectMs(),
    };
  }
}

function parseEosCounters(result: unknown[]): InterfaceCounters[] {
  if (!result.length) return [];
  const first = result[0] as Record<string, unknown> | undefined;
  if (!first) return [];
  // EOS eAPI returns either { output: { Ethernet1: {...}, Ethernet2: {...} } }
  // (newer) or the interface map directly (older). Handle both. Also the map
  // may live under .interfaces.* (eos-switch version).
  const out: InterfaceCounters[] = [];

  // Try `output.{iface}` (newer EOS 4.22+)
  let data: Record<string, unknown> | undefined;
  if ('output' in first && first.output && typeof first.output === 'object') {
    data = (first as Record<string, unknown>).output as Record<string, unknown>;
  } else if ('interfaces' in first && typeof first.interfaces === 'object') {
    data = (first as Record<string, unknown>).interfaces as Record<string, unknown>;
  } else {
    // Might BE the interface map directly (first = { Ethernet1: {...} })
    data = first;
  }

  if (!data) return out;

  for (const [name, body] of Object.entries(data)) {
    if (!body || typeof body !== 'object') continue;
    const b = body as Record<string, unknown>;
    // Skip non-interface entries (e.g. "summary")
    if (name === 'summary') continue;
    // If this value itself contains another level of nesting (older EOS style:
    // { Ethernet1: { interfaceCounters: { inOctets, ... } } }), descend.
    let flat: Record<string, unknown> = b;
    if ('interfaceCounters' in b && b.interfaceCounters && typeof b.interfaceCounters === 'object') {
      flat = b.interfaceCounters as Record<string, unknown>;
    } else if ('count' in b && 'fields' in b && typeof b.fields === 'object') {
      flat = (b as Record<string, unknown>).fields as Record<string, unknown>;
    }
    if (!('inOctets' in flat || 'outOctets' in flat || 'rxData' in flat || 'txData' in flat)) continue;
    const num = (v: unknown): bigint | undefined => {
      if (v === undefined || v === null) return undefined;
      const n = typeof v === 'string' ? Number(v) : (v as number);
      if (!Number.isFinite(n)) return undefined;
      return BigInt(Math.trunc(n));
    };
    out.push({
      name,
      inOctets: num(flat.inOctets) ?? num(flat.rxData),
      outOctets: num(flat.outOctets) ?? num(flat.txData),
      inPackets: num(flat.inUcastPkts) ?? num(flat.rxPackets) ?? num(flat.inPkts),
      outPackets: num(flat.outUcastPkts) ?? num(flat.txPackets) ?? num(flat.outPkts),
      inErrors: num(flat.inErrors) ?? num(flat.totalInErrors),
      outErrors: num(flat.outErrors) ?? num(flat.totalOutErrors),
      inDiscards: num(flat.inDiscards) ?? num(flat.rxErrors) ?? num(flat.inDropped),
      outDiscards: num(flat.outDiscards) ?? num(flat.txErrors) ?? num(flat.outDropped),
      inCrcErrors: num(flat.inCrcErrors),
    });
  }
  return out;
}

// --- IOS-XE RESTCONF (ietf-interfaces-state) ------------------------------

async function fetchIosxeCounters(host: string): Promise<FetchResult> {
  const started = Date.now();
  const collectMs = () => Date.now() - started;
  if (!IOSXE_API_ENABLED) {
    return { ok: false, source: 'iosxe-rest', interfaces: [], error: 'IOSXE_API_ENABLED=false', collectMs: collectMs() };
  }
  // `interfaces-state` (note the hyphen — operational, RFC 7223) is the
  // universal CANVAS for counters. Path is **ietf-interfaces:interfaces-state**;
  // some IOS-XE 17.x builds only expose it under that namespace.
  const url = `${IOSXE_API_SCHEME}://${host}:${IOSXE_API_PORT}/restconf/data/ietf-interfaces:interfaces-state`;
  const auth = Buffer.from(`${IOSXE_API_USER}:${IOSXE_API_PASSWORD}`).toString('base64');
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' },
      signal: AbortSignal.timeout(20000),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      return { ok: false, source: 'iosxe-rest', interfaces: [], error: `HTTP ${resp.status}`, collectMs: collectMs() };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, source: 'iosxe-rest', interfaces: [], error: 'JSON decode failed', collectMs: collectMs() };
    }
    const interfaces = parseIosxeCounters(parsed);
    return { ok: true, source: 'iosxe-rest', interfaces, collectMs: collectMs() };
  } catch (err) {
    return {
      ok: false,
      source: 'iosxe-rest',
      interfaces: [],
      error: err instanceof Error ? err.message : 'IOS-XE RESTCONF failed',
      collectMs: collectMs(),
    };
  }
}

function parseIosxeCounters(payload: unknown): InterfaceCounters[] {
  if (!payload || typeof payload !== 'object') return [];
  const out: InterfaceCounters[] = [];
  const root = payload as Record<string, unknown>;
  const ifaces = (root['interface'] ?? (root['ietf-interfaces:interfaces-state'] as Record<string, unknown> | undefined)?.['interface']) as
    | unknown[]
    | undefined;
  const list = Array.isArray(ifaces) ? ifaces : ifaces ? [ifaces] : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    const name = String(i.name ?? '').trim();
    if (!name) continue;
    const stats = (i.statistics ?? i['ietf-interfaces:statistics']) as Record<string, unknown> | undefined;
    if (!stats) continue;
    const big = (v: unknown): bigint | undefined => {
      if (v === undefined || v === null) return undefined;
      try {
        return typeof v === 'string' ? BigInt(v) : BigInt(Math.trunc(Number(v)));
      } catch {
        return undefined;
      }
    };
    out.push({
      name,
      inOctets: big(stats['in-octets'] ?? stats['inOctets']),
      outOctets: big(stats['out-octets'] ?? stats['outOctets']),
      inPackets: big(stats['in-unicast-pkts'] ?? stats['inUcastPkts'] ?? stats['in-packets']),
      outPackets: big(stats['out-unicast-pkts'] ?? stats['outUcastPkts'] ?? stats['out-packets']),
      inErrors: big(stats['in-errors'] ?? stats['inErrors']),
      outErrors: big(stats['out-errors'] ?? stats['outErrors']),
      inDiscards: big(stats['in-discards'] ?? stats['inDiscards']),
      outDiscards: big(stats['out-discards'] ?? stats['outDiscards']),
      inCrcErrors: big(stats['in-crc-errors'] ?? stats['inCrcErrors']),
    });
  }
  return out;
}

// --- Plain IOS 15.x (lab-F3-AS-01) via SSH --------------------------------

async function fetchIosSshCounters(host: string): Promise<FetchResult> {
  const started = Date.now();
  try {
    // IOS 15.x `show interfaces` is prose-heavy and the output-bytes line
    // sometimes scrolls off if terminal width is narrow. The tabular
    // `show interfaces counters` form has the same numbers in a fixed
    // column layout that's far easier to parse and survives paging.
    // Falls back to `show interfaces` if counters view isn't supported
    // (very old IOS, sub-images).
    let result = await runIosxeSshCommand(host, 'show interfaces counters', {
      port: LAB_SSH_PORT,
      username: LAB_SSH_USER,
      password: LAB_SSH_PASSWORD,
      timeoutMs: 30000,
    });
    let parsed: InterfaceCounters[] = [];
    let source: FetchResult['source'] = 'ios-ssh';
    if (result.ok) {
      parsed = parseIosCountersTabular(result.output);
      // `show interfaces counters` doesn't include inErrors/outErrors/inCRC;
      // run `show interfaces` in parallel for those fields, then merge.
      if (parsed.length > 0) {
        const prose = await runIosxeSshCommand(host, 'show interfaces', {
          port: LAB_SSH_PORT,
          username: LAB_SSH_USER,
          password: LAB_SSH_PASSWORD,
          timeoutMs: 30000,
        });
        if (prose.ok) {
          const proseIfaces = parseIosCountersProse(prose.output);
          // merge by interface name
          const byName = new Map(proseIfaces.map((p) => [p.name, p]));
          for (const row of parsed) {
            const p = byName.get(row.name);
            if (!p) continue;
            if (p.inErrors != null) row.inErrors = p.inErrors;
            if (p.outErrors != null) row.outErrors = p.outErrors;
            if (p.inCrcErrors != null) row.inCrcErrors = p.inCrcErrors;
            if (p.inDiscards != null) row.inDiscards = p.inDiscards;
            if (p.outDiscards != null) row.outDiscards = p.outDiscards;
          }
        }
      }
    } else {
      // tabular command failed — fall back to prose.
      result = await runIosxeSshCommand(host, 'show interfaces', {
        port: LAB_SSH_PORT,
        username: LAB_SSH_USER,
        password: LAB_SSH_PASSWORD,
        timeoutMs: 30000,
      });
      if (result.ok) {
        parsed = parseIosCountersProse(result.output);
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        source,
        interfaces: [],
        collectMs: Date.now() - started,
        error: result.error ?? 'SSH failed',
      };
    }
    return { ok: true, source, interfaces: parsed, collectMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      source: 'ios-ssh',
      interfaces: [],
      collectMs: Date.now() - started,
      error: err instanceof Error ? err.message : 'IOS SSH failed',
    };
  }
}

// `show interfaces counters` parser. Output layout (IOS 15.x):
//
//   Port            InOctets      InUcastPkts   InMcastPkts   InBcastPkts   OutOctets      OutUcastPkts  OutMcastPkts  OutBcastPkts
//   Gi0/0           13181538      12345         0             0             26962490       23456         0             0
//   Gi0/1                  0           0         0             0                    0            0         0             0
//
// Notes:
// - The column order is fixed but the separator is whitespace, not pipes.
// - IOS sometimes prints an additional "InErrors OutErrors ..." row when
//   error counters are present; we ignore that block (handled by prose
//   parser) and only take octets/packets from this view.
// - The interface name appears in short form (Gi0/0, Te0/1/0, Fa0/0).
//   Expand to the long form (GigabitEthernet0/0) to match what the
//   RESTCONF/Junos collectors return.
function parseIosCountersTabular(output: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  if (!output) return out;
  const lines = output.split(/\r?\n/);
  // Find the header row that contains both "InOctets" and "OutOctets".
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/\bInOctets\b/i.test(l) && /\bOutOctets\b/i.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return out;
  const header = lines[headerIdx].trim().split(/\s+/);
  const colIdx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const inOctCol = colIdx('InOctets');
  const outOctCol = colIdx('OutOctets');
  const inUcastCol = colIdx('InUcastPkts');
  const outUcastCol = colIdx('OutUcastPkts');
  const inBcastCol = colIdx('InBcastPkts');
  const outBcastCol = colIdx('OutBcastPkts');
  if (inOctCol < 0 || outOctCol < 0) return out;
  const shortToLong = (s: string): string => {
    // IOS short names: Gi -> GigabitEthernet, Te -> TenGigabitEthernet,
    // Fa -> FastEthernet, Et -> Ethernet.
    const m = s.match(/^(Gi|Te|Fa|Et)(\d.*)$/i);
    if (!m) return s;
    const prefix: Record<string, string> = {
      Gi: 'GigabitEthernet',
      Te: 'TenGigabitEthernet',
      Fa: 'FastEthernet',
      Et: 'Ethernet',
    };
    return (prefix[m[1][0].toUpperCase() + m[1][1].toLowerCase()] ?? m[1]) + m[2];
  };
  const num = (s: string): bigint => BigInt(s.replace(/[,\s]/g, ''));
  // Sum broadcast and unicast to get a total packet count. Some IOS
  // versions omit multicast from the table; the prose path can fill
  // in for that, but for the chart the unicast+broadcast sum is good
  // enough.
  const sumPkts = (row: string[]): bigint | undefined => {
    const cols = [inUcastCol, inBcastCol, outUcastCol, outBcastCol];
    if (cols.some((c) => c < 0)) return undefined;
    const inU = row[inUcastCol] ?? '0';
    const inB = row[inBcastCol] ?? '0';
    const outU = row[outUcastCol] ?? '0';
    const outB = row[outBcastCol] ?? '0';
    return num(inU) + num(inB) + num(outU) + num(outB);
  };
  const perIfaceTotalPkts = new Map<string, { in: bigint; out: bigint }>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // Stop on second header (e.g. "Port InErrors OutErrors ...")
    if (/^Port\b/i.test(l) && /\bInOctets\b/i.test(l)) break;
    const cols = l.split(/\s+/);
    if (cols.length < header.length) continue;
    const raw = cols[0];
    // Skip "Port" pseudo-row.
    if (!raw || raw.toLowerCase() === 'port') continue;
    const name = shortToLong(raw);
    const inOct = num(cols[inOctCol]);
    const outOct = num(cols[outOctCol]);
    // Total pkts
    let inPkts: bigint | undefined;
    let outPkts: bigint | undefined;
    if (inUcastCol >= 0 && inBcastCol >= 0) {
      inPkts = num(cols[inUcastCol]) + num(cols[inBcastCol]);
    }
    if (outUcastCol >= 0 && outBcastCol >= 0) {
      outPkts = num(cols[outUcastCol]) + num(cols[outBcastCol]);
    }
    out.push({
      name,
      inOctets: inOct,
      outOctets: outOct,
      inPackets: inPkts,
      outPackets: outPkts,
    });
  }
  return out;
}

// Old prose parser — kept for the secondary call from
// `fetchIosSshCounters` so we can harvest inErrors/outErrors/inCrcErrors
// that `show interfaces counters` doesn't show.
function parseIosCountersProse(output: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  if (!output) return out;
  const lines = output.split('\n');
  let current: InterfaceCounters | null = null;
  let inOctets: bigint | undefined;
  let outOctets: bigint | undefined;
  let inPackets: bigint | undefined;
  let outPackets: bigint | undefined;
  const bigFromText = (s: string | undefined): bigint | undefined => {
    if (!s) return undefined;
    try {
      return BigInt(s.replace(/[,\s]/g, ''));
    } catch {
      return undefined;
    }
  };
  const flush = () => {
    if (current && (inOctets !== undefined || outOctets !== undefined || inPackets !== undefined || outPackets !== undefined)) {
      current.inOctets = inOctets;
      current.outOctets = outOctets;
      current.inPackets = inPackets;
      current.outPackets = outPackets;
      out.push(current);
    }
    current = null;
    inOctets = outOctets = inPackets = outPackets = undefined;
  };
  const headerRe = /^([A-Za-z][\w./-]+)\s+is\s+(up|down|administratively down|admin down)/i;
  const pktRe = /^\s*(\d+)\s+packets?\s+input.*?(\d+)\s+bytes?/i;
  const octetInputRe = /^\s*(\d+)\s+input bytes\b/i;
  const octetOutputRe = /^\s*(\d+)\s+output bytes\b/i;
  // IOS sometimes prints the OUTPUT side first as "X packets output, Y bytes":
  //   12345 packets output, 2345678 bytes, 0 underruns
  const pktOutRe = /^\s*(\d+)\s+packets?\s+output.*?(\d+)\s+bytes?/i;
  const errRe = /^\s*(\d+)\s+input errors.*?\b(\d+)\s+CRC\b/i;
  const outErrRe = /^\s*(\d+)\s+output errors\b/i;
  // discards often appear as "0 input packets dropped" or on the queue line.
  const dropRe = /^\s*(\d+)\s+(?:input\s+)?packets?\s+dropped\b/i;
  const dropOutRe = /^\s*(\d+)\s+output\s+packets?\s+dropped\b/i;
  const totalOutDropsRe = /Total output drops:\s*(\d+)/i;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hm = headerRe.exec(trimmed);
    if (hm) {
      flush();
      current = { name: hm[1] };
      continue;
    }
    if (!current) continue;
    const pm = pktRe.exec(trimmed);
    if (pm) {
      inPackets = BigInt(pm[1]);
      inOctets = bigFromText(pm[2]);
      continue;
    }
    const oiRe = octetInputRe.exec(trimmed);
    if (oiRe) {
      inOctets = bigFromText(oiRe[1]);
      continue;
    }
    const ooRe = octetOutputRe.exec(trimmed);
    if (ooRe) {
      outOctets = bigFromText(ooRe[1]);
      continue;
    }
    const pmOut = pktOutRe.exec(trimmed);
    if (pmOut) {
      outPackets = BigInt(pmOut[1]);
      outOctets = bigFromText(pmOut[2]);
      continue;
    }
    const erRe = errRe.exec(trimmed);
    if (erRe) {
      current.inErrors = BigInt(erRe[1]);
      current.inCrcErrors = BigInt(erRe[2]);
      continue;
    }
    const oeRe = outErrRe.exec(trimmed);
    if (oeRe) {
      current.outErrors = BigInt(oeRe[1]);
      continue;
    }
    const drIn = dropRe.exec(trimmed);
    if (drIn) {
      current.inDiscards = BigInt(drIn[1]);
      continue;
    }
    const drOut = dropOutRe.exec(trimmed);
    if (drOut) {
      current.outDiscards = BigInt(drOut[1]);
      continue;
    }
    const totDrops = totalOutDropsRe.exec(trimmed);
    if (totDrops) {
      current.outDiscards = BigInt(totDrops[1]);
      continue;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Vendor router
// ---------------------------------------------------------------------------

async function fetchInterfaceCounters(device: Device): Promise<FetchResult> {
  const vendor = (device.vendor ?? '').toLowerCase();
  if (vendor === 'juniper') {
    // Try RESTCONF first (fast, structured). If it answers but emits no
    // <traffic-statistics> (cRPD has no data-plane counters on its RESTCONF
    // RPC), fall back to SSH `show interfaces statistics` which on cRPD proxies
    // /proc/net/dev.
    const r = await fetchJunosCounters(device.ip);
    const gotCounters = r.interfaces.some((i) => i.inOctets != null || i.outOctets != null);
    if (r.ok && gotCounters) return r;
    console.warn(`[counters] Junos RPC for ${device.ip} returned ${r.interfaces.length} ifaces but no traffic-statistics; falling back to SSH`);
    const ssh = await fetchJunosSshCounters(device.ip);
    if (ssh.ok) return ssh;
    // SSH also failed — return RESTCONF result so the UI can show what we have.
    return r.ok ? { ...r, error: ssh.error ?? r.error } : ssh;
  }
  if (vendor === 'arista') return fetchEosCounters(device.ip);
  if (vendor === 'ios') return fetchIosSshCounters(device.ip);
  // Default + 'cisco' (IOS-XE): try RESTCONF first (matches operational data
  // path on IOS-XE 16+/17.x), fall back to SSH `show interfaces statistics`
  // if RESTCONF returns 4xx/5xx/timeout. Note (gotcha #14): RESTCONF on
  // IOS-XE 17.x is documented as unreliable, so the SSH fallback is the
  // durable path for lab devices regardless.
  const rest = await fetchIosxeCounters(device.ip);
  if (rest.ok) return rest;
  console.warn(`[counters] IOS-XE RESTCONF failed for ${device.ip} (${rest.error}); falling back to SSH`);
  const ssh = await fetchIosSshCounters(device.ip);
  if (ssh.ok) return ssh;
  return { ...ssh, error: `restconf: ${rest.error ?? '?'}; ssh: ${ssh.error ?? '?'}` };
}

// cRPD exposes Linux /proc/net/dev counters via SSH `show interfaces statistics`.
// On real Junos this command returns the same data as the RESTCONF detail
// form, so this path is universally valid -- it just takes longer than RESTCONF.
async function fetchJunosSshCounters(host: string): Promise<FetchResult> {
  const started = Date.now();
  const collectMs = () => Date.now() - started;
  try {
    const result = await runIosxeSshCommand(host, 'show interfaces extensive', {
      port: JUNOS_SSH_PORT,
      username: JUNOS_API_USER,
      password: JUNOS_API_PASSWORD,
      timeoutMs: 30000,
    });
    if (!result.ok) {
      return {
        ok: false,
        source: 'junos-ssh',
        interfaces: [],
        collectMs: collectMs(),
        error: result.error ?? 'Junos SSH failed',
      };
    }
    const interfaces = parseJunosCliStats(result.output);
    return { ok: true, source: 'junos-ssh', interfaces, collectMs: collectMs() };
  } catch (err) {
    return {
      ok: false,
      source: 'junos-ssh',
      interfaces: [],
      collectMs: collectMs(),
      error: err instanceof Error ? err.message : 'Junos SSH failed',
    };
  }
}

// Parse `show interfaces extensive` from Junos / cRPD. Header lines:
//
//   Physical interface: ge-0/0/0, Enabled, Physical link is Up
// or:
//   Logical interface: ge-0/0/0.0 (Index 70) (SNMP ifIndex 521)
//
// Below the header, look for:
//   Traffic statistics:
//    Input  bytes  :              1234567                    56 bps
//    Output bytes  :              2345678                    78 bps
//    Input  packets:                  123
//    Output packets:                  456
//    Input  errors:                     0
//    Output errors:                     0
//    Input  drops :                     0
//    Output drops :                     0
//
// cRPD's "Traffic statistics:" section is identical to real Junos;
// the regex tolerates any spacing and the optional ":   56 bps" rate tail.
function parseJunosCliStats(output: string): InterfaceCounters[] {
  const out: InterfaceCounters[] = [];
  if (!output) return out;
  const lines = output.split(/\r?\n/);
  const ifaceRe = /^\s*(?:Logical interface|Physical interface)\s+([\w./-]+)/i;
  const nameRe = /^([a-zA-Z][\w/-]+?)(?:\.\d+)?$/;
  // `Traffic statistics:` opens the counter block for the current interface.
  // Below it, look for "<Input|Output> <label>:" lines. Real Junos uses
  // "Input  bytes  :" (multiple spaces); cRPD uses "Input bytes:".
  const statLineRe = (label: string) =>
    new RegExp(`^\\s*(?:Input|Output)\\s+${label}\\s*:\\s*([\\d,]+)`, 'i');
  const fieldMap: Array<[keyof InterfaceCounters, RegExp]> = [
    ['inPackets', statLineRe('packets')],
    ['outPackets', statLineRe('packets')], // same line; picked below by side
    ['inOctets', statLineRe('bytes')],
    ['outOctets', statLineRe('bytes')],
    ['inErrors', statLineRe('errors')],
    ['outErrors', statLineRe('errors')],
    ['inDiscards', statLineRe('drops')],
    ['outDiscards', statLineRe('drops')],
  ];
  let current: InterfaceCounters | null = null;
  let inTrafficBlock = false;
  const flush = () => {
    if (current) out.push(current);
    current = null;
    inTrafficBlock = false;
  };
  // The regex above matches Input|Output symmetrically, so we need a side
  // discriminator per match. Detect by stripping the matched label and
  // checking the leading word.
  const sideOf = (line: string): 'in' | 'out' => (/^\s*Output\b/i.test(line) ? 'out' : 'in');
  const num = (s: string): bigint => BigInt(s.replace(/[,\s]/g, ''));
  for (const raw of lines) {
    const line = raw.replace(/\u0000/g, ''); // strip stray NULs from cRPD
    const header = ifaceRe.exec(line);
    if (header) {
      flush();
      const phys = (header[1].match(nameRe)?.[1] ?? header[1]).replace(/\.\d+$/, '');
      current = { name: phys };
      continue;
    }
    if (!current) continue;
    if (/^\s*Traffic statistics\s*:/i.test(line)) {
      inTrafficBlock = true;
      continue;
    }
    // End the traffic block when we hit another section header.
    if (inTrafficBlock && /^\s*(?:Logical interface|Physical interface|Protocol|Device flags|Input \w+ \(|Local:|Destination:|Interface flags|Generation|Route|Encapsulation)/i.test(line)) {
      inTrafficBlock = false;
    }
    if (!inTrafficBlock) continue;
    for (const [k, re] of fieldMap) {
      const m = re.exec(line);
      if (!m) continue;
      const side = sideOf(line);
      const isIn = side === 'in';
      const targetKey = (
        (k === 'inOctets' && isIn) || (k === 'outOctets' && !isIn) ? (isIn ? 'inOctets' : 'outOctets') :
        (k === 'inPackets' && isIn) || (k === 'outPackets' && !isIn) ? (isIn ? 'inPackets' : 'outPackets') :
        (k === 'inErrors' && isIn) || (k === 'outErrors' && !isIn) ? (isIn ? 'inErrors' : 'outErrors') :
        (k === 'inDiscards' && isIn) || (k === 'outDiscards' && !isIn) ? (isIn ? 'inDiscards' : 'outDiscards') :
        null
      );
      if (targetKey && current[targetKey as keyof InterfaceCounters] === undefined) {
        try {
          (current as Record<string, unknown>)[targetKey] = num(m[1]);
        } catch {
          /* ignore */
        }
      }
    }
  }
  flush();
  return out.filter((i) => i.inOctets !== undefined || i.outOctets !== undefined);
}

// ---------------------------------------------------------------------------
// Persistence + history API (used by route)
// ---------------------------------------------------------------------------

async function persistSamples(
  deviceId: string,
  source: string,
  interfaces: InterfaceCounters[],
): Promise<number> {
  if (!interfaces.length) return 0;
  const rows: Prisma.InterfaceCounterSampleCreateManyInput[] = interfaces.map((i) => ({
    deviceId,
    interfaceName: i.name,
    source,
    inOctets: i.inOctets ?? null,
    outOctets: i.outOctets ?? null,
    inPackets: i.inPackets ?? null,
    outPackets: i.outPackets ?? null,
    inErrors: i.inErrors ?? null,
    outErrors: i.outErrors ?? null,
    inDiscards: i.inDiscards ?? null,
    outDiscards: i.outDiscards ?? null,
    inCrcErrors: i.inCrcErrors ?? null,
  }));
  await prisma.interfaceCounterSample.createMany({ data: rows });
  return rows.length;
}

async function pruneOldSamples(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 3_600_000);
  const res = await prisma.interfaceCounterSample.deleteMany({ where: { capturedAt: { lt: cutoff } } });
  return res.count;
}

// JSON-safe serialization for the BigInt columns (Express' res.json bails on BigInt).
function toJsonSafe<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? v.toString() : (v as unknown);
  }
  return out;
}

// Sorted list of managed devices for polling. Excludes UNKNOWN/MAINTENANCE to
// avoid hammering unreachable boxes.
async function listManagedDevices(): Promise<Device[]> {
  return prisma.device.findMany({
    where: { status: { in: ['MANAGED', 'ONLINE'] } },
    orderBy: { name: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// One-shot poll entry points (used by scheduler and on-demand refresh)
// ---------------------------------------------------------------------------

export async function pollDeviceCounters(deviceId: string): Promise<{
  ok: boolean;
  source?: string;
  sampleCount: number;
  error?: string;
  collectMs: number;
}> {
  const started = Date.now();
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return { ok: false, sampleCount: 0, collectMs: 0, error: 'Device not found' };
  const result = await fetchInterfaceCounters(device);
  if (!result.ok) {
    return { ok: false, sampleCount: 0, collectMs: result.collectMs, error: result.error };
  }
  const inserted = await persistSamples(device.id, result.source, result.interfaces);
  return { ok: true, source: result.source, sampleCount: inserted, collectMs: result.collectMs };
}

export async function pollAllDevicesCounters(): Promise<void> {
  if (!FEATURE_ENABLED) return;
  const devices = await listManagedDevices();
  for (let i = 0; i < devices.length; i += PARALLEL_DEVICES) {
    const batch = devices.slice(i, i + PARALLEL_DEVICES);
    await Promise.all(batch.map(async (d) => {
      try {
        const r = await fetchInterfaceCounters(d);
        if (!r.ok) {
          console.warn(`[counters] ${d.name} (${d.ip}): ${r.error}`);
          return;
        }
        await persistSamples(d.id, r.source, r.interfaces);
      } catch (err) {
        console.error(`[counters] ${d.name} failed:`, err);
      }
    }));
  }
  const deleted = await pruneOldSamples();
  if (deleted > 0) {
    console.log(`[counters] pruned ${deleted} samples older than ${RETENTION_HOURS}h`);
  }
}

// ---------------------------------------------------------------------------
// Read API used by routes
// ---------------------------------------------------------------------------

export type CounterSampleJson = {
  id: string;
  deviceId: string;
  interfaceName: string;
  source: string;
  capturedAt: string;
  inOctets: string | null;
  outOctets: string | null;
  inPackets: string | null;
  outPackets: string | null;
  inErrors: string | null;
  outErrors: string | null;
  inDiscards: string | null;
  outDiscards: string | null;
  inCrcErrors: string | null;
};

function sampleToJson(s: {
  id: string;
  deviceId: string;
  interfaceName: string;
  source: string;
  capturedAt: Date;
  inOctets: bigint | null;
  outOctets: bigint | null;
  inPackets: bigint | null;
  outPackets: bigint | null;
  inErrors: bigint | null;
  outErrors: bigint | null;
  inDiscards: bigint | null;
  outDiscards: bigint | null;
  inCrcErrors: bigint | null;
}): CounterSampleJson {
  return {
    id: s.id,
    deviceId: s.deviceId,
    interfaceName: s.interfaceName,
    source: s.source,
    capturedAt: s.capturedAt.toISOString(),
    inOctets: s.inOctets?.toString() ?? null,
    outOctets: s.outOctets?.toString() ?? null,
    inPackets: s.inPackets?.toString() ?? null,
    outPackets: s.outPackets?.toString() ?? null,
    inErrors: s.inErrors?.toString() ?? null,
    outErrors: s.outErrors?.toString() ?? null,
    inDiscards: s.inDiscards?.toString() ?? null,
    outDiscards: s.outDiscards?.toString() ?? null,
    inCrcErrors: s.inCrcErrors?.toString() ?? null,
  };
}

export type InterfaceCounterHistory = {
  interfaceName: string;
  samples: CounterSampleJson[];
  /**
   * Derived in/out bps between consecutive samples (one fewer than
   * `samples.length`). `null` when delta is undefined (counter rolled,
   * missing in baseline, etc.) — the chart skips nulls visually.
   */
  rates: Array<{ t: string; inBps: number | null; outBps: number | null }>;
};

/**
 * Returns up to `limit` most recent samples per interface for the device,
 * with derived per-interval in/out bps rates. Default 60 minutes is enough
 * for a 1-dot-per-second chart at 60 points.
 */
export async function getDeviceCounterHistory(
  deviceId: string,
  options: { interfaceName?: string; sinceMinutes?: number; limit?: number } = {},
): Promise<{ deviceId: string; interfaces: InterfaceCounterHistory[] }> {
  const sinceMinutes = options.sinceMinutes ?? 60;
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const limit = options.limit ?? 600;

  const where: Prisma.InterfaceCounterSampleWhereInput = {
    deviceId,
    capturedAt: { gte: since },
    ...(options.interfaceName ? { interfaceName: options.interfaceName } : {}),
  };

  const rows = await prisma.interfaceCounterSample.findMany({
    where,
    orderBy: { capturedAt: 'asc' },
    take: limit,
  });

  const byIface = new Map<string, CounterSampleJson[]>();
  for (const row of rows) {
    const json = sampleToJson(row);
    const list = byIface.get(json.interfaceName) ?? [];
    list.push(json);
    byIface.set(json.interfaceName, list);
  }

  const interfaces: InterfaceCounterHistory[] = [];
  for (const [name, samples] of byIface.entries()) {
    const rates = computeRates(samples);
    interfaces.push({ interfaceName: name, samples, rates });
  }
  // sort alphabetically for stable UI
  interfaces.sort((a, b) => a.interfaceName.localeCompare(b.interfaceName));
  return { deviceId, interfaces };
}

function computeRates(samples: CounterSampleJson[]): Array<{ t: string; inBps: number | null; outBps: number | null }> {
  const out: Array<{ t: string; inBps: number | null; outBps: number | null }> = [];
  for (let i = 0; i < samples.length; i++) {
    if (i === 0) {
      out.push({ t: samples[i].capturedAt, inBps: null, outBps: null });
      continue;
    }
    const prev = samples[i - 1];
    const curr = samples[i];
    const dtMs = new Date(curr.capturedAt).getTime() - new Date(prev.capturedAt).getTime();
    if (dtMs <= 0) {
      out.push({ t: curr.capturedAt, inBps: null, outBps: null });
      continue;
    }
    out.push({
      t: curr.capturedAt,
      inBps: deriveRate(prev.inOctets, curr.inOctets, dtMs),
      outBps: deriveRate(prev.outOctets, curr.outOctets, dtMs),
    });
  }
  return out;
}

function deriveRate(prev: string | null, curr: string | null, dtMs: number): number | null {
  if (prev === null || curr === null) return null;
  let p: bigint, c: bigint;
  try {
    p = BigInt(prev);
    c = BigInt(curr);
  } catch {
    return null;
  }
  // Counter rolled over (or device rebooted) — refuse to chart the gap.
  if (c < p) return null;
  const deltaBytes = c - p;
  // bps = bytes * 8 / seconds
  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return null;
  const bits = Number(deltaBytes) * 8;
  if (!Number.isFinite(bits)) return null;
  return bits / dtSec;
}

/** Most recent single sample per interface (latest cumulative counters).
 *
 * Implementation note (2026-09-19):
 *   First attempt used `prisma.$queryRaw` with `DISTINCT ON (interface_name)`,
 *   but Express returned 500 on `/latest` — the throw appeared to come from
 *   how Prisma materialised the BigInt column into a JS value when the table
 *   is empty. We use a tiny `findMany` + Map dedup instead; cheaper to reason
 *   about, no DB-specific syntax, no risk of doing the BigInt dance twice.
 */
export async function getLatestCounters(deviceId: string): Promise<{
  deviceId: string;
  capturedAt: string | null;
  interfaces: Array<CounterSampleJson & { deviceId: string }>;
}> {
  const rows = await prisma.interfaceCounterSample.findMany({
    where: { deviceId },
    orderBy: [{ interfaceName: 'asc' }, { capturedAt: 'desc' }],
    take: 1000,
  });
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    // First row per interfaceName wins because we sort capturedAt DESC.
    if (!latest.has(row.interfaceName)) latest.set(row.interfaceName, row);
  }
  const interfaces: Array<CounterSampleJson & { deviceId: string }> = [];
  let mostRecent: Date | null = null;
  for (const row of latest.values()) {
    const json = sampleToJson(row);
    interfaces.push({ ...json, deviceId: row.deviceId });
    if (!mostRecent || row.capturedAt > mostRecent) mostRecent = row.capturedAt;
  }
  return {
    deviceId,
    capturedAt: mostRecent ? mostRecent.toISOString() : null,
    interfaces,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let pollTimer: NodeJS.Timeout | null = null;

export function scheduleInterfaceCounterPoll(intervalSeconds: number): void {
  if (pollTimer) return;
  if (!FEATURE_ENABLED) {
    console.log('[counters] INTERFACE_COUNTERS_ENABLED=false; scheduler disabled');
    return;
  }
  const intervalMs = Math.max(intervalSeconds, 10) * 1000;
  console.log(`[counters] auto-poll every ${intervalMs / 1000}s, retention ${RETENTION_HOURS}h`);
  // First run after a short delay so the rest of the boot sequence (REST
  // client pools, scheduler queue) has finished initialising.
  setTimeout(() => {
    void pollAllDevicesCounters().catch((err) => console.error('[counters] first poll failed:', err));
  }, 15000);
  pollTimer = setInterval(() => {
    void pollAllDevicesCounters().catch((err) => console.error('[counters] poll tick failed:', err));
  }, intervalMs);
}

export function stopInterfaceCounterPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function interfaceCounterFeatureEnabled(): boolean {
  return FEATURE_ENABLED;
}

export const interfaceCounterConfig = {
  pollIntervalSeconds: POLL_INTERVAL_SECONDS,
  retentionHours: RETENTION_HOURS,
};

// Default-config helpers exported for tests.
export const __test = { fetchInterfaceCounters, parseJunosTrafficStats, parseEosCounters, parseIosxeCounters, parseIosCountersTabular, parseIosCountersProse, toJsonSafe };
