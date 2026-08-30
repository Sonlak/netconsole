import type { DhcpDashboard, DhcpLease } from '../types/dhcp';
import { authJsonFetch, authFetch, handleResponse } from './http';

const API_BASE = '/api/dhcp';

export async function fetchDhcpDashboard(): Promise<DhcpDashboard> {
  const response = await authFetch(`${API_BASE}/dashboard`);
  return handleResponse<DhcpDashboard>(response);
}

export async function fetchPoolLeases(subnetId: number): Promise<DhcpLease[]> {
  const response = await authFetch(`${API_BASE}/pools/${subnetId}/leases`);
  const payload = await handleResponse<{ leases: DhcpLease[] }>(response);
  return payload.leases;
}

export async function deleteDhcpLease(ip: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/leases/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  await handleResponse(response);
}

export async function wipePoolLeases(subnetId: number): Promise<void> {
  const response = await authFetch(`${API_BASE}/pools/${subnetId}/wipe`, { method: 'POST' });
  await handleResponse(response);
}

export async function addDhcpLease(input: {
  ip: string;
  mac: string;
  subnetId: number;
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
  subnetId: number;
  hostname?: string;
  note?: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/leases/${encodeURIComponent(input.ip)}/fix-static`, {
    method: 'POST',
    body: JSON.stringify({
      mac: input.mac,
      subnetId: input.subnetId,
      hostname: input.hostname,
      note: input.note,
    }),
  });
}

export async function unfixStaticDhcpLease(input: {
  ip: string;
  subnetId: number;
  mac?: string;
}): Promise<void> {
  await authJsonFetch(`${API_BASE}/leases/${encodeURIComponent(input.ip)}/unfix-static`, {
    method: 'POST',
    body: JSON.stringify({
      subnetId: input.subnetId,
      mac: input.mac,
    }),
  });
}
