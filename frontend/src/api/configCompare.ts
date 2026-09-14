import { authJsonFetch } from './http';

const BASE = '/api/config-snapshots';

export type SavedConfigEntry = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  role: string;
};

export async function fetchConfigHistory(deviceId: string): Promise<SavedConfigEntry[]> {
  const data = await authJsonFetch<{ entries: SavedConfigEntry[] }>(`${BASE}/${deviceId}/history`);
  return data.entries;
}

export type DiffSides = {
  from: {
    id: string;
    label: string;
    content: string;
    timestamp: string;
    lineCount: number;
  };
  to: {
    id: string;
    label: string;
    content: string;
    timestamp: string;
    lineCount: number;
  };
};

export async function fetchSavedConfigDiff(
  deviceId: string,
  fromId: string,
  toId: string,
): Promise<DiffSides> {
  const url = `${BASE}/${deviceId}/diff?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`;
  return authJsonFetch<DiffSides>(url);
}
