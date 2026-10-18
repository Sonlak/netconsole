import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

/**
 * Loose payload shape used by `verifyToken`. Workers may sign tokens that only
 * have `sub` + `role` (no `userId` / `username`), and we want to accept those.
 */
export interface JwtPayloadLoose {
  userId?: string;
  sub?: string;
  username?: string;
  role?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload | JwtPayloadLoose;
}

export interface SignTokenOptions {
  /** Override TTL. Default: `process.env.JWT_EXPIRES_IN` || `15m`. */
  expiresIn?: string;
  /** Required (`iss`) claim. Default: `'netconsole-backend'`. */
  issuer?: string;
  /** Required (`aud`) claim. Default: `'netconsole'`. */
  audience?: string;
}

// -----------------------------------------------------------------------------
// JWT secret resolution — fail-fast (security: see docs/agents/16-security-audit-preprod.md C1)
// -----------------------------------------------------------------------------
// Production code MUST set `JWT_SECRET` (or `SESSION_SECRET`) in the
// deployment environment. The module refuses to load otherwise — we will NOT
// fall back to a placeholder because doing so has resulted in a public,
// forgeable JWT signing key (see 2026-10-18 audit: historical commits
// shipped `'CHANGE_ME_IN_PRODUCTION'` / `'netconsole-dev-secret'` literals).
//
// Local dev: set `JWT_SECRET=any-non-empty-string` in `.env`. Use
// `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
// to mint a 48-byte secret for prod.
function resolveJwtSecret(): string {
  const fromPrimary = process.env.JWT_SECRET;
  if (fromPrimary && fromPrimary.length >= 32) return fromPrimary;
  // SESSION_SECRET is a historical alias kept for backward-compat with
  // older setups. Not encouraged — primary is JWT_SECRET.
  const fromLegacy = process.env.SESSION_SECRET;
  if (fromLegacy && fromLegacy.length >= 32) return fromLegacy;
  throw new Error(
    'JWT_SECRET environment variable is required (min 32 bytes). ' +
    'Generate with `openssl rand -base64 48` and set it in secrets.env. ' +
    'Refusing to boot with an insecure default. See docs/agents/16-security-audit-preprod.md (C1, C2, C7).',
  );
}

// Lazy: resolve at first sign/verify, not at module load. This keeps
// `require('./middleware/auth.js')` cheap and idempotent for tools that
// only import types.
let _cachedSecret: string | null = null;
function getSecret(): string {
  if (!_cachedSecret) {
    _cachedSecret = resolveJwtSecret();
  }
  return _cachedSecret;
}

const JWT_EXPIRES_IN_DEFAULT = '15m';
function getExpiresInDefault(): string {
  return process.env.JWT_EXPIRES_IN || JWT_EXPIRES_IN_DEFAULT;
}

export function signToken(
  payload: JwtPayload,
  options: SignTokenOptions | string = {},
): string {
  const opts: SignTokenOptions = typeof options === 'string' ? { expiresIn: options } : options;
  const expiresIn = (opts.expiresIn || getExpiresInDefault()) as `${number}${'s' | 'm' | 'h' | 'd'}`;
  return jwt.sign(payload, getSecret(), {
    expiresIn,
    issuer: opts.issuer || 'netconsole-backend',
    audience: opts.audience || 'netconsole',
  });
}

export function verifyToken(token: string): JwtPayloadLoose | null {
  try {
    const decoded = jwt.verify(token, getSecret(), {
      issuer: 'netconsole-backend',
      audience: 'netconsole',
    }) as JwtPayloadLoose;
    // Normalize: map `sub` -> `userId` so older / worker tokens still work
    if (!decoded.userId && decoded.sub) {
      decoded.userId = decoded.sub;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    return;
  }

  req.user = payload;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!req.user.role || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }

    next();
  };
}

