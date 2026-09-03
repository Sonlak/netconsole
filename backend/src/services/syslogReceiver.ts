/**
 * UDP syslog receiver.
 *
 * Embedded in the backend process — uses Node's built-in `dgram` so no
 * extra dependencies. Listens for incoming syslog packets from Junos
 * devices (or any relay), parses them, and writes directly to the
 * `DeviceLog` table.
 *
 * Resource budget: a UDP socket + a small JSON parser. The kernel already
 * buffers incoming datagrams, so the cost is the same as reading a few
 * KB from disk — typically <30 MB of RAM and <1% CPU for our scale.
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
  persistLogsForJob,
} from './logs.js';
import {
  type ParsedSyslog,
  parseSyslogPacket,
} from './syslogParser.js';
import {
  emitAlertsForLogs,
} from './logAlerts.js';

export type SyslogReceiverOptions = {
  /** 1514 by default — well-known alt for syslog, no root needed. */
  port: number;
  /** Bind address. `0.0.0.0` listens on all interfaces. */
  address: string;
  /** Where unmatched hostnames get tagged when no Device row matches. */
  hostnameFallback: string;
};

const DEFAULT_OPTS: SyslogReceiverOptions = {
  port: 1514,
  address: '0.0.0.0',
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
 * Build a synthetic Job row for a syslog ingest batch so we get the same
 * idempotency / dedupe behaviour as job-based collection.
 *
 * Why a Job row at all? `DeviceLog.jobId @unique` ties rows to a Job. For
 * UDP-batched syslog we point all rows in the same packet at one Job so
 * retries & deletes are coherent.
 */
async function claimSyntheticJobForPacket(deviceId: string | null): Promise<string> {
  const job = await prisma.job.create({
    data: {
      deviceId,
      type: 'GET_LOGS',
      status: 'SUCCESS',
      result: { source: 'syslog-udp', entries: [] },
      error: null,
    },
  });
  return job.id;
}

/**
 * Flush a batch of parsed syslog lines to the DB and fire alert matches.
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
  const jobId = await claimSyntheticJobForPacket(device?.id ?? null);
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

  const persisted = await persistLogsForJob(jobId, entries, hostname);
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

  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      // Backpressure: drop and log. The kernel buffer still accepts incoming
      // packets but we don't ack faster than the DB can ingest.
      console.warn(`[syslog] backpressure: dropping packet from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        const parsed = parseSyslogPacket(msg);
        const senderIp = rinfo.address && rinfo.address !== '0.0.0.0' ? rinfo.address : null;
        await flushPacket(parsed, senderIp);
      } catch (error) {
        console.error(`[syslog] flush failed from ${rinfo.address}:${rinfo.port}: ${(error as Error).message}`);
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
    console.log(`[syslog] UDP syslog receiver listening on ${address}:${activeAddr.port}`);
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
