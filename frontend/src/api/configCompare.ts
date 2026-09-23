import { authJsonFetch } from './http';

const BASE = '/api/config-snapshots';

export type EntryType = 'apply' | 'snapshot';

export type SavedConfigEntry = {
  id: string;
  label: string;
  content: string;
  timestamp: string;
  role: string;
  /** 'apply' = config pushed from web, 'snapshot' = periodic collection */
  entryType: EntryType;
  /** Null = CLI/scheduler (periodic snapshot not triggered by a web user) */
  username: string | null;
  /** eos-api / ssh-cli / junos-rest / nxos-api / null for snapshots */
  source: string | null;
  /** core/dist/access/custom/template-xxx / null for snapshots */
  configRole: string | null;
  /** Number of config lines in the applied commit / 0 for snapshots */
  lineCount: number;
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
    entryType: EntryType;
    username: string | null;
    source: string | null;
    configRole: string | null;
  };
  to: {
    id: string;
    label: string;
    content: string;
    timestamp: string;
    lineCount: number;
    entryType: EntryType;
    username: string | null;
    source: string | null;
    configRole: string | null;
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
