// =============================================================================
// TOTP management routes — P2 hardening
//
// All routes here require the user to be authenticated (the user
// themselves, NOT an admin). Admin can clear another user's TOTP via
// /api/auth/users/:id/reset-totp (see routes/auth.ts).
//
// Endpoints:
//   POST /api/totp/setup   — start enrollment: returns secret + QR + backup codes
//   POST /api/totp/verify  — confirm a code, finalize enrollment (enables TOTP)
//   POST /api/totp/disable — turn off TOTP (requires current password)
//   POST /api/totp/regenerate-backup-codes — generate 10 new codes (consumes old)
//   GET  /api/totp/status  — { enabled, hasBackupCodes, lastTotpAt }
//
// SECURITY (P2):
// - setup generates a fresh secret but does NOT set totpEnabled. The
//   user must verify a code from their authenticator before TOTP
//   becomes enforced at login. This avoids "locked out by typing
//   the wrong secret into the app".
// - backup codes are shown ONCE in the setup response, in the
//   regenerate-backup-codes response, and never again. They are
//   bcrypt-hashed at rest.
// - disable requires the current password (so a stolen access JWT
//   alone cannot turn off 2FA).
// - regenerate-backup-codes invalidates the previous codes
//   atomically in the same transaction.
// =============================================================================

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  generateTotpSecret,
  buildOtpAuthUrl,
  generateQrCodeDataUrl,
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
  currentStepTimestamp,
} from '../lib/totp.js';

export const totpRouter = Router();

function getClientIp(req: Request): string | null {
  const ip = (req as Request & { ip?: string }).ip ?? null;
  return ip || null;
}

