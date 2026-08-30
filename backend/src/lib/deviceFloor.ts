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

export function canonicalFloor(name: string, storedFloor?: string | null): string {
  const fromName = floorFromHostname(name);
  if (fromName) return fromName;
  const n = parseFloorNumber(storedFloor);
  if (n != null) return String(n);
  return (storedFloor || '').trim();
}

const HOST_SITE = /^([A-Za-z][A-Za-z0-9]{1,7})[-_]/;

export function siteFromHostname(name: string): string | null {
  const match = (name || '').trim().match(HOST_SITE);
  return match ? match[1].toUpperCase() : null;
}

export function canonicalSite(name: string, storedSite?: string | null): string {
  return siteFromHostname(name) || (storedSite || '').trim();
}
