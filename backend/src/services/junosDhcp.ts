/**
 * Junos DHCP local server — the DHCP backend for NetConsole.
 *
 * Replaces Kea (removed 2026-10-30). DHCP now runs on the distribution
 * switch itself (LAB-F6-DS-01, vqfx-10000 / Junos Evo 20.3R1.8) using
 * the Junos "extended DHCP local server" feature:
 *
 *   set system services dhcp-local-server group <G> interface irb.<vlan>
 *   set access address-assignment pool <P> family inet network <cidr>
 *   set access address-assignment pool <P> family inet range <R> low <ip> high <ip>
 *   set access address-assignment pool <P> family inet dhcp-attributes router <gw>
 *   set access address-assignment pool <P> family inet host <name> \
 *       hardware-address <mac> ip-address <ip>
 *
 * IMPORTANT PLATFORM NOTES (verified on LAB-F6-DS-01, 2026-10-30):
 *
 *  - Junos Evo on QFX does NOT accept `system services dhcp-local-server
 *    pool ...` (the classic EX/MX form) — it is a syntax error. The
 *    address pools live under `access address-assignment pool` instead.
 *  - The classic `system services dhcp binding` / `show system services
 *    dhcp statistics` commands are NOT valid on the vqfx-10000. Use
 *    `show dhcp server binding` and `show dhcp server statistics`.
 *  - There is NO `dhcp-attributes lease-time` option on this platform —
 *    only `maximum-lease-time` (plus `t1-renewal-time` /
 *    `t2-rebinding-time`).
 *  - The pool hierarchy has no `description` statement, so a human
 *    friendly pool name cannot be stored in the config. We derive the
 *    display name from the VLAN id instead.
 *  - The RESTCONF `cli-information` RPC is NOT supported on this
 *    platform (syntax error), so operational commands go over SSH.
 *  - The binding RPC must be sent WITHOUT a `<level>` child element:
 *    `<get-dhcp-server-binding-information/>` returns the bindings, but
 *    `<get-dhcp-server-binding-information><level>detail</level></...>`
 *    silently returns an EMPTY list on Junos Evo. Use `<detail/>` instead.
 *
 * There is no DHCP HA. The switch is the single source of truth.
 */

import { Client, type Algorithms } from 'ssh2';
import { prisma } from '../lib/prisma.js';
import { buildClientLookup } from './arpAddress.js';
import { listCollectableDevices } from './collectableDevices.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function restEnabled(): boolean {
  return process.env.JUNOS_REST_ENABLED === 'true';
}

function restConfig() {
  return {
    scheme: process.env.JUNOS_REST_SCHEME || 'http',
    port: Number(process.env.JUNOS_REST_PORT ?? 8443),
    username: process.env.JUNOS_REST_USER || process.env.LAB_SSH_USER || 'admin',
    password: process.env.JUNOS_REST_PASSWORD || process.env.LAB_SSH_PASSWORD || 'Admin@123',
  };
}

/**
 * Hostname (or IP) of the switch that runs the DHCP server.
 *
 * `DHCP_SERVER_HOST` overrides; otherwise we resolve the device by name
 * from the DB (a device named like LAB-F6-DS-01 / SW-DS-01). The lookup
 * is done lazily and cached for a short while so a DB hiccup does not
 * break the whole DHCP page.
 */
export function dhcpServerHost(): string {
  const explicit = (process.env.DHCP_SERVER_HOST || '').trim();
  if (explicit) return explicit;
  return 'LAB-F6-DS-01';
}

/**
 * Resolve the DHCP server to a *reachable address*.
 *
 * `dhcpServerHost()` returns the device NAME (e.g. "LAB-F6-DS-01"), but
 * the lab devices are only reachable by IP (10.10.20.110) — the hostname
 * does not resolve in the container DNS. Every transport (RESTCONF, SSH)
 * therefore needs the IP, not the name.
 *
 * Order:
 *   1. `DHCP_SERVER_HOST` when it already looks like an IP → use as-is.
 *   2. Otherwise look the name up in the `Device` table and use its `ip`.
 *   3. Fall back to the name (it may still resolve via DNS in other setups).
 */
export async function resolveDhcpServerAddress(): Promise<string> {
  const host = dhcpServerHost();

  // Already an IP literal → nothing to resolve.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  try {
    const device = await prisma.device.findFirst({
      where: { name: { equals: host, mode: 'insensitive' } },
      select: { ip: true },
    });
    if (device?.ip) return device.ip;
  } catch (error) {
    console.warn('[dhcp] failed to resolve DHCP server device by name:', error);
  }

  return host;
}

