import type { ArpAddressInventory, ArpCollectResponse } from '../types/arpAddress';
import { authFetch, handleResponse } from './http';

const API_BASE = '/api/arp-addresses';

export async function fetchArpAddressInventory(): Promise<ArpAddressInventory> {
  const response = await authFetch(API_BASE);
  return handleResponse<ArpAddressInventory>(response);
}

export async function collectArpAddresses(): Promise<ArpCollectResponse> {
  const response = await authFetch(`${API_BASE}/collect`, { method: 'POST' });
  return handleResponse<ArpCollectResponse>(response);
}
