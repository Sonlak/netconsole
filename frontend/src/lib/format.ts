/**
 * Project-wide display timezone. The NetConsole operator works in Vietnam
 * (UTC+7), so all user-facing timestamps are formatted in this zone
 * regardless of the browser's locale. Backend timestamps arrive as ISO
 * strings (UTC), and `Asia/Ho_Chi_Minh` is a fixed +07:00 offset with no
 * DST, so this is stable year-round.
 *
 * See docs/agents/05-gotchas.md for the original "logs show 7 hours off"
 * symptom this constant fixes.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
};

const SHORT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
};

const COMPACT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: DISPLAY_TIME_ZONE,
};

export function formatVNDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  return date.toLocaleString('en-GB', DATE_TIME_OPTIONS).replace(',', '');
}

export function formatVNShortDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  return date.toLocaleString('en-GB', SHORT_DATE_TIME_OPTIONS).replace(',', '');
}

export function formatVNCompactDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  // en-GB yields "dd/mm/yyyy, hh:mm:ss" — turn ", " into " " for "yyyy-mm-dd hh:mm:ss".
  return date.toLocaleString('en-GB', COMPACT_DATE_TIME_OPTIONS).replace(',', '');
}

export function formatAbsolute(value: string | null | undefined): string {
  return formatVNCompactDateTime(value);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  const future = diffSec < 0;
  const unit = (n: number, label: string) => {
    const text = `${n}${label}`;
    return future ? `in ${text}` : `${text} ago`;
  };
  if (abs < 10) return 'just now';
  if (abs < 60) return unit(abs, 's');
  if (abs < 3600) return unit(Math.round(abs / 60), 'm');
  if (abs < 86400) return unit(Math.round(abs / 3600), 'h');
  if (abs < 86400 * 7) return unit(Math.round(abs / 86400), 'd');
  return formatAbsolute(value);
}

export function normalizeMac(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-f]/g, '');
}

export function matchesMacOrIp(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const macQ = normalizeMac(q);
  const macH = normalizeMac(haystack);
  if (macQ.length > 0 && macH.includes(macQ)) return true;
  return haystack.toLowerCase().includes(q);
}

export function summarizeJson(value: unknown, max = 160): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    if (!text) return '—';
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return 'Unreadable value';
  }
}

export function prettyJson(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const SENSITIVE_KEY = /password|secret|credential|community|token|passphrase/i;
const CONFIG_KEY = /^(config|content|runningConfig|committedContent|rollbackContent)$/i;

export function redactForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '••••';
      } else if (CONFIG_KEY.test(key) && typeof nested === 'string') {
        out[key] = `[config ${nested.length} chars]`;
      } else {
        out[key] = redactForDisplay(nested);
      }
    }
    return out;
  }
  return value;
}

export function formatUptime(seconds: number | null | undefined, sampledAt?: string | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  let total = Math.round(seconds);
  if (sampledAt) {
    const sampled = new Date(sampledAt).getTime();
    if (!Number.isNaN(sampled)) {
      total += Math.max(0, Math.round((Date.now() - sampled) / 1000));
    }
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 0)}m`;
}

export function formatPing(lastPingAt: string | null | undefined, lastPingMs: number | null | undefined): string {
  if (!lastPingAt) return 'Never pinged';
  const relative = formatRelative(lastPingAt);
  if (lastPingMs == null) return relative;
  return `${relative} · ${lastPingMs}ms`;
}
