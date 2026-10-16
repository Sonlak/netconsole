/**
 * NetBox REST API client — backend side (read + write).
 *
 * Supports MULTIPLE NetBox instances via the `NETBOX_INSTANCES` env var
 * (JSON). Falls back to legacy `NETBOX_URL` + `NETBOX_TOKEN` for a single
 * instance.
 *
 *   NETBOX_INSTANCES='{"production":{"url":"http://...","token":"..."},"netbox2":{"url":"http://...","token":"..."}}'
 *   NETBOX_DEFAULT_INSTANCE=production
 *
 * All functions accept an optional `instance` parameter (string name, default =
 * NETBOX_DEFAULT_INSTANCE or "production"). When instance is omitted the call
 * goes to the default instance.
 *
 * Read methods are GET-only (idempotent). Write methods (POST/PATCH/DELETE)
 * are used by the import/copy tools. The assistant confirms with the user
 * before every write operation.
 *
 * Error model: any 4xx/5xx raises `NetBoxError` with the message from
 * NetBox. Routes convert that to a 502 with the message in the body
 * (mirror of the Kea route pattern).
 */

export class NetBoxError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'NetBoxError';
  }
}

// ─── Instance registry ────────────────────────────────────────────────────────

export type NetBoxInstanceConfig = {
  url: string;
  token: string;
};

type InstancesMap = Record<string, NetBoxInstanceConfig>;

let _instances: InstancesMap | null = null;
let _defaultInstance = 'production';

function loadInstances(): void {
  if (_instances !== null) return;
  try {
    const raw = process.env.NETBOX_INSTANCES;
    if (raw) {
      _instances = JSON.parse(raw) as InstancesMap;
    }
  } catch {
    _instances = {};
  }
  _defaultInstance =
    (process.env.NETBOX_DEFAULT_INSTANCE || 'production').trim() || 'production';
}

function getInstance(name?: string): NetBoxInstanceConfig {
  loadInstances();
  const instanceName = (name || _defaultInstance).trim();

  // Multi-instance config
  if (_instances && Object.keys(_instances).length > 0) {
    const cfg = _instances[instanceName];
    if (!cfg) {
      throw new NetBoxError(
        `Unknown NetBox instance "${instanceName}". Available: ${Object.keys(_instances).join(', ')}`,
      );
    }
    if (!cfg.url || !cfg.token) {
      throw new NetBoxError(`NetBox instance "${instanceName}" is missing url or token in config.`);
    }
    return cfg;
  }

  // Legacy single-instance fallback
  const url = (process.env.NETBOX_URL || 'http://localhost:8001/api/').trim();
  const token = (process.env.NETBOX_TOKEN || '').trim();
  if (!token) throw new NetBoxError('NETBOX_TOKEN is not set on the backend');
  return {
    url: url.endsWith('/') ? url : `${url}/`,
    token,
  };
}

export function listNetboxInstanceNames(): string[] {
  loadInstances();
  if (_instances && Object.keys(_instances).length > 0) {
    return Object.keys(_instances);
  }
  return ['production'];
}

export function getDefaultInstance(): string {
  loadInstances();
  return _defaultInstance;
}

/**
 * Resolve the instance name that would be used if `name` is passed to
 * any read/write helper. Returns the literal instance name string
 * (never undefined) — useful for stamping the resolved name into tool
 * results so the LLM can't mislabel which instance the data came from.
 */
export function resolveNetboxInstance(name?: string): string {
  loadInstances();
  return (name || _defaultInstance).trim();
}

// ─── Low-level request ───────────────────────────────────────────────────────

function timeoutMs(): number {
  return Number(process.env.NETBOX_TIMEOUT_MS) || 15000;
}

interface NetBoxRequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

