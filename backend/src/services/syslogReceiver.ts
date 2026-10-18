/**
 * UDP syslog receiver.
 *
 * Embedded in the backend process — uses Node's built-in `dgram` so no
 * extra dependencies. Listens for incoming syslog packets from Junos
 * devices (or any relay), parses them, and writes directly to the
 * `DeviceLog` table.
 *
 * SECURITY (C8, see docs/agents/16-security-audit-preprod.md):
 *   * Source-IP allowlist (`SYSLOG_ALLOWED_CIDRS` env, default
 *     `10.10.20.0/24,127.0.0.0/8`). Packets from other prefixes are
 *     dropped silently. Prevents spoofed log injection.
 *   * Per-source-IP token bucket (configurable, default 50 pkts/s
 *     burst 200). Single attacker cannot starve the receiver.
 *   * Bind 0.0.0.0:1514 inside the container, but the docker-compose
 *     host port publish is constrained to the lab NIC. Operators can
 *     ALSO restrict the bind address to a specific interface via
 *     `SYSLOG_BIND_ADDRESS=10.10.20.20`.
 *
 * Ingestion path:
 *   - accept packet on UDP port (default 1514 — unprivileged; 514 needs
 *     `cap_add: NET_BIND_SERVICE` in docker-compose or running as root;
 *     Junos accepts any destination port via `set system syslog host X port Y`)
 *   - match the device by looking up the source IP / hostname in `Device.ip`
 *     and `Device.name`
 *   - persist the batch via `createMany` so one query handles N lines per packet
 *   - on success, notify the alert evaluator so matching rules fire within
 *     `LOG_ALERT_INTERVAL_SECONDS`
 */

import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { prisma } from '../lib/prisma.js';
import {
  type LogEntry,
  persistLogs,
} from './logs.js';
import {
  type ParsedSyslog,
  parseSyslogPacket,
} from './syslogParser.js';
import {
  emitAlertsForLogs,
} from './logAlerts.js';

// -----------------------------------------------------------------------------
// Source-IP allowlist (security: C8)
// -----------------------------------------------------------------------------
// CIDR-list env (comma separated). Empty => reject everything unless
// `SYSLOG_ALLOW_ALL=true` (lab mode ONLY — never set in prod).

interface SourceBucket {
  /** Tokens remaining (refill at rate per second). */
  tokens: number;
  /** Last refill timestamp. */
  lastRefill: number;
}

interface ParsedCidr {
  /** 32-bit network mask (network order). */
  base: number;
  /** Prefix length. */
  prefix: number;
}

function parseCidr(s: string): ParsedCidr | null {
  const [ip, prefixStr] = s.trim().split('/');
  const prefix = Number(prefixStr ?? '32');
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return null;
  }
  const base =
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return { base, prefix };
}

function ipToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  const out =
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0;
  return Number.isFinite(out) ? out : null;
}

function ipMatchesCidr(addr: string, cidr: ParsedCidr): boolean {
  const ipInt = ipToInt(addr);
  if (ipInt === null) return false;
  if (cidr.prefix === 0) return true;
  const mask = cidr.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return (ipInt & mask) === (cidr.base & mask);
}

let _allowlistCache: { raw: string; cidrs: ParsedCidr[] } | null = null;
function getAllowlist(): ParsedCidr[] {
  const raw = process.env.SYSLOG_ALLOWED_CIDRS || '10.10.20.0/24,127.0.0.0/8';
  if (_allowlistCache && _allowlistCache.raw === raw) return _allowlistCache.cidrs;
  const cidrs = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== null);
  _allowlistCache = { raw, cidrs };
  return cidrs;
}

function isSourceAllowed(addr: string): boolean {
  if (process.env.SYSLOG_ALLOW_ALL === 'true') return true; // lab override
  const cidrs = getAllowlist();
  if (cidrs.length === 0) return false;
  return cidrs.some((c) => ipMatchesCidr(addr, c));
}

