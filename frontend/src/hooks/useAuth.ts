import { useState, useEffect, useCallback } from 'react';
import {
  login as apiLogin,
  getCurrentUser,
  getToken,
  setToken as saveToken,
  removeToken,
  getStoredUser,
  setStoredUser,
  removeStoredUser,
  type User,
} from '../api/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;
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
    };
  }
  return {
    user: null,
    token: null,
    isLoading: false,
    isAuthenticated: false,
    error: null,
  };
}

function buildUser(response: { user: { id: string; username: string; email: string; role: string; lastLoginAt?: string | null } }, fallbackCreatedAt?: string): User {
  return {
    id: response.user.id,
    username: response.user.username,
    email: response.user.email,
    role: response.user.role,
    active: true,
    lastLoginAt: response.user.lastLoginAt ?? null,
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
        removeToken();
        removeStoredUser();
        setState({
          user: null,
          token: null,
          isLoading: false,
          isAuthenticated: false,
          error: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const response = await apiLogin(credentials);
      saveToken(response.token);
      const user = buildUser(response);
      setStoredUser(user);
      setState({
        user,
        token: response.token,
        isLoading: false,
        isAuthenticated: true,
        error: null,
      });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Login failed';
      setState((s) => ({
        ...s,
        isLoading: false,
        error,
      }));
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    removeToken();
    removeStoredUser();
    setState({
      user: null,
      token: null,
      isLoading: false,
      isAuthenticated: false,
      error: null,
    });
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    ...state,
    login,
    logout,
    clearError,
  };
}
