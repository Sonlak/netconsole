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
  // SECURITY: use authJsonFetch (not raw `fetch`) so a stale access JWT
  // is silently refreshed + retried. Without this, clicking the NetBox
  // Import tab >15 min after login threw "NetBox instances HTTP 401" on
  // first mount and the page errored out — users thought the app had
  // logged them out.
  const res = await authJsonFetch<NetBoxInstances>('/api/netbox/instances');
  return res;
}

export async function fetchNetboxHealth(instance?: string): Promise<{ ok: boolean; instance: string }> {
  const qs = instance ? `?instance=${encodeURIComponent(instance)}` : '';
  return authJsonFetch<{ ok: boolean; instance: string }>(`/api/netbox/health${qs}`);
}

export async function fetchNetboxPrefixes(instance?: string, limit = 1000): Promise<NetBoxPrefix[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (instance) params.set('instance', instance);
  // Same auto-refresh rationale as fetchNetboxInstances — the page
  // renders nothing useful if the first list call 401s and we don't retry.
  const body = await authJsonFetch<{ prefixes?: NetBoxPrefix[] }>(`/api/netbox/prefixes?${params}`);
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

/**
 * Export prefixes as a downloadable CSV file (browser-side).
 *
 * Fetches all pages from the source instance (limit=1000 per page) and
 * builds a name-based CSV that can be re-imported via the "Upload CSV"
 * tab. Used for offline editing / sharing the dataset outside the app.
 */
export async function exportPrefixesCsv(
  instance: string,
  filename: string,
): Promise<{ rowCount: number }> {
  const allRows: NetBoxPrefix[] = [];
  let offset = 0;
  const pageSize = 1000;
  // The backend caps limit at 1000; for very large datasets we paginate
  // by repeatedly filtering the previous page's max id. NetBox's `prefix`
  // filter does exact-match only, so we use a stable cursor: fetch all
  // then sort client-side.
  while (true) {
    const params = new URLSearchParams({ limit: String(pageSize) });
    params.set('instance', instance);
    if (offset > 0) params.set('offset', String(offset));
    // SECURITY: authJsonFetch (not raw `fetch`) so a stale access JWT
    // is silently refreshed + retried on the first page hit. Without
    // this, an export started >15 min after login aborts on page 0
    // with HTTP 401 and the user has to reload to retry.
    const body = await authJsonFetch<{ prefixes?: NetBoxPrefix[] }>(`/api/netbox/prefixes?${params}`);
    const page = body.prefixes ?? [];
    allRows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    // Safety: cap at 50k to avoid runaway loops
    if (allRows.length >= 50_000) break;
  }
  if (allRows.length === 0) {
    throw new Error(`No prefixes found in instance "${instance}"`);
  }

  const headers = [
    'prefix', 'status', 'description', 'site', 'vrf', 'tenant', 'vlan', 'role', 'tags',
  ];
  const escape = (v: string | number | null | undefined): string => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const p of allRows) {
    lines.push([
      escape(p.prefix),
      escape(p.status?.value ?? 'active'),
      escape(p.description),
      escape(p.site?.name),
      escape(p.vrf?.name),
      escape(p.tenant?.name),
      escape(p.vlan?.vid ?? ''),
      escape(p.role?.name),
      escape((p as unknown as { tags?: Array<{ slug?: string }> }).tags?.map((t) => t.slug).filter(Boolean).join(';') ?? ''),
    ].join(','));
  }
  // BOM so Excel opens UTF-8 correctly
  const csv = '\uFEFF' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { rowCount: allRows.length };
}