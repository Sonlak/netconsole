import { describe, expect, it } from 'vitest';
import { expandCidr, normalizeCidr } from '../../src/utils/subnet.js';

describe('expandCidr', () => {
  it('expands a /30 subnet to 2 hosts', () => {
    const ips = expandCidr('10.0.0.0/30');
    expect(ips).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('expands a /29 subnet to 6 hosts', () => {
    const ips = expandCidr('192.168.1.0/29');
    expect(ips).toEqual([
      '192.168.1.1',
      '192.168.1.2',
      '192.168.1.3',
      '192.168.1.4',
      '192.168.1.5',
      '192.168.1.6',
    ]);
  });

  it('expands a /28 subnet to 14 hosts', () => {
    const ips = expandCidr('172.16.5.0/28');
    expect(ips).toHaveLength(14);
    expect(ips[0]).toBe('172.16.5.1');
    expect(ips[13]).toBe('172.16.5.14');
  });

  it('handles non-zero network addresses', () => {
    const ips = expandCidr('10.20.3.0/29');
    expect(ips[0]).toBe('10.20.3.1');
    expect(ips[ips.length - 1]).toBe('10.20.3.6');
  });

  it('trims whitespace', () => {
    const ips = expandCidr('  10.0.0.0/30  ');
    expect(ips).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('throws on invalid IP format', () => {
    expect(() => expandCidr('not-an-ip/24')).toThrow('Invalid subnet format');
    expect(() => expandCidr('10.0.0/24')).toThrow('Invalid subnet format');
    expect(() => expandCidr('256.0.0.0/24')).toThrow('Invalid subnet format');
  });

  it('throws on prefix too small (DoS protection)', () => {
    expect(() => expandCidr('10.0.0.0/15')).toThrow('between /16 and /30');
    expect(() => expandCidr('10.0.0.0/8')).toThrow('between /16 and /30');
    expect(() => expandCidr('10.0.0.0/0')).toThrow('between /16 and /30');
  });

  it('throws on prefix too large', () => {
    expect(() => expandCidr('10.0.0.0/31')).toThrow('between /16 and /30');
    expect(() => expandCidr('10.0.0.0/32')).toThrow('between /16 and /30');
  });

  it('throws on subnet too large (>1024 hosts)', () => {
    // /22 = 1022 hosts, /21 = 2046 hosts
    expect(() => expandCidr('10.0.0.0/21', 1024)).toThrow('Subnet too large');
  });

  it('respects custom maxHosts parameter', () => {
    expect(() => expandCidr('10.0.0.0/24', 10)).toThrow('Subnet too large');
    // /28 = 14 hosts, just above 10
    expect(() => expandCidr('10.0.0.0/28', 14)).not.toThrow();
  });

  it('returns empty array for valid prefix with no usable hosts', () => {
    // /31 has 0 usable hosts (only network and broadcast)
    expect(() => expandCidr('10.0.0.0/31')).toThrow('between /16 and /30');
  });

  it('handles boundary case at network edge', () => {
    const ips = expandCidr('255.255.255.252/30');
    expect(ips).toEqual(['255.255.255.253', '255.255.255.254']);
  });
});

describe('normalizeCidr', () => {
  it('returns the trimmed CIDR string', () => {
    expect(normalizeCidr('10.0.0.0/30')).toBe('10.0.0.0/30');
    expect(normalizeCidr('  192.168.1.0/29  ')).toBe('192.168.1.0/29');
  });

  it('throws on invalid input', () => {
    expect(() => normalizeCidr('not-an-ip/24')).toThrow();
    expect(() => normalizeCidr('10.0.0.0/8')).toThrow();
  });
});
