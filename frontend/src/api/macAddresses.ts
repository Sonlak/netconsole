import type { MacAddressInventory, MacCollectResponse } from '../types/macAddress';
import { authFetch, handleResponse } from './http';

const API_BASE = '/api/mac-addresses';

export async function fetchMacAddressInventory(): Promise<MacAddressInventory> {
  const response = await authFetch(API_BASE);
  return handleResponse<MacAddressInventory>(response);
}

export async function collectMacAddresses(): Promise<MacCollectResponse> {
  const response = await authFetch(`${API_BASE}/collect`, { method: 'POST' });
  return handleResponse<MacCollectResponse>(response);
}
