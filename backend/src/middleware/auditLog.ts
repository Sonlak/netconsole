import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from './auth.js';

/**
 * Append-only audit trail for every mutating API request.
 *
 * - Only logs methods that change state: POST / PUT / PATCH / DELETE.
 * - Reads happen at res.on('finish'), so the response statusCode is final
 *   and req.user has already been populated by authMiddleware.
 * - Best-effort: a write failure is logged to stderr but never thrown,
 *   so an audit-write outage cannot break user-facing requests.
 * - Never logs raw request bodies — only object keys, so passwords and
 *   tokens never reach the audit table.
 * - Explicit skip list for endpoints that touch credentials directly
 *   (login, password change) — the LoginAttempt shape is enough; we do
 *   not want a second row that could leak a body field by accident.
 */

const AUDIT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIP_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/password',
]);

function clientIp(req: Request): string | null {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)
    ?.split(',')[0]
    ?.trim();
  return xff || (req.headers['x-real-ip'] as string | undefined) || req.ip || null;
}

function routeShape(req: Request): string {
  // Use the matched route pattern (e.g. /api/auth/users/:id) instead of the
  // literal URL, so the audit row groups requests to the same endpoint.
  // Express 5 puts the matched pattern on req.route when a route matched.
  const base = (req.baseUrl || '').replace(/\/$/, '');
  if (req.route?.path) {
    return `${base}${req.route.path}`;
  }
  // Fallback: collapse obvious id-shaped segments.
  return req.originalUrl
    .split('?')[0]
    .replace(/\/[0-9a-f-]{20,}/gi, '/:id')
    .replace(/\/$/, '');
}

export function auditLogMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!AUDIT_METHODS.has(req.method)) {
    next();
    return;
  }
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  res.on('finish', () => {
    const user = req.user;
    const bodyKeys = req.body && typeof req.body === 'object'
      ? Object.keys(req.body as Record<string, unknown>)
      : [];

    prisma.auditLog
      .create({
        data: {
          userId: typeof user?.userId === 'string' ? user.userId : null,
          username: typeof user?.username === 'string' ? user.username : null,
          role: typeof user?.role === 'string' ? user.role : null,
          method: req.method,
          path: req.originalUrl,
          action: routeShape(req),
          ip: clientIp(req),
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          statusCode: res.statusCode,
          metadata: {
            params: req.params,
            bodyKeys,
          },
        },
      })
      .catch((err: unknown) => {
        console.error('[audit] failed to write log:', err);
      });
  });

  next();
}
