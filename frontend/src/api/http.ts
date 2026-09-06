import { authHeaders, refreshTokens, clearAllAuth } from './auth';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// Single-flight refresh: when multiple API calls hit a 401 at the same
// time, only one POST /api/auth/refresh is in-flight; everyone else
// waits for its result. Prevents the thundering herd of concurrent
// refresh calls that would otherwise each consume one refresh token.
let refreshInFlight: Promise<void> | null = null;

async function doRefresh(): Promise<void> {
  const result = await refreshTokens();
  // refreshTokens() already updates localStorage on success. Touch the
  // var to keep linters happy and to make the success path explicit.
  void result;
}

export async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) {
      // Token expired or invalid. Try a single refresh + retry; if the
      // refresh itself fails (expired / replay / no refresh token) the
      // session is dead and we bounce to /login.
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          try {
            await doRefresh();
          } catch (err) {
            const code = (err as { code?: string } | null)?.code;
            if (code === 'replay_detected') {
              console.warn('[auth] refresh replay detected — clearing local session');
            }
            clearAllAuth();
          } finally {
            // Allow the next batch of 401s to attempt a fresh refresh.
            refreshInFlight = null;
          }
        })();
      }
      try {
        await refreshInFlight;
      } catch {
        // already handled inside doRefresh
      }
      // If the refresh succeeded, the caller can retry the request.
      // We can't transparently retry inside handleResponse (the caller's
      // `response` object is gone), so surface a typed signal.
      throw new UnauthorizedError('Token expired — retry after refresh');
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
  // Up to 2 attempts: the first may 401, in which case we trigger a
  // single-flight refresh and retry once with the new access token.
  // After the second attempt we surface whatever status came back.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await authFetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (response.status !== 401) {
      return handleResponse<T>(response);
    }
    // 401 on the first attempt: kick a single-flight refresh and retry.
    if (attempt === 0) {
      if (!refreshInFlight) {
        refreshInFlight = (async () => {
          try {
            await doRefresh();
          } catch (err) {
            const code = (err as { code?: string } | null)?.code;
            if (code === 'replay_detected') {
              console.warn('[auth] refresh replay detected — clearing local session');
            }
            clearAllAuth();
          } finally {
            refreshInFlight = null;
          }
        })();
      }
      try {
        await refreshInFlight;
      } catch {
        // handled inside doRefresh
      }
      // If refresh cleared local auth, we won't have an Authorization
      // header on retry → second 401 will hit handleResponse cleanly.
      continue;
    }
    // Second 401 → give up.
    return handleResponse<T>(response);
  }
  // Unreachable: the loop always returns or continues.
  throw new UnauthorizedError('Auth retry loop exhausted');
}
