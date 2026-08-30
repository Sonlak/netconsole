import type { DiscoveryScan } from '../types/discovery';
import { authJsonFetch, handleResponse, authFetch } from './http';

const API_BASE = '/api/discovery';

export async function fetchDiscoveryScans(): Promise<DiscoveryScan[]> {
  const response = await authFetch(`${API_BASE}/scans`);
  return handleResponse<DiscoveryScan[]>(response);
}

export async function fetchDiscoveryScan(id: string): Promise<DiscoveryScan> {
  const response = await authFetch(`${API_BASE}/scans/${id}`);
  return handleResponse<DiscoveryScan>(response);
}

export async function startDiscoveryScan(input: {
  subnet: string;
  site?: string;
  floor?: string;
}): Promise<DiscoveryScan> {
  return authJsonFetch<DiscoveryScan>(`${API_BASE}/scans`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function syncDiscoveryResults(
  scanId: string,
  resultIds: string[],
  input: { site: string; floor: string },
): Promise<{ synced: number; created: string[] }> {
  return authJsonFetch<{ synced: number; created: string[] }>(
    `${API_BASE}/scans/${scanId}/sync`,
    {
      method: 'POST',
      body: JSON.stringify({ resultIds, ...input }),
    },
  );
}
