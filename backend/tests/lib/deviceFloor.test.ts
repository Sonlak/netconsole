import { describe, expect, it } from 'vitest';
import {
  floorFromHostname,
  parseFloorNumber,
  canonicalFloor,
  siteFromHostname,
  canonicalSite,
} from '../../src/lib/deviceFloor.js';

describe('floorFromHostname', () => {
  it('extracts floor number from F03 pattern', () => {
    expect(floorFromHostname('SW-AS-F03-01')).toBe('3');
    expect(floorFromHostname('core-f12-r1')).toBe('12');
  });

  it('handles various separators', () => {
    expect(floorFromHostname('switch_F05_a')).toBe('5');
    expect(floorFromHostname('dev-f9-port1')).toBe('9');
  });

  it('returns null for invalid format', () => {
    expect(floorFromHostname('switch-1')).toBeNull();
    expect(floorFromHostname('F0')).toBeNull(); // F0 is invalid (zero)
    expect(floorFromHostname('')).toBeNull();
    expect(floorFromHostname('random')).toBeNull();
  });

  it('strips leading zeros', () => {
    expect(floorFromHostname('SW-F003-R5')).toBe('3');
    expect(floorFromHostname('SW-F099-Test')).toBe('99');
  });

  it('handles uppercase and lowercase', () => {
    expect(floorFromHostname('SW-f03')).toBe('3');
    expect(floorFromHostname('SW-F03')).toBe('3');
  });

  it('handles whitespace', () => {
    expect(floorFromHostname('  SW-F03-R1  ')).toBe('3');
  });
});

describe('parseFloorNumber', () => {
  it('parses stored floor format like "F03"', () => {
    expect(parseFloorNumber('F03')).toBe(3);
    expect(parseFloorNumber('F12')).toBe(12);
    expect(parseFloorNumber('3')).toBe(3);
  });

  it('extracts floor from hostname string', () => {
    expect(parseFloorNumber('SW-F05-A')).toBe(5);
  });

  it('returns null for invalid input', () => {
    expect(parseFloorNumber('')).toBeNull();
    expect(parseFloorNumber(null)).toBeNull();
    expect(parseFloorNumber(undefined)).toBeNull();
    expect(parseFloorNumber('F0')).toBeNull(); // F0 is invalid
    expect(parseFloorNumber('F100')).toBeNull(); // Out of range
    expect(parseFloorNumber('random')).toBeNull();
  });

  it('handles whitespace', () => {
    expect(parseFloorNumber('  F07  ')).toBe(7);
  });
});

describe('canonicalFloor', () => {
  it('prefers floor from hostname', () => {
    expect(canonicalFloor('SW-F05-R1', 'F99')).toBe('5');
  });

  it('falls back to stored floor when hostname has no floor', () => {
    expect(canonicalFloor('switch-1', 'F07')).toBe('7');
  });

  it('returns raw stored floor when no parsing possible', () => {
    expect(canonicalFloor('switch-1', 'Basement')).toBe('Basement');
  });

  it('returns empty string when nothing is set', () => {
    expect(canonicalFloor('switch-1')).toBe('');
  });
});

describe('siteFromHostname', () => {
  it('extracts site code from hostname', () => {
    expect(siteFromHostname('HCM-F03-SW01')).toBe('HCM');
    expect(siteFromHostname('hn-r5-core')).toBe('HN');
  });

  it('returns null for invalid format', () => {
    expect(siteFromHostname('123abc-thing')).toBeNull();
    expect(siteFromHostname('1-f03')).toBeNull(); // starts with digit
    expect(siteFromHostname('')).toBeNull();
  });

  it('uppercases the result', () => {
    expect(siteFromHostname('hcm-f03')).toBe('HCM');
  });

  it('handles various separators', () => {
    expect(siteFromHostname('site_name-here')).toBe('SITE');
    expect(siteFromHostname('hn_f03')).toBe('HN');
  });
});

describe('canonicalSite', () => {
  it('prefers site from hostname', () => {
    expect(canonicalSite('HCM-SW-01', 'HN')).toBe('HCM');
  });

  it('falls back to stored site', () => {
    expect(canonicalSite('switch', 'HN')).toBe('HN');
  });

  it('returns empty string when nothing is set', () => {
    expect(canonicalSite('switch')).toBe('');
  });

  it('trims whitespace', () => {
    expect(canonicalSite('switch', '  HN  ')).toBe('HN');
  });
});
