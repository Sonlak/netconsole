// =============================================================================
// MFA challenge tokens — short-lived proof that a user passed the
// password check but has not yet completed TOTP verification.
//
// SECURITY (P2, 2026-10-19):
// - Issued by POST /api/auth/login when the user has TOTP enabled and
//   the password was correct.
// - The token is a JWT with `purpose: 'mfa'` claim and a 5-minute TTL.
//   It can ONLY be redeemed at POST /api/auth/mfa/verify — it is not a
//   valid access token for any other endpoint (the authMiddleware
//   check refuses tokens with `purpose !== undefined`).
// - The 5-minute window is a balance: long enough to pull out a phone,
//   unlock the authenticator, and type 6 digits, but short enough that
//   a leaked token doesn't keep the door open for hours.
// - On TOTP success, the mfa token is consumed (we add a `mfa:nonce` to
//   a Redis set with 5-minute TTL; second use is rejected). A leaked
//   mfa token is therefore single-use after the legitimate TOTP verify.
// =============================================================================

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSecret } from './../middleware/auth.js';

const MFA_TOKEN_TTL_S = 5 * 60; // 5 minutes

export interface MfaTokenPayload {
  /** Subject = userId. */
  sub: string;
  /** Discriminator so this JWT can never be confused with an access JWT. */
  purpose: 'mfa';
  /** Random nonce (so two mfa tokens for the same user are unique). */
  nonce: string;
}

export function signMfaToken(userId: string): string {
  const payload: MfaTokenPayload = {
    sub: userId,
    purpose: 'mfa',
    nonce: crypto.randomUUID(),
  };
  return jwt.sign(payload, getSecret(), {
    expiresIn: MFA_TOKEN_TTL_S,
    issuer: 'netconsole-backend',
    audience: 'netconsole',
  });
}

export function verifyMfaToken(token: string): MfaTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), {
      issuer: 'netconsole-backend',
      audience: 'netconsole',
    }) as jwt.JwtPayload;
    if (decoded.purpose !== 'mfa') return null;
    if (typeof decoded.sub !== 'string') return null;
    if (typeof decoded.nonce !== 'string') return null;
    return {
      sub: decoded.sub,
      purpose: 'mfa',
      nonce: decoded.nonce,
    };
  } catch {
    return null;
  }
}
