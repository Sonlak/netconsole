/**
 * Helpers shared by the port-stats drawer.
 *
 * Why a dedicated file?
 *   - Speed strings arrive in mixed formats from vendors:
 *       "1000mbps", "10000mbps", "1G", "10G", "100M", "auto",
 *       "1000baseT", "10GigabitEthernet"
 *     and we need to normalize them to **bits per second** for utilization
 *     math against the chart's bps series.
 *   - The chart already labels Y axis with `formatBps` (see BandwidthChart)
 *     but the KPI cards need a slightly different output (more decimals when
 *     <10 Kbps, no trailing space). Centralizing keeps the two callers in
 *     sync when units change.
 */

const UNIT_TABLE: Array<[number, string]> = [
  [1_000_000_000_000, 'Tbps'],
  [1_000_000_000, 'Gbps'],
  [1_000_000, 'Mbps'],
  [1_000, 'Kbps'],
  [1, 'bps'],
];

/** Format a numeric bps value as "240 Kbps", "12.3 Mbps", etc. */
export function formatBps(value: number | null | undefined, options?: { decimals?: number; padZero?: boolean }): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return options?.padZero ? '0 bps' : '0';
  const decimals = options?.decimals ?? (value >= 100 ? 0 : value >= 10 ? 1 : 2);
  let v = value;
  for (const [unit, label] of UNIT_TABLE) {
    if (v >= unit) {
      const scaled = v / unit;
      return `${scaled.toFixed(decimals)} ${label}`;
    }
  }
  return `${value.toFixed(0)} bps`;
}

/** Format an octet count as bytes (B/KB/MB/GB/TB). */
export function formatBytes(octets: string | number | null | undefined): string {
  if (octets === null || octets === undefined || octets === '') return '—';
  const n = typeof octets === 'string' ? Number(octets) : octets;
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(decimals)} ${units[u]}`;
}

/**
 * Parse a vendor interface speed string into bits-per-second.
 *
 * Examples:
 *   "1000mbps"  -> 1_000_000_000
 *   "10gbps"    -> 10_000_000_000
 *   "1G"        -> 1_000_000_000
 *   "10G"       -> 10_000_000_000
 *   "100M"      -> 100_000_000
 *   "auto"      -> null (no fixed speed)
 *
 * Returns null when we cannot confidently convert — callers should hide
 * the utilization gauge rather than display garbage.
 */
export function parseSpeedBps(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'auto' || s === 'auto-negotiate' || s === 'autoneg') return null;
  // "1G" / "10G" / "100M"
  const short = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/.exec(s);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2];
    if (!Number.isFinite(n)) return null;
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
  }
  // "1000mbps" / "10gbps" / "100kbps"
  const long = /^(\d+(?:\.\d+)?)\s*(k|m|g|t)?bps$/.exec(s);
  if (long) {
    const n = Number(long[1]);
    const unit = long[2] ?? '';
    if (!Number.isFinite(n)) return null;
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
    if (unit === 't') return Math.round(n * 1_000_000_000_000);
    return Math.round(n);
  }
  // "1000baseT" / "10GBase-LR" / "10GigabitEthernet" — best-effort
  const base = /^(\d+(?:\.\d+)?)\s*(g|m|k)?(?:base|bit|bits)?/i.exec(s);
  if (base) {
    const n = Number(base[1]);
    const unit = (base[2] ?? '').toLowerCase();
    if (!Number.isFinite(n)) return null;
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
  }
  return null;
}

/**
 * Compute the % utilization of a port's bps rate against its nominal speed.
 * Returns null when speed is unknown ("auto") or rate is non-positive.
 */
export function utilizationPercent(rateBps: number | null | undefined, speedBps: number | null | undefined): number | null {
  if (rateBps === null || rateBps === undefined || !Number.isFinite(rateBps)) return null;
  if (speedBps === null || speedBps === undefined || !Number.isFinite(speedBps) || speedBps <= 0) return null;
  if (rateBps <= 0) return 0;
  return Math.min(100, Math.max(0, (rateBps / speedBps) * 100));
}

/** Traffic-light tone for utilization %, matching dhcpUtilMeta thresholds (warn 70, crit 85). */
export function utilizationTone(percent: number | null): 'success' | 'warning' | 'error' | 'default' {
  if (percent === null) return 'default';
  if (percent >= 85) return 'error';
  if (percent >= 70) return 'warning';
  return 'success';
}

/** Tone for absolute error counter counts — anything >0 is concerning on most uplinks. */
export function errorCountTone(n: number | null | undefined): 'success' | 'warning' | 'error' | 'default' {
  if (n === null || n === undefined) return 'default';
  if (n === 0) return 'success';
  if (n < 10) return 'warning';
  return 'error';
}

/** Relative time formatter used in the drawer header — e.g. "12s ago", "3 phút trước". */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'vừa xong';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'vừa xong';
  if (sec < 60) return `${sec}s trước`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h trước`;
  return `${Math.floor(hr / 24)} ngày trước`;
}
