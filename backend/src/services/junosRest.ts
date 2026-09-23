function restEnabled(): boolean {
  return process.env.JUNOS_REST_ENABLED === 'true';
}

export function junosRestEnabled(): boolean {
  return restEnabled();
}

function restConfig() {
  return {
    scheme: process.env.JUNOS_REST_SCHEME || 'http',
    port: Number(process.env.JUNOS_REST_PORT ?? 8443),
    verifyTls: process.env.JUNOS_REST_VERIFY_TLS === 'true',
    username: process.env.JUNOS_REST_USER || process.env.LAB_SSH_USER || 'admin',
    password: process.env.JUNOS_REST_PASSWORD || process.env.LAB_SSH_PASSWORD || 'Admin@123',
  };
}

type JunosFields = {
  hostname?: string;
  vendor: string;
  model?: string;
  version?: string;
  serial?: string;
};

function localName(tag: string): string {
  return tag.includes('}') ? tag.slice(tag.lastIndexOf('}') + 1) : tag;
}

function junosText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (Array.isArray(node)) {
    for (const item of node) {
      const text = junosText(item);
      if (text) return text;
    }
    return '';
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if ('data' in record) return junosText(record.data);
    for (const value of Object.values(record)) {
      const text = junosText(value);
      if (text) return text;
    }
  }
  return '';
}

function findJson(node: unknown, keys: Set<string>): string {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJson(item, keys);
      if (found) return found;
    }
    return '';
  }
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) {
      const text = junosText(value);
      if (text) return text;
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = findJson(value, keys);
      if (found) return found;
    }
  }
  return '';
}

function findXml(xml: string, keys: Set<string>): string {
  const matches = xml.matchAll(/<([\w:-]+)>([^<]+)<\/\1>/g);
  const skipSerial = new Set(['BUILTIN', 'N/A', 'UNKNOWN']);
  for (const match of matches) {
    const name = localName(match[1] ?? '');
    const text = match[2]?.trim() ?? '';
    if (!keys.has(name) || !text) continue;
    if (keys.has('serial-number') && skipSerial.has(text.toUpperCase())) continue;
    return text;
  }
  return '';
}

function parseIdentity(payload: unknown, raw: string): JunosFields {
  const fields: JunosFields = { vendor: 'Juniper' };
  const hostnameKeys = new Set(['host-name', 'hostname']);
  const modelKeys = new Set(['hardware-model', 'product-model', 'product-name']);
  const versionKeys = new Set(['os-version', 'junos-version']);
  const serialKeys = new Set(['serial-number']);

  let hostname = '';
  let model = '';
  let version = '';
  let serial = '';

  if (payload && typeof payload === 'object') {
    hostname = findJson(payload, hostnameKeys);
    model = findJson(payload, modelKeys);
    version = findJson(payload, versionKeys);
    serial = findJson(payload, serialKeys);
  }

  if (!hostname) hostname = findXml(raw, hostnameKeys);
  if (!model) model = findXml(raw, modelKeys);
  if (!version) version = findXml(raw, versionKeys);
  if (!serial) serial = findXml(raw, serialKeys);
  if (serial.toUpperCase() === 'BUILTIN') serial = '';

  if (hostname) fields.hostname = hostname;
  if (model) fields.model = model;
  if (version) fields.version = version;
  if (serial) fields.serial = serial;
  return fields;
}

const IDENTITY_TIMEOUT_MS = 60000;

function probeIsDead(status?: number, error?: string): boolean {
  if (status != null && status !== 405 && status < 500) return true;
  const text = (error || '').toLowerCase();
  return (
    text.includes('abort') ||
    text.includes('timeout') ||
    text.includes('econnrefused') ||
    text.includes('fetch failed') ||
    text.includes('network')
  );
}