export function dhcpServerEnabled(): boolean {
  const raw = (process.env.DHCP_SERVER_ENABLED ?? '').trim();
  if (!raw) return true;
  return /^(1|true|yes|on)$/i.test(raw);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DhcpServerPool = {
  /** Junos pool name (e.g. "V201"). */
  name: string;
  /** Display name — derived from the VLAN, since Junos pools have no description. */
  label: string;
  /** Network in CIDR form. */
  subnet: string;
  /** VLAN id derived from the pool name / gateway, 0 when unknown. */
  vlan: number;
  /** Gateway (router option). */
  gateway: string;
  /** DNS servers. */
  dns: string[];
  /** Domain name. */
  domainName: string;
  /** Lease time in seconds. */
  leaseTime: number;
  /** Inclusive dynamic range. */
  rangeStart: string;
  rangeEnd: string;
  /** Number of addresses in the dynamic range. */
  poolSize: number;
  /** Number of addresses reserved by static hosts. */
  reservedCount: number;
  /** Static host reservations in this pool. */
  hosts: DhcpServerHost[];
};

export type DhcpServerHost = {
  name: string;
  mac: string;
  ip: string;
};

export type DhcpServerLease = {
  ip: string;
  mac: string;
  /** "BOUND" / "INIT" / ... */
  state: string;
  /** Seconds until the lease expires. */
  leaseExpires: number;
  /** Absolute expiry as ISO string, when the platform reports it. */
  expiresAt: string | null;
  /** Lease start as ISO string, when the platform reports it. */
  startedAt: string | null;
  /** Logical interface the client is on ("irb.201"). */
  interface: string;
  /** Full incoming interface ("irb.201:xe-0/0/1.0"). */
  clientInterface: string;
  /** Server identifier that handed out the lease. */
  serverIdentifier: string;
  /** Junos pool that owns the lease. */
  poolName: string;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Strip the XML envelope Junos wraps every RPC response in. */
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

function localName(tag: string): string {
  return tag.includes('}') ? tag.slice(tag.lastIndexOf('}') + 1) : tag;
}

function xmlChildText(xml: string, ...tagNames: string[]): string {
  for (const tag of tagNames) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<([\\w:-]+:)?${escaped}(?:\\s[^>]*)?>([^<]*)</([\\w:-]+:)?${escaped}>`, 'i');
    const m = re.exec(xml);
    if (m) return m[2]?.trim() ?? '';
  }
  return '';
}

/** Extract the inner XML of the FIRST `<parent>` block. */
function xmlInner(xml: string, parentTag: string): string {
  const escaped = parentTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([\\w:-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</([\\w:-]+:)?${escaped}>`, 'i');
  const m = re.exec(xml);
  return m?.[2] ?? '';
}

/** Extract every `<parent>` block (non-nested match on the same tag). */
function xmlBlocks(xml: string, parentTag: string): string[] {
  const escaped = parentTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<([\\w:-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</([\\w:-]+:)?${escaped}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[2]);
  }
  return out;
}

/** Read a repeated leaf list like `<name-server><name>8.8.8.8</name></name-server>`. */
function xmlNameList(inner: string, wrapper: string): string[] {
  const blocks = xmlBlocks(inner, wrapper);
  if (blocks.length === 0) return [];
  const out: string[] = [];
  for (const block of blocks) {
    const name = xmlChildText(block, 'name');
    if (name) out.push(name);
  }
  return out;
}

function normalizeMac(mac: string): string {
  const hex = (mac || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return (mac || '').trim().toLowerCase();
  return [
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10, 12),
  ].join(':').toLowerCase();
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** /24-style network address for a CIDR. */
function networkAddress(cidr: string): string {
  const [ip, mask] = cidr.split('/');
  const prefix = Number(mask);
  if (!ip || !Number.isFinite(prefix)) return '';
  const maskBits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(ipToInt(ip) & maskBits);
}

// ---------------------------------------------------------------------------
// RESTCONF transport
// ---------------------------------------------------------------------------

async function callRestRpc(
  host: string,
  body: string,
  timeoutMs = 25000,
): Promise<{ ok: boolean; raw: string; error?: string; status?: number }> {
  if (!restEnabled()) {
    return { ok: false, raw: '', error: 'JUNOS_REST_ENABLED=false' };
  }
  const cfg = restConfig();
  const url = `${cfg.scheme}://${host}:${cfg.port}/rpc`;
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, raw, error: `HTTP ${response.status}`, status: response.status };
    }
    if (/<xnm:error/i.test(raw)) {
      const message = xmlChildText(raw, 'message') || 'Junos RPC error';
      return { ok: false, raw, error: message, status: response.status };
    }
    return { ok: true, raw, status: response.status };
  } catch (error) {
    return {
      ok: false,
      raw: '',
      error: error instanceof Error ? error.message : 'Junos REST failed',
    };
  }
}

