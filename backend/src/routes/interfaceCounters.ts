import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  getDeviceCounterHistory,
  getLatestCounters,
  pollDeviceCounters,
} from '../services/interfaceCounters.js';

export const interfaceCountersRouter = Router({ mergeParams: true });

interfaceCountersRouter.use(authMiddleware);

/**
 * GET /api/devices/:deviceId/interface-counters/latest
 *   Returns the most recent cumulative-counter sample per interface for the
 *   given device. Used by the Ports panel "Show errors" button to render a
 *   tabular view (input/output errors, discards, CRC).
 */
interfaceCountersRouter.get('/:deviceId/interface-counters/latest', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const result = await getLatestCounters(deviceId);
  res.json(result);
});

/**
 * GET /api/devices/:deviceId/interface-counters/history
 *   Query params:
 *     interface (optional): restrict to one interface name
 *     sinceMinutes (optional, default 60): window of history to return
 *   Returns per-interface cumulative samples + derived in/out bps rates.
 *   The chart and the cumulative counter list use this endpoint.
 */
interfaceCountersRouter.get('/:deviceId/interface-counters/history', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const iface = typeof req.query.interface === 'string' ? req.query.interface.trim() : undefined;
  const sinceRaw = Number(req.query.sinceMinutes);
  const sinceMinutes = Number.isFinite(sinceRaw) && sinceRaw > 0 && sinceRaw <= 24 * 60 ? sinceRaw : 60;
  const result = await getDeviceCounterHistory(deviceId, {
    interfaceName: iface || undefined,
    sinceMinutes,
  });
  res.json(result);
});

/**
 * POST /api/devices/:deviceId/interface-counters/refresh
 *   Synchronously poll one device right now (skips the scheduler). Returns
 *   the inserted sample count and the source vendor tag so the UI can
 *   refresh the chart without waiting for the next tick.
 *
 *   Marked auth-protected — same as apply_config. Be light: never block on
 *   this from inside the chart polling loop.
 */
interfaceCountersRouter.post('/:deviceId/interface-counters/refresh', async (req, res) => {
  const deviceId = String(req.params.deviceId);
  const r = await pollDeviceCounters(deviceId);
  if (!r.ok) {
    res.status(r.error === 'Device not found' ? 404 : 502).json({
      ok: false,
      sampleCount: r.sampleCount,
      error: r.error,
      collectMs: r.collectMs,
    });
    return;
  }
  res.json({
    ok: true,
    sampleCount: r.sampleCount,
    source: r.source,
    collectMs: r.collectMs,
  });
});
