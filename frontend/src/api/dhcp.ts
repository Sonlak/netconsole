import type { DhcpDashboard, DhcpLease, DhcpServer } from '../types/dhcp';
import { authJsonFetch, authFetch, handleResponse } from './http';

const API_BASE = '/api/dhcp';

export async function fetchDhcpDashboard(): Promise<DhcpDashboard> {
  const response = await authFetch(`${API_BASE}/dashboard`);
  return handleResponse<DhcpDashboard>(response);
}

export async function fetchDhcpServer(): Promise<{
  server: DhcpServer;
  totals: DhcpDashboard['totals'];
}> {
  const response = await authFetch(`${API_BASE}/server`);
  return handleResponse(response);
}

export async function fetchPoolLeases(poolName: string): Promise<DhcpLease[]> {
  const response = await authFetch(`${API_BASE}/pools/${encodeURIComponent(poolName)}/leases`);
  const payload = await handleResponse<{ leases: DhcpLease[] }>(response);
  return payload.leases;
}

export async function deleteDhcpLease(ip: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/leases/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  await handleResponse(response);
}

export async function wipePoolLeases(poolName: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/pools/${encodeURIComponent(poolName)}/wipe`, {
    method: 'POST',
  });
  await handleResponse(response);
}

export async function addDhcpLease(input: {
  ip: string;
  mac: string;
  poolName: string;
  hostname?: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/leases`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fixStaticDhcpLease(input: {
  ip: string;
  mac: string;
  poolName: string;
  hostname?: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/leases/${encodeURIComponent(input.ip)}/fix-static`, {
    method: 'POST',
    body: JSON.stringify({
      mac: input.mac,
      poolName: input.poolName,
      hostname: input.hostname,
    }),
  });
}

export async function unfixStaticDhcpLease(input: {
  ip: string;
  poolName: string;
  mac?: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/leases/${encodeURIComponent(input.ip)}/unfix-static`, {
    method: 'POST',
    body: JSON.stringify({
      poolName: input.poolName,
      mac: input.mac,
    }),
  });
}

export async function addDhcpPool(input: {
  poolName: string;
  subnet: string;
  poolStart: string;
  poolEnd: string;
  gateway: string;
  dns?: string[];
  domainName?: string;
  leaseTime?: number;
  interfaceName: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/pools`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteDhcpPool(poolName: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/pools/${encodeURIComponent(poolName)}`, {
    method: 'DELETE',
  });
  await handleResponse(response);
}