/** Load + commit a set of Junos CLI commands via RESTCONF. */
async function loadAndCommit(
  host: string,
  commands: string[],
  timeoutMs = 45000,
): Promise<{ ok: boolean; error?: string; loadRaw?: string; commitRaw?: string }> {
  const text = commands.join('\n');
  const loadBody =
    '<load-configuration action="set" format="text">' +
    `<configuration-set>${escapeXml(text)}</configuration-set>` +
    '</load-configuration>';

  const loaded = await callRestRpc(host, loadBody, timeoutMs);
  if (!loaded.ok) {
    return { ok: false, error: loaded.error || 'load-configuration failed', loadRaw: loaded.raw };
  }
  if (!/<load-success/i.test(loaded.raw)) {
    return { ok: false, error: 'Junos load-configuration did not succeed', loadRaw: loaded.raw };
  }

  const committed = await callRestRpc(host, '<commit-configuration/>', timeoutMs);
  if (!committed.ok) {
    return {
      ok: false,
      error: committed.error || 'commit-configuration failed',
      loadRaw: loaded.raw,
      commitRaw: committed.raw,
    };
  }
  if (!/<commit-success/i.test(committed.raw)) {
    return {
      ok: false,
      error: 'Junos commit-configuration did not succeed',
      loadRaw: loaded.raw,
      commitRaw: committed.raw,
    };
  }
  return { ok: true, loadRaw: loaded.raw, commitRaw: committed.raw };
}

// ---------------------------------------------------------------------------
// SSH transport (operational commands — the cli-information RPC is not
// supported on Junos Evo on QFX)
// ---------------------------------------------------------------------------

const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp521',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp256',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group1-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp521',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp256',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ],
  cipher: [
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes256-cbc',
    'aes192-cbc',
    'aes128-cbc',
    '3des-cbc',
  ],
  hmac: [
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha1-etm@openssh.com',
    'hmac-sha2-512',
    'hmac-sha2-256',
    'hmac-sha1',
    'hmac-sha1-96',
    'hmac-md5',
    'hmac-md5-96',
  ],
} satisfies Algorithms;

export type SshExecResult = { ok: boolean; output: string; error?: string };

export function runSshExec(
  host: string,
  command: string,
  options?: { timeoutMs?: number; port?: number },
): Promise<SshExecResult> {
  const timeoutMs = options?.timeoutMs ?? 30000;
  const port = options?.port ?? Number(process.env.LAB_SSH_PORT ?? 22);
  const username = process.env.LAB_SSH_USER || 'admin';
  const password = process.env.LAB_SSH_PASSWORD || 'Admin@123';

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const finish = (result: SshExecResult) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, output: '', error: `SSH command timeout: ${command}` });
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            finish({ ok: false, output: '', error: err.message });
            return;
          }
          let output = '';
          stream.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
          });
          stream.on('close', () => {
            clearTimeout(timer);
            finish({ ok: true, output });
          });
        });
      })
      .on('error', (error: Error) => {
        clearTimeout(timer);
        finish({ ok: false, output: '', error: error.message });
      })
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 20000,
        algorithms: SSH_ALGORITHMS,
      });
  });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse the `access address-assignment` config out of a `<get-configuration>`
 * XML response.
 *
 * Shape (verified on LAB-F6-DS-01):
 *   <configuration><access><address-assignment>
 *     <pool><name>V201</name><family><inet>
 *       <network>10.1.201.0/24</network>
 *       <range><name>R201</name><low>10.1.201.10</low><high>10.1.201.199</high></range>
 *       <dhcp-attributes>
 *         <maximum-lease-time>28800</maximum-lease-time>
 *         <domain-name>lab.netconsole.local</domain-name>
 *         <name-server><name>8.8.8.8</name></name-server>
 *         <router><name>10.1.201.254</name></router>
 *       </dhcp-attributes>
 *       <host><name>vpc5</name><hardware-address>aa:bb:..</hardware-address><ip-address>10.1.201.50</ip-address></host>
 *     </inet></family>
 *   </pool>
 *   </address-assignment></access></configuration>
 */