async function callRpc(
  host: string,
  rpc: string,
  timeoutMs = 12000,
): Promise<{ ok: boolean; payload: unknown; raw: string; error?: string; status?: number }> {
  const cfg = restConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/rpc/${rpc}`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  const request = async (method: 'GET' | 'POST') =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

  try {
    let response = await request('GET');
    if (response.status === 405) {
      response = await request('POST');
    }
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, payload: null, raw, error: `HTTP ${response.status}`, status: response.status };
    }
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
    return { ok: true, payload, raw, status: response.status };
  } catch (error) {
    return {
      ok: false,
      payload: null,
      raw: '',
      error: error instanceof Error ? error.message : 'Junos REST failed',
    };
  }
}

export async function probeJunosRestIdentity(host: string): Promise<{
  ok: boolean;
  fields: JunosFields | null;
  raw?: string;
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, fields: null, error: 'JUNOS_REST_ENABLED=false' };
  }

  const system = await callRpc(host, 'get-system-information', IDENTITY_TIMEOUT_MS);
  if (!system.ok && probeIsDead(system.status, system.error)) {
    return { ok: false, fields: null, raw: system.raw, error: system.error || 'Junos REST unreachable' };
  }

  const software = system.ok ? system : await callRpc(host, 'get-software-information', IDENTITY_TIMEOUT_MS);
  if (!software.ok && probeIsDead(software.status, software.error)) {
    return { ok: false, fields: null, raw: software.raw, error: software.error || system.error || 'Junos REST unreachable' };
  }

  let fields = parseIdentity(software.payload, software.raw);
  const rawParts = [software.raw];

  if (!fields.serial) {
    const chassis = await callRpc(host, 'get-chassis-inventory', IDENTITY_TIMEOUT_MS);
    rawParts.push(chassis.raw);
    const chassisFields = parseIdentity(chassis.payload, chassis.raw);
    if (chassisFields.serial) fields = { ...fields, serial: chassisFields.serial };
  }

  const mergedRaw = rawParts.filter(Boolean).join('\n');
  const ok = Boolean(fields.hostname || fields.model || fields.serial);
  if (!ok) {
    return {
      ok: false,
      fields: null,
      raw: mergedRaw,
      error: software.error || 'Junos REST identity empty',
    };
  }

  return { ok: true, fields, raw: mergedRaw };
}

// ----------------------------------------------------------------
// XML/JSON helpers for Junos RPC responses
// ----------------------------------------------------------------

function extractXmlBody(text: string): string {
  let body = (text || '').trim();
  if (!body) return '';
  if (body.startsWith('--')) {
    let start = body.indexOf('\n<');
    if (start < 0) {
      start = body.indexOf('<');
      if (start < 0) return body;
      body = body.slice(start);
    } else {
      body = body.slice(start + 1);
    }
    const end = body.indexOf('\n--');
    if (end >= 0) body = body.slice(0, end);
    return body.trim();
  }
  return body;
}

function xmlChildText(xml: string, ...tagNames: string[]): string {
  for (const tag of tagNames) {
    // match <tag>...</tag> where tag may have namespace prefix
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<([\\w:-]+:)?${escaped}(?:\\s[^>]*)?>([^<]*)</([\\w:-]+:)?${escaped}>`, 'i');
    const m = re.exec(xml);
    if (m) return m[2]?.trim() ?? '';
  }
  return '';
}

