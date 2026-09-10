import { Router, type Request, type Response } from 'express';
import { strictRateLimit } from '../middleware/rateLimit.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { searchAll } from '../services/search.js';

export const searchRouter = Router();

function parseLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 10) : 3;
}

/**
 * GET /api/search?q=<query>&limit=<n>
 *
 * Global search across all entity types. Returns grouped results ready for
 * the CommandPalette UI.
 *
 * `q`         — required; minimum 2 characters.
 * `limit`     — optional; max results per group (1-10, default 3).
 *
 * All groups are parallel; one failing source does not block the rest.
 * Audit log results are only included for ADMIN users.
 */
searchRouter.get(
  '/',
  strictRateLimit,
  authMiddleware,
  async (req: Request, res: Response) => {
    const q =
      typeof req.query.q === 'string' && req.query.q.trim().length >= 2
        ? req.query.q.trim()
        : null;

    if (!q) {
      res.status(400).json({
        error: '`q` query parameter is required (minimum 2 characters)',
      });
      return;
    }

    const limit = parseLimit(req.query.limit);
    const isAdmin = (req as AuthenticatedRequest).user?.role === 'ADMIN';

    try {
      const groups = await searchAll(q, { limitPerGroup: limit });

      // Strip audit group for non-admin users (the service query is fast
      // enough that we ran it anyway; just don't return the results).
      const filtered = isAdmin
        ? groups
        : groups.filter((g) => g.kind !== 'audit');

      res.json({ groups: filtered });
    } catch (error) {
      console.error('[search] error:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  },
);