export function parseAddressAssignmentPools(configXml: string): DhcpServerPool[] {
  const assignment = xmlInner(configXml, 'address-assignment');
  if (!assignment) return [];

  const pools: DhcpServerPool[] = [];

  for (const poolBlock of xmlBlocks(assignment, 'pool')) {
    const poolName = xmlChildText(poolBlock, 'name');
    if (!poolName) continue;

    const inet = xmlInner(poolBlock, 'inet');
    if (!inet) continue;

    const network = xmlChildText(inet, 'network');
    const rangeBlock = xmlInner(inet, 'range');
    const rangeStart = xmlChildText(rangeBlock, 'low');
    const rangeEnd = xmlChildText(rangeBlock, 'high');

    const attrs = xmlInner(inet, 'dhcp-attributes');
    const gateway = xmlNameList(attrs, 'router')[0] ?? '';
    const dns = xmlNameList(attrs, 'name-server');
    const domainName = xmlChildText(attrs, 'domain-name');
    const leaseTime = Number(xmlChildText(attrs, 'maximum-lease-time')) || 0;

    const hosts: DhcpServerHost[] = [];
    for (const hostBlock of xmlBlocks(inet, 'host')) {
      const hostName = xmlChildText(hostBlock, 'name');
      const mac = xmlChildText(hostBlock, 'hardware-address');
      const ip = xmlChildText(hostBlock, 'ip-address');
      if (!mac || !ip) continue;
      hosts.push({ name: hostName, mac: normalizeMac(mac), ip });
    }

    // The gateway's third octet mirrors the VLAN id in the lab layout
    // (10.1.<vlan>.254). Prefer the interface the pool is bound to when we
    // can derive it, but fall back to the gateway octet.
    const vlan = deriveVlan(poolName, network, gateway);

    const poolSize =
      rangeStart && rangeEnd && ipToInt(rangeEnd) >= ipToInt(rangeStart)
        ? ipToInt(rangeEnd) - ipToInt(rangeStart) + 1
        : 0;

    pools.push({
      name: poolName,
      label: vlan ? `VLAN ${vlan}` : poolName,
      subnet: network ? networkAddress(network) || network : '',
      vlan,
      gateway,
      dns,
      domainName,
      leaseTime,
      rangeStart,
      rangeEnd,
      poolSize,
      reservedCount: hosts.length,
      hosts,
    });
  }

  return pools;
}

/** Best-effort VLAN id for a pool: from the name ("V201"), else the gateway octet. */
function deriveVlan(poolName: string, network: string, gateway: string): number {
  const fromName = /(\d{2,4})$/.exec(poolName);
  if (fromName) {
    const value = Number(fromName[1]);
    if (value >= 1 && value <= 4094) return value;
  }
  const fromGateway = /^(\d+)\.(\d+)\.(\d+)\./.exec(gateway);
  if (fromGateway) {
    const value = Number(fromGateway[3]);
    if (value >= 1 && value <= 4094) return value;
  }
  const fromNetwork = /^(\d+)\.(\d+)\.(\d+)\./.exec(network);
  if (fromNetwork) {
    const value = Number(fromNetwork[3]);
    if (value >= 1 && value <= 4094) return value;
  }
  return 0;
}

/**
 * Parse `get-dhcp-server-binding-information` XML into leases.
 *
 * IMPORTANT: the request must NOT carry a `<level>` child — Junos Evo
 * returns an empty list for `<level>detail</level>`. Use `<detail/>`.
 */
export function parseDhcpBindings(xml: string): DhcpServerLease[] {
  const leases: DhcpServerLease[] = [];

  for (const block of xmlBlocks(xml, 'dhcp-binding')) {
    const ip = xmlChildText(block, 'allocated-address');
    const mac = xmlChildText(block, 'mac-address');
    if (!ip || !mac) continue;

    const state = (xmlChildText(block, 'lease-state') || '').split('(')[0].trim();
    const expires = Number(xmlChildText(block, 'lease-expires')) || 0;
    const endTime = xmlChildText(block, 'lease-end-time');
    const startTime = xmlChildText(block, 'lease-start-time');

    const rawInterface = xmlChildText(block, 'interface-name');
    // "irb.201:xe-0/0/1.0" → logical "irb.201" + physical "xe-0/0/1.0"
    const [logical, physical] = rawInterface.includes(':')
      ? [rawInterface.slice(0, rawInterface.indexOf(':')), rawInterface.slice(rawInterface.indexOf(':') + 1)]
      : [rawInterface, ''];

    leases.push({
      ip,
      mac: normalizeMac(mac),
      state,
      leaseExpires: expires,
      expiresAt: endTime ? toIsoUtc(endTime) : null,
      startedAt: startTime ? toIsoUtc(startTime) : null,
      interface: logical,
      clientInterface: physical ? `${logical}:${physical}` : logical,
      serverIdentifier: xmlChildText(block, 'server-ip-address'),
      poolName: xmlChildText(block, 'pool-name'),
      sessionId: xmlChildText(block, 'session-id'),
    });
  }

  return leases;
}

