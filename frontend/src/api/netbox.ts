/**
 * NetBox API client (frontend).
 *
 * Mirrors backend `routes/netbox.ts`:
 * - All routes accept optional `?instance=<name>` query param
 * - WRITE routes require ADMIN role
 */

import { authJsonFetch } from './http';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NetBoxInstanceInfo = {
  id: number;
  name: string;
  slug: string;
  description?: string;
  status?: { value: string; label: string };
  tags?: Array<{ id: number; name: string; slug: string }>;
};

export type NetBoxPrefix = {
  id: number;
  prefix: string;
  prefix_length: number;
  site?: { id: number; name: string; slug?: string } | null;
  vrf?: { id: number; name: string; rd?: string | null } | null;
  tenant?: { id: number; name: string; slug?: string } | null;
  vlan?: { id: number; vid: number; name: string; display?: string } | null;
  role?: { id: number; name: string; slug?: string } | null;
  status: { value: string; label: string };
  description: string;
  utilization: number;
  is_pool: boolean;
  mark_utilized: boolean;
};

export type NetBoxInstances = {
  instances: string[];
  default: string;
};

// ─── READ ──────────────────────────────────────────────────────────────────────

export async function fetchNetboxInstances(): Promise<NetBoxInstances> {
  const res = await fetch('/api/netbox/instances', { credentials: 'include' });
  if (!res.ok) throw new Error(`NetBox instances HTTP ${res.status}`);
  return res.json();
}

export async function fetchNetboxHealth(instance?: string): Promise<{ ok: boolean; instance: string }> {
  const qs = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  const res = await fetch(`/api/netbox/health${qs}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`NetBox health HTTP ${res.status}`);
  return res.json();
}

export async function fetchNetboxPrefixes(instance?: string, limit = 1000): Promise<NetBoxPrefix[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (instance) params.set('instance', instance);
  const res = await fetch(`/api/netbox/prefixes?${params}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`NetBox prefixes HTTP ${res.status}`);
  const body = await res.json();
  return body.prefixes ?? [];
}

// ─── WRITE ─────────────────────────────────────────────────────────────────────

export type ImportPrefixRow = {
  prefix: string;
  status?: string;
  description?: string;
  site?: string;
  vrf?: string;
  tenant?: string;
  vlan?: number;
  role?: string;
  tags?: string[];
};

export type ImportPrefixResult = {
  total: number;
  created: number;
  skipped: number;
  updated: number;
  errors: number;
  details?: Array<{ action: string; prefix: string; id?: number; error?: string }>;
  instance: string;
  overwrite: boolean;
};

export async function importPrefixes(
  rows: ImportPrefixRow[],
  options: { instance?: string; overwrite?: boolean; csvText?: string } = {},
): Promise<ImportPrefixResult> {
  const body: Record<string, unknown> = {
    overwrite: options.overwrite ?? false,
  };
  if (options.instance) body.instance = options.instance;
  if (rows.length > 0) body.rows = rows;
  if (options.csvText) body.csvText = options.csvText;

  const res = await authJsonFetch<ImportPrefixResult>('/api/netbox/import-prefixes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res;
}

export type CopyPrefixResult = {
  total: number;
  created: number;
  skipped: number;
  updated: number;
  errors: number;
  sourceInstance: string;
  targetInstance: string;
  overwrite: boolean;
};

export async function copyPrefixes(
  source: string,
  target: string,
  options: { overwrite?: boolean; tenant_filter?: string; site_filter?: string } = {},
): Promise<CopyPrefixResult> {
  const body: Record<string, unknown> = {
    sourceInstance: source,
    targetInstance: target,
    overwrite: options.overwrite ?? false,
  };
  if (options.tenant_filter) body.tenantFilter = options.tenant_filter;
  if (options.site_filter) body.siteFilter = options.site_filter;

  const res = await authJsonFetch<CopyPrefixResult>('/api/netbox/copy-prefixes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res;
}