function xmlChildrenOf(xml: string, parentTag: string): string[] {
  // Extract all child blocks of a parent element
  const escaped = parentTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([\\w:-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</([\\w:-]+:)?${escaped}>`, 'i');
  const m = re.exec(xml);
  if (!m) return [];
  const inner = m[2];
  const children: string[] = [];
  // Split on top-level child tags (not perfect but sufficient for these RPCs)
  const childRe = /<([\w:-]+(?::[\w:-]+)?)[^>]*>([^<]*(?:<(?!\/\1)[^<]*)*)<\/\1>/gi;
  let child;
  while ((child = childRe.exec(inner)) !== null) {
    children.push(child[0]);
  }
  return children;
}

// ----------------------------------------------------------------
// ARP table parser
// ----------------------------------------------------------------

export type JunosArpEntry = {
  ip: string;
  mac: string;
  hostname: string;
  interface: string;
  flags: string;
};

function normalizeMac(mac: string): string {
  // Accept : / . / bare hex — normalize to aa:bb:cc:dd:ee:ff
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return mac;
  return `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`.toLowerCase();
}

function isLoopbackOrLinkLocal(ip: string): boolean {
  try {
    // eslint-disable-next-line no-unused-vars
    const parts = ip.split('.').map(Number);
    if (parts.length === 4) {
      if (parts[0] === 127) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function parseArpEntryBlock(xml: string): JunosArpEntry | null {
  const ip = xmlChildText(xml, 'ip-address', 'ip', 'address');
  const mac = normalizeMac(xmlChildText(xml, 'mac-address', 'mac'));
  if (!ip || !mac) return null;
  const interface_ = xmlChildText(xml, 'interface-name', 'interface') || '-';
  const hostname = xmlChildText(xml, 'hostname', 'name') || ip;
  const flags = xmlChildText(xml, 'arp-flags', 'flags') || 'none';
  if (isLoopbackOrLinkLocal(ip)) return null;
  return { ip, mac, hostname, interface: interface_, flags };
}

// Top-level XML tag walker with depth tracking.
//
// The old `xmlChildrenOf` used a regex with a negative lookahead that
// compared the closing tag against `\1` (the opening tag name). The
// regex treated `</arp-table-entry-flags>` as a prefix match of
// `</arp-table-entry>`, so as soon as the parser hit the inner
// `<arp-table-entry-flags>` (which Junos RESTCONF nests inside every
// entry), the lookahead failed and the parent regex never advanced.
// Symptom: cRPD / Junos RESTCONF responses returned 0 entries even
// though they contained valid data.
//
// Walk the parent block manually with depth tracking so nested
// similarly-named elements (e.g. `<arp-table-entry-flags>`) are ignored.
function xmlBlockRange(text: string, tag: string): [number, number] | null {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'i');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
  const openMatch = openRe.exec(text);
  if (!openMatch) return null;
  const start = openMatch.index;
  const closeMatch = closeRe.exec(text.slice(start + openMatch[0].length));
  if (!closeMatch) return null;
  return [start, start + openMatch[0].length + closeMatch.index + closeMatch[0].length];
}

function findChildBlocks(xml: string, parentTag: string, childTag: string): string[] {
  const range = xmlBlockRange(xml, parentTag);
  if (!range) return [];
  const inner = xml.slice(range[0], range[1]);

  const childOpenRe = new RegExp(`<${childTag}\\b[^>]*>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = childOpenRe.exec(inner)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // Depth-tracking close find — ignore nested <childTag-...> blocks
    const tagPrefix = childTag;
    const closeRe = new RegExp(`</${tagPrefix}(\\s[\\s\\S]*)?>`, 'gi');
    const nestedOpenRe = new RegExp(`<${tagPrefix}\\b[^>]*>`, 'gi');
    let depth = 1;
    let cursor = end;
    while (depth > 0) {
      closeRe.lastIndex = cursor;
      const close = closeRe.exec(inner);
      if (!close) break;
      // Count any nested opens of the SAME tag (followed by non-name char)
      // between cursor and the close position.
      nestedOpenRe.lastIndex = cursor;
      let nextOpen: RegExpExecArray | null;
      let additional = 0;
      while ((nextOpen = nestedOpenRe.exec(inner)) !== null && nextOpen.index < close.index) {
        // Skip if it's actually the closing of a longer-named nested tag
        // like <arp-table-entry-flags> being re-scanned here. The
        // nestedOpenRe matches `childTag\b`, so `<arp-table-entry-flags>`
        // will be matched because of the `\b` (boundary). To avoid that,
        // re-check the tag is exactly childTag (no dash after).
        const afterTag = inner[nextOpen.index + match[0].length - 1] === '>' ? '' :
          inner.slice(nextOpen.index + 1, nextOpen.index + childTag.length + 1);
        if (afterTag === childTag) {
          additional++;
        }
      }
      depth += additional;
      depth -= 1;
      cursor = close.index + close[0].length;
      if (depth === 0) {
        blocks.push(inner.slice(start, cursor));
        childOpenRe.lastIndex = cursor;
        break;
      }
    }
  }
  return blocks;
}

function parseArpTableXml(xml: string): JunosArpEntry[] {
  const blocks = findChildBlocks(xml, 'arp-table-information', 'arp-table-entry');
  const entries: JunosArpEntry[] = [];
  for (const block of blocks) {
    const entry = parseArpEntryBlock(block);
    if (entry) entries.push(entry);
  }
  return entries;
}

// Junos RESTCONF (and the NetConsole lab simulator at
// `lab/juniper-sim/junos_rest_server.py`) responds with **JSON** in the
// `{"arp-table-information":{"arp-table-entry":[...]}}` shape — but the
// historical Junos REST API also returns XML for the same RPC. The old
// code only handled XML, so any cRPD / simulator / Junos REST endpoint
// that answered JSON produced 0 entries and silently overwrote the
// inventory's last good ARP job with an empty SUCCESS row (the user-
// visible symptom: clicking "Collect" blanks the ARP tab).
//
// Mirror the worker's `parsers/arp_table_rpc.py::_walk_json` so both
// formats are supported in the backend's RESTCONF fast-path.

function walkJsonArp(node: unknown, out: JunosArpEntry[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJsonArp(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const macRaw = junosText(obj['mac-address'] ?? obj['mac']);
  const mac = normalizeMac(macRaw);
  const ip = junosText(obj['ip-address'] ?? obj['ip'] ?? obj['address']);
  if (mac && ip && !isLoopbackOrLinkLocal(ip)) {
    const interface_ =
      junosText(obj['interface-name'] ?? obj['interface'] ?? obj['logical-interface']) || '-';
    const flags = junosText(obj['arp-flags'] ?? obj['flags']) || 'none';
    const hostname = junosText(obj['hostname'] ?? obj['name']) || ip;
    out.push({ ip, mac, hostname, interface: interface_, flags });
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') walkJsonArp(v, out);
  }
}

function parseArpTableJson(text: string): JunosArpEntry[] {
  const entries: JunosArpEntry[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return entries;
  }
  walkJsonArp(parsed, entries);
  return entries;
}

function parseArpTable(text: string): JunosArpEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseArpTableJson(trimmed);
  }
  return parseArpTableXml(trimmed);
}

// ----------------------------------------------------------------
// MAC table parser
// ----------------------------------------------------------------

export type JunosMacEntry = {
  mac: string;
  vlan: string;
  tag: string;
  interface: string;
  flags: string;
  type: string;
  sessId: string;
};

const MAC_FLAG_LABELS: Record<string, string> = {
  S: 'static',
  D: 'dynamic',
  L: 'locally learned',
  C: 'control',
  R: 'remote',
};

function flagToType(flags: string): string {
  const first = (flags || 'D').trim()[0]?.toUpperCase() || 'D';
  return MAC_FLAG_LABELS[first] ?? first.toLowerCase();
}

function parseMacEntryBlock(xml: string): JunosMacEntry | null {
  const mac = normalizeMac(xmlChildText(xml, 'l2ng-l2-mac-address', 'mac-address', 'mac'));
  if (!mac) return null;
  const vlan = xmlChildText(xml, 'l2ng-l2-vlan-id', 'vlan-id', 'vlan') || '-';
  const interface_ = xmlChildText(xml, 'l2ng-l2-mac-logical-interface', 'mac-logical-interface', 'interface-name', 'interface') || '-';
  const flagsRaw = xmlChildText(xml, 'l2ng-l2-mac-flags', 'l2ng-l2-mac-entry-flags', 'mac-flags', 'mac-type') || 'D';
  const flags = flagsRaw.slice(0, 8);
  const sessId = xmlChildText(xml, 'l2ng-l2-mac-sequence-number', 'sess-id') || '0';
  return {
    mac,
    vlan,
    tag: '-',
    interface: interface_,
    flags,
    type: flagToType(flags),
    sessId,
  };
}

function parseMacTableXml(xml: string): JunosMacEntry[] {
  // The Junos `get-ethernet-switching-table-information` RPC returns an
  // envelope that varies between Junos versions and routing-instance
  // scopes (default-switch vs bridge-domains). The old parser looked
  // for a hardcoded `ethernet-switching-table-information` parent tag,
  // which matched NOTHING in modern Junos 20+ responses — the actual
  // root is `<l2ng-l2ald-rtb-macdb>`, with VLAN groups under
  // `<l2ng-l2ald-mac-entry-vlan>` and individual entries under
  // `<l2ng-mac-entry>`. Verified 2026-09-19 against LAB-F2-AS-01
  // (10.10.20.221, 3 MAC entries) and LAB-F6-CORE-01 (10.10.20.102,
  // L3-only, 0 entries — see also the `l3Only` flag in the message).
  //
  // Find every <l2ng-mac-entry>...</l2ng-mac-entry> block in one shot
  // with a global regex (matches the same set as the worker parser's
  // recursive walk — see worker/netconsole_worker/parsers/mac_table_rpc.py).
  // VLAN id is inherited from the nearest ancestor `<l2ng-l2-vlan-id>`
  // by scanning the prefix before each match.
  const entries: JunosMacEntry[] = [];
  const entryRe = /<l2ng-mac-entry(?:\s[^>]*)?>([\s\S]*?)<\/l2ng-mac-entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const inner = m[1];
    const mac = normalizeMac(xmlChildText(inner, 'l2ng-l2-mac-address', 'mac-address', 'mac'));
    if (!mac) continue;
    // Look back into the prefix before this match for the nearest
    // <l2ng-l2-vlan-id>...</l2ng-l2-vlan-id> — that's the VLAN the
    // entry belongs to (modern Junos groups entries by VLAN under
    // <l2ng-l2ald-mac-entry-vlan>).
    const prefix = xml.slice(0, m.index);
    const lastVlan = (prefix.match(/<l2ng-l2-vlan-id(?:\s[^>]*)?>([^<]*)<\/l2ng-l2-vlan-id>/i) || [])[1] ?? '';
    const vlan =
      lastVlan.trim() ||
      xmlChildText(inner, 'l2ng-l2-vlan-id') ||
      xmlChildText(inner, 'l2ng-l2-mac-vlan-name', 'mac-vlan', 'vlan') ||
      '-';
    const interface_ =
      xmlChildText(
        inner,
        'l2ng-l2-mac-logical-interface',
        'mac-logical-interface',
        'interface-name',
        'interface',
      ) || '-';
    const flagsRaw =
      xmlChildText(
        inner,
        'l2ng-l2-mac-flags',
        'l2ng-l2-mac-entry-flags',
        'mac-flags',
        'mac-type',
      ) || 'D';
    const flags = flagsRaw.slice(0, 8);
    const sessId =
      xmlChildText(inner, 'l2ng-l2-mac-sequence-number', 'sess-id') || '0';
    entries.push({
      mac,
      vlan,
      tag: '-',
      interface: interface_,
      flags,
      type: flagToType(flags),
      sessId,
    });
  }
  return entries;
}