async function netboxFetch(
  instanceName: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  options: NetBoxRequestOptions = {},
): Promise<unknown> {
  const { url: base, token } = getInstance(instanceName);
  // Normalize: strip leading slashes so new URL(path, base) treats it as
  // relative (avoids dropping the /api/ prefix — WHATWG URL spec).
  const relative = path.replace(/^\/+/, '');
  const fetchUrl = new URL(relative, base);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value === undefined || value === null || value === '') continue;
      fetchUrl.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const linkedSignal = options.signal;
  if (linkedSignal) {
    if (linkedSignal.aborted) controller.abort();
    else linkedSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(fetchUrl, {
      method,
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(body ? {} : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = `NetBox HTTP ${response.status}`;
      let rawBody = '';
      try {
        const json = (await response.json()) as { detail?: string; [key: string]: unknown };
        if (json?.detail) detail += `: ${json.detail}`;
        rawBody = JSON.stringify(json);
      } catch {
        rawBody = await response.text().catch(() => '');
      }
      const error = new NetBoxError(detail, response.status);
      (error as unknown as { _raw: string })._raw = rawBody.slice(0, 500);
      throw error;
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error instanceof NetBoxError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetBoxError(
        `NetBox request timed out after ${timeoutMs()}ms: ${fetchUrl.pathname}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[netbox:${method}] ${fetchUrl.pathname} failed: ${message}`);
    throw new NetBoxError(`NetBox ${method} ${fetchUrl.pathname} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function netboxGet<T>(
  instanceName: string | undefined,
  path: string,
  options: NetBoxRequestOptions = {},
): Promise<T> {
  return (await netboxFetch(instanceName, 'GET', path, undefined, options)) as T;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface NetBoxListResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export type NetBoxSite = {
  id: number;
  name: string;
  slug: string;
  status: { value: string; label: string };
  description: string;
  region: { id: number; name: string } | null;
  tags: Array<{ id: number; name: string; slug: string }>;
};

export type NetBoxDeviceRole = {
  id: number;
  name: string;
  slug: string;
  color: string;
  description: string;
  vm_role: boolean;
};

export type NetBoxManufacturer = {
  id: number;
  name: string;
  slug: string;
  description: string;
};

export type NetBoxDevice = {
  id: number;
  name: string;
  device_type: { id: number; manufacturer: { id: number; name: string }; model: string; slug: string };
  role: { id: number; name: string; slug: string; color: string } | null;
  site: { id: number; name: string; slug: string } | null;
  status: { value: string; label: string };
  serial: string;
  platform: { id: number; name: string; slug: string } | null;
  rack: { id: number; name: string } | null;
  position: number | null;
  face: { value: string; label: string } | null;
  primary_ip4: { id: number; address: string } | null;
  primary_ip6: { id: number; address: string } | null;
  description: string;
  comments: string;
  tags: Array<{ id: number; name: string; slug: string }>;
  custom_fields: Record<string, unknown>;
  url: string;
  created: string;
  last_updated: string;
};

export type NetBoxInterface = {
  id: number;
  device: { id: number; name: string };
  name: string;
  type: { value: string; label: string } | null;
  enabled: boolean;
  description: string;
  mtu: number | null;
  speed: number | null;
  mac_address: string | null;
  mode: { value: string; label: string } | null;
  untagged_vlan: { id: number; vid: number; name: string } | null;
  tagged_vlans: Array<{ id: number; vid: number; name: string }>;
  tag: { value: string; label: string } | null;
};

export type NetBoxVlan = {
  id: number;
  vid: number;
  name: string;
  status: { value: string; label: string };
  site: { id: number; name: string } | null;
  group: { id: number; name: string } | null;
  description: string;
  role: { id: number; name: string } | null;
};

export type NetBoxPrefix = {
  id: number;
  prefix: string;
  site: { id: number; name: string; slug?: string } | null;
  vrf: { id: number; name: string; rd?: string | null } | null;
  tenant: { id: number; name: string; slug?: string } | null;
  vlan: { id: number; vid: number; name: string; display?: string } | null;
  role: { id: number; name: string; slug?: string } | null;
  tags: Array<{ id: number; name: string; slug: string }>;
  status: { value: string; label: string };
  description: string;
  utilization: number;
  is_pool: boolean;
  mark_utilized: boolean;
  prefix_length: number;
};

export type NetBoxIpAddress = {
  id: number;
  address: string;
  status: { value: string; label: string };
  role: { id: number; name: string } | null;
  dns_name: string;
  description: string;
  assigned_object: { id: number; name: string; device: { id: number; name: string } | null } | null;
  interface: { id: number; name: string } | null;
  nat_inside: { id: number; address: string } | null;
  tags: Array<{ id: number; name: string; slug: string }>;
};

// ─── READ API (all accept optional `instance` param) ────────────────────────

/** True if the NetBox API is reachable. Uses the lightweight /status/ endpoint. */
export async function netboxHealthCheck(instance?: string): Promise<boolean> {
  try {
    await netboxGet(instance, '/status/');
    return true;
  } catch {
    return false;
  }
}

export async function listNetboxSites(instance?: string, options: { limit?: number } = {}): Promise<NetBoxSite[]> {
  const data = await netboxGet<NetBoxListResponse<NetBoxSite>>(instance, '/dcim/sites/', {
    params: { limit: options.limit ?? 200 },
  });
  return data.results;
}

export async function listNetboxDeviceRoles(instance?: string, options: { limit?: number } = {}): Promise<NetBoxDeviceRole[]> {
  const data = await netboxGet<NetBoxListResponse<NetBoxDeviceRole>>(instance, '/dcim/device-roles/', {
    params: { limit: options.limit ?? 100 },
  });
  return data.results;
}

export async function listNetboxManufacturers(instance?: string, options: { limit?: number } = {}): Promise<NetBoxManufacturer[]> {
  const data = await netboxGet<NetBoxListResponse<NetBoxManufacturer>>(instance, '/dcim/manufacturers/', {
    params: { limit: options.limit ?? 200 },
  });
  return data.results;
}

export type ListNetboxDevicesOptions = {
  limit?: number;
  offset?: number;
  site_id?: number;
  site?: string;
  role_id?: number;
  role?: string;
  manufacturer_id?: number;
  status?: 'active' | 'offline' | 'planned' | 'staged' | 'failed' | 'inventory' | 'decommissioning';
  tag?: string;
  search?: string;
  netconsole_id?: string;
};

export async function listNetboxDevices(
  instance: string | undefined,
  options: ListNetboxDevicesOptions = {},
): Promise<{ total: number; devices: NetBoxDevice[] }> {
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const data = await netboxGet<NetBoxListResponse<NetBoxDevice>>(instance, '/dcim/devices/', {
    params: {
      limit,
      offset,
      site_id: options.site_id,
      site: options.site,
      role_id: options.role_id,
      role: options.role,
      manufacturer_id: options.manufacturer_id,
      status: options.status,
      tag: options.tag,
      q: options.search,
      cf_netconsole_id: options.netconsole_id,
    },
  });
  return { total: data.count, devices: data.results };
}

export async function getNetboxDeviceById(instance: string | undefined, id: number): Promise<NetBoxDevice | null> {
  try {
    return await netboxGet<NetBoxDevice>(instance, `/dcim/devices/${id}/`);
  } catch (error) {
    if (error instanceof NetBoxError && error.message.includes('HTTP 404')) return null;
    throw error;
  }
}

export async function findNetboxDeviceByNetconsoleId(instance: string | undefined, netconsoleId: string): Promise<NetBoxDevice | null> {
  const { devices } = await listNetboxDevices(instance, { netconsole_id: netconsoleId, limit: 1 });
  return devices[0] ?? null;
}

export async function listNetboxInterfaces(
  instance: string | undefined,
  deviceId: number,
  options: { limit?: number } = {},
): Promise<NetBoxInterface[]> {
  const limit = Math.min(options.limit ?? 500, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxInterface>>(instance, '/dcim/interfaces/', {
    params: { device_id: deviceId, limit },
  });
  return data.results;
}

export async function listNetboxVlans(
  instance: string | undefined,
  options: { site_id?: number; site?: string; limit?: number } = {},
): Promise<NetBoxVlan[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxVlan>>(instance, '/ipam/vlans/', {
    params: { site_id: options.site_id, site: options.site, limit },
  });
  return data.results;
}

export async function listNetboxPrefixes(
  instance: string | undefined,
  options: {
    site_id?: number;
    site?: string;
    status?: string;
    contains?: string;
    prefix?: string;
    tenant?: string;
    vlan?: string | number;
    role?: string;
    limit?: number;
  } = {},
): Promise<{ results: NetBoxPrefix[]; count: number }> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxPrefix>>(instance, '/ipam/prefixes/', {
    params: {
      site_id: options.site_id,
      site: options.site,
      status: options.status,
      contains: options.contains,
      prefix: options.prefix,
      tenant: options.tenant,
      vlan_id: typeof options.vlan === 'number' ? options.vlan : undefined,
      vlan: typeof options.vlan === 'string' ? options.vlan : undefined,
      role: options.role,
      // `limit=0` is the documented NetBox way to ask for the total count
      // without paying for a results page. Falls back to the actual limit
      // if 0 isn't accepted (older NetBox versions).
      limit: limit === 0 ? 0 : limit,
    },
  });
  return { results: data.results, count: data.count };
}

export async function listNetboxIpAddresses(
  instance: string | undefined,
  options: { device_id?: number; site_id?: number; status?: string; search?: string; limit?: number } = {},
): Promise<NetBoxIpAddress[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxIpAddress>>(instance, '/ipam/ip-addresses/', {
    params: {
      device_id: options.device_id,
      site_id: options.site_id,
      status: options.status,
      q: options.search,
      limit,
    },
  });
  return data.results;
}

// ─── WRITE API ────────────────────────────────────────────────────────────────

type NetBoxCreateResult = { id: number; url?: string };
type NetBoxUpdateResult = Record<string, unknown>;

async function netboxPost<T extends NetBoxCreateResult>(
  instance: string | undefined,
  path: string,
  body: unknown,
): Promise<T> {
  return (await netboxFetch(instance, 'POST', path, body)) as T;
}

async function netboxPatch(
  instance: string | undefined,
  path: string,
  body: unknown,
): Promise<NetBoxUpdateResult> {
  return (await netboxFetch(instance, 'PATCH', path, body)) as NetBoxUpdateResult;
}

async function netboxDelete(
  instance: string | undefined,
  path: string,
): Promise<void> {
  await netboxFetch(instance, 'DELETE', path, undefined);
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

type NetBoxTag = { id: number; name: string; slug: string; description: string };

async function getOrCreateTag(
  instance: string | undefined,
  name: string,
  slug: string,
  description = '',
): Promise<number> {
  const existing = await netboxGet<NetBoxListResponse<NetBoxTag>>(instance, '/extras/tags/', {
    params: { slug },
  });
  if (existing.results.length > 0) return existing.results[0].id;
  const created = await netboxPost<NetBoxTag>(instance, '/extras/tags/', {
    name,
    slug,
    description,
  });
  return created.id;
}

// ── Tenant ───────────────────────────────────────────────────────────────────

export type NetBoxTenant = { id: number; name: string; slug: string };

export async function getOrCreateNetboxTenant(
  instance: string | undefined,
  name: string,
): Promise<number> {
  if (!name) return 0;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = await netboxGet<NetBoxListResponse<NetBoxTenant>>(instance, '/tenancy/tenants/', {
    params: { slug },
  });
  if (existing.results.length > 0) return existing.results[0].id;
  const created = await netboxPost<NetBoxTenant>(instance, '/tenancy/tenants/', {
    name,
    slug,
  });
  return created.id;
}

// ── VRF ────────────────────────────────────────────────────────────────────────

export type NetBoxVrf = { id: number; name: string; rd: string };

export async function getOrCreateNetboxVrf(
  instance: string | undefined,
  name: string,
  rd?: string,
): Promise<number> {
  if (!name) return 0;
  const existing = await netboxGet<NetBoxListResponse<NetBoxVrf>>(instance, '/ipam/vrfs/', {
    params: { name },
  });
  if (existing.results.length > 0) return existing.results[0].id;
  const created = await netboxPost<NetBoxVrf>(instance, '/ipam/vrfs/', {
    name,
    rd: rd || `65000:${Math.floor(Math.random() * 65000) + 1}`,
  });
  return created.id;
}

// ── VLAN ──────────────────────────────────────────────────────────────────────

export type NetBoxVlanResult = { id: number; vid: number; name: string };

export async function getOrCreateNetboxVlan(
  instance: string | undefined,
  vid: number,
  tenantId?: number,
): Promise<number> {
  if (!vid) return 0;
  const params: Record<string, string | number> = { vid };
  if (tenantId) params.tenant_id = tenantId;
  const existing = await netboxGet<NetBoxListResponse<NetBoxVlanResult>>(instance, '/ipam/vlans/', { params });
  if (existing.results.length > 0) return existing.results[0].id;
  const created = await netboxPost<NetBoxVlanResult>(instance, '/ipam/vlans/', {
    vid,
    name: `VLAN ${vid}`,
    status: 'active',
    ...(tenantId ? { tenant: tenantId } : {}),
  });
  return created.id;
}

// ── Prefix Role ───────────────────────────────────────────────────────────────

export type NetBoxRoleResult = { id: number; name: string; slug: string };

export async function getOrCreateNetboxRole(
  instance: string | undefined,
  name: string,
): Promise<number> {
  if (!name) return 0;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const existing = await netboxGet<NetBoxListResponse<NetBoxRoleResult>>(instance, '/ipam/roles/', {
    params: { slug },
  });
  if (existing.results.length > 0) return existing.results[0].id;
  const created = await netboxPost<NetBoxRoleResult>(instance, '/ipam/roles/', { name, slug });
  return created.id;
}

// ── Prefix ───────────────────────────────────────────────────────────────────

export type CreateNetboxPrefixOptions = {
  prefix: string;
  status?: string;
  description?: string;
  site?: string;       // site name (slug-lookup + create-if-missing)
  vrf?: string;        // VRF name (get-or-create by name)
  tenant?: string;     // tenant name (get-or-create by name)
  vlan?: number;       // VID (get-or-create by VID)
  role?: string;       // role name (get-or-create by name)
  tags?: string[];     // tag slugs (get-or-create each)
  is_pool?: boolean;
  mark_utilized?: boolean;
  comments?: string;
  /** When true: if prefix exists, PATCH it with updated fields. Default: skip. */
  overwrite?: boolean;
};

export type CreateNetboxPrefixResult = {
  action: 'created' | 'skipped' | 'updated' | 'error';
  id?: number;
  prefix: string;
  error?: string;
};

export async function findNetboxPrefix(
  instance: string | undefined,
  prefix: string,
): Promise<NetBoxPrefix | null> {
  const data = await netboxGet<NetBoxListResponse<NetBoxPrefix>>(instance, '/ipam/prefixes/', {
    params: { prefix, limit: 1 },
  });
  return data.results[0] ?? null;
}

export async function createNetboxPrefix(
  instance: string | undefined,
  opts: CreateNetboxPrefixOptions,
): Promise<CreateNetboxPrefixResult> {
  const { prefix, overwrite = false, tags, vrf, tenant, vlan, role, ...rest } = opts;

  // Resolve related objects to IDs
  const [vrfId, tenantId, vlanId, roleId] = await Promise.all([
    vrf ? getOrCreateNetboxVrf(instance, vrf) : Promise.resolve(0),
    tenant ? getOrCreateNetboxTenant(instance, tenant) : Promise.resolve(0),
    vlan ? getOrCreateNetboxVlan(instance, vlan, tenant ? (await getOrCreateNetboxTenant(instance, tenant)) || undefined : undefined) : Promise.resolve(0),
    role ? getOrCreateNetboxRole(instance, role) : Promise.resolve(0),
  ]);

  // Resolve tag slugs to IDs
  const tagIds: number[] = [];
  if (tags && tags.length > 0) {
    for (const t of tags) {
      try { tagIds.push(await getOrCreateTag(instance, t, t)); } catch { /* skip */ }
    }
  }

  const payload: Record<string, unknown> = {
    prefix,
    status: opts.status || 'active',
    ...rest,
    ...(vrfId ? { vrf: vrfId } : {}),
    ...(tenantId ? { tenant: tenantId } : {}),
    ...(vlanId ? { vlan: vlanId } : {}),
    ...(roleId ? { role: roleId } : {}),
    ...(tagIds.length > 0 ? { tags: tagIds } : {}),
  };

  try {
    const existing = await findNetboxPrefix(instance, prefix);
    if (existing) {
      if (!overwrite) return { action: 'skipped', prefix };
      // PATCH existing
      const patchable = { ...payload };
      delete (patchable as Record<string, unknown>)['prefix']; // prefix is immutable on PATCH
      await netboxPatch(instance, `/ipam/prefixes/${existing.id}/`, patchable);
      return { action: 'updated', id: existing.id, prefix };
    }

    const created = await netboxPost<{ id: number }>(instance, '/ipam/prefixes/', payload);
    return { action: 'created', id: created.id, prefix };
  } catch (error) {
    const msg = error instanceof NetBoxError ? error.message : String(error);
    return { action: 'error', prefix, error: msg };
  }
}

export type BulkCreateNetboxPrefixesResult = {
  total: number;
  created: number;
  skipped: number;
  updated: number;
  errors: number;
  details: CreateNetboxPrefixResult[];
};

export async function bulkCreateNetboxPrefixes(
  instance: string | undefined,
  rows: CreateNetboxPrefixOptions[],
  concurrency = 3,
): Promise<BulkCreateNetboxPrefixesResult> {
  const details: CreateNetboxPrefixResult[] = [];
  let created = 0, skipped = 0, updated = 0, errors = 0;

  // Process in batches to avoid hammering the API
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((row) => createNetboxPrefix(instance, row)),
    );
    details.push(...results);
    for (const r of results) {
      if (r.action === 'created') created++;
      else if (r.action === 'skipped') skipped++;
      else if (r.action === 'updated') updated++;
      else errors++;
    }
    // Rate-limit: small sleep between batches
    if (i + concurrency < rows.length) await new Promise((r) => setTimeout(r, 100));
  }

  return { total: rows.length, created, skipped, updated, errors, details };
}

// ── Copy all prefixes from one instance to another ──────────────────────────

export type CopyNetboxPrefixesOptions = {
  sourceInstance: string;
  targetInstance: string;
  /** If provided, only copy prefixes belonging to this tenant name. */
  tenantFilter?: string;
  /** If provided, only copy prefixes belonging to this site name. */
  siteFilter?: string;
  /** When true: PATCH existing prefixes in target with source data. Default: skip. */
  overwrite?: boolean;
};

export async function copyNetboxPrefixesToInstance(
  opts: CopyNetboxPrefixesOptions,
): Promise<{ total: number; created: number; skipped: number; updated: number; errors: number }> {
  // 1. Fetch all prefixes from source (paginate)
  const allPrefixes: NetBoxPrefix[] = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const data = await netboxGet<NetBoxListResponse<NetBoxPrefix>>(
      opts.sourceInstance,
      '/ipam/prefixes/',
      { params: { limit, offset, ...(opts.tenantFilter ? { tenant: opts.tenantFilter } : {}), ...(opts.siteFilter ? { site: opts.siteFilter } : {}) } },
    );
    allPrefixes.push(...data.results);
    if (!data.next || allPrefixes.length >= data.count) break;
    offset += data.results.length;
  }

  // 2. Convert to CreateNetboxPrefixOptions
  const rows: CreateNetboxPrefixOptions[] = allPrefixes.map((p) => ({
    prefix: p.prefix,
    status: p.status?.value || 'active',
    description: p.description || '',
    site: p.site?.name,
    vrf: p.vrf?.name,
    tenant: p.tenant?.name,
    vlan: p.vlan?.vid,
    role: p.role?.name,
    tags: (p.tags || []).map((t: { slug?: string }) => t.slug || '').filter(Boolean),
    is_pool: p.is_pool,
    mark_utilized: p.mark_utilized,
    comments: (p as unknown as Record<string, unknown>)['comments'] as string || '',
    overwrite: opts.overwrite,
  }));

  // 3. Bulk create
  const result = await bulkCreateNetboxPrefixes(opts.targetInstance, rows);
  return {
    total: result.total,
    created: result.created,
    skipped: result.skipped,
    updated: result.updated,
    errors: result.errors,
  };
}
