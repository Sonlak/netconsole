export type DiscoveryScanStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type DiscoveryResultStatus =
  | 'PENDING'
  | 'PING_FAIL'
  | 'PROBING'
  | 'DISCOVERED'
  | 'SYNCED'
  | 'SKIPPED_EXISTS'
  | 'FAILED';

export type DiscoveryResult = {
  id: string;
  scanId: string;
  ip: string;
  status: DiscoveryResultStatus;
  pingOk: boolean;
  pingMs: number | null;
  sshOk: boolean;
  name: string | null;
  vendor: string | null;
  model: string | null;
  version: string | null;
  serial: string | null;
  description: string | null;
  showRun: string | null;
  error: string | null;
  deviceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DiscoveryScan = {
  id: string;
  subnet: string;
  site: string;
  floor: string;
  status: DiscoveryScanStatus;
  totalHosts: number;
  scanned: number;
  reachable: number;
  discovered: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  results?: DiscoveryResult[];
  _count?: { results: number };
};

export const DISCOVERY_RESULT_STATUS: Record<
  DiscoveryResultStatus,
  { label: string; color: string }
> = {
  PENDING: { label: 'Pending', color: 'default' },
  PING_FAIL: { label: 'Ping fail', color: 'default' },
  PROBING: { label: 'Probing', color: 'processing' },
  DISCOVERED: { label: 'Discovered', color: 'success' },
  SYNCED: { label: 'Synced', color: 'purple' },
  SKIPPED_EXISTS: { label: 'Already in inventory', color: 'warning' },
  FAILED: { label: 'Failed', color: 'error' },
};
