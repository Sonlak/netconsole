/**
 * NetBox HTTP routes (read + write).
 *
 * Thin handlers that call into `netboxClient.ts` and convert errors to 502.
 * Mounted at `/api/netbox` by `index.ts`.
 *
 * Multi-instance: all routes accept `?instance=<name>` to target a specific
 * NetBox instance. Default is the `NETBOX_DEFAULT_INSTANCE` env var (or
 * "production"). Available instances are configured via `NETBOX_INSTANCES` env
 * var as JSON:
 *   '{"production":{"url":"...","token":"..."},"netbox2":{"url":"...","token":"..."}}'
 *
 * WRITE routes require ADMIN role (netbox import/copy is a privileged operation).
 */

import { Router } from 'express';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  NetBoxError,
  listNetboxInstanceNames,
  getDefaultInstance,
  netboxHealthCheck,
  getNetboxDeviceById,
  listNetboxDeviceRoles,
  listNetboxDevices,
  listNetboxIpAddresses,
  listNetboxManufacturers,
  listNetboxInterfaces,
  listNetboxPrefixes,
  listNetboxSites,
  listNetboxVlans,
  bulkCreateNetboxPrefixes,
  copyNetboxPrefixesToInstance,
  type CreateNetboxPrefixOptions,
} from '../services/netboxClient.js';
import { prisma } from '../lib/prisma.js';

export const netboxRouter = Router();

// ─── Instance helper ─────────────────────────────────────────────────────────

/** Extract the instance name from the request query params. */
function instanceFromReq(req: import('express').Request): string | undefined {
  const raw = typeof req.query.instance === 'string' ? req.query.instance.trim() : undefined;
  return raw || undefined; // undefined → use default
}

// ─── Error handler ────────────────────────────────────────────────────────────