/** "2026-10-30 14:46:56 UTC" → ISO 8601. */
function toIsoUtc(text: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/** Read the DHCP pool configuration from the switch. */
export async function fetchDhcpPools(host: string): Promise<{
  ok: boolean;
  pools: DhcpServerPool[];
  error?: string;
}> {
  const body =
    '<get-configuration format="xml">' +
    '<configuration><access><address-assignment/></access></configuration>' +
    '</get-configuration>';
  const result = await callRestRpc(host, body, 25000);
  if (!result.ok) {
    return { ok: false, pools: [], error: result.error || 'Failed to read DHCP pools' };
  }
  const xml = extractXmlBody(result.raw);
  if (!xml) {
    return { ok: false, pools: [], error: 'Empty DHCP pool configuration response' };
  }
  return { ok: true, pools: parseAddressAssignmentPools(xml) };
}

/**
 * Read the DHCP bindings from the switch.
 *
 * Uses the RESTCONF `get-dhcp-server-binding-information` RPC. When the
 * RPC is unavailable (older Junos, or a device without the DHCP server
 * feature) we fall back to `show dhcp server binding detail` over SSH.
 */
export async function fetchDhcpLeases(host: string): Promise<{
  ok: boolean;
  leases: DhcpServerLease[];
  source: 'restconf' | 'ssh';
  error?: string;
}> {
  const body =
    '<get-dhcp-server-binding-information ' +
    'xmlns="http://xml.juniper.net/junos/20.3R1/junos-dhcp-server"><detail/>' +
    '</get-dhcp-server-binding-information>';

  const result = await callRestRpc(host, body, 25000);
  if (result.ok) {
    const xml = extractXmlBody(result.raw);
    if (xml) {
      return { ok: true, leases: parseDhcpBindings(xml), source: 'restconf' };
    }
  }

  // RESTCONF fallback → SSH.
  const ssh = await runSshExec(host, 'show dhcp server binding detail', { timeoutMs: 40000 });
  if (!ssh.ok) {
    return {
      ok: false,
      leases: [],
      source: 'ssh',
      error: result.error || ssh.error || 'Failed to read DHCP bindings',
    };
  }
  return { ok: true, leases: parseDhcpBindingsText(ssh.output), source: 'ssh' };
}

/**
 * Parse `show dhcp server binding detail` (the text form).
 *
 * Each binding looks like:
 *   Client IP Address:  10.1.201.10
 *        Hardware Address:             00:50:79:66:68:05
 *        State:                        BOUND(LOCAL_SERVER_STATE_BOUND)
 *        Lease Expires:                2026-10-30 14:46:56 UTC
 *        Lease Expires in:             28585 seconds
 *        Lease Start:                  2026-10-30 06:46:55 UTC
 *        Incoming Client Interface:    irb.201:xe-0/0/1.0
 *        Server Identifier:            10.1.201.252
 *        Session Id:                   3
 *        Client Pool Name:             V201
 */
export function parseDhcpBindingsText(text: string): DhcpServerLease[] {
  const leases: DhcpServerLease[] = [];
  // Split on the record marker but keep the marker in each block so the
  // per-field regexes below can still find "Client IP Address:".
  const blocks = text
    .split(/^Client IP Address:/m)
    .slice(1)
    .map((block) => `Client IP Address:${block}`);

  for (const block of blocks) {
    const ip = /Client IP Address:\s*(\S+)/.exec(block)?.[1] ?? '';
    const mac = /Hardware Address:\s*(\S+)/.exec(block)?.[1] ?? '';
    if (!ip || !mac) continue;

    const rawState = /State:\s*(\S+)/.exec(block)?.[1] ?? '';
    const expiresIn = /Lease Expires in:\s*(\d+)/.exec(block)?.[1] ?? '0';
    const endTime = /Lease Expires:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    const startTime = /Lease Start:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    const rawInterface = /Incoming Client Interface:\s*(\S+)/.exec(block)?.[1] ?? '';
    const [logical, physical] = rawInterface.includes(':')
      ? [rawInterface.slice(0, rawInterface.indexOf(':')), rawInterface.slice(rawInterface.indexOf(':') + 1)]
      : [rawInterface, ''];

    leases.push({
      ip,
      mac: normalizeMac(mac),
      state: rawState.split('(')[0].trim(),
      leaseExpires: Number(expiresIn) || 0,
      expiresAt: endTime ? toIsoUtc(endTime) : null,
      startedAt: startTime ? toIsoUtc(startTime) : null,
      interface: logical,
      clientInterface: physical ? `${logical}:${physical}` : logical,
      serverIdentifier: /Server Identifier:\s*(\S+)/.exec(block)?.[1] ?? '',
      poolName: /Client Pool Name:\s*(\S+)/.exec(block)?.[1] ?? '',
      sessionId: /Session Id:\s*(\S+)/.exec(block)?.[1] ?? '',
    });
  }

  return leases;
}

// ---------------------------------------------------------------------------
// Public writes
// ---------------------------------------------------------------------------

/** Delete a single lease by IP. */
export async function deleteDhcpLease(host: string, ip: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const result = await runSshExec(host, `clear dhcp server binding ${ip}`, { timeoutMs: 40000 });
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to clear DHCP binding' };
  }
  if (/No binding for specified IP address/i.test(result.output)) {
    return { ok: false, error: `No binding for ${ip}` };
  }
  return { ok: true };
}

