import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

export const auditLogRouter = Router();

// Admin-only viewer for the audit trail. Paginated, filterable by userId /
// method / status code / path prefix. The audit middleware writes append-only
// rows; this endpoint is the only way to read them.
auditLogRouter.get(
  '/',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      const method = typeof req.query.method === 'string' ? req.query.method : undefined;
      const pathPrefix = typeof req.query.pathPrefix === 'string' ? req.query.pathPrefix : undefined;
      const statusMin = Number(req.query.statusMin);
      const statusMax = Number(req.query.statusMax);

      const where: Record<string, unknown> = {};
      if (userId) where.userId = userId;
      if (method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        where.method = method;
      }
      if (pathPrefix) {
        where.path = { startsWith: pathPrefix };
      }
      if (Number.isFinite(statusMin) || Number.isFinite(statusMax)) {
        const statusWhere: Record<string, number> = {};
        if (Number.isFinite(statusMin)) statusWhere.gte = statusMin;
        if (Number.isFinite(statusMax)) statusWhere.lte = statusMax;
        where.statusCode = statusWhere;
      }

      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        prisma.auditLog.count({ where }),
      ]);

      res.json({ logs, total, limit, offset });
    } catch (error) {
      console.error('[audit-log] list failed:', error);
      res.status(500).json({ error: 'Failed to fetch audit log' });
    }
  },
);