// ----------------------------------------------------------------
// Interface terse parser
// ----------------------------------------------------------------

export type JunosInterfaceEntry = {
  name: string;
  adminStatus: string;
  operStatus: string;
  description: string;
  mode: string;
  accessVlan: string;
  address: string;
  mtu: string;
  speed: string;
};

const KEEP_IFACE_RE = /^(ge-|xe-|et-|ae\d|irb|vlan|lo0|me0|fxp0|em0)/i;

function keepIface(name: string): boolean {
  return Boolean(name) && KEEP_IFACE_RE.test(name);
}

const TERSE_RE = /^(?:\S+\s+){2}(?:\S+\s+)?(\S+)\s+(up|down)\s+(up|down)\s+(\S+)(?:\s+(\S+))?/i;

function parseTerseLine(line: string): JunosInterfaceEntry | null {
  // Format: Interface  Admin  Link  Proto  Local  (or just Interface Admin Link Proto)
  // e.g.: ge-0/0/0    up    up    up
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const name = parts[0];
  if (!keepIface(name)) return null;
  const admin = parts[1]?.toLowerCase() ?? 'up';
  const oper = parts[2]?.toLowerCase() ?? 'up';
  const proto = (parts[3] ?? '').toLowerCase();
  const mode = proto === 'inet' ? 'inet' : proto === 'eth-switch' || proto === 'ethernet-switching' ? 'eth-switch' : '';
  const address = proto === 'inet' ? (parts[4] ?? '') : '';
  return {
    name,
    adminStatus: admin,
    operStatus: oper,
    description: '',
    mode,
    accessVlan: '',
    address,
    mtu: '',
    speed: '',
  };
}

