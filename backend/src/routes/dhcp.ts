import { Router } from 'express';
import {
  addDhcpReservation,
  addDhcpSubnet,
  deleteDhcpLease,
  deleteDhcpSubnet,
  fixStaticReservation,
  getDhcpDashboard,
  listDhcpLeases,
  unfixStaticReservation,
  wipeDhcpSubnet,
} from '../services/keaDhcp.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

export const dhcpRouter = Router();

dhcpRouter.get('/dashboard', async (_req, res) => {
  try {
    res.json(await getDhcpDashboard());
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load DHCP dashboard',
    });
  }
});

dhcpRouter.get('/leases', async (req, res) => {
  try {
    const subnetId =
      typeof req.query.subnetId === 'string' && req.query.subnetId
        ? Number(req.query.subnetId)
        : undefined;
    if (subnetId != null && !Number.isFinite(subnetId)) {
      res.status(400).json({ error: 'Invalid subnetId' });
      return;
    }
    res.json({ leases: await listDhcpLeases(subnetId) });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load leases',
    });
  }
});

dhcpRouter.get('/pools/:subnetId/leases', async (req, res) => {
  try {
    const subnetId = Number(req.params.subnetId);
    if (!Number.isFinite(subnetId)) {
      res.status(400).json({ error: 'Invalid subnetId' });
      return;
    }
    res.json({ subnetId, leases: await listDhcpLeases(subnetId) });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load pool leases',
    });
  }
});

dhcpRouter.delete('/leases/:ip', async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const result = await deleteDhcpLease(ip);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to delete lease',
    });
  }
});

dhcpRouter.post('/pools/:subnetId/wipe', async (req, res) => {
  try {
    const subnetId = Number(req.params.subnetId);
    if (!Number.isFinite(subnetId)) {
      res.status(400).json({ error: 'Invalid subnetId' });
      return;
    }
    const result = await wipeDhcpSubnet(subnetId);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to wipe pool leases',
    });
  }
});

dhcpRouter.post('/leases', async (req, res) => {
  try {
    const body = req.body as {
      ip?: string;
      mac?: string;
      subnetId?: number;
      hostname?: string;
    };
    if (!body.ip || !body.mac || body.subnetId == null) {
      res.status(400).json({ error: 'ip, mac, subnetId are required' });
      return;
    }
    const result = await addDhcpReservation({
      ip: body.ip,
      mac: body.mac,
      subnetId: Number(body.subnetId),
      hostname: body.hostname,
    });
    res.status(201).json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to add lease',
    });
  }
});

dhcpRouter.post('/leases/:ip/fix-static', async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const body = req.body as {
      mac?: string;
      subnetId?: number;
      hostname?: string;
      note?: string;
    };
    if (!body.mac || body.subnetId == null) {
      res.status(400).json({ error: 'mac and subnetId are required' });
      return;
    }
    const result = await fixStaticReservation({
      ip,
      mac: body.mac,
      subnetId: Number(body.subnetId),
      hostname: body.hostname,
      note: body.note,
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to fix static IP',
    });
  }
});

dhcpRouter.post('/leases/:ip/unfix-static', async (req, res) => {
  try {
    const ip = String(req.params.ip);
    const body = req.body as { subnetId?: number; mac?: string };
    if (body.subnetId == null) {
      res.status(400).json({ error: 'subnetId is required' });
      return;
    }
    const result = await unfixStaticReservation({
      ip,
      subnetId: Number(body.subnetId),
      mac: body.mac,
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to unfix static IP',
    });
  }
});

// POST /api/dhcp/subnets — add a new subnet to Kea config (ADMIN only)
dhcpRouter.post('/subnets', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const body = req.body as {
      subnetId?: number;
      subnet?: string;
      poolStart?: string;
      poolEnd?: string;
      gateway?: string;
      dns?: string[];
      site?: string;
      vlan?: number;
      name?: string;
    };
    if (!body.subnetId || !body.subnet || !body.poolStart || !body.poolEnd || !body.gateway) {
      res.status(400).json({
        error: 'subnetId, subnet (CIDR), poolStart, poolEnd, gateway are required',
      });
      return;
    }
    const result = await addDhcpSubnet({
      subnetId: Number(body.subnetId),
      subnet: body.subnet,
      poolStart: body.poolStart,
      poolEnd: body.poolEnd,
      gateway: body.gateway,
      dns: body.dns,
      site: body.site,
      vlan: body.vlan,
      name: body.name,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to add subnet',
    });
  }
});

// DELETE /api/dhcp/subnets/:subnetId — remove a subnet entirely (ADMIN only)
dhcpRouter.delete('/subnets/:subnetId', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const subnetId = Number(req.params.subnetId);
    if (!Number.isFinite(subnetId)) {
      res.status(400).json({ error: 'Invalid subnetId' });
      return;
    }
    const result = await deleteDhcpSubnet(subnetId);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to delete subnet',
    });
  }
});
