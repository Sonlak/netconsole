import type { FabricTopology } from '../types/fabric';
import { authFetch, handleResponse } from './http';

export async function fetchFabricTopology(site: string): Promise<FabricTopology> {
  const params = new URLSearchParams();
  if (site) params.set('site', site);
  // Timestamp busts the server-side fabric cache so we always get fresh data.
  // The server ignores this param; it only affects the cache key.
  params.set('_t', String(Date.now()));
  const response = await authFetch(`/api/fabric?${params.toString()}`);
  return handleResponse<FabricTopology>(response);
}