// ----------------------------------------------------------------
// Public REST functions
// ----------------------------------------------------------------

export async function fetchArpTable(host: string): Promise<{
  ok: boolean;
  entries: JunosArpEntry[];
  collectMs: number;
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, entries: [], collectMs: 0, error: 'JUNOS_REST_ENABLED=false' };
  }
  const started = Date.now();
  const result = await callRpc(host, 'get-arp-table-information', 20000);
  if (!result.ok) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: result.error };
  }
  const xml = extractXmlBody(result.raw);
  if (!xml) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: 'Empty ARP response' };
  }
  const entries = parseArpTable(xml);
  return { ok: true, entries, collectMs: Date.now() - started };
}

export async function fetchMacTable(host: string): Promise<{
  ok: boolean;
  entries: JunosMacEntry[];
  collectMs: number;
  raw?: string; // raw XML body — caller may inspect for L3-only detection
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, entries: [], collectMs: 0, error: 'JUNOS_REST_ENABLED=false' };
  }
  const started = Date.now();
  const result = await callRpc(host, 'get-ethernet-switching-table-information', 20000);
  if (!result.ok) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: result.error };
  }
  const xml = extractXmlBody(result.raw);
  if (!xml) {
    return { ok: false, entries: [], collectMs: Date.now() - started, error: 'Empty MAC response' };
  }
  const entries = parseMacTableXml(xml);
  return { ok: true, entries, collectMs: Date.now() - started, raw: xml };
}

