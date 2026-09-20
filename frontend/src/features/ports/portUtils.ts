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
 * Estimate nominal port speed in bps from a Juniper / IOS-XE / EOS interface name.
 * Used as a fallback when the backend doesn't populate the `speed` field
 * (it returns '' for IOS-XE REST and Junos REST).
 *
 * Vendor-specific conventions:
 *
 * **Juniper Junos** — prefix with hyphen
 *   ge-       → 1 Gbps   (Gigabit Ethernet)
 *   xe-       → 10 Gbps  (10-Gigabit Ethernet)
 *   et-       → 40 Gbps  (40-Gigabit Ethernet)
 *   em-, fxp*, me* → 1 Gbps (Management)
 *   ae*, vlan*, lo*, irb* → null (no physical speed)
 *
 * **Cisco IOS-XE / IOS-XR** — full name or short alias
 *   GigabitEthernet    / Gi → 1 Gbps
 *   TenGigabitEthernet / Te → 10 Gbps
 *   TwentyFiveGigE     / Twe → 25 Gbps
 *   FortyGigabitEthernet / Fo → 40 Gbps
 *   HundredGigE        / Hu → 100 Gbps
 *   FourHundredGigE    / Fou → 400 Gbps
 *   AppGigabitEthernet → 1 Gbps
 *   Loopback, Vlan, Port-channel, Bundle-Ether → null
 *
 * **Arista EOS** — generic name, but Management has known speed
 *   Management / Ma1* → 1 Gbps
 *   Loopback, Port-Channel, Ethernet*, Vxlan → null
 *   (Ethernet* speed is hardware-dependent per platform — leave to backend
 *    bandwidth field if it is actually populated.)
 *
 * Returns null when no rule matches — caller renders "—" instead of a guess.
 */
const SPEED_RULES: ReadonlyArray<[RegExp, number | null]> = [
  // ------ Juniper: must come before Cisco "ge" since Juniper names start "ge-" ------
  [/^ge-/, 1_000_000_000],
  [/^xe-/, 10_000_000_000],
  [/^et-/, 40_000_000_000],
  [/^em[\d/:.]/, 1_000_000_000],       // Embedded Management — no hyphen
  [/^fxp[\d/:.]/, 1_000_000_000],      // Management — no hyphen
  [/^me[\d/:.]/, 1_000_000_000],       // Management — no hyphen

  // ------ Cisco IOS-XE / IOS-XR: full long names ------
  [/^gigabit[e]?thernet/, 1_000_000_000],
  [/^appgigabit[e]?thernet/, 1_000_000_000],
  [/^tengig(abit[e]?)?[e]?therne?t?/, 10_000_000_000],
  [/^twentyfivegig[e]?/, 25_000_000_000],
  [/^fortygig(abit[e]?)?[e]?therne?t?/, 40_000_000_000],
  [/^hundredgig[e]?/, 100_000_000_000],
  [/^fourhundredgig[e]?/, 400_000_000_000],
  // Cisco short form — anchored to start, must be a complete token (word boundary)
  [/^gi[\d/:.]/, 1_000_000_000],
  [/^te[\d/:.]/, 10_000_000_000],
  [/^twe[\d/:.]/, 25_000_000_000],
  [/^fo[\d/:.]/, 40_000_000_000],
  [/^hu[\d/:.]/, 100_000_000_000],
  [/^fou[\d/:.]/, 400_000_000_000],

  // ------ Arista EOS ------
  [/^ma(nagement)?[\d/:.]/, 1_000_000_000],

  // ------ Skip: virtual / aggregated (no nominal speed) ------
  [/^vlan/, null],
  [/^loopback/, null],
  [/^lo[\d/:.]/, null],
  [/^irb/, null],
  [/^ae\d/, null],                // Juniper aggregated
  [/^port-?channel/, null],      // Cisco / IOS-XE
  [/^po\d/, null],               // EOS / NX-OS short for port-channel
  [/^bundle-?ether/, null],      // IOS-XR
  [/^vxlan/, null],              // EOS
];

