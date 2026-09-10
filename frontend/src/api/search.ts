import { authFetch, handleResponse } from './http';

export type SearchResultItem = {
  primary: string;
  secondary: string;
  href: string;
  tag?: string;
  tagColor?: string;
};

export type SearchResultGroup = {
  kind: 'device' | 'arp' | 'mac' | 'log' | 'job' | 'audit' | 'dhcp';
  label: string;
  url: string;
  items: SearchResultItem[];
  total: number;
};

export type SearchResponse = {
  groups: SearchResultGroup[];
};

/**
 * Global search — queries all entity types in parallel.
 *
 * @param q        Search keyword (min 2 chars, enforced by backend).
 * @param limit    Max results per group (1-10, default 3).
 */
export async function globalSearch(q: string, limit = 3): Promise<SearchResultGroup[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const response = await authFetch(`/api/search?${params}`);
  const payload = await handleResponse<SearchResponse>(response);
  return payload.groups ?? [];
}