export async function fetchInterfaceList(host: string): Promise<{
  ok: boolean;
  interfaces: JunosInterfaceEntry[];
  collectMs: number;
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, interfaces: [], collectMs: 0, error: 'JUNOS_REST_ENABLED=false' };
  }
  const started = Date.now();
  // Use terse= to get a compact interface list (much faster than full XML)
  const result = await callRpc(host, 'get-interface-information', 20000);
  if (!result.ok) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: result.error };
  }
  const raw = result.raw || '';
  const lines = raw.split('\n');
  const interfaces: JunosInterfaceEntry[] = [];
  for (const line of lines) {
    const entry = parseTerseLine(line);
    if (entry) interfaces.push(entry);
  }
  if (interfaces.length === 0) {
    return { ok: false, interfaces: [], collectMs: Date.now() - started, error: 'No interfaces in response' };
  }
  return { ok: true, interfaces, collectMs: Date.now() - started };
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ----------------------------------------------------------------
// Switchport mode / VLAN membership parser (mirrors worker/parsers/interface_set.py)
// ----------------------------------------------------------------

function physicalInterfaceName(name: string): string {
  const text = (name || '').trim();
  if (text.includes('.') && !text.toLowerCase().startsWith('irb.')) {
    const idx = text.lastIndexOf('.');
    const tail = text.slice(idx + 1);
    if (/^\d+$/.test(tail)) return text.slice(0, idx);
  }
  return text;
}

const _SWITCH_MODE_RE = /^set interfaces (\S+)(?: unit \d+)? family ethernet-switching (?:interface-mode|port-mode) (trunk|access)\s*$/gim;
const _SWITCH_MEMBERS_RE = /^set interfaces (\S+)(?: unit \d+)? family ethernet-switching vlan members (.+)$/gim;

interface SwitchModeInfo {
  mode?: string;
  members?: string;
}

export function parseSwitchingModesFromSet(config: string): Record<string, SwitchModeInfo> {
  const modes: Record<string, SwitchModeInfo> = {};

  // Reset lastIndex before each use
  _SWITCH_MODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = _SWITCH_MODE_RE.exec(config)) !== null) {
    const name = physicalInterfaceName(match[1] || '');
    if (!modes[name]) modes[name] = {};
    modes[name].mode = (match[2] || '').toLowerCase();
  }

  _SWITCH_MEMBERS_RE.lastIndex = 0;
  while ((match = _SWITCH_MEMBERS_RE.exec(config)) !== null) {
    const name = physicalInterfaceName(match[1] || '');
    const members = (match[2] || '').trim();
    if (!members) continue;
    if (!modes[name]) modes[name] = {};
    modes[name].members = members;
  }

  return modes;
}

const L3_MODES = new Set(['inet', 'l3', 'routed']);

export function applySwitchingModesToInterfaces(
  interfaces: JunosInterfaceEntry[],
  modes: Record<string, SwitchModeInfo>,
): void {
  for (const iface of interfaces) {
    const name = physicalInterfaceName(iface.name || '');
    const info = modes[name];
    if (!info) continue;

    const currentMode = (iface.mode || '').toLowerCase();
    if (L3_MODES.has(currentMode) || iface.address) continue;

    const mode = (info.mode || '').toLowerCase();
    const members = (info.members || '').trim();

    if (mode === 'trunk' || mode === 'access') {
      iface.mode = mode;
    }

    if (mode === 'trunk') {
      iface.accessVlan = members.toLowerCase() === 'all' ? 'all' : (members || iface.accessVlan || '');
    } else if (mode === 'access' && members && !iface.accessVlan) {
      iface.accessVlan = members;
    }
  }
}