// POST /api/totp/setup — start enrollment
// SECURITY: does NOT set totpEnabled. Returns a pending secret + QR
// + a cleartext list of backup codes (the user must save them now).
// The user must then call /api/totp/verify with a 6-digit code from
// their authenticator to actually enable TOTP.
totpRouter.post('/setup', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.totpEnabled) {
      res.status(400).json({ error: 'TOTP is already enabled. Disable first to re-enroll.' });
      return;
    }

    const secret = generateTotpSecret();
    const otpAuthUrl = buildOtpAuthUrl(user.username, secret);
    const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUrl);
    const backupCodesCleartext = generateBackupCodes();
    const backupCodesHashed = await Promise.all(
      backupCodesCleartext.map((c) => hashBackupCode(c)),
    );

    // Store the pending secret + hashed backup codes. totpEnabled stays
    // false until /api/totp/verify confirms a code. If the user never
    // completes verification, the secret is overwritten on the next
    // /setup call (no security impact).
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecret: secret,
        totpBackupCodes: backupCodesHashed,
        // Wipe any previous TOTP verify state (e.g. from a partial setup).
        lastTotpAt: null,
        totpEnrolledAt: null,
      },
    });

    res.json({
      // The secret in base32 — users can also paste it into an
      // authenticator that doesn't support QR (e.g. some hardware
      // tokens). NOT to be confused with the QR code data URL.
      secret,
      // otpauth:// URL the QR encodes.
      otpAuthUrl,
      // PNG data URL for the QR.
      qrCodeDataUrl,
      // 10 single-use recovery codes. Shown ONCE.
      backupCodes: backupCodesCleartext,
    });
  } catch (error) {
    console.error('TOTP setup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/totp/verify — confirm first code, finalize enrollment
// Body: { code: "123456" }
totpRouter.post('/verify', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      res.status(400).json({ error: '6-digit code is required' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!user.totpSecret) {
      res.status(400).json({ error: 'No pending TOTP setup. Call /api/totp/setup first.' });
      return;
    }
    if (user.totpEnabled) {
      res.status(400).json({ error: 'TOTP already enabled' });
      return;
    }

    // Anti-replay: a code used within the same 30s window is rejected.
    // During initial setup, lastTotpAt is null so the first verify always
    // passes; the field gets stamped on success.
    const ok = verifyTotpCode(user.totpSecret, code, user.lastTotpAt);
    if (!ok) {
      res.status(401).json({ error: 'Invalid code' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: true,
        totpEnrolledAt: new Date(),
        lastTotpAt: currentStepTimestamp(),
      },
    });

    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          username: user.username,
          role: user.role,
          method: 'POST',
          path: '/api/totp/verify',
          action: '/api/totp/verify (enrolled)',
          ip: getClientIp(req),
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          statusCode: 200,
          metadata: {
            code: 'totp_enrolled',
            backupCodesRemaining: user.totpBackupCodes.length,
          },
        },
      })
      .catch(() => undefined);

    res.json({ message: 'TOTP enabled successfully.' });
  } catch (error) {
    console.error('TOTP verify error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/totp/disable — turn off TOTP (requires current password)
// SECURITY: the password check is what makes this safe. A stolen
// access JWT alone cannot turn off 2FA; the attacker would also need
// the user's current password.
totpRouter.post('/disable', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword } = req.body as { currentPassword?: string };
    if (!currentPassword) {
      res.status(400).json({ error: 'Current password is required to disable TOTP' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!user.totpEnabled) {
      res.status(400).json({ error: 'TOTP is not enabled' });
      return;
    }

    const passwordOk = await bcrypt.compare(currentPassword, user.password);
    if (!passwordOk) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpEnrolledAt: null,
        totpBackupCodes: [],
        lastTotpAt: null,
      },
    });

    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          username: user.username,
          role: user.role,
          method: 'POST',
          path: '/api/totp/disable',
          action: '/api/totp/disable',
          ip: getClientIp(req),
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
          statusCode: 200,
          metadata: { code: 'totp_disabled' },
        },
      })
      .catch(() => undefined);

    res.json({ message: 'TOTP disabled.' });
  } catch (error) {
    console.error('TOTP disable error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/totp/regenerate-backup-codes — generate 10 new codes
// SECURITY: requires a valid TOTP code from the user (proves they
// still have the device). The previous set of codes is invalidated
// atomically. Old codes cannot be re-used even if a screenshot of
// them was leaked.
totpRouter.post(
  '/regenerate-backup-codes',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { code } = req.body as { code?: string };
      if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        res.status(400).json({ error: '6-digit TOTP code is required' });
        return;
      }

      const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      if (!user.totpEnabled || !user.totpSecret) {
        res.status(400).json({ error: 'TOTP is not enabled' });
        return;
      }

      const codeOk = verifyTotpCode(user.totpSecret, code, user.lastTotpAt);
      if (!codeOk) {
        res.status(401).json({ error: 'Invalid TOTP code' });
        return;
      }

      const newCleartext = generateBackupCodes();
      const newHashed = await Promise.all(newCleartext.map((c) => hashBackupCode(c)));

      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpBackupCodes: newHashed,
          lastTotpAt: currentStepTimestamp(),
        },
      });

      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            username: user.username,
            role: user.role,
            method: 'POST',
            path: '/api/totp/regenerate-backup-codes',
            action: '/api/totp/regenerate-backup-codes',
            ip: getClientIp(req),
            userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
            statusCode: 200,
            metadata: { code: 'totp_backup_codes_regenerated' },
          },
        })
        .catch(() => undefined);

      res.json({
        message: 'Backup codes regenerated. The previous codes are no longer valid.',
        backupCodes: newCleartext,
      });
    } catch (error) {
      console.error('TOTP regenerate-backup-codes error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// GET /api/totp/status — for the frontend user-settings page
totpRouter.get('/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        totpEnabled: true,
        totpEnrolledAt: true,
        totpBackupCodes: true,
        lastTotpAt: true,
      },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({
      enabled: user.totpEnabled,
      enrolledAt: user.totpEnrolledAt ? user.totpEnrolledAt.toISOString() : null,
      backupCodesRemaining: user.totpBackupCodes.length,
      lastTotpAt: user.lastTotpAt ? user.lastTotpAt.toISOString() : null,
    });
  } catch (error) {
    console.error('TOTP status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
