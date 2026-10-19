// =============================================================================
// TOTP (RFC 6238) helpers — P2 hardening
//
// SECURITY (P2, 2026-10-19):
// - Per-user 2FA with industry-standard TOTP (Google Authenticator, Authy,
//   1Password, etc.).
// - Secret is a 20-byte (160-bit) random value, base32-encoded for
//   the otpauth:// URL. Meets the RFC 6238 §5.1 recommendation of
//   "shared secret of at least 128 bits, preferably 160 bits".
// - 6-digit codes, 30-second step, SHA-1 hash (compatible with all
//   major authenticator apps).
// - ±1 step window (90s total) to absorb device clock drift; codes
//   already used within the window are rejected to prevent replay.
// - Backup codes: 10 single-use codes generated at enrollment.
//   Each code is bcrypt-hashed before storage. The user stores them
//   offline; we never see them after enrollment.
// - The server NEVER receives the user's cleartext backup codes after
//   the initial generation — they're shown ONCE in the enrollment
//   response and never again.
// =============================================================================

import { generateSecret, generateURI, generateSync, verifySync, createGuardrails } from 'otplib';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';

// Guardrails: window=1 (±1 step = 90s total) to handle device clock drift.
// Cast through unknown because OTPGuardrailsConfig doesn't expose `window`
// at the TypeScript level, but createGuardrails accepts it at runtime.
const GUARDRAILS = createGuardrails({ window: 1 } as unknown as Parameters<typeof createGuardrails>[0]);

// Issuers shown in the authenticator app's UI.
const ISSUER = 'NetConsole';

/** Generate a fresh base32 TOTP secret. */
export function generateTotpSecret(): string {
  // generateSecret uses crypto.randomBytes under the hood (20 bytes by default).
  return generateSecret();
}

/** Build the otpauth:// URL the user scans into their authenticator app. */
export function buildOtpAuthUrl(username: string, secret: string): string {
  return generateURI({ secret, issuer: ISSUER, label: username });
}

/** Generate a QR code (data URL) for the otpauth URL. */
export async function generateQrCodeDataUrl(otpAuthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256,
    color: {
      dark: '#000000',
      light: '#FFFFFF',
    },
  });
}

/**
 * Verify a 6-digit TOTP code against a secret. Returns true on success.
 * Anti-replay: `lastTotpAt` is the timestamp of the last successful
 * verify. If a code resolves to the same step, reject (the attacker
 * might have replayed the same code). The caller is responsible for
 * updating `lastTotpAt` on success.
 *
 * @param secret base32-encoded shared secret
 * @param code 6-digit string from the authenticator app
 * @param lastTotpAt DateTime of last successful verify (for replay rejection)
 * @returns true if code is valid AND not a replay
 */
export function verifyTotpCode(
  secret: string,
  code: string,
  lastTotpAt: Date | null = null,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({ token: code, secret, guardrails: GUARDRAILS });
  if (!result.valid) return false;

  // Anti-replay: reject if the current step was already consumed.
  if (lastTotpAt) {
    const lastStep = Math.floor(lastTotpAt.getTime() / 1000 / 30);
    // timeStep is only present on valid results; guard with optional chaining.
    const currentStep = (result as { timeStep?: number }).timeStep;
    if (currentStep !== undefined && lastStep === currentStep) return false;
  }
  return true;
}

/** Generate a single random backup code. */
function generateBackupCode(): string {
  const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    out += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
  }
  return out;
}

// 10 codes is the common balance — enough to last ~6 months if the user
// loses their device and uses ~1-2 per year, but small enough to print
// on one page. 8 is too tight (lose 2 codes in one bad day = locked out
// until admin reset). 12 starts to feel excessive.
const BACKUP_CODE_COUNT = 10;
// SECURITY: backup codes are 10 alphanumeric characters (A-Z + 0-9), no
// ambiguous chars (0/O, 1/I/L). 36^10 ≈ 3.6e15 entropy space.
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_LENGTH = 10;

/** Generate a batch of backup codes (cleartext). */
export function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code: string;
    // Defensive: keep regenerating until unique within this batch.
    do {
      code = generateBackupCode();
    } while (codes.includes(code));
    codes.push(code);
  }
  return codes;
}

/** Hash a backup code with bcrypt for storage. */
export async function hashBackupCode(code: string): Promise<string> {
  // bcrypt cost=10 is fine for codes (the password bcrypt cost=13 dominates).
  return bcrypt.hash(code.toUpperCase(), 10);
}

/** Verify a backup code against a stored hash. */
export async function verifyBackupCode(
  storedHashes: string[],
  code: string,
): Promise<{ valid: boolean; remaining: string[] }> {
  const normalized = code.toUpperCase().replace(/[\s-]/g, '');
  for (let i = 0; i < storedHashes.length; i++) {
    const hash = storedHashes[i];
    if (await bcrypt.compare(normalized, hash)) {
      // Consume this code by removing it from the list.
      const remaining = [...storedHashes.slice(0, i), ...storedHashes.slice(i + 1)];
      return { valid: true, remaining };
    }
  }
  return { valid: false, remaining: storedHashes };
}

/**
 * Compute a step-aligned timestamp suitable for `lastTotpAt`. We snap to
 * the start of the 30-second window so two verifications within the
 * same window produce the same value (which the anti-replay check uses
 * to reject the second one).
 */
export function currentStepTimestamp(): Date {
  const now = Math.floor(Date.now() / 1000 / 30) * 30 * 1000;
  return new Date(now);
}
