import {
  startKeccFailbackScheduler,
  stopKeaFailbackScheduler,
  triggerKeaFailbackCheck,
  getAutoFailbackStatus,
  setAutoFailbackEnabled,
  type KEA_FAILBACK_RUNTIME,
} from '../services/keaFailback.js';
import {
  type KeaTarget,
  addDhcpReservation,
  addDhcpSubnet,
  deleteDhcpLease,
  deleteDhcpSubnet,
  fixStaticReservation,
  getDhcpDashboard,
  getHaState,
  listDhcpLeases,
  switchHaPartner,
  unfixStaticReservation,
  wipeDhcpSubnet,
} from '../services/keaDhcp.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { Router } from 'express';

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

/**
 * Detailed HA state snapshot for the operator UI. Includes the auto-failback
 * status (in-memory) so the dashboard can show "auto-failback: ON" and
 * "last failback: 2h ago" in one round-trip.
 */
dhcpRouter.get('/ha-state', async (_req, res) => {
  try {
    const haState = await getHaState();
    const autoFailback = getAutoFailbackStatus();
    res.json({ ha: haState, autoFailback });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load HA state',
    });
  }
});

/**
 * Manual HA switchover. Operator picks the CURRENT primary; the API
 * sends `ha-switch-partner` to that site, which gracefully demotes it
 * and promotes the other site. Brief ~1-3s gap where no server serves.
 *
 * Body: { currentPrimary: 'DC' | 'DR' }
 *
 * Use case:
 *   - DC recovered but auto-failback disabled → ops can trigger manually
 *   - DR is being decommissioned → switch back to DC first
 *   - Testing / drill
 */
dhcpRouter.post('/switchover', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const body = req.body as { currentPrimary?: string };
  if (body.currentPrimary !== 'DC' && body.currentPrimary !== 'DR') {
    res.status(400).json({ error: 'currentPrimary must be "DC" or "DR"' });
    return;
  }
  try {
    const result = await switchHaPartner(body.currentPrimary);
    if (result.result !== 0) {
      res.status(502).json({
        error: result.text || 'Kea rejected ha-switch-partner',
        result,
      });
      return;
    }
    res.json({ ok: true, result });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Switchover failed',
    });
  }
});

/**
 * Get current auto-failback state.
 */
dhcpRouter.get('/auto-failback', async (_req, res) => {
  res.json(getAutoFailbackStatus());
});

/**
 * Enable / disable auto-failback at runtime (no backend restart needed).
 * Body: { enabled: boolean }
 *
 * When enabled: scheduler polls every 30s, calls ha-switch-partner when
 *   DC is healthy and DR has been active for the stability window.
 * When disabled: scheduler still runs but never triggers a switchover.
 */
dhcpRouter.post('/auto-failback', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const body = req.body as { enabled?: boolean };
  if (typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  setAutoFailbackEnabled(body.enabled);
  res.json({ ok: true, status: getAutoFailbackStatus() });
});

/**
 * Force an immediate failback-scheduler check (instead of waiting for
 * the next tick). Useful for ops to verify "is the scheduler healthy?"
 * or to retry after a missed check.
 */
dhcpRouter.post('/auto-failback/check', authMiddleware, requireRole('ADMIN'), async (_req, res) => {
  try {
    await triggerKeaFailbackCheck('manual');
    res.json({ ok: true, status: getAutoFailbackStatus() });
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Check failed',
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

// SECURITY (C3, C5, see docs/agents/16-security-audit-preprod.md):
// wipe/add/delete DHCP lease endpoints can DoS every device on a
// subnet (bank branches lose IP). Mount-level authMiddleware applies
// (so login required), but VIEWER must NOT trigger these. Wiping a
// pool is the most destructive — restrict to ADMIN; mutations to a
// single lease go through OPERATOR+.
dhcpRouter.delete('/leases/:ip', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
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

dhcpRouter.post('/pools/:subnetId/wipe', authMiddleware, requireRole('ADMIN'), async (req, res) => {
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

dhcpRouter.post('/leases', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
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

dhcpRouter.post('/leases/:ip/fix-static', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
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

dhcpRouter.post('/leases/:ip/unfix-static', authMiddleware, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
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

// Re-export the runtime handle so server.ts can wire up the scheduler.
export type { KEA_FAILBACK_RUNTIME };
