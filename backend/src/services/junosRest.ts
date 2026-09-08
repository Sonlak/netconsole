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

function parseArpTableXml(xml: string): JunosArpEntry[] {
  const blocks = xmlChildrenOf(xml, 'arp-table-information');
  const entries: JunosArpEntry[] = [];
  for (const block of blocks) {
    const entry = parseArpEntryBlock(block);
    if (entry) entries.push(entry);
  }
  return entries;
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
  const blocks = xmlChildrenOf(xml, 'ethernet-switching-table-information');
  const entries: JunosMacEntry[] = [];
  for (const block of blocks) {
    const entry = parseMacEntryBlock(block);
    if (entry) entries.push(entry);
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
  const entries = parseArpTableXml(xml);
  return { ok: true, entries, collectMs: Date.now() - started };
}

export async function fetchMacTable(host: string): Promise<{
  ok: boolean;
  entries: JunosMacEntry[];
  collectMs: number;
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
  return { ok: true, entries, collectMs: Date.now() - started };
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
