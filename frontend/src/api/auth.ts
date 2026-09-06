const API_BASE = '/api/auth';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
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
  refreshToken: string;
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
  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return handleResponse<LoginResponse>(response);
}

export async function getCurrentUser(): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/me`, {
    headers: authHeaders(),
  });
  return handleResponse<{ user: User }>(response);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/password`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
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
  });
  return handleResponse<{ users: User[] }>(response);
}

// Admin: create new user
export async function register(request: RegisterRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return handleResponse<{ user: User }>(response);
}

// Admin: update user (role, active)
export async function updateUser(id: string, request: UpdateUserRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/users/${id}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return handleResponse<{ user: User }>(response);
}

// Admin: reset user password
export async function resetUserPassword(id: string, newPassword: string): Promise<void> {
  const response = await fetch(`${API_BASE}/users/${id}/reset-password`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
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
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }
}

// POST /api/auth/refresh — exchange the refresh token for a new pair.
// Throws if the refresh token is missing/expired/replayed; the caller
// should then clear local auth and bounce to /login.
export async function refreshTokens(): Promise<RefreshResponse> {
  const refresh = getRefreshToken();
  if (!refresh) {
    throw new Error('No refresh token in storage');
  }
  const response = await fetch(`${API_BASE}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
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
  setRefreshToken(data.refreshToken, data.refreshExpiresAt);
  return data;
}

// POST /api/auth/logout — revoke the refresh token server-side. Best
// effort: if it fails (e.g. already offline) we still clear local auth.
export async function logout(): Promise<void> {
  const refresh = getRefreshToken();
  try {
    if (refresh) {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
    }
  } catch {
    // Network error during logout is fine — local state will be cleared
    // either way.
  }
  clearAllAuth();
}

// Token storage helpers
const TOKEN_KEY = 'netconsole_token';
const REFRESH_KEY = 'netconsole_refresh';
const REFRESH_EXPIRES_KEY = 'netconsole_refresh_expires';
const USER_KEY = 'netconsole_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function getRefreshExpiresAt(): number | null {
  const raw = localStorage.getItem(REFRESH_EXPIRES_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setRefreshToken(token: string, expiresAtIso: string): void {
  localStorage.setItem(REFRESH_KEY, token);
  localStorage.setItem(REFRESH_EXPIRES_KEY, String(new Date(expiresAtIso).getTime()));
}

export function removeRefreshToken(): void {
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(REFRESH_EXPIRES_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function removeStoredUser(): void {
  localStorage.removeItem(USER_KEY);
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
