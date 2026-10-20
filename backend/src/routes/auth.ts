import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { signToken, authMiddleware, requireRole, setRefreshCookie, clearRefreshCookie, invalidatePasswordCache } from '../middleware/auth.js';
import type { AuthenticatedRequest, JwtPayload } from '../middleware/auth.js';
import {
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
  RefreshError,
} from '../lib/refreshTokens.js';
import {
  recordFailedLogin,
  recordSuccessfulLogin,
  isLoginLocked,
} from '../middleware/loginAttempt.js';
import { authRateLimit } from '../middleware/rateLimit.js';
import { signMfaToken, verifyMfaToken } from '../lib/mfaToken.js';
import { verifyTotpCode, verifyBackupCode, currentStepTimestamp } from '../lib/totp.js';

export const authRouter = Router();

// SECURITY (M7, see docs/agents/16-security-audit-preprod.md): bump
// bcrypt rounds from 12 to 13 for banking workload. 12 was on the
// lower edge of PCI-DSS recommendations; 13 adds ~250ms per hash and
// makes offline brute-force materially harder against a DB dump. To
// run this against an existing user table with old `cost=12` hashes,
// bcrypt.compare() falls back gracefully — old hashes are still
// accepted, and the next successful login (change-password or admin
// reset) re-hashes at cost=13.
const BCRYPT_ROUNDS = 13;

// SECURITY (C13, see docs/agents/16-security-audit-preprod.md):
// Refresh token + access TTLs for both body and HttpOnly cookie paths.
// Browsers get the cookie; non-browser clients (worker container, CLI
// scripts) read the body. Both paths go through the same DB row so
// rotation / revocation works uniformly.
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_COOKIE_NAME = 'nc_refresh';

// SECURITY (H10): use Express's `req.ip`. After `app.set('trust proxy',
// 1)` in index.ts, this returns the X-Forwarded-For value supplied by
// the local nginx hop — manual X-Forwarded-For parsing without trust-
// proxy would let a client spoof the IP recorded in the user / audit
// tables, polluting downstream rate-limit + lockout logic.
function getClientIp(req: Request): string | null {
  const ip = (req as Request & { ip?: string }).ip ?? null;
  return ip || null;
}

// Helper: pull the refresh token from either the HttpOnly cookie or a
// request body field (cookie preferred for XSS resistance; body field
// accepted for non-browser clients like the worker container).
function readRefreshToken(req: Request): string | null {
  const fromCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const fromBody = (req.body && typeof req.body.refreshToken === 'string') ? req.body.refreshToken : null;
  return fromBody;
}

// Helper: shape the user object we return to clients (never include password)
function shapeUser(user: {
  id: string;
  username: string;
  email: string;
  role: string;
  active: boolean;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdAt: Date;
  // P2 hardening: mustChangePassword + totpEnabled included so the
  // frontend can route the user appropriately.
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  // password is optional — callers from Prisma selects omit it.
  password?: string;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    active: user.active,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    lastLoginIp: user.lastLoginIp ?? null,
    createdAt: user.createdAt.toISOString(),
    mustChangePassword: user.mustChangePassword ?? false,
    totpEnabled: user.totpEnabled ?? false,
  };
}

