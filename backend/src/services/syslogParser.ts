/**
 * BSD / RFC 3164 / RFC 5424 syslog parser.
 *
 * Mirrors `worker/netconsole_worker/parsers/syslog_rpc.py` so the same
 * packets are understood on both sides of the wire. Knows about Junos'
 * standard text format (no priority prefix on the wire for many devices,
 * `<priority>` prefix on others) and about the priority byte at the start
 * of a packet.
 *
 * Lines that we can't parse are still returned (timestamp=null, severity=INFO)
 * so the audit trail is complete; downstream consumer decides whether to keep.
 */

import { severityFromJunos, facilityFromJunos } from '../lib/logSeverity.js';

export type ParsedSyslog = {
  timestamp: Date;
  hostname: string;
  program: string | null;
  pid: number | null;
  tag: string | null;
  severity: ReturnType<typeof severityFromJunos>;
  facility: ReturnType<typeof facilityFromJunos>;
  message: string;
  raw: string;
};

// BSD-style priority prefix: `<165>` (10–191 octal would also work in theory,
// Junos almost always sends decimal).
const PRIORITY_RE = /^\s*<(\d+)>/;

// Standard-format message (RFC 3164 + Junos CLI style):
//   Sep  3 01:23:45 lab-jr1 mgd[12345]: UI_CMDLINE_READ_LINE: ...
//   Sep  3 01:23:45 lab-jr1 mgd: ...
const STANDARD_LINE_RE =
  /^(?:<\s*(\d+)\s*>)?(?<ts>\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<host>\S+)\s+(?<proc>[A-Za-z0-9_-]+)(?:\[(?<pid>\d+)\])?(?::\s*)?(?<rest>.*)$/;

// Structured-data (RFC 5424) message
const STRUCTURED_LINE_RE =
  /^<\s*(\d+)\s*>1\s+(?<ts>\S+)\s+(?<host>\S+)\s+(?<proc>\S+)\s+(?<pid>\S+)\s+(?<msgid>\S+)(?:\s+\S+)?\s+(?<rest>.*)$/;

// "Sep  3 01:23:45"
const SHORT_TS_RE = /^(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})$/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function safeInt(value: string | undefined): number | null {
  if (value === undefined || value === null || value === '' || value === '-') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;

  // ISO 8601 (RFC 5424)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // "Sep  3 01:23:45" — append the current year; if "future", roll back one year.
  const m = SHORT_TS_RE.exec(text);
  if (m) {
    const [, monthStr, dayStr, timeStr] = m;
    const month = MONTHS[monthStr];
    if (month === undefined) return null;
    const day = Number(dayStr);
    const [hh, mm, ss] = timeStr.split(':').map(Number);
    const now = new Date();
    let year = now.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, month, day, hh, mm, ss));
    // If the candidate is more than 7 days in the future, it must belong to last year.
    if (candidate.getTime() - now.getTime() > 7 * 86400 * 1000) {
      year -= 1;
      return new Date(Date.UTC(year, month, day, hh, mm, ss));
    }
    return candidate;
  }

  return null;
}

function priorityToSeverity(priority: number): ReturnType<typeof severityFromJunos> {
  const sev = priority & 0x07;
  const names = ['emergency', 'alert', 'critical', 'error', 'warning', 'notice', 'info', 'debug'];
  return severityFromJunos(names[Math.min(sev, names.length - 1)]);
}

function priorityToFacility(priority: number): ReturnType<typeof facilityFromJunos> {
  const fac = (priority >> 3) & 0xff;
  const byCode: Record<number, string> = {
    0: 'kern', 1: 'user', 2: 'mail', 3: 'daemon', 4: 'auth', 5: 'syslog',
    6: 'lpr', 7: 'news', 8: 'uucp', 9: 'cron', 10: 'authpriv', 11: 'ftp',
    12: 'ntp', 13: 'security', 14: 'console',
    16: 'local0', 17: 'local1', 18: 'local2', 19: 'local3',
    20: 'local4', 21: 'local5', 22: 'local6', 23: 'local7',
  };
  return facilityFromJunos(byCode[fac]);
}

export function parseSyslogLine(line: string): ParsedSyslog | null {
  const raw = line.trim();
  if (!raw) return null;

  // RFC 5424 first (the priority prefix is mandatory there)
  const sd = STRUCTURED_LINE_RE.exec(raw);
  if (sd && sd.groups) {
    const [, priorityStr, tsStr, host, proc, pidStr, msgid, ...rest] = sd as unknown as [string, string, string, string, string, string, string, string];
    const priority = Number(priorityStr);
    const message = rest.find((s) => typeof s === 'string' && s.length > 0) ?? '';
    const timestamp = parseTimestamp(tsStr) ?? new Date();
    return {
      timestamp,
      hostname: host,
      program: proc === '-' ? null : proc,
      pid: safeInt(pidStr),
      tag: msgid === '-' ? null : msgid,
      severity: priorityToSeverity(priority),
      facility: priorityToFacility(priority),
      message,
      raw,
    };
  }

  // RFC 3164 / Junos CLI
  const std = STANDARD_LINE_RE.exec(raw);
  if (std && std.groups) {
    const groups = std.groups as { ts?: string; host?: string; proc?: string; pid?: string; rest?: string };
    // The first capture group is the optional priority. Pull it from the original match,
    // not from groups, so we look it up correctly.
    const priorityStr = std[1];
    const priority = priorityStr !== undefined ? Number(priorityStr) : null;
    const rest = (groups.rest ?? '').replace(/^:\s*/, '').trim();
    const tagMatch = rest && /^([A-Z][A-Z0-9_]+):\s*/.exec(rest);
    const tag = tagMatch ? tagMatch[1] : null;
    const timestamp = parseTimestamp(groups.ts ?? '') ?? new Date();
    return {
      timestamp,
      hostname: groups.host ?? '',
      program: groups.proc ?? null,
      pid: safeInt(groups.pid),
      tag,
      severity: priority !== null ? priorityToSeverity(priority) : severityFromJunos(null),
      facility: priority !== null ? priorityToFacility(priority) : facilityFromJunos(null),
      message: tagMatch ? rest.replace(/^[A-Z][A-Z0-9_]+:\s*/, '') : rest,
      raw,
    };
  }

  // Unparseable — keep as-is so callers can still archive the raw line.
  return {
    timestamp: new Date(),
    hostname: '',
    program: null,
    pid: null,
    tag: null,
    severity: severityFromJunos(null),
    facility: facilityFromJunos(null),
    message: raw,
    raw,
  };
}

/**
 * Handle a packet that may contain one or more CRLF-separated log lines
 * (Junos usually sends one line per UDP datagram; some relays batch several).
 */
export function parseSyslogPacket(buf: Buffer | string): ParsedSyslog[] {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const out: ParsedSyslog[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSyslogLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Extract just the priority from a packet (used as a sanity check). */
export function peekPriority(buf: Buffer | string): number | null {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  const m = PRIORITY_RE.exec(text);
  return m ? Number(m[1]) : null;
}
