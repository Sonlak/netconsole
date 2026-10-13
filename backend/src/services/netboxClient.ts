/**
 * NetBox REST API client (backend, read-only).
 *
 * The worker has the canonical NetBox client (used for sync). This is a
 * thin backend counterpart used by:
 *   - HTTP routes (`/api/netbox/*`) for the frontend to query NetBox
 *   - AI assistant handlers for the same queries from chat
 *
 * The split is intentional:
 *   - Worker client: full read+write, used during sync (Phase 1+2)
 *   - Backend client: read-only, used for ad-hoc queries from UI/assistant
 *   - The two stay in sync conceptually (same field names) but the worker
 *     is the only place we mutate NetBox.
 *
 * Idempotency: every method is GET. No POST/PATCH/DELETE on this side.
 *
 * Error model: any 4xx/5xx raises `NetBoxError` with the message from
 * NetBox. Routes convert that to a 502 with the message in the body
 * (mirror of the Kea route pattern).
 */

export class NetBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetBoxError';
  }
}

function getNetboxUrl(): string {
  const raw = (process.env.NETBOX_URL || 'http://localhost:8001/api/').trim();
  // Ensure trailing slash (URL join safety).
  return raw.endsWith('/') ? raw : `${raw}/`;
}

function getNetboxToken(): string {
  return (process.env.NETBOX_TOKEN || '').trim();
}

function timeoutMs(): number {
  return Number(process.env.NETBOX_TIMEOUT_MS) || 15000;
}

interface NetBoxListResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

interface NetBoxRequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

/**
 * Fire a GET request to the NetBox API. Returns the parsed JSON body.
 * Throws NetBoxError on any 4xx/5xx or network failure.
 */
async function netboxGet<T>(path: string, options: NetBoxRequestOptions = {}): Promise<T> {
  const base = getNetboxUrl();
  const token = getNetboxToken();
  if (!token) {
    throw new NetBoxError('NETBOX_TOKEN is not set on the backend');
  }
  const url = new URL(path, base);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
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
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = `NetBox HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { detail?: string };
        if (body?.detail) detail += `: ${body.detail}`;
      } catch {
        // ignore — keep the status-only message
      }
      throw new NetBoxError(detail);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof NetBoxError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetBoxError(`NetBox request timed out after ${timeoutMs()}ms: ${url.pathname}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[netbox] GET ${url.pathname} failed: ${message}`);
    throw new NetBoxError(`NetBox GET ${url.pathname} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public read API ─────────────────────────────────────────────────────────

/** True if the NetBox API is reachable. Uses the lightweight /status/ endpoint. */
export async function netboxHealthCheck(): Promise<boolean> {
  try {
    await netboxGet<unknown>('/status/');
    return true;
  } catch {
    return false;
  }
}

// ── Sites ───────────────────────────────────────────────────────────────────

export type NetBoxSite = {
  id: number;
  name: string;
  slug: string;
  status: { value: string; label: string };
  description: string;
  region: { id: number; name: string } | null;
  tags: Array<{ id: number; name: string; slug: string }>;
};

export async function listNetboxSites(options: { limit?: number } = {}): Promise<NetBoxSite[]> {
  const limit = options.limit ?? 200;
  const data = await netboxGet<NetBoxListResponse<NetBoxSite>>('/dcim/sites/', {
    params: { limit },
  });
  return data.results;
}

// ── Device roles ────────────────────────────────────────────────────────────

export type NetBoxDeviceRole = {
  id: number;
  name: string;
  slug: string;
  color: string;
  description: string;
  vm_role: boolean;
};

export async function listNetboxDeviceRoles(options: { limit?: number } = {}): Promise<NetBoxDeviceRole[]> {
  const limit = options.limit ?? 100;
  const data = await netboxGet<NetBoxListResponse<NetBoxDeviceRole>>('/dcim/device-roles/', {
    params: { limit },
  });
  return data.results;
}

// ── Manufacturers ───────────────────────────────────────────────────────────

export type NetBoxManufacturer = {
  id: number;
  name: string;
  slug: string;
  description: string;
};

export async function listNetboxManufacturers(options: { limit?: number } = {}): Promise<NetBoxManufacturer[]> {
  const limit = options.limit ?? 200;
  const data = await netboxGet<NetBoxListResponse<NetBoxManufacturer>>('/dcim/manufacturers/', {
    params: { limit },
  });
  return data.results;
}

// ── Devices ─────────────────────────────────────────────────────────────────

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
  /** Filter by `cf_netconsole_id` exact match (used to look up a device
   *  by NetConsole primary key — preferred over name match). */
  netconsole_id?: string;
};