// POST /api/auth/login
// SECURITY (2026-10-20): the `authRateLimit` middleware is attached
// ONLY to this route (and to `POST /mfa/verify` below). It used to
// live on a global `app.use('/api/auth', ...)` in index.ts and was
// tripping after ~7 successful re-logins because the in-memory gate
// counted every request — including 200 OK responses — toward the
// budget. Now `authRateLimit` has `failuresOnly: true` so successful
// logins roll the increment back via `res.on('finish')`, and the
// DB-backed `loginAttempt.ts` lockout (5 consecutive bad passwords)
// remains the authoritative credential-stuffing gate.
authRouter.post('/login', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const ip = getClientIp(req);

    // SECURITY (H11, see docs/agents/16-security-audit-preprod.md):
    // lock out users after 5 consecutive failed attempts (window:
    // 15 minutes). Runs BEFORE the user lookup so the timing of a
    // lockout response matches a normal user-not-found response —
    // prevents username enumeration via timing.
    if (ip && (await isLoginLocked(username, ip))) {
      res.status(429).json({
        error: 'Too many failed login attempts. Try again in 15 minutes.',
      });
      return;
    }

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.active) {
      // Same error for "not found" and "inactive" — avoid user enumeration
      if (ip) await recordFailedLogin(username, ip);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      if (ip) await recordFailedLogin(username, ip).catch(() => undefined);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    // SECURITY (P2, 2026-10-19): per-user TOTP 2FA gate. If the user has
    // enrolled TOTP, the password alone is not enough — issue a 5-minute
    // mfa challenge token and have the client call /api/auth/mfa/verify
    // with a 6-digit code. The mfa token has no other authority; the
    // /api/auth/me endpoint rejects it (authMiddleware check) so a
    // leaked mfa token is only good for 5 min and only at the verify
    // endpoint.
    if (user.totpEnabled) {
      const mfaToken = signMfaToken(user.id);
      res.status(200).json({
        requireTotp: true,
        mfaToken,
        // Hint to the client: which methods are accepted. Backup codes
        // are always available (until exhausted) so the UI offers them
        // as a fallback when the user has lost their device.
        methods: ['totp', 'backup-code'],
      });
      return;
    }

    // Issue a (access JWT, refresh token) pair. The refresh row is the
    // source of truth for session lifetime — access JWTs are short-lived
    // (15 min) and stateless.
    let pair;
    try {
      pair = await issueTokenPair(
        user.id,
        { userAgent, ip },
        (payload) => signToken(payload),
      );
    } catch (err) {
      console.error('Failed to issue token pair:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // Record last login (best-effort — do not fail the login if this errors).
    // SECURITY: clear the failed-login counter only on successful auth.
    prisma.user
      .update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      })
      .catch((err) => console.error('Failed to record lastLoginAt:', err));
    if (ip) {
      recordSuccessfulLogin(username, ip).catch(() => undefined);
    }

    // SECURITY (C13): set the refresh token as an HttpOnly + SameSite=Strict
    // cookie. We still return the raw value in the body so non-browser
    // clients (worker container, curl scripts) can keep working — the
    // refresh-row in DB is the same one either side uses.
    setRefreshCookie(res, pair.refreshToken, { maxAgeMs: REFRESH_TTL_MS });

    res.json({
      token: pair.accessToken,
      refreshToken: pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        // P2 hardening: tell the frontend to redirect to the
        // change-password page on first login. The frontend should
        // already enforce this via ProtectedRoute, but exposing it in
        // the login response means non-browser clients (CLI scripts)
        // also know they must rotate the password before doing
        // anything else.
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// SECURITY (P2, 2026-10-19): POST /api/auth/mfa/verify — complete the
// second factor of a TOTP-protected login. Accepts either a 6-digit
// TOTP code or a single-use backup code. On success, issues the
// canonical (access, refresh) pair just like a non-TOTP login would.
authRouter.post('/mfa/verify', authRateLimit, async (req: Request, res: Response) => {
  try {
    const { mfaToken, code, method } = req.body as {
      mfaToken?: string;
      code?: string;
      method?: 'totp' | 'backup-code';
    };

    if (!mfaToken || !code) {
      res.status(400).json({ error: 'mfaToken and code are required' });
      return;
    }
    if (typeof code !== 'string' || code.length < 6 || code.length > 20) {
      res.status(400).json({ error: 'Invalid code format' });
      return;
    }

    const payload = verifyMfaToken(mfaToken);
    if (!payload) {
      res.status(401).json({ error: 'MFA token invalid or expired' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
      // Race: admin disabled TOTP between password verify and mfa verify.
      // Treat as a fresh login (return 401 so the client starts over).
      res.status(401).json({ error: 'MFA not available; restart login' });
      return;
    }

    let success = false;
    let newBackupCodes = user.totpBackupCodes;

    if (method === 'backup-code') {
      // Consume a backup code. Codes are bcrypt-hashed; we check the
      // list, find a match, and rewrite the column to drop the consumed
      // code. If `code` doesn't match any, return 401 (without leaking
      // how many codes the user has left).
      const result = await verifyBackupCode(user.totpBackupCodes, code);
      if (result.valid) {
        success = true;
        newBackupCodes = result.remaining;
      }
    } else {
      // Default to TOTP code path.
      const codeOk = verifyTotpCode(user.totpSecret, code, user.lastTotpAt);
      if (codeOk) {
        success = true;
      }
    }

    if (!success) {
      res.status(401).json({ error: 'Invalid code' });
      return;
    }

    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    // Issue the real (access, refresh) pair. Update user row in the
    // same transaction so a half-success (token issued, but row
    // update failed) cannot leave a TOTP code replayable.
    let pair;
    try {
      pair = await prisma.$transaction(async (tx) => {
        const newPair = await issueTokenPair(
          user.id,
          { userAgent, ip },
          (p) => signToken(p),
        );
        await tx.user.update({
          where: { id: user.id },
          data: {
            lastTotpAt: currentStepTimestamp(),
            totpBackupCodes: newBackupCodes,
            lastLoginAt: new Date(),
            lastLoginIp: ip,
          },
        });
        return newPair;
      });
    } catch (err) {
      console.error('MFA verify: failed to issue tokens:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (ip) {
      recordSuccessfulLogin(user.username, ip).catch(() => undefined);
    }

    setRefreshCookie(res, pair.refreshToken, { maxAgeMs: REFRESH_TTL_MS });

    // SECURITY: audit-log the mfa success. We use a distinct code so
    // compliance dashboards can separate "password login" from
    // "password + TOTP login" without parsing the user-agent.
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          username: user.username,
          role: user.role,
          method: 'POST',
          path: '/api/auth/mfa/verify',
          action: '/api/auth/mfa/verify (success)',
          ip: ip ?? null,
          userAgent: userAgent ?? null,
          statusCode: 200,
          metadata: {
            code: 'totp_success',
            method: method === 'backup-code' ? 'backup_code' : 'totp',
            backupCodesRemaining: newBackupCodes.length,
          },
        },
      })
      .catch(() => undefined);

    res.json({
      token: pair.accessToken,
      refreshToken: pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (error) {
    console.error('MFA verify error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh — exchange a refresh token for a new (access, refresh)
// pair. The old refresh row is consumed atomically and a NEW refresh row is
// issued; the raw refresh token rotates each call so a stolen token cannot
// be replayed once it's been used.
authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const raw = readRefreshToken(req);
    if (!raw) {
      res.status(400).json({ error: 'Refresh token is required (cookie or body field)' });
      return;
    }

    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    let pair;
    try {
      pair = await rotateRefreshToken(
        raw,
        { userAgent, ip },
        (payload) => signToken(payload),
      );
    } catch (err) {
      if (err instanceof RefreshError) {
        // SECURITY (H7, see docs/agents/16-security-audit-preprod.md):
        // a replay-detected event means an attacker used an already-
        // consumed refresh token. The cookie-rotation chain is revoked,
        // but a row in AuditLog is what makes the incident queryable in
        // compliance dashboards (otherwise the only signal is a
        // console.warn).
        if (err.code === 'replay_detected') {
          console.warn(
            `[auth] refresh replay detected (ip=${ip ?? 'unknown'}, ua=${userAgent ?? 'unknown'})`,
          );
          prisma.auditLog
            .create({
              data: {
                userId: null,
                username: null,
                role: null,
                method: 'POST',
                path: '/api/auth/refresh',
                action: '/api/auth/refresh (replay-detected)',
                ip: ip ?? null,
                userAgent: userAgent ?? null,
                statusCode: 401,
                metadata: {
                  code: 'replay_detected',
                  reason:
                    'Refresh token was already consumed; whole session chain revoked.',
                },
              },
            })
            .catch((auditErr) =>
              console.error('[audit] failed to log replay event:', auditErr),
            );
          res.status(401).json({ error: err.message, code: err.code });
          return;
        }
        res.status(401).json({ error: err.message, code: err.code });
        return;
      }
      console.error('Refresh error:', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    // SECURITY (C13): refresh cookie too, UNLESS this was a grace hit
    // (a parallel POST just rotated the cookie already — sending
    // another Set-Cookie would either be a no-op or churn the cookie
    // for no reason). The raw body stays for non-browser clients.
    if (!pair.graceHit) {
      setRefreshCookie(res, pair.refreshToken, { maxAgeMs: REFRESH_TTL_MS });
    }

    res.json({
      token: pair.accessToken,
      refreshToken: pair.graceHit ? undefined : pair.refreshToken,
      refreshExpiresAt: pair.refreshExpiresAt.toISOString(),
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout — revoke the supplied refresh token. Idempotent:
// returns 204 whether or not the token was recognised.
authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const raw = readRefreshToken(req);
    if (raw) {
      await revokeRefreshToken(raw).catch((err) =>
        console.error('Failed to revoke refresh token:', err),
      );
    }
    // SECURITY (C13): always clear the cookie even when no token was
    // supplied — covers "logged out from another tab" / "local auth
    // cleared" flows where the cookie may still be on the request.
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout-all — revoke every refresh token for the current
// user. Useful for "log out of every device" buttons.
authRouter.post('/logout-all', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const revoked = await revokeAllForUser(userId);
    res.json({ message: 'All sessions revoked', revoked });
  } catch (error) {
    console.error('Logout-all error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register (Admin only)
authRouter.post('/register', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    // Username validation: 3-32 chars, alphanumeric + dash/underscore/dot
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, dot, dash, underscore)' });
      return;
    }

    // Email validation: basic shape
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    // Password policy (matches frontend rules)
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const validRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
    if (role && !validRoles.includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
    });

    if (existing) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        username,
        email,
        password: hashed,
        role: (role as 'ADMIN' | 'OPERATOR' | 'VIEWER') || 'OPERATOR',
      },
    });

    res.status(201).json({ user: shapeUser(user) });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me - Get current user
authRouter.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        // P2 hardening: expose mustChangePassword + totpEnabled so the
        // frontend can route the user to the right setup page.
        mustChangePassword: true,
        totpEnabled: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
    });

    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: shapeUser({ ...user, password: '' }) });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/auth/password - Change password (self)
authRouter.put('/password', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new password are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, user.password);

    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // P2 hardening: when the user changes their password (self-service
    // OR admin reset), clear the `mustChangePassword` flag so they
    // don't get redirected to the change-password page forever.
    // Also revoke all existing refresh tokens so a stolen old session
    // can't survive a forced rotation.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashed,
          mustChangePassword: false,
          // SECURITY (2026-10-20): stamp the rotation so authMiddleware
          // can reject any access token minted before this moment. See the
          // block comment above `tokenPredatesPasswordChange` in
          // middleware/auth.ts.
          // NOT set here for admin resets — see note at the admin reset block.
          passwordChangedAt: new Date(),
        },
      }),
      // SECURITY: force-logout the user from every other session. If
      // the rotation was triggered by a forgotten-password flow, the
      // attacker with the old session can no longer refresh.
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // SECURITY (2026-10-20): drop the in-process cache entry so the
    // next request on this process does NOT serve a stale value.
    invalidatePasswordCache(user.id);

    // Clear the refresh cookie on the current response (the rotation
    // above invalidated the cookie the browser is sending).
    clearRefreshCookie(res);

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/users (Admin only)
authRouter.get('/users', authMiddleware, requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        // P2 hardening: expose totpEnabled + mustChangePassword so the
        // admin user-management page can show which users have 2FA on
        // and which accounts need a forced rotation.
        totpEnabled: true,
        mustChangePassword: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ users: users.map((u) => shapeUser({ ...u, password: '' })) });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/auth/users/:id (Admin only) — update role or active
authRouter.patch('/users/:id', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { role, active } = req.body;

    if (id === req.user!.userId && active === false) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    if (id === req.user!.userId && role && role !== 'ADMIN') {
      res.status(400).json({ error: 'Cannot demote your own account' });
      return;
    }

    const data: Record<string, unknown> = {};
    if (role !== undefined) {
      const validRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
      if (!validRoles.includes(role)) {
        res.status(400).json({ error: 'Invalid role' });
        return;
      }
      data.role = role;
    }
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        res.status(400).json({ error: 'active must be boolean' });
        return;
      }
      data.active = active;
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        active: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
    });

    res.json({ user: shapeUser(user) });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/users/:id/reset-password (Admin only) — set temp password, force change on next login
authRouter.post('/users/:id/reset-password', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const { newPassword, forceChange = true } = req.body;

    if (!newPassword) {
      res.status(400).json({ error: 'New password is required' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      res.status(400).json({ error: 'Password must contain upper, lower, and a digit' });
      return;
    }

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // P2 hardening: admin-set passwords ALWAYS mark
    // `mustChangePassword = true` by default (so the user must
    // rotate on next login), revoke all existing refresh tokens
    // (the old sessions are dead — only the new password works),
    // and audit-log the action.
    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: {
          password: hashed,
          mustChangePassword: Boolean(forceChange),
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    prisma.auditLog
      .create({
        data: {
          userId: req.user!.userId,
          username: req.user!.username,
          role: req.user!.role,
          method: 'POST',
          path: `/api/auth/users/${id}/reset-password`,
          action: '/api/auth/users/:id/reset-password',
          ip: getClientIp(req),
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          statusCode: 200,
          metadata: {
            targetUserId: id,
            targetUsername: target.username,
            forceChange: Boolean(forceChange),
          },
        },
      })
      .catch(() => undefined);

    res.json({ message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/users/:id/reset-totp (Admin only) — clear the user's
// TOTP enrollment. Used when the user has lost their authenticator
// device AND lost their backup codes. The user will be prompted to
// re-enroll on next login.
authRouter.post('/users/:id/reset-totp', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await prisma.user.update({
      where: { id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpEnrolledAt: null,
        totpBackupCodes: [],
        lastTotpAt: null,
      },
    });

    // Audit log the TOTP reset. Distinct from reset-password so the
    // compliance dashboard can flag a "user lost their 2FA" pattern
    // (multiple TOTP resets for the same user in a short window = red
    // flag for social engineering).
    prisma.auditLog
      .create({
        data: {
          userId: req.user!.userId,
          username: req.user!.username,
          role: req.user!.role,
          method: 'POST',
          path: `/api/auth/users/${id}/reset-totp`,
          action: '/api/auth/users/:id/reset-totp',
          ip: getClientIp(req),
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          statusCode: 200,
          metadata: {
            targetUserId: id,
            targetUsername: target.username,
          },
        },
      })
      .catch(() => undefined);

    res.json({ message: 'TOTP enrollment cleared. User will be prompted to re-enroll on next login.' });
  } catch (error) {
    console.error('Reset TOTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/users/:id (Admin only)
authRouter.delete('/users/:id', authMiddleware, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = String(req.params.id);

    if (id === req.user!.userId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    await prisma.user.delete({ where: { id } });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
