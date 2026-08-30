import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AntdBridge } from './components/antd-bridge';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { PageLoader } from './components/common/PageLoader';
import { ProtectedRoute } from './components/ProtectedRoute';
import AppLayout from './layouts/AppLayout';
import LoginPage from './pages/LoginPage';
import ChangePasswordRequiredPage from './pages/ChangePasswordRequiredPage';
import DashboardPage from './pages/DashboardPage';

const DevicesPage = lazy(() => import('./pages/DevicesPage'));
const DeviceDetailPage = lazy(() => import('./pages/DeviceDetailPage'));
const JobsPage = lazy(() => import('./pages/JobsPage'));
const DiscoveryPage = lazy(() => import('./pages/DiscoveryPage'));
const ArpPage = lazy(() => import('./pages/ArpPage'));
const DhcpPage = lazy(() => import('./pages/DhcpPage'));
const InterfacesPage = lazy(() => import('./pages/InterfacesPage'));
const MacAddressPage = lazy(() => import('./pages/MacAddressPage'));
const GenerateConfigPage = lazy(() => import('./pages/GenerateConfigPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const FabricPage = lazy(() => import('./pages/FabricPage'));

export default function App() {
  return (
    <AntdBridge>
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/change-password-required"
              element={
                <ProtectedRoute>
                  <ChangePasswordRequiredPage />
                </ProtectedRoute>
              }
            />
            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="devices" element={<DevicesPage />} />
              <Route path="devices/:id" element={<DeviceDetailPage />} />
              <Route path="jobs" element={<JobsPage />} />
              <Route path="discovery" element={<DiscoveryPage />} />
              <Route path="fabric" element={<FabricPage />} />
              <Route path="mac-addresses" element={<MacAddressPage />} />
              <Route path="arp-addresses" element={<ArpPage />} />
              <Route path="interfaces" element={<InterfacesPage />} />
              <Route path="generate-config" element={<GenerateConfigPage />} />
              <Route path="dhcp" element={<DhcpPage />} />
              <Route
                path="settings"
                element={
                  <ProtectedRoute requiredRoles={['ADMIN']}>
                    <SettingsPage />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AntdBridge>
  );
}
