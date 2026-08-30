import { useState, useEffect, useCallback } from 'react';
import { login as apiLogin, getCurrentUser, getToken, setToken as saveToken, removeToken, type User } from '../api/auth';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  error: string | null;
}

interface LoginCredentials {
  username: string;
  password: string;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: null,
    isLoading: true,
    isAuthenticated: false,
    mustChangePassword: false,
    error: null,
  });

  // Check for existing token and validate on mount
  useEffect(() => {
    const validateToken = async () => {
      const token = getToken();
      if (!token) {
        setState((s) => ({ ...s, isLoading: false }));
        return;
      }

      try {
        const { user } = await getCurrentUser();
        setState({
          user,
          token,
          isLoading: false,
          isAuthenticated: true,
          mustChangePassword: user.mustChangePassword === true,
          error: null,
        });
      } catch {
        // Token invalid or expired
        removeToken();
        setState({
          user: null,
          token: null,
          isLoading: false,
          isAuthenticated: false,
          mustChangePassword: false,
          error: null,
        });
      }
    };

    validateToken();
  }, []);

  const login = useCallback(async (credentials: LoginCredentials) => {
    setState((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const response = await apiLogin(credentials);
      saveToken(response.token);
      const mustChange = response.user.mustChangePassword === true;
      setState({
        user: {
          id: response.user.id,
          username: response.user.username,
          email: response.user.email,
          role: response.user.role,
          active: true,
          mustChangePassword: mustChange,
          createdAt: new Date().toISOString(),
        },
        token: response.token,
        isLoading: false,
        isAuthenticated: true,
        mustChangePassword: mustChange,
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

  const markPasswordChanged = useCallback(() => {
    setState((s) => ({
      ...s,
      mustChangePassword: false,
      user: s.user ? { ...s.user, mustChangePassword: false } : s.user,
    }));
  }, []);

  const logout = useCallback(() => {
    removeToken();
    setState({
      user: null,
      token: null,
      isLoading: false,
      isAuthenticated: false,
      mustChangePassword: false,
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
    markPasswordChanged,
  };
}
