import crypto from 'node:crypto';
import { prisma } from './prisma.js';

const REFRESH_TOKEN_BYTES = 32;          // 256-bit secret
const REFRESH_TOKEN_TTL_DAYS = 30;       // sliding 30 days
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

/**
 * Issue a new refresh + access token pair for the given user.
 *
 * Returns:
 *   refreshToken      raw, base64url-encoded secret to hand to the client
 *   accessToken       signed JWT (15-minute TTL)
 *   refreshExpiresAt  when the refresh chain becomes invalid
 */
export interface TokenPair {
  refreshToken: string;
  accessToken: string;
  refreshExpiresAt: Date;
  /**
   * `true` if the caller was racing a parallel refresh within
   * `REPLAY_GRACE_MS` and we returned the new access JWT but did
   * NOT rotate again. The caller (the auth route) should skip the
   * Set-Cookie in this case — the parallel POST already set the
   * cookie, and overwriting it with a value derived from the same
   * hash would be a no-op or worse, churn the cookie.
   */
  graceHit?: boolean;
}

export async function issueTokenPair(
  userId: string,
  meta: { userAgent?: string | null; ip?: string | null },
  signAccess: (payload: { userId: string; username: string; role: string }) => string,
): Promise<TokenPair> {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, role: true, active: true },
  });
  if (!user || !user.active) {
    throw new Error('User not found or inactive');
  }

  const accessToken = signAccess({
    userId,
    username: user.username,
    role: user.role,
  });

  return { refreshToken: raw, accessToken, refreshExpiresAt: expiresAt };
}

/**
 * Rotate a refresh token: validate the raw token, mark the previous row as
 * consumed, and issue a fresh pair. Throws if the token is unknown,
 * already consumed, expired, revoked, or tied to an inactive user.
 *
 * If a *consumed* token is replayed, the entire chain for that user is
 * revoked as a defence against token theft.
 *
 * Race-tolerance (added 2026-10-19):
 *   The previous behaviour was a hard `replay_detected` for ANY
 *   already-consumed token. The cost was that benign parallel refreshes
 *   (e.g. NetBox Import page mounts → fires `fetchNetboxInstances` +
 *   `fetchNetboxHealth` simultaneously, both hit 401, both kick
 *   coordinatedRefresh; OR two tabs of the same user land on 401 at the
 *   same millisecond) produced an unavoidable double-POST to /api/auth/refresh
 *   → second one ALWAYS fired replay_detected → entire refresh chain
 *   revoked → user kicked out, has to log in again. Logged 06:18-06:19
 *   on 2026-10-19 as admin@118.69.212.253 with three logins in 2 min.
 *
 *   The fix: if the consumed token was consumed within `REPLAY_GRACE_MS`
 *   (5s) AND the same user already has an un-consumed, un-revoked token
 *   that is NOT the one just consumed, the new token is returned instead
 *   of throwing. The stolen-token defence (revoke the whole chain) only
 *   fires when the consumed token is older than the grace window — by
 *   then it's almost certainly an attacker replaying a token the
 *   legitimate user discarded hours/days ago.
 *
 *   Tunable: 5s is enough to absorb same-millisecond double-POSTs from
 *   any number of tabs (cross-tab coordination normally prevents this,
 *   but BroadcastChannel can be blocked by extension, private mode, or
 *   same-millisecond race on the first call after a tab open). Going
 *   beyond ~10s starts to weaken the stolen-token defence materially.
 */
const REPLAY_GRACE_MS = 5_000;

