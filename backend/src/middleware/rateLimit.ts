import { Request, Response, NextFunction } from 'express';

interface RateLimitStore {
  [key: string]: { count: number; resetTime: number };
}

const store: RateLimitStore = {};

function cleanup() {
  const now = Date.now();
  for (const key in store) {
    if (store[key].resetTime < now) {
      delete store[key];
    }
  }
}

setInterval(cleanup, 60000); // Cleanup every minute

export interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number; // Max requests per window
  keyGenerator?: (req: Request) => string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator = ((req: Request) => req.ip || 'unknown'), message = 'Too many requests, please try again later' } = options;

  return (req: Request, res: Response, _next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!store[key] || store[key].resetTime < now) {
      store[key] = { count: 1, resetTime: now + windowMs };
      res.setHeader('X-RateLimit-Limit', max.toString());
      res.setHeader('X-RateLimit-Remaining', (max - 1).toString());
      res.setHeader('X-RateLimit-Reset', store[key].resetTime.toString());
      _next();
      return;
    }

    store[key].count++;

    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - store[key].count).toString());
    res.setHeader('X-RateLimit-Reset', store[key].resetTime.toString());

    if (store[key].count > max) {
      res.status(429).json({ error: message, retryAfter: Math.ceil((store[key].resetTime - now) / 1000) });
      return;
    }

    _next();
  };
}

// Pre-configured rate limiters
// Internal lab: keep limits very high so reads from the dashboard never trip during normal use.
export const strictRateLimit = rateLimit({ windowMs: 60 * 1000, max: 600 }); // 600 requests per minute
export const moderateRateLimit = rateLimit({ windowMs: 60 * 1000, max: 600 }); // 600 requests per minute
// Auth rate-limit keyed by username (or ip if no body) so NAT'd users don't share counters
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many login attempts, please try again after 15 minutes',
  keyGenerator: (req) => {
    try {
      const u = (req.body && (req.body.username || req.body.user)) || '';
      if (typeof u === 'string' && u.length > 0) return `user:${u}`;
    } catch {}
    return `ip:${req.ip || 'unknown'}`;
  },
}); // 200 attempts per 15 minutes per username
export const scanRateLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many scan requests, please wait' }); // 30 scans per minute
