import type { FabricTopology } from '../types/fabric';
import { authFetch, handleResponse } from './http';

export async function fetchFabricTopology(site: string): Promise<FabricTopology> {
  const params = new URLSearchParams();
  if (site) params.set('site', site);
  const qs = params.toString();
  const response = await authFetch(`/api/fabric${qs ? `?${qs}` : ''}`);
  return handleResponse<FabricTopology>(response);
}
