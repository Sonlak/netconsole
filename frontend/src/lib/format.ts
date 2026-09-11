export function formatAbsolute(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
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