export async function rotateRefreshToken(
  raw: string,
  meta: { userAgent?: string | null; ip?: string | null },
  signAccess: (payload: { userId: string; username: string; role: string }) => string,
): Promise<TokenPair> {
  const tokenHash = hashRefreshToken(raw);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { active: true } } },
  });

  if (!existing) {
    throw new RefreshError('invalid_token', 'Refresh token not recognised');
  }
  if (existing.revokedAt) {
    throw new RefreshError('revoked_token', 'Refresh token was revoked');
  }
  if (existing.consumedAt) {
    // ── Race-tolerant path (2026-10-19) ───────────────────────────────
    // The token was just consumed by a parallel POST that the same
    // user almost certainly also initiated (cross-tab refresh, page
    // mount firing multiple authJsonFetch, etc.). If the consume was
    // within the last REPLAY_GRACE_MS AND the user has a fresh
    // un-consumed, un-revoked token minted around the same time, hand
    // back a fresh access JWT but DO NOT mint a new refresh token —
    // the parallel POST already did that and updated the browser
    // cookie. The raw value of the new refresh token is unrecoverable
    // (DB only stores the hash), so we set `graceHit: true` and let
    // the auth route skip Set-Cookie — the browser cookie from the
    // parallel POST is the source of truth.
    //
    //   The stolen-token defence (revoke the whole chain) only
    //   fires when the consumed token is older than the grace
    //   window — by then it's almost certainly an attacker replaying
    //   a token the legitimate user discarded hours/days ago.
    const consumedMsAgo = Date.now() - existing.consumedAt.getTime();
    if (consumedMsAgo <= REPLAY_GRACE_MS) {
      const fresh = await prisma.refreshToken.findFirst({
        where: {
          userId: existing.userId,
          revokedAt: null,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          // Minted AFTER the consumed token, otherwise we could be
          // returning a token the user is actively rotating elsewhere.
          createdAt: { gt: existing.consumedAt },
        },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { username: true, role: true, active: true } } },
      });
      if (fresh && fresh.user.active) {
        console.log(
          `[auth] refresh grace hit (ip=${meta.ip ?? 'unknown'}, user=${fresh.user.username}, ` +
          `consumedMsAgo=${consumedMsAgo})`,
        );
        const accessToken = signAccess({
          userId: fresh.userId,
          username: fresh.user.username,
          role: fresh.user.role,
        });
        return {
          // Marker string; the auth route will refuse to set-cookie
          // when graceHit is true. The client gets a fresh access
          // JWT and keeps whatever refresh cookie the browser
          // already has (set by the parallel POST).
          refreshToken: '__grace_hit__',
          accessToken,
          refreshExpiresAt: fresh.expiresAt,
          graceHit: true,
        };
      }
    }
    // Genuine replay — the consumed token is stale (or the user has
    // no fresh replacement). Invalidate every still-valid token for
    // this user.
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null, consumedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new RefreshError('replay_detected', 'Refresh token replay detected; all sessions revoked');
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw new RefreshError('expired_token', 'Refresh token expired');
  }
  if (!existing.user.active) {
    throw new RefreshError('inactive_user', 'User account is inactive');
  }

  // Mark the old token as consumed and mint a new one, all inside a single
  // transaction so a crash between the two leaves the chain recoverable
  // (we'd rather the user re-login than silently mint tokens forever).
  const newRaw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const newHash = hashRefreshToken(newRaw);
  const newExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { accessToken } = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: newHash,
        expiresAt: newExpires,
        userAgent: meta.userAgent ?? null,
        ip: meta.ip ?? null,
      },
    });
    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { consumedAt: new Date() },
    });

    const user = await tx.user.findUnique({
      where: { id: existing.userId },
      select: { username: true, role: true },
    });
    if (!user) {
      throw new RefreshError('user_not_found', 'User not found');
    }
    return {
      accessToken: signAccess({
        userId: existing.userId,
        username: user.username,
        role: user.role,
      }),
    };
  });

  return {
    refreshToken: newRaw,
    accessToken,
    refreshExpiresAt: newExpires,
  };
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  const tokenHash = hashRefreshToken(raw);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export class RefreshError extends Error {
  constructor(
    public readonly code:
      | 'invalid_token'
      | 'revoked_token'
      | 'replay_detected'
      | 'expired_token'
      | 'inactive_user'
      | 'user_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'RefreshError';
  }
}

export const REFRESH_COOKIE_NAME = 'nc_refresh';
export const REFRESH_TTL_DAYS = REFRESH_TOKEN_TTL_DAYS;
export const ACCESS_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS;