import { Router } from 'express';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import {
  addDhcpLease,
  addDhcpSubnet,
  deleteDhcpLease,
  deleteDhcpSubnet,
  dhcpServerHost,
  fixStaticReservation,
  getDhcpDashboard,
  listDhcpLeases,
  unfixStaticReservation,
  wipeDhcpPool,
} from '../services/junosDhcp.js';

export const dhcpRouter = Router();

/**
 * DHCP is served by the distribution switch (Junos extended DHCP local
 * server). There is no HA pair any more, so the dashboard is a single
 * round-trip that reads the pools + bindings straight from the switch.
 */
dhcpRouter.get('/dashboard', async (_req, res) => {
  try {
    res.json(await getDhcpDashboard());
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load DHCP dashboard',
    });
  }
});

/**
 * The DHCP server identity + reachability. Replaces the old Kea
 * DC↔DR `ha-state` endpoint.
 */
dhcpRouter.get('/server', async (_req, res) => {
  try {
    const dashboard = await getDhcpDashboard();
    res.json({ server: dashboard.server, totals: dashboard.totals });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load DHCP server state',
    });
  }
});

/**
 * List leases. Optional `pool` filter (Junos pool name, e.g. "V201").
 */
dhcpRouter.get('/leases', async (req, res) => {
  try {
    const pool = typeof req.query.pool === 'string' && req.query.pool ? req.query.pool : undefined;
    res.json({ leases: await listDhcpLeases(pool) });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load leases',
    });
  }
});

dhcpRouter.get('/pools/:poolName/leases', async (req, res) => {
  try {
    const poolName = String(req.params.poolName);
    res.json({ poolName, leases: await listDhcpLeases(poolName) });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load pool leases',
    });
  }
});

/**
 * SECURITY (C3, C5, see docs/agents/16-security-audit-preprod.md):
 * clearing DHCP leases can knock every device on a subnet offline
 * (bank branches lose IP). Mount-level authMiddleware applies (so login
 * is required), but VIEWER must NOT trigger these. Wiping a whole pool is
 * the most destructive — restrict to ADMIN; a single lease goes through
 * OPERATOR+.
 */
dhcpRouter.delete('/leases/:ip', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const result = await deleteDhcpLease(dhcpServerHost(), ip);
    if (!result.ok) {
      res.status(502).json({ error: result.error || `Failed to delete lease ${ip}` });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to delete lease',
    });
  }
});

/**
 * Wipe every lease of a pool. We clear the bindings on the pool's
 * interface rather than "deleting a subnet" — the pool itself stays
 * configured, only the leases are dropped.
 */
dhcpRouter.post('/pools/:poolName/wipe', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const poolName = String(req.params.poolName);
    const dashboard = await getDhcpDashboard();
    const pool = dashboard.pools.find((item) => item.poolName === poolName);
    if (!pool) {
      res.status(404).json({ error: `Pool ${poolName} not found` });
      return;
    }
    if (!pool.interface) {
      res.status(400).json({ error: `Pool ${poolName} has no known interface` });
      return;
    }
    const result = await wipeDhcpPool(dhcpServerHost(), pool.interface);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to wipe pool leases' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to wipe pool leases',
    });
  }
});

/**
 * Pin an IP to a MAC. On Junos this is a static reservation
 * (`access address-assignment pool ... host ...`).
 */
dhcpRouter.post('/leases', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const body = req.body as {
      ip?: string;
      mac?: string;
      poolName?: string;
      hostname?: string;
    };
    if (!body.ip || !body.mac || !body.poolName) {
      res.status(400).json({ error: 'ip, mac, poolName are required' });
      return;
    }
    const result = await addDhcpLease(dhcpServerHost(), {
      ip: body.ip,
      mac: body.mac,
      poolName: body.poolName,
      hostname: body.hostname,
    });
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to add lease' });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to add lease',
    });
  }
});

dhcpRouter.post('/leases/:ip/fix-static', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const body = req.body as { mac?: string; poolName?: string; hostname?: string };
    if (!body.mac || !body.poolName) {
      res.status(400).json({ error: 'mac and poolName are required' });
      return;
    }
    const result = await fixStaticReservation(dhcpServerHost(), {
      ip,
      mac: body.mac,
      poolName: body.poolName,
      hostname: body.hostname,
    });
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to fix static IP' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to fix static IP',
    });
  }
});

dhcpRouter.post('/leases/:ip/unfix-static', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const body = req.body as { poolName?: string; mac?: string };
    if (!body.poolName) {
      res.status(400).json({ error: 'poolName is required' });
      return;
    }
    const result = await unfixStaticReservation(dhcpServerHost(), {
      ip,
      poolName: body.poolName,
      mac: body.mac,
    });
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to unfix static IP' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to unfix static IP',
    });
  }
});

/**
 * Add a new DHCP pool to the switch (ADMIN only).
 *
 * Body:
 *   { poolName, subnet, poolStart, poolEnd, gateway, dns?, domainName?,
 *     leaseTime?, interfaceName }
 */
dhcpRouter.post('/pools', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const body = req.body as {
      poolName?: string;
      subnet?: string;
      poolStart?: string;
      poolEnd?: string;
      gateway?: string;
      dns?: string[];
      domainName?: string;
      leaseTime?: number;
      interfaceName?: string;
    };
    if (!body.poolName || !body.subnet || !body.poolStart || !body.poolEnd || !body.gateway) {
      res.status(400).json({
        error: 'poolName, subnet (CIDR), poolStart, poolEnd, gateway are required',
      });
      return;
    }
    if (!body.interfaceName) {
      res.status(400).json({ error: 'interfaceName is required (e.g. irb.201)' });
      return;
    }
    const result = await addDhcpSubnet(dhcpServerHost(), {
      poolName: body.poolName,
      subnet: body.subnet,
      poolStart: body.poolStart,
      poolEnd: body.poolEnd,
      gateway: body.gateway,
      dns: body.dns,
      domainName: body.domainName,
      leaseTime: body.leaseTime,
      interfaceName: body.interfaceName,
    });
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to add DHCP pool' });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to add DHCP pool',
    });
  }
});

/**
 * Remove a DHCP pool from the switch (ADMIN only).
 * WARNING: this also drops the pool's static reservations.
 */
dhcpRouter.delete('/pools/:poolName', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const poolName = String(req.params.poolName);
    const result = await deleteDhcpSubnet(dhcpServerHost(), poolName);
    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Failed to delete DHCP pool' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to delete DHCP pool',
    });
  }
});
