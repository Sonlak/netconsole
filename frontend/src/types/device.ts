export type DeviceStatus = 'MANAGED' | 'ONLINE' | 'OFFLINE' | 'MAINTENANCE' | 'UNKNOWN';

export type ManagedChecks = {
  ping: boolean;
  ssh: boolean;
  /** RESTCONF / NETCONF / eAPI / NX-API port TCP-reachable. Probe-only; no auth. */
  rest: boolean;
  /** Legacy fields — kept in the shape for back-compat with rows
   * written before 2026-09-09. The worker no longer fetches them. */
  showVersion: boolean;
  showRun: boolean;
};

export type DeviceRole = 'core' | 'dist' | 'access';

export type Device = {
  id: string;
  site: string;
  floor: string;
  name: string;
  ip: string;
  status: DeviceStatus;
  /** Not a Prisma field. Hostname inference only; never treat as API-authoritative. */
  role?: DeviceRole;
  /** Not a Prisma field. Unused in P1 inventory tables. */
  pair?: string | null;
  /** Not a Prisma field. Do not render as an inventory column. */
  vlan?: number | null;
  vendor: string;
  model: string;
  version: string;
  serial: string;
  description: string | null;
  lastPingAt: string | null;
  lastPingMs: number | null;
  lastManagedCheckAt: string | null;
  managedChecks: ManagedChecks | null;
  manageError: string | null;
  uptimeSeconds: number | null;
  uptimeAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceInput = {
  site: string;
  floor: string;
  name: string;
  ip: string;
  status: DeviceStatus;
  vendor: string;
  model: string;
  version: string;
  serial: string;
  description?: string;
};

export { DEVICE_STATUS_OPTIONS } from '@/design/status';

export const DEVICE_FORM_STATUS_OPTIONS = [
  { value: 'UNKNOWN' as const, label: 'Auto (ping + managed check)' },
  { value: 'MAINTENANCE' as const, label: 'Maintenance — pause checks' },
];

export const MANAGED_CHECK_LABELS: { key: keyof ManagedChecks; label: string }[] = [
  { key: 'ping', label: 'Ping' },
  { key: 'ssh', label: 'SSH' },
  { key: 'rest', label: 'REST/NETCONF' },
];

export { deviceStatusMeta as getStatusMeta } from '@/design/status';

export { formatPing as formatLastPing } from '@/lib/format';

export function isFullyManaged(checks: ManagedChecks | null | undefined) {
  if (!checks) return false;
  // Gate mirrors the backend `isFullyManaged` after 2026-09-09:
  // ping + ssh + rest. showVersion/showRun are legacy fields kept for
  // back-compat; if a pre-refactor row still has them set we honor it.
  if (checks.rest) {
    return Boolean(checks.ping && checks.ssh);
  }
  // Legacy row (no `rest` key): fall back to showVersion + showRun.
  return Boolean(checks.ping && checks.ssh && checks.showVersion && checks.showRun);
}
