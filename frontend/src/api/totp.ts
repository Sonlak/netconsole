// =============================================================================
// Frontend TOTP API client — P2 hardening
//
// Calls the backend /api/totp/* endpoints. See backend/src/routes/totp.ts
// for the server-side handler. All endpoints here require the access
// JWT (set in the Authorization header by `authHeaders()`).
// =============================================================================

import { authHeaders } from './auth';
import type { TotpSetupResponse, TotpStatus } from './auth';

const API_BASE = '/api/totp';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
  return response.json() as Promise<T>;
}

// POST /api/totp/setup — start TOTP enrollment.
// Returns the secret, otpauth URL, QR data URL, and 10 backup codes.
export async function setupTotp(): Promise<TotpSetupResponse> {
  const response = await fetch(`${API_BASE}/setup`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    credentials: 'include',
  });
  return handleResponse<TotpSetupResponse>(response);
}

// POST /api/totp/verify — confirm a 6-digit code, finalize enrollment.
export async function verifyTotpSetup(code: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE}/verify`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    credentials: 'include',
  });
  return handleResponse<{ message: string }>(response);
}

// POST /api/totp/disable — turn off TOTP (requires current password).
export async function disableTotp(currentPassword: string): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE}/disable`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword }),
    credentials: 'include',
  });
  return handleResponse<{ message: string }>(response);
}

// POST /api/totp/regenerate-backup-codes — generate 10 new codes
// (requires a valid TOTP code from the user, proving they still have
// the device). Previous codes are invalidated atomically.
export async function regenerateBackupCodes(
  code: string,
): Promise<{ message: string; backupCodes: string[] }> {
  const response = await fetch(`${API_BASE}/regenerate-backup-codes`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    credentials: 'include',
  });
  return handleResponse<{ message: string; backupCodes: string[] }>(response);
}

// GET /api/totp/status — for the user-settings page.
export async function getTotpStatus(): Promise<TotpStatus> {
  const response = await fetch(`${API_BASE}/status`, {
    headers: authHeaders(),
    credentials: 'include',
  });
  return handleResponse<TotpStatus>(response);
}

// Admin: clear another user's TOTP enrollment (used when the user
// has lost both their device and all backup codes).
export async function adminResetUserTotp(userId: string): Promise<{ message: string }> {
  const response = await fetch(`/api/auth/users/${userId}/reset-totp`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    credentials: 'include',
  });
  return handleResponse<{ message: string }>(response);
}