// Per-source-IP token bucket — limit ingestion rate per attacker.
const perSourceBuckets = new Map<string, SourceBucket>();
const SYSLOG_RATE_PER_SEC = Number(process.env.SYSLOG_RATE_PER_SEC ?? 50);
const SYSLOG_BURST = Number(process.env.SYSLOG_BURST ?? 200);

function consumeToken(addr: string): boolean {
  const now = Date.now();
  const bucket = perSourceBuckets.get(addr) ?? {
    tokens: SYSLOG_BURST,
    lastRefill: now,
  };
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(SYSLOG_BURST, bucket.tokens + elapsedSec * SYSLOG_RATE_PER_SEC);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    perSourceBuckets.set(addr, bucket);
    return false;
  }
  bucket.tokens -= 1;
  perSourceBuckets.set(addr, bucket);
  return true;
}

// Periodically purge buckets that have been idle for > 1 hour so the
// Map doesn't grow unbounded when many sources probe once.
const BUCKET_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [addr, b] of perSourceBuckets) {
    if (now - b.lastRefill > BUCKET_TTL_MS) perSourceBuckets.delete(addr);
  }
}, 5 * 60 * 1000).unref();

export type SyslogReceiverOptions = {
  /** 1514 by default — well-known alt for syslog, no root needed. */
  port: number;
  /** Bind address. Default from `SYSLOG_BIND_ADDRESS` env or `0.0.0.0`. */
  address: string;
  /** Where unmatched hostnames get tagged when no Device row matches. */
  hostnameFallback: string;
};

const DEFAULT_OPTS: SyslogReceiverOptions = {
  port: 1514,
  address: process.env.SYSLOG_BIND_ADDRESS || '0.0.0.0',
  hostnameFallback: 'unknown-device',
};

type ActiveSocket = dgram.Socket & { _netconsoleClosed?: boolean };

let activeSocket: ActiveSocket | null = null;
let activeAddr: AddressInfo | null = null;