/** Clear every lease on an interface (used by the "wipe pool" action). */
export async function wipeDhcpPool(host: string, interfaceName: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  const result = await runSshExec(
    host,
    `clear dhcp server binding interface ${interfaceName}`,
    { timeoutMs: 40000 },
  );
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to clear DHCP bindings' };
  }
  return { ok: true };
}

export type DhcpSubnetInput = {
  /** Junos pool name. */
  poolName: string;
  /** Network in CIDR form. */
  subnet: string;
  poolStart: string;
  poolEnd: string;
  gateway: string;
  dns?: string[];
  domainName?: string;
  leaseTime?: number;
  /** Interface to bind the local server to (e.g. "irb.201"). */
  interfaceName: string;
  /** Name of the `dhcp-local-server group`. */
  groupName?: string;
};

const DEFAULT_GROUP = 'NETCONSOLE-DHCP';

/**
 * Add (or update) a DHCP pool on the switch.
 *
 * Emits the Junos Evo hierarchy:
 *   set system services dhcp-local-server group <G> interface <irb>
 *   set access address-assignment pool <P> family inet network <cidr>
 *   set access address-assignment pool <P> family inet range <R> low <..> high <..>
 *   set access address-assignment pool <P> family inet dhcp-attributes router <gw>
 *   ... name-server / domain-name / maximum-lease-time
 */
export async function addDhcpSubnet(host: string, input: DhcpSubnetInput): Promise<{
  ok: boolean;
  error?: string;
  commands?: string[];
}> {
  const group = input.groupName || DEFAULT_GROUP;
  const leaseTime = input.leaseTime && input.leaseTime > 0 ? input.leaseTime : 28800;
  const dns = input.dns?.length ? input.dns : ['8.8.8.8', '1.1.1.1'];

  const commands = [
    `set system services dhcp-local-server group ${group} interface ${input.interfaceName}`,
    `set access address-assignment pool ${input.poolName} family inet network ${input.subnet}`,
    `set access address-assignment pool ${input.poolName} family inet range ${input.poolName}R low ${input.poolStart} high ${input.poolEnd}`,
    `set access address-assignment pool ${input.poolName} family inet dhcp-attributes router ${input.gateway}`,
    ...dns.map(
      (server) =>
        `set access address-assignment pool ${input.poolName} family inet dhcp-attributes name-server ${server}`,
    ),
  ];
  if (input.domainName) {
    commands.push(
      `set access address-assignment pool ${input.poolName} family inet dhcp-attributes domain-name ${input.domainName}`,
    );
  }
  commands.push(
    `set access address-assignment pool ${input.poolName} family inet dhcp-attributes maximum-lease-time ${leaseTime}`,
  );

  const result = await loadAndCommit(host, commands);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to apply DHCP pool configuration', commands };
  }
  return { ok: true, commands };
}

/** Remove a DHCP pool (and its static hosts) from the switch. */
export async function deleteDhcpSubnet(host: string, poolName: string): Promise<{
  ok: boolean;
  error?: string;
  commands?: string[];
}> {
  const commands = [`delete access address-assignment pool ${poolName}`];
  const result = await loadAndCommit(host, commands);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to delete DHCP pool', commands };
  }
  return { ok: true, commands };
}

/**
 * Create / update a static reservation (host MAC ↔ IP) inside a pool.
 */