function handleNetboxError(error: unknown, res: import('express').Response): void {
  if (error instanceof NetBoxError) {
    res.status(502).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown NetBox error';
  console.error('[netbox-route] unexpected error:', error);
  res.status(500).json({ error: message });
}

// ─── Instance management ──────────────────────────────────────────────────────

/** List available NetBox instances and which is the default. */
netboxRouter.get('/instances', async (req, res) => {
  const instances = listNetboxInstanceNames();
  const def = getDefaultInstance();
  res.json({ instances, default: def });
});

// ─── Health ─────────────────────────────────────────────────────────────────

/** Lightweight reachability check. Checks the instance named in `?instance=`, or the default. */
netboxRouter.get('/health', async (req, res) => {
  const instance = instanceFromReq(req);
  const ok = await netboxHealthCheck(instance);
  res.json({ ok, instance: instance || getDefaultInstance() });
});

// ─── Sites ───────────────────────────────────────────────────────────────────

netboxRouter.get('/sites', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const sites = await listNetboxSites(instance, { limit });
    res.json({ total: sites.length, sites });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Device roles ────────────────────────────────────────────────────────────

netboxRouter.get('/device-roles', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const roles = await listNetboxDeviceRoles(instance, { limit });
    res.json({ total: roles.length, roles });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Manufacturers ───────────────────────────────────────────────────────────

netboxRouter.get('/manufacturers', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const manufacturers = await listNetboxManufacturers(instance, { limit });
    res.json({ total: manufacturers.length, manufacturers });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Devices ─────────────────────────────────────────────────────────────────

netboxRouter.get('/devices', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const status = (typeof req.query.status === 'string' ? req.query.status : undefined) as
      | 'active' | 'offline' | 'planned' | 'staged' | 'failed' | 'inventory' | 'decommissioning'
      | undefined;
    const result = await listNetboxDevices(instance, {
      limit: clampInt(req.query.limit, 50, 1, 500),
      offset: clampInt(req.query.offset, 0, 0, 100_000),
      site: typeof req.query.site === 'string' ? req.query.site : undefined,
      role: typeof req.query.role === 'string' ? req.query.role : undefined,
      status,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      netconsole_id: typeof req.query.netconsole_id === 'string' ? req.query.netconsole_id : undefined,
    });
    res.json(result);
  } catch (error) {
    handleNetboxError(error, res);
  }
});

netboxRouter.get('/devices/:nbid', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const id = Number(req.params.nbid);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const device = await getNetboxDeviceById(instance, id);
    if (!device) {
      res.status(404).json({ error: 'NetBox device not found' });
      return;
    }
    res.json({ device });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Interfaces ─────────────────────────────────────────────────────────────

netboxRouter.get('/devices/:nbid/interfaces', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const id = Number(req.params.nbid);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const interfaces = await listNetboxInterfaces(instance, id, {
      limit: clampInt(req.query.limit, 500, 1, 1000),
    });
    res.json({ total: interfaces.length, interfaces });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── VLANs ─────────────────────────────────────────────────────────────────

netboxRouter.get('/vlans', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const vlans = await listNetboxVlans(instance, {
      site: typeof req.query.site === 'string' ? req.query.site : undefined,
      limit: clampInt(req.query.limit, 200, 1, 1000),
    });
    res.json({ total: vlans.length, vlans });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Prefixes ───────────────────────────────────────────────────────────────

netboxRouter.get('/prefixes', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const { results, count } = await listNetboxPrefixes(instance, {
      site: typeof req.query.site === 'string' ? req.query.site : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      contains: typeof req.query.contains === 'string' ? req.query.contains : undefined,
      prefix: typeof req.query.prefix === 'string' ? req.query.prefix : undefined,
      limit: clampInt(req.query.limit, 200, 1, 1000),
    });
    // `count` is the real total in NetBox (e.g. 835); `total` is the page
    // size we returned (≤ limit). Both exposed so the UI can show
    // "Showing 200 of 835" instead of pretending there are only 200.
    res.json({ total: results.length, count, prefixes: results });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── IP addresses ────────────────────────────────────────────────────────────

netboxRouter.get('/ip-addresses', async (req, res) => {
  try {
    const instance = instanceFromReq(req);
    const addresses = await listNetboxIpAddresses(instance, {
      device_id: typeof req.query.device_id === 'string' ? Number(req.query.device_id) : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      limit: clampInt(req.query.limit, 200, 1, 1000),
    });
    res.json({ total: addresses.length, addresses });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── Sync status ─────────────────────────────────────────────────────────────

netboxRouter.get('/sync-status', async (req, res) => {
  try {
    const deviceId = typeof req.query.device_id === 'string' ? req.query.device_id : null;
    const site = typeof req.query.site === 'string' ? req.query.site : null;

    const where: Record<string, unknown> = {};
    if (deviceId) where.id = deviceId;
    if (site) where.site = site;

    const rows = await prisma.device.findMany({
      where,
      select: {
        id: true, name: true, ip: true, site: true, vendor: true, model: true,
        netboxDeviceId: true, netboxSyncedAt: true, netboxSyncError: true,
      },
      orderBy: [{ site: 'asc' }, { name: 'asc' }],
    });

    const summary = {
      total: rows.length,
      synced: rows.filter((r) => r.netboxDeviceId !== null && r.netboxSyncError === null).length,
      pending: rows.filter((r) => r.netboxDeviceId === null && r.netboxSyncError === null).length,
      failed: rows.filter((r) => r.netboxSyncError !== null).length,
    };

    res.json({
      summary,
      devices: rows.map((r) => ({
        deviceId: r.id, name: r.name, ip: r.ip, site: r.site,
        vendor: r.vendor, model: r.model,
        synced: r.netboxDeviceId !== null && r.netboxSyncError === null,
        netboxDeviceId: r.netboxDeviceId,
        netboxSyncedAt: r.netboxSyncedAt,
        netboxSyncError: r.netboxSyncError,
      })),
    });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ─── WRITE: Bulk import prefixes ────────────────────────────────────────────

/**
 * POST /api/netbox/import-prefixes
 *
 * Bulk-import prefixes from an in-request CSV or from pre-built JSON rows.
 * Admin-only.
 *
 * Body shape (JSON):
 *   {
 *     "instance": "netbox2",          // target instance name (optional, default = default instance)
 *     "rows": [
 *       { "prefix": "10.10.20.0/24", "status": "active", "description": "LAN", ... }
 *     ],
 *     "overwrite": false              // skip existing (default) | overwrite = PATCH existing
 *   }
 *
 * OR multipart/form-data with field `file` = CSV file upload.
 * CSV columns: prefix, status, description, site, vrf, tenant, vlan, role, tags
 * (name-based — tags = semicolon-separated slugs)
 */
netboxRouter.post(
  '/import-prefixes',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: import('express').Response) => {
    try {
      const instance = typeof req.body.instance === 'string' ? req.body.instance.trim() : undefined;
      const overwrite = req.body.overwrite === true || req.body.overwrite === 'true';

      // Support both JSON rows and file upload
      let rows: CreateNetboxPrefixOptions[];
      if (Array.isArray(req.body.rows)) {
        rows = req.body.rows as CreateNetboxPrefixOptions[];
      } else if (typeof req.body.csvText === 'string') {
        // CSV text sent as base64 or plain string
        let text: string;
        try {
          text = Buffer.from(req.body.csvText, 'base64').toString('utf-8');
        } catch {
          text = req.body.csvText; // plain text
        }
        rows = parseCsvRows(text);
      } else {
        res.status(400).json({ error: 'Provide either `rows` (JSON array) or `csvText` (CSV string or base64).' });
        return;
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: 'rows must be a non-empty array.' });
        return;
      }

      // Inject overwrite into each row
      const rowsWithOverwrite = rows.map((r) => ({ ...r, overwrite }));

      const result = await bulkCreateNetboxPrefixes(instance, rowsWithOverwrite);
      res.json({
        ...result,
        instance: instance || getDefaultInstance(),
        overwrite,
      });
    } catch (error) {
      handleNetboxError(error, res);
    }
  },
);

// ─── WRITE: Copy prefixes from one instance to another ────────────────────────

/**
 * POST /api/netbox/copy-prefixes
 *
 * Copy all prefixes from one NetBox instance to another.
 * Admin-only.
 *
 * Body:
 *   {
 *     "sourceInstance": "production",
 *     "targetInstance": "netbox2",
 *     "tenantFilter": "TTDL Binh Duong",   // optional
 *     "siteFilter": "LAB",                  // optional
 *     "overwrite": false                     // default = skip existing
 *   }
 */
netboxRouter.post(
  '/copy-prefixes',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: import('express').Response) => {
    try {
      const {
        sourceInstance,
        targetInstance,
        tenantFilter,
        siteFilter,
        overwrite = false,
      } = req.body as {
        sourceInstance?: string;
        targetInstance?: string;
        tenantFilter?: string;
        siteFilter?: string;
        overwrite?: boolean;
      };

      if (!sourceInstance || !targetInstance) {
        res.status(400).json({ error: 'sourceInstance and targetInstance are required.' });
        return;
      }
      if (sourceInstance === targetInstance) {
        res.status(400).json({ error: 'source and target must be different instances.' });
        return;
      }

      const result = await copyNetboxPrefixesToInstance({
        sourceInstance,
        targetInstance,
        tenantFilter,
        siteFilter,
        overwrite,
      });

      res.json({ ...result, sourceInstance, targetInstance, overwrite });
    } catch (error) {
      handleNetboxError(error, res);
    }
  },
);

// ─── helpers ────────────────────────────────────────────────────────────────

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Parse CSV text into CreateNetboxPrefixOptions[]. Handles name-based format. */
function parseCsvRows(text: string): CreateNetboxPrefixOptions[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: CreateNetboxPrefixOptions[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length === 0) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < cols.length; j++) {
      row[headers[j]] = cols[j].trim();
    }
    if (!row.prefix) continue;
    rows.push({
      prefix: row.prefix,
      status: row.status || 'active',
      description: row.description || '',
      site: row.site || undefined,
      vrf: row.vrf || undefined,
      tenant: row.tenant || undefined,
      vlan: row.vlan ? Number(row.vlan) : undefined,
      role: row.role || undefined,
      tags: row.tags ? row.tags.split(';').map((t: string) => t.trim()).filter(Boolean) : undefined,
    });
  }
  return rows;
}

/** Minimal CSV line parser (handles quoted fields). */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
