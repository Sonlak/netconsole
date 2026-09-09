import { Router } from 'express';
import { getFabricTopology, invalidateFabricCache } from '../services/fabricTopology.js';

export const fabricRouter = Router();

fabricRouter.get('/', async (req, res) => {
  try {
    const site = typeof req.query.site === 'string' && req.query.site.trim() ? req.query.site.trim() : undefined;
    res.json(await getFabricTopology(site));
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to load fabric topology',
    });
  }
});

fabricRouter.delete('/cache', (_req, res) => {
  invalidateFabricCache();
  res.json({ ok: true, message: 'Fabric cache cleared' });
});