export async function listNetboxDevices(
  options: ListNetboxDevicesOptions = {},
): Promise<{ total: number; devices: NetBoxDevice[] }> {
  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const data = await netboxGet<NetBoxListResponse<NetBoxDevice>>('/dcim/devices/', {
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

export async function getNetboxDeviceById(id: number): Promise<NetBoxDevice | null> {
  try {
    return await netboxGet<NetBoxDevice>(`/dcim/devices/${id}/`);
  } catch (error) {
    if (error instanceof NetBoxError && error.message.includes('HTTP 404')) return null;
    throw error;
  }
}

/**
 * Convenience: look up a device by its NetConsole UUID via the custom field.
 * Returns the NetBox device dict or null.
 */
export async function findNetboxDeviceByNetconsoleId(
  netconsoleId: string,
): Promise<NetBoxDevice | null> {
  const { devices } = await listNetboxDevices({ netconsole_id: netconsoleId, limit: 1 });
  return devices[0] ?? null;
}

// ── Interfaces (per NetBox device) ──────────────────────────────────────────

export type NetBoxInterface = {
  id: number;
  device: { id: number; name: string };
  name: string;
  type: { value: string; label: string } | null;
  enabled: boolean;
  description: string;
  mtu: number | null;
  speed: number | null; // bps
  mac_address: string | null;
  mode: { value: string; label: string } | null;
  untagged_vlan: { id: number; vid: number; name: string } | null;
  tagged_vlans: Array<{ id: number; vid: number; name: string }>;
  // 802.1Q mode marker (NetBox v4 split tag/all into separate fields)
  tag: { value: string; label: string } | null;
};

export async function listNetboxInterfaces(
  deviceId: number,
  options: { limit?: number } = {},
): Promise<NetBoxInterface[]> {
  const limit = Math.min(options.limit ?? 500, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxInterface>>('/dcim/interfaces/', {
    params: { device_id: deviceId, limit },
  });
  return data.results;
}

// ── VLANs (per site or all) ─────────────────────────────────────────────────

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

export async function listNetboxVlans(
  options: { site_id?: number; site?: string; limit?: number } = {},
): Promise<NetBoxVlan[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxVlan>>('/ipam/vlans/', {
    params: {
      site_id: options.site_id,
      site: options.site,
      limit,
    },
  });
  return data.results;
}

// ── Prefixes (IPAM) ─────────────────────────────────────────────────────────

export type NetBoxPrefix = {
  id: number;
  prefix: string;
  site: { id: number; name: string } | null;
  vrf: { id: number; name: string } | null;
  status: { value: string; label: string };
  role: { id: number; name: string } | null;
  description: string;
  utilization: number; // % (NetBox v4 computes this)
};

export async function listNetboxPrefixes(
  options: { site_id?: number; site?: string; status?: string; limit?: number } = {},
): Promise<NetBoxPrefix[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxPrefix>>('/ipam/prefixes/', {
    params: {
      site_id: options.site_id,
      site: options.site,
      status: options.status,
      limit,
    },
  });
  return data.results;
}

// ── IP addresses (IPAM) ─────────────────────────────────────────────────────

export type NetBoxIpAddress = {
  id: number;
  address: string; // "x.x.x.x/32"
  status: { value: string; label: string };
  role: { id: number; name: string } | null;
  dns_name: string;
  description: string;
  assigned_object: {
    id: number;
    name: string;
    device: { id: number; name: string } | null;
  } | null;
  interface: { id: number; name: string } | null;
  nat_inside: { id: number; address: string } | null;
  tags: Array<{ id: number; name: string; slug: string }>;
};

export async function listNetboxIpAddresses(
  options: {
    device_id?: number;
    site_id?: number;
    status?: string;
    search?: string;
    limit?: number;
  } = {},
): Promise<NetBoxIpAddress[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const data = await netboxGet<NetBoxListResponse<NetBoxIpAddress>>('/ipam/ip-addresses/', {
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
