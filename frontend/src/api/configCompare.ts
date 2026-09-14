import { authJsonFetch } from './http';

const BASE = '/api/config-snapshots';

export type ConfigSnapshot = {
  jobId: string;
  collectedAt: string;
  collectMs: number;
  username: string | null;
  lineCount: number;
};

export type DiffLine = {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
};

export type DiffResult = {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
};

export type SnapshotSide = {
  jobId: string;
  collectedAt: string | null;
  username: string | null;
  collectMs: number;
  lineCount: number;
};

export async function fetchConfigSnapshots(deviceId: string): Promise<ConfigSnapshot[]> {
  const data = await authJsonFetch<{ snapshots: ConfigSnapshot[] }>(`${BASE}/${deviceId}`);
  return data.snapshots;
}

export async function fetchConfigDiff(
  deviceId: string,
  fromJobId: string,
  toJobId: string,
): Promise<{ from: SnapshotSide; to: SnapshotSide; diff: DiffResult }> {
  const url = `${BASE}/${deviceId}/diff?from=${encodeURIComponent(fromJobId)}&to=${encodeURIComponent(toJobId)}`;
  return authJsonFetch<{ from: SnapshotSide; to: SnapshotSide; diff: DiffResult }>(url);
}
