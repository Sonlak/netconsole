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
export const strictRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10 }); // 10 requests per minute
export const moderateRateLimit = rateLimit({ windowMs: 60 * 1000, max: 60 }); // 60 requests per minute
export const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'Too many login attempts, please try again after 15 minutes' }); // 5 attempts per 15 minutes
export const scanRateLimit = rateLimit({ windowMs: 60 * 1000, max: 3, message: 'Too many scan requests, please wait' }); // 3 scans per minute
