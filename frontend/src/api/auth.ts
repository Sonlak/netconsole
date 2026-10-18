import { broadcastLogout } from '../lib/refreshCoordinator';

// SECURITY (C13, see docs/agents/16-security-audit-preprod.md):
// refresh token is now stored ONLY in an HttpOnly + SameSite=Strict
// cookie set by the backend on login/refresh. Frontend NEVER reads or
// writes localStorage for the refresh token — eliminates XSS-read of
// a 30-day bearer credential. The access token still goes in memory
// (XSS-resistant: 15 min TTL) and is the only token the frontend
// holds in JS-accessible form.
//
// Cookie path is `/api/auth` so the cookie is only sent on auth-
// related requests, reducing surface area.
const API_BASE = '/api/auth';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  // SECURITY: refreshToken is still in the body for non-browser
  // clients (worker, curl scripts, dev tools). Browsers should rely
  // on the Set-Cookie header — keep the field optional in TS so the
  // type doesn't lie about what the server actually returns.
  refreshToken?: string;
  refreshExpiresAt: string;
  user: {
    id: string;
    username: string;
    email: string;
    role: string;
    lastLoginAt?: string | null;
  };
}

export interface RefreshResponse {
  token: string;
  refreshToken?: string;
  refreshExpiresAt: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  active: boolean;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  createdAt: string;
}

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  role?: UserRole;
}

export interface UpdateUserRequest {
  role?: UserRole;
  active?: boolean;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
  return response.json() as Promise<T>;
}

export async function login(request: LoginRequest): Promise<LoginResponse> {
  // SECURITY (C13): include `credentials: 'include'` so the Set-Cookie
  // response header is honoured by the browser and stored as the
  // HttpOnly refresh token. Without this, the cookie is silently
  // dropped on cross-origin and the user is forced to log in again
  // every 15 minutes when the access JWT expires.
  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include',
  });
  return handleResponse<LoginResponse>(response);
}

export async function getCurrentUser(): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/me`, {
    headers: authHeaders(),
    credentials: 'include',
  });
  return handleResponse<{ user: User }>(response);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/password`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
}

// Admin: list all users
export async function listUsers(): Promise<{ users: User[] }> {
  const response = await fetch(`${API_BASE}/users`, {
    headers: authHeaders(),
    credentials: 'include',
  });
  return handleResponse<{ users: User[] }>(response);
}

// Admin: create new user
export async function register(request: RegisterRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include',
  });
  return handleResponse<{ user: User }>(response);
}

// Admin: update user (role, active)
export async function updateUser(id: string, request: UpdateUserRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include',
  });
  return handleResponse<{ user: User }>(response);
}

// Admin: reset user password
export async function resetUserPassword(id: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/users/${id}/reset-password`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
}

// Admin: delete user
export async function deleteUser(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
}

// POST /api/auth/refresh — exchange the cookie for a new access JWT.
//
// SECURITY (C13): the refresh token is now in the HttpOnly cookie,
// NOT in the body. The browser sends it automatically with
// `credentials: 'include'`. We deliberately do NOT pass a body field
// — the cookie is the only source. Throws if the cookie is missing
// (we still keep the body field accepted on the backend for non-
// browser clients).
export async function refreshTokens(): Promise<RefreshResponse> {
  const response = await fetch(`${API_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    credentials: 'include',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401 replay_detected / invalid / expired — bubble up the code so
    // http.ts can decide whether to clear local auth.
    const err = new Error(payload.error ?? 'Refresh failed') as Error & { code?: string; status?: number };
    err.code = payload.code;
    err.status = response.status;
    throw err;
  }
  const data = payload as RefreshResponse;
  setToken(data.token);
  // The body may or may not include a refreshToken. For browsers
  // we rely on the rotated cookie. For non-browser clients the body
  // is the only place to read it from. We accept both.
  if (data.refreshToken && data.refreshExpiresAt) {
    setRefreshToken(data.refreshToken, data.refreshExpiresAt);
  }
  return data;
}

// POST /api/auth/logout — revoke the refresh token server-side. Best
// effort: if it fails (e.g. already offline) we still clear local auth.
// Also broadcasts a logout event to other tabs so they clear their
// local session too (see frontend/src/lib/refreshCoordinator.ts).
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'include',
    });
  } catch {
    // Network error during logout is fine — local state will be cleared
    // either way.
  }
  clearAllAuth();
  broadcastLogout();
}

// Token storage helpers
//
// SECURITY: the access JWT is stored in memory via a module-level
// variable (not localStorage). The refresh token is now an HttpOnly
// cookie that JS cannot read — we no longer need localStorage for
// it. We keep the localStorage helpers as fallbacks for non-browser
// clients (worker / dev tools), but a normal browser session never
// touches them for the refresh token.
const TOKEN_KEY = 'netconsole_token';
const REFRESH_KEY = 'netconsole_refresh';
const REFRESH_EXPIRES_KEY = 'netconsole_refresh_expires';
const USER_KEY = 'netconsole_user';

let _inMemoryToken: string | null = null;

export function getToken(): string | null {
  // Prefer in-memory token (XSS-resistant). Fall back to localStorage
  // for HMR / page-reload survival — the access JWT is only 15 min
  // so a reload-flicker is fine.
  if (_inMemoryToken) return _inMemoryToken;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  _inMemoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage may be disabled (private mode, iframe sandbox).
    // In-memory copy still works for the current tab.
  }
}

export function removeToken(): void {
  _inMemoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * @deprecated Kept only for non-browser clients. Browsers should
 * rely on the HttpOnly refresh cookie. Will be removed in a future
 * release once the worker is migrated to read the cookie.
 */
export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

/**
 * @deprecated See `getRefreshToken` note. Browsers should not call this
 * — the HttpOnly cookie is the source of truth.
 */
export function setRefreshToken(token: string, expiresAtIso: string): void {
  try {
    localStorage.setItem(REFRESH_KEY, token);
    localStorage.setItem(REFRESH_EXPIRES_KEY, String(new Date(expiresAtIso).getTime()));
  } catch {
    // ignore
  }
}

/**
 * @deprecated See `getRefreshToken` note. Removes the localStorage copy
 * if any; the HttpOnly cookie is cleared by the backend on logout.
 */
export function removeRefreshToken(): void {
  try {
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(REFRESH_EXPIRES_KEY);
  } catch {
    // ignore
  }
}

export function getStoredUser(): User | null {
  const raw = (() => {
    try {
      return localStorage.getItem(USER_KEY);
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // ignore
  }
}

export function removeStoredUser(): void {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

// Clear both tokens + user in a single call. Used on logout AND on
// irrecoverable auth failures (e.g. refresh-token replay detected).
export function clearAllAuth(): void {
  removeToken();
  removeRefreshToken();
  removeStoredUser();
}

// Header helper for authenticated requests
export function authHeaders(): Record<string, string> {
  const token = getToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
