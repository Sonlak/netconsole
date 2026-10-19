import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Spin } from 'antd';

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRoles?: string[];
}

export function ProtectedRoute({ children, requiredRoles }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" tip="Loading..." />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  // P2 hardening: forced password change gate. Admins can set
  // `mustChangePassword` on a user (e.g. on the first login after
  // a reset, or as part of onboarding). Until the user rotates
  // their password, every protected page redirects to the
  // change-password screen. The change-password screen itself is
  // allowed to render so the user can submit the form.
  if (user?.mustChangePassword && location.pathname !== '/change-password-required') {
    return <Navigate to="/change-password-required" replace />;
  }

  if (requiredRoles && user && !requiredRoles.includes(user.role)) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <h2>Access Denied</h2>
        <p>You don't have permission to access this page.</p>
      </div>
    );
  }

  return <>{children}</>;
}
