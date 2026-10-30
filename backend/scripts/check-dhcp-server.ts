/**
 * Manual check: does the backend read the DHCP pools + bindings from the
 * real DS1 switch? Run with: npx tsx scripts/check-dhcp-server.ts
 */
process.env.JUNOS_REST_ENABLED = process.env.JUNOS_REST_ENABLED ?? 'true';
process.env.JUNOS_REST_SCHEME = process.env.JUNOS_REST_SCHEME ?? 'http';
process.env.JUNOS_REST_PORT = process.env.JUNOS_REST_PORT ?? '8443';
process.env.JUNOS_REST_VERIFY_TLS = 'false';
process.env.JUNOS_REST_USER = process.env.JUNOS_REST_USER ?? 'admin';
process.env.JUNOS_REST_PASSWORD = process.env.JUNOS_REST_PASSWORD ?? 'Admin@123';
process.env.LAB_SSH_USER = process.env.LAB_SSH_USER ?? 'admin';
process.env.LAB_SSH_PASSWORD = process.env.LAB_SSH_PASSWORD ?? 'Admin@123';
process.env.DHCP_SERVER_HOST = process.env.DHCP_SERVER_HOST ?? 'LAB-F6-DS-01';

import { getDhcpDashboard, fetchDhcpLeases, dhcpServerHost } from '../src/services/junosDhcp.js';

const host = dhcpServerHost();
console.log('DHCP server host:', host);

const leases = await fetchDhcpLeases(host);
console.log('leases ok:', leases.ok, 'source:', leases.source, 'error:', leases.error ?? '-');
console.log('lease count:', leases.leases.length);
for (const lease of leases.leases.slice(0, 10)) {
  console.log(
    `  ${lease.ip}  ${lease.mac}  ${lease.state}  pool=${lease.poolName}  if=${lease.clientInterface}`,
  );
}

const dashboard = await getDhcpDashboard();
console.log('\nserver:', JSON.stringify(dashboard.server));
console.log('totals:', JSON.stringify(dashboard.totals));
for (const pool of dashboard.pools) {
  console.log(
    `  pool ${pool.poolName} vlan=${pool.vlan} ${pool.subnet} range=${pool.pool} gw=${pool.gateway} ` +
      `dns=${pool.dns.join(',')} leased=${pool.leased}/${pool.poolSize} (${pool.utilization}%) reserved=${pool.reserved} if=${pool.interface}`,
  );
}