export async function fixStaticReservation(
  host: string,
  input: { poolName: string; ip: string; mac: string; hostname?: string },
): Promise<{ ok: boolean; error?: string; commands?: string[] }> {
  const mac = normalizeMac(input.mac);
  if (!mac) {
    return { ok: false, error: 'Invalid MAC address' };
  }
  const name = (input.hostname || '').trim() || mac.replace(/:/g, '');
  const commands = [
    `set access address-assignment pool ${input.poolName} family inet host ${name} hardware-address ${mac} ip-address ${input.ip}`,
  ];
  const result = await loadAndCommit(host, commands);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to create static reservation', commands };
  }
  return { ok: true, commands };
}

/**
 * Remove a static reservation from a pool.
 *
 * The Junos host statement is keyed by its NAME, so we must read the
 * current pool first to find the name that carries this IP/MAC.
 */
export async function unfixStaticReservation(
  host: string,
  input: { poolName: string; ip: string; mac?: string },
): Promise<{ ok: boolean; error?: string; commands?: string[] }> {
  const pools = await fetchDhcpPools(host);
  if (!pools.ok) {
    return { ok: false, error: pools.error || 'Failed to read DHCP pools' };
  }
  const pool = pools.pools.find((item) => item.name === input.poolName);
  if (!pool) {
    return { ok: false, error: `Pool ${input.poolName} not found` };
  }

  const mac = input.mac ? normalizeMac(input.mac) : '';
  const target = pool.hosts.find(
    (item) => item.ip === input.ip || (mac && item.mac === mac),
  );
  if (!target) {
    return { ok: false, error: `No static reservation for ${input.ip} in ${input.poolName}` };
  }

  const commands = [
    `delete access address-assignment pool ${input.poolName} family inet host ${target.name}`,
  ];
  const result = await loadAndCommit(host, commands);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to remove static reservation', commands };
  }
  return { ok: true, commands };
}

/**
 * Create a lease entry on the switch for a given IP/MAC.
 *
 * Junos has no "add a dynamic lease" RPC — a static reservation IS the
 * supported way to pin an IP to a MAC, so we write the host statement.
 */