const SET_TAG = /<(?:[\w.-]+:)?(configuration-set|configuration-text|configuration-output|config-text)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1>/i;
const HOST_NAME = /^set system host-name\s+(\S+)/m;
const VERSION = /^set version\s+(\S+)/m;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseConfigurationSet(payload: string): string {
  const xml = extractXmlBody(payload);
  const tagged = xml.match(SET_TAG);
  if (tagged?.[2]) {
    const text = unescapeXml(tagged[2]).trim();
    if (text) return text;
  }
  const plain = unescapeXml(xml).trim();
  if (plain.startsWith('set ') || plain.startsWith('delete ')) {
    return plain;
  }
  return '';
}

export function parseIdentityFromSetConfig(config: string): { hostname?: string; version?: string } {
  const parsed: { hostname?: string; version?: string } = {};
  const host = HOST_NAME.exec(config || '')?.[1]?.trim().replace(/^"+|"+$/g, '');
  if (host && SAFE_TOKEN.test(host)) parsed.hostname = host;
  const version = VERSION.exec(config || '')?.[1]?.trim().replace(/^"+|"+$/g, '');
  if (version && SAFE_TOKEN.test(version)) parsed.version = version;
  return parsed;
}

export async function fetchConfigurationSet(host: string): Promise<{
  ok: boolean;
  config: string;
  identity: { hostname?: string; version?: string };
  collectMs: number;
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, config: '', identity: {}, collectMs: 0, error: 'JUNOS_REST_ENABLED=false' };
  }

  const cfg = restConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/rpc`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/xml',
        'Content-Type': 'application/xml',
      },
      body: '<get-configuration format="set"/>',
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    const collectMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, config: '', identity: {}, collectMs, error: `HTTP ${response.status}` };
    }
    const lowered = raw.toLowerCase();
    if (lowered.includes('<xnm:error') || lowered.includes('<error-message>')) {
      return { ok: false, config: '', identity: {}, collectMs, error: 'Junos RPC error' };
    }
    const config = parseConfigurationSet(raw);
    if (!config) {
      return { ok: false, config: '', identity: {}, collectMs, error: 'Junos REST returned empty configuration' };
    }
    return { ok: true, config, identity: parseIdentityFromSetConfig(config), collectMs };
  } catch (error) {
    return {
      ok: false,
      config: '',
      identity: {},
      collectMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'Junos REST get-configuration failed',
    };
  }
}

// ---------------------------------------------------------------------------
// VLAN membership parser
// ---------------------------------------------------------------------------

export type JunosVlanMember = {
  name: string;
  interfaces: string[];
};

/** Extract interface name from Junos VLAN member string like "ge-0/0/2.0" or "ge-0/0/0.0". */
function _vlan_iface_name(raw: string): string {
  // Strip trailing .0 unit number if present (VLAN unit)
  const trimmed = (raw || '').trim();
  if (trimmed.endsWith('.0')) return trimmed.slice(0, -2);
  return trimmed;
}

export function parseVlanInformation(xml: string): JunosVlanMember[] {
  /** Junos VLAN RPC returns XML like:
   *  <vlans>
   *    <vlan>
   *      <name>VLAN100</name>
   *      <l2ng-l2-static-mac-table>
   *        <l2ng-l2-static-mac-entry>
   *          <l2ng-l2-mac-address>...</l2ng-l2-mac-address>
   *          <l2ng-l2-vlan-name-tag>vlan100</l2ng-l2-vlan-name-tag>
   *          <l2ng-l2-static-mobile mac-address="" vlan-name="" interface="ge-0/0/2.0" />
   *        </l2ng-l2-static-mac-entry>
   *      </l2ng-l2-static-mac-table>
   *    </vlan>
   *  </vlans>
   *
   *  Or from get-vlan-information RPC:
   *  <vlan>
   *    <name>VLAN100</name>
   *    <vlan-member-list>
   *      <vlan-member>ge-0/0/2</vlan-member>
   *      <vlan-member>ge-0/0/3</vlan-member>
   *    </vlan-member-list>
   *  </vlan>
   */
  const result: JunosVlanMember[] = [];
  if (!xml) return result;

  // Extract all <vlan> blocks
  const vlanRe = /<vlan>([\s\S]*?)<\/vlan>/gi;
  let vlanMatch: RegExpExecArray | null;
  while ((vlanMatch = vlanRe.exec(xml)) !== null) {
    const vlanBlock = vlanMatch[1];
    const nameMatch = /<name>([\s\S]*?)<\/name>/i.exec(vlanBlock);
    if (!nameMatch) continue;
    const vlanName = nameMatch[1].trim();

    const interfaces: string[] = [];

    // Try vlan-member-list format (get-vlan-information RPC)
    const memberRe = /<vlan-member>([\s\S]*?)<\/vlan-member>/gi;
    let memberMatch: RegExpExecArray | null;
    while ((memberMatch = memberRe.exec(vlanBlock)) !== null) {
      const memberName = memberMatch[1].trim();
      if (memberName) interfaces.push(_vlan_iface_name(memberName));
    }

    // Try l2ng-l2-static-mobile format (get-ethernet-switching-table-information RPC)
    if (interfaces.length === 0) {
      const mobileRe = /<l2ng-l2-static-mobile[^>]*interface="([^"]*)"/gi;
      let mobileMatch: RegExpExecArray | null;
      while ((mobileMatch = mobileRe.exec(vlanBlock)) !== null) {
        const ifaceName = mobileMatch[1].trim();
        if (ifaceName) interfaces.push(_vlan_iface_name(ifaceName));
      }
    }

    if (interfaces.length > 0) {
      result.push({ name: vlanName, interfaces });
    }
  }
  return result;
}

export async function fetchVlanInformation(host: string): Promise<{
  ok: boolean;
  vlans: JunosVlanMember[];
  collectMs: number;
  error?: string;
}> {
  if (!restEnabled()) {
    return { ok: false, vlans: [], collectMs: 0, error: 'JUNOS_REST_ENABLED=false' };
  }
  const started = Date.now();
  const result = await callRpc(host, 'get-vlan-information', 20000);
  if (!result.ok) {
    return { ok: false, vlans: [], collectMs: Date.now() - started, error: result.error };
  }
  const xml = extractXmlBody(result.raw);
  if (!xml) {
    return { ok: false, vlans: [], collectMs: Date.now() - started, error: 'Empty VLAN response' };
  }
  const vlans = parseVlanInformation(xml);
  return { ok: true, vlans, collectMs: Date.now() - started };
}

/** Apply VLAN membership to interface list.
 *
 * For each VLAN, find interfaces that belong to it and set `accessVlan` on those
 * interfaces (only if not already set by switchport-mode parsing).
 * Also set `mode = "access"` if mode is empty and the interface is in a VLAN.
 */
export function applyVlanMembershipToInterfaces(
  interfaces: JunosInterfaceEntry[],
  vlans: JunosVlanMember[],
): void {
  // Build reverse map: interface name -> vlan name
  const ifaceToVlan = new Map<string, string>();
  for (const vlan of vlans) {
    for (const ifaceName of vlan.interfaces) {
      // Store the first VLAN found for this interface
      if (!ifaceToVlan.has(ifaceName)) {
        ifaceToVlan.set(ifaceName, vlan.name);
      }
    }
  }

  for (const iface of interfaces) {
    const name = iface.name || '';
    // Try exact name match and name without unit
    let vlanName = ifaceToVlan.get(name);
    if (!vlanName) {
      // Try without trailing .0 (unit number)
      const withoutUnit = name.replace(/\.0$/, '');
      vlanName = ifaceToVlan.get(withoutUnit);
    }
    if (!vlanName) {
      // Try prefix match (interface name may include unit)
      for (const [key, val] of ifaceToVlan.entries()) {
        if (name.startsWith(key) || key.startsWith(name)) {
          vlanName = val;
          break;
        }
      }
    }

    if (vlanName) {
      // Set access VLAN if not already set
      if (!iface.accessVlan) {
        iface.accessVlan = vlanName;
      }
      // Set mode to access if not already set and not L3
      if (!iface.mode && !iface.address) {
        iface.mode = 'access';
      }
    }
  }
}