// -----------------------------------------------------------------------------
// Cookie / refresh-token helpers (security: HttpOnly refresh cookie, C13)
// -----------------------------------------------------------------------------
// SECURITY: we issue the refresh token BOTH in the JSON body (for non-browser
// clients like the worker container) AND as an HttpOnly cookie (the canonical
// path for browsers). Callers that only need the cookie may pass
// `omitBody: true`. Set-Cookie uses `Secure` + `SameSite=Strict` so the
// refresh token is never exposed to JS — eliminates the XSS-read of
// `localStorage` that was the pre-prod audit finding.

export const REFRESH_COOKIE_NAME = 'nc_refresh';

export interface RefreshCookieOptions {
  /** `secure: false` is ONLY for local dev (HTTP). Production must leave default. */
  secure?: boolean;
  /** TTL in ms. Required. */
  maxAgeMs: number;
  /** `SameSite` policy. Default `'strict'`. */
  sameSite?: 'strict' | 'lax' | 'none';
  /** Cookie `Path`. Default `'/api/auth'`. */
  path?: string;
}

export function setRefreshCookie(res: Response, rawToken: string, opts: RefreshCookieOptions): void {
  const cookieSecure = opts.secure ?? process.env.NODE_ENV === 'production';
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: opts.sameSite ?? 'strict',
    path: opts.path ?? '/api/auth',
    maxAge: opts.maxAgeMs,
  });
}

export function clearRefreshCookie(res: Response, opts?: { secure?: boolean; path?: string }): void {
  const cookieSecure = opts?.secure ?? process.env.NODE_ENV === 'production';
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'strict',
    path: opts?.path ?? '/api/auth',
  });
}

// -----------------------------------------------------------------------------
// Password-redaction helper for WS terminal output (security: H14)
// -----------------------------------------------------------------------------
// PCI-DSS 3.2 forbids auth material from appearing in audit logs / captured
// output. Junos / IOS commands routinely include user-typed plaintext
// passwords (e.g. `set system login user X authentication plain-text-password
// ABC...`). The WS terminal persists `stream.data` text into
// `TerminalCommand.output` for compliance — redact before persist.
const PASSWORD_LIKE_PATTERNS: RegExp[] = [
  // common CLI: `password <value>` / `secret <value>`
  /\b(password|passwd|pswd|secret|key-string|preshared-key|pre-shared-key|community-string)\b\s+(?!\$|:)\S{4,}/gi,
  // Junos: `authentication plain-text-password` followed by a value on the next line / same line
  /\b(plain-text-password|plaintext-password)\b[^\n]{0,8}["']?([^\s"']{4,})/gi,
  // IOS-XE: `username X privilege 15 secret 0/5 <hash-or-password>`
  /\b(username\s+\S+\s+(?:privilege\s+\d+\s+)?(?:secret|password)\s+(?:0|5|7|8)\s+)\S{4,}/gi,
  // generic: `pre-shared-key` / `pre-shared key` followed by value
  /\bpre[ -]shared[ -]?key\s*[:=]?\s*["']?([A-Za-z0-9!@#$%^&*()_+=\-]{6,})/gi,
];

export function redactSensitiveMaterial(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of PASSWORD_LIKE_PATTERNS) {
    out = out.replace(re, (_match, ...groups) => {
      // Preserve identifier / verb but replace the secret with REDACTED:N bytes
      const last = groups[groups.length - 1];
      if (typeof last === 'string' && last.length >= 4) {
        return last.replace(/./g, '*');
      }
      return '[REDACTED]';
    });
  }
  return out;
}

// Verify that a string is a well-formed JWT signature (defensive — used by
// WS upgrade to avoid feeding garbage to jsonwebtoken that triggers slow
// paths or panics). Length-bounded so a hostile client cannot exhaust CPU.
export function looksLikeJwt(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (s.length < 20 || s.length > 8192) return false;
  // Three base64url segments separated by '.'
  return /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(s);
}

// Constant-time string compare (audit fixes share-secret hygiene).
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
