const API_BASE = '/api/auth';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  mustChangePassword?: boolean;
  user: {
    id: string;
    username: string;
    email: string;
    role: string;
    mustChangePassword?: boolean;
  };
}

export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
  active: boolean;
  mustChangePassword?: boolean;
  createdAt: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  role?: 'ADMIN' | 'OPERATOR' | 'VIEWER';
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

export async function register(request: RegisterRequest): Promise<{ user: User }> {
  const response = await fetch(`${API_BASE}/register`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return handleResponse<{ user: User }>(response);
}

// Token storage helpers
const TOKEN_KEY = 'netconsole_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Header helper for authenticated requests
export function authHeaders(): Record<string, string> {
  const token = getToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
