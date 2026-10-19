import { useState, useEffect, useCallback } from 'react';
import {
  login as apiLogin,
  verifyMfa as apiVerifyMfa,
  getCurrentUser,
  getToken,
  setToken as saveToken,
  setRefreshToken as saveRefreshToken,
  getStoredUser,
  setStoredUser,
  clearAllAuth,
  logout as apiLogout,
  type User,
} from '../api/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
  // P2 hardening: when the server returns `requireTotp: true` from
  // the password login, the frontend stores the MFA challenge here
  // so a separate component can show the 6-digit-code input.
  pendingMfa: { mfaToken: string; methods: ('totp' | 'backup-code')[] } | null;
}

interface LoginCredentials {
  username: string;
  password: string;
}

// Synchronous hydration from localStorage so the dashboard renders instantly.
function hydrate(): AuthState {
  const token = getToken();
  const cached = getStoredUser();
  if (token && cached) {
    return {
      user: cached,
      token,
      isLoading: false,
      isAuthenticated: true,
      error: null,
      pendingMfa: null,
    };
  }
  return {
    user: null,
    token: null,
    isLoading: false,
    isAuthenticated: false,
    error: null,
    pendingMfa: null,
  };
}

function buildUser(response: { user?: { id: string; username: string; email: string; role: string; lastLoginAt?: string | null; mustChangePassword?: boolean; totpEnabled?: boolean } }, fallbackCreatedAt?: string): User {
  // Caller is responsible for ensuring response.user is defined.
  // (Both call sites throw before reaching this point if user is missing.)
  const u = response.user!;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    active: true,
    lastLoginAt: u.lastLoginAt ?? null,
    mustChangePassword: u.mustChangePassword ?? false,
    totpEnabled: u.totpEnabled ?? false,
    createdAt: fallbackCreatedAt ?? new Date().toISOString(),
  };
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(hydrate);

  // Background verify on mount — UI already hydrated, no spinner needed.
  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let cancelled = false;
    getCurrentUser()
      .then(({ user }) => {
        if (cancelled) return;
        setStoredUser(user);
        setState((s) => ({ ...s, user }));
      })
      .catch(() => {
        if (cancelled) return;
        // Token invalid or expired → clear and drop back to login screen.
        clearAllAuth();
        setState({
          user: null,
          token: null,
          isLoading: false,
          isAuthenticated: false,
          error: null,
          pendingMfa: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    setState((s) => ({ ...s, isLoading: true, error: null, pendingMfa: null }));
    try {
      const response = await apiLogin(credentials);

      // P2 hardening: TOTP challenge branch. Password was correct but
      // the user has 2FA enabled — surface the MFA challenge so the
      // LoginPage can show the 6-digit code form. We do NOT store any
      // token in localStorage yet; the mfaToken is a separate
      // 5-minute JWT that can only be exchanged at /api/auth/mfa/verify.
      if (response.requireTotp && response.mfaToken) {
        setState({
          user: null,
          token: null,
          isLoading: false,
          isAuthenticated: false,
          error: null,
          pendingMfa: {
            mfaToken: response.mfaToken,
            methods: response.methods ?? ['totp', 'backup-code'],
          },
        });
        return 'require_totp' as const;
      }

      if (!response.token || !response.user) {
        throw new Error('Login response missing token or user');
      }

      // SECURITY (C13, see docs/agents/16-security-audit-preprod.md):
      // refresh token is now primarily in the HttpOnly cookie. The
      // body field is still present (workers / non-browser clients
      // rely on it), but for browsers we only mirror it to
      // localStorage as a best-effort fallback for the in-tab
      // refresh coordinator. The actual rotation goes through the
      // cookie on the next /api/auth/refresh call.
      saveToken(response.token);
      if (response.refreshToken && response.refreshExpiresAt) {
        saveRefreshToken(response.refreshToken, response.refreshExpiresAt);
      }
      const user = buildUser(response);
      setStoredUser(user);
      setState({
        user,
        token: response.token,
        isLoading: false,
        isAuthenticated: true,
        error: null,
        pendingMfa: null,
      });
      return 'ok' as const;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Login failed';
      setState((s) => ({
        ...s,
        isLoading: false,
        error,
        pendingMfa: null,
      }));
      return 'error' as const;
    }
  }, []);

  // P2 hardening: complete a TOTP login after the password was
  // accepted but a 6-digit code is required. Called from the MFA
  // challenge component in the LoginPage.
  const verifyMfaCode = useCallback(
    async (code: string, method: 'totp' | 'backup-code' = 'totp') => {
      setState((s) => {
        if (!s.pendingMfa) return s;
        return { ...s, isLoading: true, error: null };
      });

      const mfaToken = state.pendingMfa?.mfaToken;
      if (!mfaToken) {
        setState((s) => ({ ...s, isLoading: false, error: 'MFA challenge expired. Log in again.' }));
        return false;
      }

      try {
        const response = await apiVerifyMfa(mfaToken, code, method);
        if (!response.token || !response.user) {
          throw new Error('MFA verify response missing token or user');
        }
        saveToken(response.token);
        if (response.refreshToken && response.refreshExpiresAt) {
          saveRefreshToken(response.refreshToken, response.refreshExpiresAt);
        }
        const user = buildUser(response);
        setStoredUser(user);
        setState({
          user,
          token: response.token,
          isLoading: false,
          isAuthenticated: true,
          error: null,
          pendingMfa: null,
        });
        return true;
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Verification failed';
        setState((s) => ({ ...s, isLoading: false, error }));
        return false;
      }
    },
    [state.pendingMfa],
  );

  // P2 hardening: clear the pending MFA challenge (e.g. user clicked
  // "back to login" or wants to try a different account).
  const cancelMfa = useCallback(() => {
    setState((s) => ({
      ...s,
      pendingMfa: null,
      error: null,
    }));
  }, []);

  const logout = useCallback(async () => {
    // Fire-and-forget: the local state update should not block on the
    // /logout HTTP call finishing.
    void apiLogout();
    setState({
      user: null,
      token: null,
      isLoading: false,
      isAuthenticated: false,
      error: null,
      pendingMfa: null,
    });
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  // P2 hardening: refresh the cached user record (e.g. after a
  // password change that clears `mustChangePassword`).
  const refreshUser = useCallback(async () => {
    try {
      const { user } = await getCurrentUser();
      setStoredUser(user);
      setState((s) => ({ ...s, user }));
    } catch {
      // Silent: the next API call will fail and the refresh
      // coordinator will redirect to /login.
    }
  }, []);

  return {
    ...state,
    login,
    verifyMfaCode,
    cancelMfa,
    logout,
    clearError,
    refreshUser,
  };
}
