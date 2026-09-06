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
 */
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
    // Replay attack: invalidate every still-valid token for this user.
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