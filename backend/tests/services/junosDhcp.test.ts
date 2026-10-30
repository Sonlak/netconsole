/**
 * Tests for the Junos DHCP server integration (`junosDhcp.ts`).
 *
 * Replaces the old Kea HA tests: Kea was removed on 2026-10-30 and the
 * DHCP server now runs on the distribution switch (Junos extended DHCP
 * local server). There is no HA pair any more — the switch is the only
 * server.
 *
 * These tests lock in the parsing of:
 *   1. `access address-assignment pool` config  → pools
 *   2. `get-dhcp-server-binding-information` XML → leases
 *   3. `show dhcp server binding detail` text   → leases (SSH fallback)
 */
import { describe, expect, it } from 'vitest';

import {
  parseAddressAssignmentPools,
  parseDhcpBindings,
  parseDhcpBindingsText,
} from '../../src/services/junosDhcp.js';

const POOL_CONFIG_XML = `
<configuration>
  <access>
    <address-assignment>
      <pool>
        <name>V201</name>
        <family>
          <inet>
            <network>10.1.201.0/24</network>
            <range>
              <name>V201R</name>
              <low>10.1.201.10</low>
              <high>10.1.201.254</high>
            </range>
            <dhcp-attributes>
              <maximum-lease-time>28800</maximum-lease-time>
              <name-server><name>10.10.20.20</name></name-server>
              <domain-name>lab.netconsole.local</domain-name>
              <router><name>10.1.201.254</name></router>
            </dhcp-attributes>
            <host>
              <name>vpc5</name>
              <hardware-address>aa:bb:cc:dd:ee:ff</hardware-address>
              <ip-address>10.1.201.50</ip-address>
            </host>
          </inet>
        </family>
      </pool>
    </address-assignment>
  </access>
</configuration>`;

const BINDINGS_XML = `
<rpc-reply>
  <dhcp-binding-information xmlns="http://xml.juniper.net/junos/20.3R1/junos-dhcp-server">
    <dhcp-binding>
      <allocated-address>10.1.201.10</allocated-address>
      <mac-address>00:50:79:66:68:05</mac-address>
      <lease-state>BOUND</lease-state>
      <lease-expires>28585</lease-expires>
      <lease-start-time>2026-10-30 06:46:55 UTC</lease-start-time>
      <lease-end-time>2026-10-30 14:46:56 UTC</lease-end-time>
      <interface-name>irb.201:xe-0/0/1.0</interface-name>
      <server-ip-address>10.1.201.254</server-ip-address>
      <pool-name>V201</pool-name>
      <session-id>3</session-id>
    </dhcp-binding>
  </dhcp-binding-information>
</rpc-reply>`;

const BINDINGS_TEXT = `Client IP Address:  10.1.204.10
       Hardware Address:             00:50:79:66:68:09
                State:                        BOUND(LOCAL_SERVER_STATE_BOUND)
           Lease Expires:                2026-10-30 14:46:56 UTC
      Lease Expires in:             28585 seconds
           Lease Start:                  2026-10-30 06:46:55 UTC
Incoming Client Interface:    irb.204:xe-0/0/6.0
       Server Identifier:            10.1.204.254
              Session Id:                   7
          Client Pool Name:             V204
`;

describe('parseAddressAssignmentPools', () => {
  it('reads network, range, gateway, DNS and lease time', () => {
    const pools = parseAddressAssignmentPools(POOL_CONFIG_XML);

    expect(pools).toHaveLength(1);
    const pool = pools[0];
    expect(pool.name).toBe('V201');
    expect(pool.subnet).toBe('10.1.201.0');
    expect(pool.rangeStart).toBe('10.1.201.10');
    expect(pool.rangeEnd).toBe('10.1.201.254');
    expect(pool.gateway).toBe('10.1.201.254');
    expect(pool.dns).toEqual(['10.10.20.20']);
    expect(pool.domainName).toBe('lab.netconsole.local');
    expect(pool.leaseTime).toBe(28800);
    expect(pool.vlan).toBe(201);
  });

  it('computes the pool size from the inclusive range', () => {
    const pools = parseAddressAssignmentPools(POOL_CONFIG_XML);
    expect(pools[0].poolSize).toBe(245);
  });

  it('reads static reservations', () => {
    const pools = parseAddressAssignmentPools(POOL_CONFIG_XML);
    expect(pools[0].hosts).toEqual([
      { name: 'vpc5', mac: 'aa:bb:cc:dd:ee:ff', ip: '10.1.201.50' },
    ]);
    expect(pools[0].reservedCount).toBe(1);
  });

  it('returns an empty list when there is no address-assignment block', () => {
    expect(parseAddressAssignmentPools('<configuration/>')).toEqual([]);
  });
});

describe('parseDhcpBindings', () => {
  it('reads the binding fields from the RESTCONF RPC reply', () => {
    const leases = parseDhcpBindings(BINDINGS_XML);

    expect(leases).toHaveLength(1);
    const lease = leases[0];
    expect(lease.ip).toBe('10.1.201.10');
    expect(lease.mac).toBe('00:50:79:66:68:05');
    expect(lease.state).toBe('BOUND');
    expect(lease.leaseExpires).toBe(28585);
    expect(lease.interface).toBe('irb.201');
    expect(lease.clientInterface).toBe('irb.201:xe-0/0/1.0');
    expect(lease.serverIdentifier).toBe('10.1.201.254');
    expect(lease.poolName).toBe('V201');
    expect(lease.sessionId).toBe('3');
  });

  it('converts the lease timestamps to ISO 8601', () => {
    const leases = parseDhcpBindings(BINDINGS_XML);
    expect(leases[0].expiresAt).toBe('2026-10-30T14:46:56Z');
    expect(leases[0].startedAt).toBe('2026-10-30T06:46:55Z');
  });

  it('skips bindings without an IP or MAC', () => {
    const xml = `
    <rpc-reply>
      <dhcp-binding>
        <allocated-address>10.1.201.11</allocated-address>
      </dhcp-binding>
    </rpc-reply>`;
    expect(parseDhcpBindings(xml)).toEqual([]);
  });
});

describe('parseDhcpBindingsText', () => {
  it('parses the SSH fallback output of "show dhcp server binding detail"', () => {
    const leases = parseDhcpBindingsText(BINDINGS_TEXT);

    expect(leases).toHaveLength(1);
    const lease = leases[0];
    expect(lease.ip).toBe('10.1.204.10');
    expect(lease.mac).toBe('00:50:79:66:68:09');
    expect(lease.state).toBe('BOUND');
    expect(lease.leaseExpires).toBe(28585);
    expect(lease.interface).toBe('irb.204');
    expect(lease.clientInterface).toBe('irb.204:xe-0/0/6.0');
    expect(lease.poolName).toBe('V204');
    expect(lease.sessionId).toBe('7');
  });

  it('returns an empty list when there are no bindings', () => {
    expect(parseDhcpBindingsText('Total number of leases: 0')).toEqual([]);
  });
});
