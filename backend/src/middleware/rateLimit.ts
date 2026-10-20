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
  /**
   * When `true`, the per-key counter only accumulates on FAILED responses
   * (4xx/5xx). Successful responses (2xx/3xx) roll the just-added +1 back
   * out via a `res.on('finish')` listener so a user who is logging in
   * repeatedly (e.g. session drops forcing a re-login every few minutes)
   * does not hit the limit. The DB-backed lockout in loginAttempt.ts is
   * unchanged and still fires after 5 consecutive bad passwords — this
   * option is for the in-memory FAST gate, not the security gate.
   */
  failuresOnly?: boolean;
}

export function rateLimit(options: RateLimitOptions) {
  const {
    windowMs,
    max,
    keyGenerator = ((req: Request) => req.ip || 'unknown'),
    message = 'Too many requests, please try again later',
    failuresOnly = false,
  } = options;

  return (req: Request, res: Response, _next: NextFunction): void => {
    const key = keyGenerator(req);
    const now = Date.now();

    // Increment unconditionally; if `failuresOnly`, the rollback happens
    // in the `finish` listener below. Increment first so X-RateLimit-*
    // headers reflect the worst-case for this request.
    let incrementedForThisRequest = false;
    if (!store[key] || store[key].resetTime < now) {
      store[key] = { count: 1, resetTime: now + windowMs };
    } else {
      store[key].count++;
    }
    incrementedForThisRequest = true;

    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - store[key].count).toString());
    res.setHeader('X-RateLimit-Reset', store[key].resetTime.toString());

    if (store[key].count > max) {
      res.status(429).json({ error: message, retryAfter: Math.ceil((store[key].resetTime - now) / 1000) });
      // Counted as a failure — keep the increment.
      return;
    }

    if (failuresOnly) {
      res.on('finish', () => {
        // Only roll back if we actually incremented this request AND the
        // response was a success (2xx/3xx). 401/400/429/etc. all keep
        // the +1.
        if (!incrementedForThisRequest) return;
        if (res.statusCode < 200 || res.statusCode >= 400) return;
        const entry = store[key];
        if (entry && entry.count > 0) {
          entry.count--;
        }
      });
    }

    _next();
  };
}

// Pre-configured rate limiters
// Internal lab: keep limits very high so reads from the dashboard never trip during normal use.
export const strictRateLimit = rateLimit({ windowMs: 60 * 1000, max: 200 }); // 200 requests per minute
export const moderateRateLimit = rateLimit({ windowMs: 60 * 1000, max: 600 }); // 600 requests per minute

// SECURITY (H11, see docs/agents/16-security-audit-preprod.md):
//
// authRateLimit is the FAST in-memory gate that sits BEFORE the DB-
// backed lockout in `loginAttempt.ts`. Its job is to stop a single
// attacker from driving the bcrypt+prisma round-trip on every request
// even before the 5-strike DB lockout fires.
//
// Two design choices fixed in 2026-10-20 (incident: legitimate user
// hit "Too many login attempts" after ~7 successful re-logins caused
// by session drops):
//
// 1. `failuresOnly: true` — successful logins (200) DO NOT contribute
//    to the counter. Only 401/400/429 (or any 4xx/5xx) increment it.
//    A user whose session drops and who has to re-type their
//    password 20 times in an hour can no longer lock themselves out.
//
// 2. Apply only to credential-challenge endpoints (`POST /login` and
//    `POST /mfa/verify`). NOT applied globally to `/api/auth/*` —
//    `/auth/me`, `/auth/refresh`, `/auth/logout` etc. are not
//    credential challenges and must remain at moderateRateLimit (or
//    no limit) so they don't trip during normal dashboard polling.
//
// Note that the DB-backed `recordFailedLogin` lockout at 5 consecutive
// bad passwords (15-min window) is still the authoritative gate —
// `authRateLimit` is the cheap upstream filter and now only counts
// failures, so its budget should stay generous (we keep 30 / 15 min /
// per IP+username pair).
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  failuresOnly: true,
  message: 'Too many login attempts, please try again after 15 minutes',
  keyGenerator: (req) => {
    try {
      const u = (req.body && (req.body.username || req.body.user)) || '';
      if (typeof u === 'string' && u.length > 0) return `login:user:${u}`;
    } catch {}
    return `login:ip:${req.ip || 'unknown'}`;
  },
}); // 30 failed attempts per 15 minutes per (username, ip)
export const scanRateLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many scan requests, please wait' }); // 30 scans per minute
