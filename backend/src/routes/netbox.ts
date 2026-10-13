/**
 * NetBox HTTP routes (read-only).
 *
 * Mirrors the Kea DHCP route pattern: thin handlers that call into
 * `netboxClient.ts` and convert errors to 502. Mounted at `/api/netbox`
 * by `index.ts`. The assistant handlers also use these client functions
 * directly (no HTTP roundtrip — same process, same DB).
 *
 * Why a separate route group: we want the frontend to be able to fetch
 * NetBox data for its own UI (not just via assistant). This also lets
 * us paginate, filter, and shape responses with a stable contract
 * independent of the chat-style tool preview.
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  NetBoxError,
  getNetboxDeviceById,
  listNetboxDeviceRoles,
  listNetboxDevices,
  listNetboxIpAddresses,
  listNetboxManufacturers,
  listNetboxInterfaces,
  listNetboxPrefixes,
  listNetboxSites,
  listNetboxVlans,
  netboxHealthCheck,
} from '../services/netboxClient.js';
import { prisma } from '../lib/prisma.js';

export const netboxRouter = Router();

/**
 * Convert any thrown error into a JSON 502 response. The frontend
 * surfaces the message as a toast.
 */
function handleNetboxError(error: unknown, res: import('express').Response): void {
  if (error instanceof NetBoxError) {
    res.status(502).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown NetBox error';
  console.error('[netbox-route] unexpected error:', error);
  res.status(500).json({ error: message });
}

// ── Health ──────────────────────────────────────────────────────────────────

/** Lightweight reachability check for the frontend banner. */
netboxRouter.get('/health', async (_req, res) => {
  const ok = await netboxHealthCheck();
  res.json({ ok, url: process.env.NETBOX_URL ?? null });
});

// ── Sites ───────────────────────────────────────────────────────────────────

netboxRouter.get('/sites', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const sites = await listNetboxSites({ limit });
    res.json({ total: sites.length, sites });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── Device roles ────────────────────────────────────────────────────────────

netboxRouter.get('/device-roles', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const roles = await listNetboxDeviceRoles({ limit });
    res.json({ total: roles.length, roles });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── Manufacturers ───────────────────────────────────────────────────────────

netboxRouter.get('/manufacturers', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 200, 1, 1000);
    const manufacturers = await listNetboxManufacturers({ limit });
    res.json({ total: manufacturers.length, manufacturers });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── Devices ─────────────────────────────────────────────────────────────────

/**
 * List NetBox devices. Optional filters:
 *   - site (string, matches site slug)
 *   - role (string, matches role slug)
 *   - status (active/offline/planned/staged/failed/inventory/decommissioning)
 *   - search (full-text on name/serial)
 *   - netconsole_id (exact match on custom field; preferred lookup)
 *   - limit, offset
 */
netboxRouter.get('/devices', async (req, res) => {
  try {
    const status = (typeof req.query.status === 'string' ? req.query.status : undefined) as
      | 'active' | 'offline' | 'planned' | 'staged' | 'failed' | 'inventory' | 'decommissioning'
      | undefined;
    const result = await listNetboxDevices({
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

/** Get one NetBox device by id. */
netboxRouter.get('/devices/:nbid', async (req, res) => {
  try {
    const id = Number(req.params.nbid);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const device = await getNetboxDeviceById(id);
    if (!device) {
      res.status(404).json({ error: 'NetBox device not found' });
      return;
    }
    res.json({ device });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── Interfaces (per NetBox device) ──────────────────────────────────────────

/** List interfaces for a NetBox device by id. */
netboxRouter.get('/devices/:nbid/interfaces', async (req, res) => {
  try {
    const id = Number(req.params.nbid);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    const interfaces = await listNetboxInterfaces(id, {
      limit: clampInt(req.query.limit, 500, 1, 1000),
    });
    res.json({ total: interfaces.length, interfaces });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── VLANs ───────────────────────────────────────────────────────────────────

netboxRouter.get('/vlans', async (req, res) => {
  try {
    const vlans = await listNetboxVlans({
      site: typeof req.query.site === 'string' ? req.query.site : undefined,
      limit: clampInt(req.query.limit, 200, 1, 1000),
    });
    res.json({ total: vlans.length, vlans });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── Prefixes (IPAM) ─────────────────────────────────────────────────────────

netboxRouter.get('/prefixes', async (req, res) => {
  try {
    const prefixes = await listNetboxPrefixes({
      site: typeof req.query.site === 'string' ? req.query.site : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      // `contains` accepts a single IP and returns the prefix(es) that contain it.
      // Example: /api/netbox/prefixes?contains=192.168.95.1
      contains: typeof req.query.contains === 'string' ? req.query.contains : undefined,
      // `prefix` is an exact CIDR match.
      // Example: /api/netbox/prefixes?prefix=10.10.20.0/24
      prefix: typeof req.query.prefix === 'string' ? req.query.prefix : undefined,
      limit: clampInt(req.query.limit, 200, 1, 1000),
    });
    res.json({ total: prefixes.length, prefixes });
  } catch (error) {
    handleNetboxError(error, res);
  }
});

// ── IP addresses (IPAM) ─────────────────────────────────────────────────────

netboxRouter.get('/ip-addresses', async (req, res) => {
  try {
    const addresses = await listNetboxIpAddresses({
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

// ── Sync status (NetConsole-side) ──────────────────────────────────────────

/**
 * Return the NetBox sync state for one device (or all). Reads from the
 * NetConsole Device table — this is the "do we have a NetBox record
 * for this device?" question that the assistant often needs.
 *
 *   - netboxDeviceId: NetBox dcim.devices.id (null = not yet synced)
 *   - netboxSyncedAt: when did the last successful sync complete
 *   - netboxSyncError: last failure message (cleared on next success)
 *   - site: same as the device site (used for filtering)
 */
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
        id: true,
        name: true,
        ip: true,
        site: true,
        vendor: true,
        model: true,
        netboxDeviceId: true,
        netboxSyncedAt: true,
        netboxSyncError: true,
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
        deviceId: r.id,
        name: r.name,
        ip: r.ip,
        site: r.site,
        vendor: r.vendor,
        model: r.model,
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

// ── helpers ─────────────────────────────────────────────────────────────────

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
