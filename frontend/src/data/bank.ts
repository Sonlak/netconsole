import type { Device } from '@/types/device';

export type SiteCode = 'LAB' | 'NKKN' | 'NTMK';
export type SiteFilter = 'all' | SiteCode;
export type DeviceRole = 'core' | 'dist' | 'access';

export type SiteDef = {
  code: SiteCode;
  label: string;
  floors: number;
  vlanBase: number;
  mgmt: number;
};

export const SITES: SiteDef[] = [
  { code: 'LAB', label: 'LAB', floors: 15, vlanBase: 100, mgmt: 10 },
  { code: 'NKKN', label: 'NKKN', floors: 15, vlanBase: 100, mgmt: 11 },
  { code: 'NTMK', label: 'NTMK', floors: 18, vlanBase: 200, mgmt: 12 },
];

export const SITE_CODES: SiteCode[] = ['LAB', 'NKKN', 'NTMK'];

export function isBankSite(value: string): value is SiteCode {
  return value === 'NKKN' || value === 'NTMK';
}

export function isKnownSite(value: string): value is SiteCode {
  return SITE_CODES.includes(value as SiteCode);
}

export function getSite(code: SiteCode): SiteDef {
  return SITES.find((item) => item.code === code)!;
}

export function floorLabel(n: number): string {
  return String(n);
}

const HOST_FLOOR = /(?:^|[-_])F0*([1-9]\d?)(?:[-_]|$)/i;
const STORED_FLOOR = /^F?0*([1-9]\d?)$/i;

export function floorFromHostname(name: string): string | null {
  const match = (name || '').trim().match(HOST_FLOOR);
  if (!match) return null;
  return String(Number(match[1]));
}

export function parseFloorNumber(value: string | null | undefined): number | null {
  const text = (value || '').trim();
  if (!text) return null;
  const fromHost = floorFromHostname(text);
  if (fromHost) return Number(fromHost);
  const match = text.match(STORED_FLOOR);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

export function deviceFloor(device: Pick<Device, 'name' | 'floor'>): string {
  const fromName = floorFromHostname(device.name);
  if (fromName) return fromName;
  const n = parseFloorNumber(device.floor);
  if (n != null) return String(n);
  return device.floor;
}

export function floorsMatch(device: Pick<Device, 'name' | 'floor'>, filter: string): boolean {
  if (!filter || filter === 'all') return true;
  const value = deviceFloor(device);
  if (value === filter) return true;
  const left = parseFloorNumber(value);
  const right = parseFloorNumber(filter);
  return left != null && left === right;
}

const HOST_SITE = /^([A-Za-z][A-Za-z0-9]{1,7})[-_]/;

export function siteFromHostname(name: string): string | null {
  const match = (name || '').trim().match(HOST_SITE);
  return match ? match[1].toUpperCase() : null;
}

export function deviceSite(device: Pick<Device, 'name' | 'site'>): string {
  return siteFromHostname(device.name) || device.site;
}

export function floorVlan(code: SiteCode, floor: number): number {
  return getSite(code).vlanBase + floor;
}

export function floorNumbers(code: SiteCode): number[] {
  return Array.from({ length: getSite(code).floors }, (_, index) => index + 1);
}

export function mgmtCidr(code: SiteCode, scope: 'core' | 'dist' | number): string {
  const octet = getSite(code).mgmt;
  if (scope === 'core') return `10.${octet}.0.0/28`;
  if (scope === 'dist') return `10.${octet}.0.8/29`;
  return `10.${octet}.${scope}.0/24`;
}

export function deviceRole(device: Device): DeviceRole {
  if (device.role) return device.role;
  const key = `${device.name} ${device.floor}`.toLowerCase();
  if (key.includes('core')) return 'core';
  if (key.includes('dist') || /(?:^|[-_])ds(?:[-_]|\d|$)/i.test(key)) return 'dist';
  if (key.includes('access') || /(?:^|[-_])as(?:[-_]|\d|$)/i.test(key)) return 'access';
  return 'access';
}

/** Normalize the free-form `Device.vendor` string to a vendor family.

Mirrors the worker-side `detect_vendor()` in `worker/netconsole_worker/vendor.py`.
The Prisma column is a plain String, so the seed uses title-case ("Juniper",
"Cisco", "Arista") but historic / operator-typed rows can drift to
"aristaEOS", "Cisco-IOS-XE", "Junos", etc. We collapse those here so the
bulk-deploy filter stays usable. Unknown vendors map to `'unknown'`.
*/
export type DeviceVendorFamily = 'juniper' | 'cisco' | 'arista' | 'unknown';

export function deviceVendorFamily(device: Pick<Device, 'vendor' | 'model'>): DeviceVendorFamily {
  const v = (device.vendor || '').trim().toLowerCase();
  const m = (device.model || '').trim().toLowerCase();
  if (v === 'juniper' || v === 'junos' || m.includes('mx') || m.includes('ex') || m.includes('qfx') || m.includes('srx') || m.includes('junos')) {
    return 'juniper';
  }
  if (v === 'cisco' || v === 'ios-xe' || v === 'iosxe' || v === 'catalyst' || v === 'nexus' || v === 'nxos' || v === 'cisco-nx-os'
    || m.includes('catalyst') || m.includes('nexus') || m.includes('csr') || m.includes('asr') || m.includes('isr')) {
    return 'cisco';
  }
  if (v === 'arista' || v === 'eos' || v === 'aristaeos' || m.includes('arista') || m.includes('dcs-') || m.includes('ceos')) {
    return 'arista';
  }
  return 'unknown';
}

export const DEVICE_VENDOR_LABELS: Record<DeviceVendorFamily, string> = {
  juniper: 'Juniper (NETCONF/RESTCONF)',
  cisco: 'Cisco IOS-XE / NX-OS (NETCONF/SSH)',
  arista: 'Arista EOS (eAPI)',
  unknown: 'Unknown vendor',
};

export const BANK_DEVICES: Device[] = [];

export function filterBySite(devices: Device[], site: SiteFilter): Device[] {
  if (site === 'all') return devices;
  return devices.filter((device) => deviceSite(device) === site);
}

export function siteStats(devices: Device[], site: SiteFilter) {
  const list = filterBySite(devices, site);
  return {
    total: list.length,
    core: list.filter((device) => deviceRole(device) === 'core').length,
    dist: list.filter((device) => deviceRole(device) === 'dist').length,
    access: list.filter((device) => deviceRole(device) === 'access').length,
    managed: list.filter((device) => device.status === 'MANAGED').length,
    online: list.filter((device) => device.status === 'ONLINE').length,
    offline: list.filter((device) => device.status === 'OFFLINE').length,
    unknown: list.filter((device) => device.status === 'UNKNOWN').length,
  };
}

export function floorDevices(devices: Device[], site: SiteCode, floor: number): Device[] {
  return devices.filter((device) => deviceSite(device) === site && parseFloorNumber(deviceFloor(device)) === floor);
}
