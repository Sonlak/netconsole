import type { DeviceStatus } from '@/types/device';
import type { DiscoveryResultStatus, DiscoveryScanStatus } from '@/types/discovery';
import type { JobStatus } from '@/types/job';

export type StatusTone = 'success' | 'error' | 'warning' | 'processing' | 'purple' | 'default';

export type StatusMeta = {
  label: string;
  tone: StatusTone;
  pulse?: boolean;
};

export const DEVICE_STATUS_META: Record<DeviceStatus, StatusMeta> = {
  ONLINE: { label: 'Online', tone: 'success' },
  OFFLINE: { label: 'Offline', tone: 'error' },
  MAINTENANCE: { label: 'Maintenance', tone: 'warning' },
  UNKNOWN: { label: 'Unchecked', tone: 'default' },
  MANAGED: { label: 'Managed', tone: 'purple' },
};

export const JOB_STATUS_META: Record<JobStatus, StatusMeta> = {
  PENDING: { label: 'Pending', tone: 'default' },
  RUNNING: { label: 'Running', tone: 'processing', pulse: true },
  SUCCESS: { label: 'Success', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'error' },
};

export const DISCOVERY_SCAN_META: Record<DiscoveryScanStatus, StatusMeta> = {
  PENDING: { label: 'Pending', tone: 'default' },
  RUNNING: { label: 'Running', tone: 'processing', pulse: true },
  COMPLETED: { label: 'Completed', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'error' },
};

export const DISCOVERY_RESULT_META: Record<DiscoveryResultStatus, StatusMeta> = {
  PENDING: { label: 'Pending', tone: 'default' },
  PING_FAIL: { label: 'Ping fail', tone: 'default' },
  PROBING: { label: 'Probing', tone: 'processing', pulse: true },
  DISCOVERED: { label: 'Discovered', tone: 'success' },
  SYNCED: { label: 'Synced', tone: 'purple' },
  SKIPPED_EXISTS: { label: 'Already in inventory', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'error' },
};

export const DEVICE_STATUS_OPTIONS = (Object.keys(DEVICE_STATUS_META) as DeviceStatus[]).map((value) => ({
  value,
  label: DEVICE_STATUS_META[value].label,
  color: DEVICE_STATUS_META[value].tone,
}));

export const DHCP_UTIL_WARNING = 70;
export const DHCP_UTIL_CRITICAL = 85;

export function deviceStatusMeta(status: DeviceStatus): StatusMeta {
  return DEVICE_STATUS_META[status] ?? DEVICE_STATUS_META.UNKNOWN;
}

export function jobStatusMeta(status: JobStatus): StatusMeta {
  return JOB_STATUS_META[status] ?? JOB_STATUS_META.PENDING;
}

export function discoveryScanMeta(status: DiscoveryScanStatus): StatusMeta {
  return DISCOVERY_SCAN_META[status] ?? DISCOVERY_SCAN_META.PENDING;
}

export function discoveryResultMeta(status: DiscoveryResultStatus): StatusMeta {
  return DISCOVERY_RESULT_META[status] ?? DISCOVERY_RESULT_META.PENDING;
}

export function linkStatusMeta(status: string | undefined): StatusMeta {
  const value = (status || '').toLowerCase();
  if (value === 'up') return { label: 'Up', tone: 'success' };
  if (value === 'down') return { label: 'Down', tone: 'error' };
  return { label: status || 'Unknown', tone: 'default' };
}

export function peerStatusMeta(reachable: boolean): StatusMeta {
  return reachable ? { label: 'Reachable', tone: 'success' } : { label: 'Unreachable', tone: 'error' };
}

export function dhcpUtilMeta(utilization: number): StatusMeta {
  if (utilization >= DHCP_UTIL_CRITICAL) return { label: 'Critical', tone: 'error' };
  if (utilization >= DHCP_UTIL_WARNING) return { label: 'Warning', tone: 'warning' };
  return { label: 'Normal', tone: 'success' };
}
