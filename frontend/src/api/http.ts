import { authHeaders } from './auth';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      // Token expired or invalid - redirect to login
      window.location.href = '/login';
      throw new UnauthorizedError('Session expired. Please log in again.');
    }
    if (response.status === 403) {
      throw new Error('You do not have permission to perform this action.');
    }
    if (response.status === 429) {
      const payload = await response.json().catch(() => ({ error: 'Too many requests' }));
      throw new Error(payload.error ?? 'Too many requests, please try again later');
    }
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error ?? 'Request failed');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
}

export async function authJsonFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await authFetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return handleResponse<T>(response);
}