export async function addDhcpLease(
  host: string,
  input: { poolName: string; ip: string; mac: string; hostname?: string },
): Promise<{ ok: boolean; error?: string; commands?: string[] }> {
  return fixStaticReservation(host, input);
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// ---------------------------------------------------------------------------

export type DhcpDashboardPool = {
  poolName: string;
  name: string;
  site: string;
  vlan: number;
  subnet: string;
  pool: string;
  gateway: string;
  dns: string[];
  leased: number;
  poolSize: number;
  utilization: number;
  reserved: number;
  interface: string;
};

export type DhcpDashboard = {
  server: {
    name: string;
    host: string;
    reachable: boolean;
    source: string;
  };
  sites: Array<{
    site: string;
    pools: number;
    leased: number;
    poolSize: number;
    utilization: number;
  }>;
  pools: DhcpDashboardPool[];
  gateways: Array<{
    site: string;
    vlan: number;
    gateway: string;
    subnet: string;
    name: string;
  }>;
  totals: {
    sites: number;
    pools: number;
    leased: number;
    poolSize: number;
  };
};

/**
 * Build the DHCP dashboard payload from the switch.
 *
 * The "site" concept is derived from the VLAN: in the lab every VLAN
 * belongs to site LAB. Sites are kept in the payload so the existing
 * site-filter UI keeps working, but there is no DC/DR HA dimension any
 * more — the switch is the only DHCP server.
 */
export async function getDhcpDashboard(): Promise<DhcpDashboard> {
  const host = await resolveDhcpServerAddress();

  const [poolsResult, leasesResult] = await Promise.all([
    fetchDhcpPools(host),
    fetchDhcpLeases(host),
  ]);

  if (!poolsResult.ok && !leasesResult.ok) {
    throw new Error(poolsResult.error || leasesResult.error || 'DHCP server unreachable');
  }

  const pools = poolsResult.pools;
  const leases = leasesResult.leases;

  const leaseCountByPool = new Map<string, number>();
  for (const lease of leases) {
    const key = lease.poolName || lease.interface;
    leaseCountByPool.set(key, (leaseCountByPool.get(key) ?? 0) + 1);
  }

  const SITE = 'LAB';

  const dashboardPools: DhcpDashboardPool[] = pools.map((pool) => {
    const leased = leaseCountByPool.get(pool.name) ?? 0;
    const interfaceName = pool.vlan ? `irb.${pool.vlan}` : '';
    return {
      poolName: pool.name,
      name: pool.label,
      site: SITE,
      vlan: pool.vlan,
      subnet: pool.subnet,
      pool: pool.rangeStart && pool.rangeEnd ? `${pool.rangeStart}-${pool.rangeEnd}` : '',
      gateway: pool.gateway,
      dns: pool.dns,
      leased,
      poolSize: pool.poolSize,
      utilization: pool.poolSize > 0 ? Math.round((leased / pool.poolSize) * 1000) / 10 : 0,
      reserved: pool.reservedCount,
      interface: interfaceName,
    };
  });

  const sites = [
    {
      site: SITE,
      pools: dashboardPools.length,
      leased: dashboardPools.reduce((sum, pool) => sum + pool.leased, 0),
      poolSize: dashboardPools.reduce((sum, pool) => sum + pool.poolSize, 0),
      utilization: 0,
    },
  ];
  sites[0].utilization =
    sites[0].poolSize > 0 ? Math.round((sites[0].leased / sites[0].poolSize) * 1000) / 10 : 0;

  return {
    server: {
      name: dhcpServerHost(),
      host,
      reachable: poolsResult.ok || leasesResult.ok,
      source: leasesResult.source,
    },
    sites,
    pools: dashboardPools,
    gateways: dashboardPools.map((pool) => ({
      site: pool.site,
      vlan: pool.vlan,
      gateway: pool.gateway,
      subnet: pool.subnet,
      name: pool.name,
    })),
    totals: {
      sites: sites.length,
      pools: dashboardPools.length,
      leased: sites[0].leased,
      poolSize: sites[0].poolSize,
    },
  };
}

/**
 * List the leases, enriched with the pool metadata and the client device
 * lookup (MAC → device/port), matching the shape the DHCP page expects.
 */
export async function listDhcpLeases(poolName?: string): Promise<
  Array<{
    ip: string;
    mac: string;
    hostname: string;
    clientDevice: string;
    clientPort: string;
    poolName: string;
    subnet: string;
    site: string;
    vlan: number;
    validLifetime: number;
    cltt: number | null;
    expiresAt: string | null;
    state: string;
    stateLabel: string;
    reserved: boolean;
    note: string;
  }>
> {
  const host = await resolveDhcpServerAddress();
  const [poolsResult, leasesResult] = await Promise.all([
    fetchDhcpPools(host),
    fetchDhcpLeases(host),
  ]);

  const pools = poolsResult.pools;
  const leases = leasesResult.leases;

  const poolByName = new Map(pools.map((pool) => [pool.name, pool]));
  const reservedByIp = new Map<string, { mac: string; hostname: string }>();
  for (const pool of pools) {
    for (const hostEntry of pool.hosts) {
      reservedByIp.set(hostEntry.ip, {
        mac: hostEntry.mac,
        hostname: hostEntry.name,
      });
    }
  }

  const clientsByMac = await buildClientLookup(
    (await listCollectableDevices()).map((device) => device.id),
  );

  const SITE = 'LAB';

  const rows = leases.map((lease) => {
    const pool = poolByName.get(lease.poolName);
    const reservedInfo = reservedByIp.get(lease.ip);
    const reserved = Boolean(reservedInfo && reservedInfo.mac === lease.mac);
    const client = clientsByMac.get(lease.mac);

    return {
      ip: lease.ip,
      mac: lease.mac,
      hostname: reservedInfo?.hostname ?? '',
      clientDevice: client?.device ?? '',
      clientPort: client?.port ?? '',
      poolName: lease.poolName,
      subnet: pool?.subnet ?? '',
      site: SITE,
      vlan: pool?.vlan ?? 0,
      validLifetime: lease.leaseExpires,
      cltt: lease.startedAt ? Math.floor(new Date(lease.startedAt).getTime() / 1000) : null,
      expiresAt: lease.expiresAt,
      state: lease.state,
      stateLabel: reserved ? 'static' : lease.state.toLowerCase(),
      reserved,
      note: '',
    };
  });

  // Static reservations that have no live lease yet still belong in the
  // table — the operator configured them on purpose.
  const seenIps = new Set(rows.map((row) => row.ip));
  for (const pool of pools) {
    for (const hostEntry of pool.hosts) {
      if (seenIps.has(hostEntry.ip)) continue;
      const client = clientsByMac.get(hostEntry.mac);
      rows.push({
        ip: hostEntry.ip,
        mac: hostEntry.mac,
        hostname: hostEntry.name,
        clientDevice: client?.device ?? '',
        clientPort: client?.port ?? '',
        poolName: pool.name,
        subnet: pool.subnet,
        site: SITE,
        vlan: pool.vlan,
        validLifetime: 0,
        cltt: null,
        expiresAt: null,
        state: 'RESERVED',
        stateLabel: 'static',
        reserved: true,
        note: '',
      });
    }
  }

  const filtered = poolName ? rows.filter((row) => row.poolName === poolName) : rows;
  return filtered.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}