export function defaultSyslogPort(): number {
  const fromEnv = Number(process.env.SYSLOG_UDP_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_OPTS.port;
}

export function isSyslogReceiverRunning(): boolean {
  return activeSocket !== null;
}

/**
 * Match a syslog packet's hostname / IP to a Device row.
 *
 * Devices send syslog with their loopback or management source-address,
 * which should match `Device.ip`. Hostname is a fallback in case a relay
 * rewrites the source IP.
 */
async function resolveDeviceFromPacket(parsed: ParsedSyslog, senderIp: string | null): Promise<{ id: string; name: string } | null> {
  // Try IP first — most reliable
  if (senderIp) {
    const byIp = await prisma.device.findFirst({ where: { ip: senderIp }, select: { id: true, name: true } });
    if (byIp) return byIp;
  }

  // Fallback: hostname match (case-insensitive)
  if (parsed.hostname) {
    const byName = await prisma.device.findFirst({
      where: { name: { equals: parsed.hostname, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (byName) return byName;
  }

  return null;
}

/**
 * Flush a batch of parsed syslog lines to the DB and fire alert matches.
 * Logs are persisted directly into DeviceLog without a Job row so they
 * don't appear in the jobs list.
 * Returns the number of rows actually persisted.
 */
async function flushPacket(
  parsed: ParsedSyslog[],
  senderIp: string | null,
): Promise<number> {
  if (parsed.length === 0) return 0;

  const firstWithHost = parsed.find((entry) => entry.hostname);
  const probe = firstWithHost ?? parsed[0];
  const device = await resolveDeviceFromPacket(probe, senderIp);

  const hostname = device?.name ?? probe.hostname ?? DEFAULT_OPTS.hostnameFallback;
  const entries: LogEntry[] = parsed.map((entry) => ({
    timestamp: entry.timestamp.toISOString(),
    severity: entry.severity,
    facility: entry.facility,
    hostname: entry.hostname || hostname,
    program: entry.program,
    pid: entry.pid,
    tag: entry.tag,
    message: entry.message,
  }));

  // Persist logs directly without a synthetic Job row.
  // Logs appear in the device logs page but not in the jobs list.
  const persisted = await persistLogs(device?.id ?? null, entries, hostname);
  if (persisted > 0) {
    // Fire alert evaluation in the background; never block the socket.
    void emitAlertsForLogs(device?.id ?? null, entries);
  }
  return persisted;
}

export function startSyslogReceiver(opts?: Partial<SyslogReceiverOptions>): {
  socket: dgram.Socket;
  port: number;
} {
  if (activeSocket) {
    return { socket: activeSocket, port: activeAddr?.port ?? opts?.port ?? DEFAULT_OPTS.port };
  }

  const options: SyslogReceiverOptions = { ...DEFAULT_OPTS, ...(opts ?? {}) };
  const socket: ActiveSocket = dgram.createSocket('udp4');
  let inFlight = 0;
  const MAX_IN_FLIGHT = 32;

  // SECURITY (C8): Track how many packets were dropped due to source-
  // IP filter or rate-limit, so an attacker can't silently DoS the
  // log path without leaving a signal in container logs.
  let droppedBySourceFilter = 0;
  let droppedByRateLimit = 0;

  setInterval(() => {
    if (droppedBySourceFilter > 0 || droppedByRateLimit > 0) {
      if (droppedBySourceFilter > 0) {
        console.warn(
          `[syslog] dropped ${droppedBySourceFilter} packets from non-allowlisted source in last 60s (CIDR allowlist = ${process.env.SYSLOG_ALLOWED_CIDRS || '10.10.20.0/24,127.0.0.0/8'})`,
        );
        droppedBySourceFilter = 0;
      }
      if (droppedByRateLimit > 0) {
        console.warn(`[syslog] dropped ${droppedByRateLimit} packets by per-source rate limit in last 60s`);
        droppedByRateLimit = 0;
      }
    }
  }, 60_000).unref();

  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const senderIp = rinfo.address && rinfo.address !== '0.0.0.0' ? rinfo.address : null;

    // SECURITY (C8): drop packets from sources not in the allowlist.
    if (!senderIp || !isSourceAllowed(senderIp)) {
      droppedBySourceFilter += 1;
      return;
    }
    if (!consumeToken(senderIp)) {
      droppedByRateLimit += 1;
      return;
    }

    if (inFlight >= MAX_IN_FLIGHT) {
      // Backpressure: drop and log. The kernel buffer still accepts incoming
      // packets but we don't ack faster than the DB can ingest.
      console.warn(`[syslog] backpressure: dropping packet from ${senderIp}:${rinfo.port}`);
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        const parsed = parseSyslogPacket(msg);
        await flushPacket(parsed, senderIp);
      } catch (error) {
        console.error(`[syslog] flush failed from ${senderIp}:${rinfo.port}: ${(error as Error).message}`);
      } finally {
        inFlight -= 1;
      }
    })();
  });

  socket.on('error', (err) => {
    console.error('[syslog] socket error', err);
  });

  socket.bind(options.port, options.address, () => {
    activeAddr = socket.address();
    const address = activeAddr.address === '0.0.0.0' ? 'all interfaces' : activeAddr.address;
    const allowAll = process.env.SYSLOG_ALLOW_ALL === 'true';
    console.log(
      `[syslog] UDP receiver listening on ${address}:${activeAddr.port}` +
        ` (source allowlist=${allowAll ? 'ALL (LAB MODE)' : process.env.SYSLOG_ALLOWED_CIDRS || '10.10.20.0/24,127.0.0.0/8'}; rate=${SYSLOG_RATE_PER_SEC} pps, burst=${SYSLOG_BURST})`,
    );
  });

  activeSocket = socket;
  return { socket, port: options.port };
}

export function stopSyslogReceiver(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!activeSocket) {
      resolve();
      return;
    }
    const socket = activeSocket;
    activeSocket = null;
    socket.close(() => {
      if (socket._netconsoleClosed) return;
      socket._netconsoleClosed = true;
      resolve();
    });
  });
}