export function inferSpeedBps(ifaceName: string | null | undefined): number | null {
  if (!ifaceName) return null;
  const n = ifaceName.toLowerCase();
  for (const [re, bps] of SPEED_RULES) {
    if (re.test(n)) return bps;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vendor interface-name variants
//
// The counter collector stores the long form (GigabitEthernet0/0) while the
// device-interface table may surface the short form (Gi0/0). Same physical
// port, different stored names. Frontend callers usually pass in whatever
// the device-interface table returned; backend counter queries need to hit
// every equivalent canonical form so the lookup is spelling-agnostic.
//
// Mirrors `expandIfaceVariants` in `backend/src/services/interfaceCounters.ts`.
// Keep both sides in sync if you add new prefixes here.
// ---------------------------------------------------------------------------
export const IFACE_SHORT_TO_LONG: Readonly<Record<string, string>> = Object.freeze({
  gi: 'GigabitEthernet',
  te: 'TenGigabitEthernet',
  fa: 'FastEthernet',
  et: 'Ethernet',
  tw: 'TwoGigabitEthernet',
  twe: 'TwentyFiveGigE',
  fo: 'FortyGigabitEthernet',
  hu: 'HundredGigE',
  fou: 'FourHundredGigE',
  po: 'Port-channel',
});

export const IFACE_LONG_TO_SHORT: Readonly<Record<string, string>> = Object.freeze({
  gigabitethernet: 'Gi',
  tengigabitethernet: 'Te',
  fastethernet: 'Fa',
  ethernet: 'Et',
  twogigabitethernet: 'Tw',
  twentyfivegige: 'Twe',
  fortygigabitethernet: 'Fo',
  hundredgige: 'Hu',
  fourhundredgige: 'Fou',
  'port-channel': 'Po',
});

/**
 * Return every canonical spelling of a vendor interface name. The first
 * element is always the input as-given. Useful when comparing an interface
 * string that came from one source (e.g. device-interface table) against
 * rows that came from another (e.g. counter history).
 *
 * Examples:
 *   "Gi0/0"               → ["Gi0/0", "GigabitEthernet0/0"]
 *   "GigabitEthernet0/0"  → ["GigabitEthernet0/0", "Gi0/0"]
 *   "ge-0/0/0"            → ["ge-0/0/0"]              (Junos — no rewrite)
 *   "et-0/0/0"            → ["et-0/0/0"]              (Junos — no rewrite)
 *   "Et1"                 → ["Et1", "Ethernet1"]      (EOS short → long)
 */
export function expandIfaceVariants(name: string | null | undefined): string[] {
  if (!name) return [];
  const trimmed = String(name).trim();
  if (!trimmed) return [];
  const out = new Set<string>([trimmed]);
  const lower = trimmed.toLowerCase();

  // Short → long only when next char is digit — keeps Junos `et-`/`ge-`
  // out of the rewrite path.
  for (const [short, long] of Object.entries(IFACE_SHORT_TO_LONG)) {
    if (lower.startsWith(short) && trimmed.length > short.length) {
      const next = trimmed[short.length];
      if (next && /\d/.test(next)) {
        out.add(long + trimmed.slice(short.length));
        break;
      }
    }
  }

  // Long → short (case-insensitive prefix match).
  for (const [long, short] of Object.entries(IFACE_LONG_TO_SHORT)) {
    if (lower.startsWith(long) && trimmed.length > long.length) {
      out.add(short + trimmed.slice(long.length));
      break;
    }
  }

  return Array.from(out);
}

/**
 * True if `a` and `b` resolve to the same physical interface (accounting
 * for short/long Cisco form differences, case-insensitive on vendor names,
 * trailing subif .N suffixes normalised).
 */
export function samePhysicalIface(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const av = expandIfaceVariants(a);
  return av.includes(b);
}

/**
 * Pick the first matching interface name from a list, treating
 * short/long Cisco spellings as equal.
 */
export function findMatchingIface<T extends { interfaceName?: string | null }>(
  rows: T[] | null | undefined,
  name: string | null | undefined,
): T | null {
  if (!rows || !name) return null;
  const variants = new Set(expandIfaceVariants(name));
  for (const row of rows) {
    const candidate = row.interfaceName;
    if (candidate && variants.has(candidate)) return row;
  }
  return null;
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
 * Falls back to `inferSpeedBps(name)` when the raw string is empty or
 * unparseable. Returns null when neither the string nor the name prefix
 * yields a confident estimate.
 */
export function parseSpeedBps(raw: string | null | undefined, ifaceName?: string | null): number | null {
  if (!raw) return inferSpeedBps(ifaceName);
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'auto' || s === 'auto-negotiate' || s === 'autoneg') return inferSpeedBps(ifaceName);
  // "1G" / "10G" / "100M"
  const short = /^(\d+(?:\.\d+)?)\s*([kmg])b?$/.exec(s);
  if (short) {
    const n = Number(short[1]);
    const unit = short[2];
    if (!Number.isFinite(n)) return inferSpeedBps(ifaceName);
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
  }
  // "1000mbps" / "10gbps" / "100kbps"
  const long = /^(\d+(?:\.\d+)?)\s*(k|m|g|t)?bps$/.exec(s);
  if (long) {
    const n = Number(long[1]);
    const unit = long[2] ?? '';
    if (!Number.isFinite(n)) return inferSpeedBps(ifaceName);
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
    if (unit === 't') return Math.round(n * 1_000_000_000_000);
    return Math.round(n);
  }
  // Plain integer (no unit) — per RFC 7224 (ietf-interfaces YANG), `bandwidth`
  // is reported in bits per second. EOS populates this field directly.
  // Examples: "1000000000" (1G) / "10000000000" (10G) / "40000000000" (40G).
  const numeric = /^\d+$/.exec(s);
  if (numeric) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  // "1000baseT" / "10GBase-LR" / "10GigabitEthernet" — best-effort
  const base = /^(\d+(?:\.\d+)?)\s*(g|m|k)?(?:base|bit|bits)?/i.exec(s);
  if (base) {
    const n = Number(base[1]);
    const unit = (base[2] ?? '').toLowerCase();
    if (!Number.isFinite(n)) return inferSpeedBps(ifaceName);
    if (unit === 'g') return Math.round(n * 1_000_000_000);
    if (unit === 'm') return Math.round(n * 1_000_000);
    if (unit === 'k') return Math.round(n * 1_000);
  }
  return inferSpeedBps(ifaceName);
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
