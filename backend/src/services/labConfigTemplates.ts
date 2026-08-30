export type ConfigRole = 'core' | 'dist' | 'access';

export type ConfigTemplateMeta = {
  id: ConfigRole;
  label: string;
  description: string;
};

export const CONFIG_TEMPLATES: ConfigTemplateMeta[] = [
  {
    id: 'core',
    label: 'Core (L3)',
    description: 'Loopback, OSPF Area 0 + Area 10, /30 xuống Distribution',
  },
  {
    id: 'dist',
    label: 'Distribution (L2/L3)',
    description: 'SVI VLAN 201–203 (tầng 1–3), VRRP .254, DHCP relay → Kea, OSPF Area 10, RSTP',
  },
  {
    id: 'access',
    label: 'Access switch',
    description: 'Dual-home trunk lên 2 DS, access VLAN 201/202/203 cho VPC',
  },
];

type DeviceLike = {
  name: string;
  ip: string;
  model?: string | null;
};

function header(device: DeviceLike, role: ConfigRole): string {
  return [
    `## NetConsole lab template: ${role}`,
    `## device ${device.name}  mgmt ${device.ip}`,
    `## Save on tool first. Commit pushes to device.`,
    `set system host-name ${device.name}`,
    'set system services ssh',
    'set system services netconf ssh',
    'set system login user admin class super-user',
    'set system login user admin authentication encrypted-password "$1$lab$AdminHash"',
    'set system root-authentication encrypted-password "$1$lab$RootHash"',
  ].join('\n');
}

function coreTemplate(device: DeviceLike): string {
  const isC1 = /core-01|core_01|c1$/i.test(device.name) || device.ip.endsWith('.11');
  const lo = isC1 ? '1.1.1.1' : '1.1.1.2';
  const peer = isC1 ? '10.10.10.1/30' : '10.10.10.2/30';
  const toDs1 = isC1 ? '10.10.20.1/30' : '10.10.20.17/30';
  const toDs2 = isC1 ? '10.10.20.9/30' : '10.10.20.25/30';
  const rid = lo;
  const peerDesc = isC1 ? 'to SW-CORE-02 OSPF A0' : 'to SW-CORE-01 OSPF A0';

  return `${header(device, 'core')}
set interfaces lo0 description "router-id"
set interfaces lo0 unit 0 family inet address ${lo}/32
set interfaces ge-0/0/0 description "mgmt lab-net"
set interfaces ge-0/0/0 unit 0 family inet address ${device.ip}/24
set interfaces ge-0/0/1 description "${peerDesc}"
set interfaces ge-0/0/1 unit 0 family inet address ${peer}
set interfaces ge-0/0/2 description "to SW-DS-01 OSPF A10"
set interfaces ge-0/0/2 unit 0 family inet address ${toDs1}
set interfaces ge-0/0/3 description "to SW-DS-02 OSPF A10"
set interfaces ge-0/0/3 unit 0 family inet address ${toDs2}
set routing-options router-id ${rid}
set protocols ospf area 0.0.0.0 interface lo0.0 passive
set protocols ospf area 0.0.0.0 interface ge-0/0/1.0
set protocols ospf area 0.0.0.10 interface ge-0/0/2.0
set protocols ospf area 0.0.0.10 interface ge-0/0/3.0
set protocols lldp interface all
`;
}

function distTemplate(device: DeviceLike): string {
  const isDs1 = /ds-01|ds_01|dist-01/i.test(device.name);
  const lo = isDs1 ? '2.2.2.1' : '2.2.2.2';
  const toC1 = isDs1 ? '192.168.1.2/30' : '192.168.1.14/30';
  const toC2 = isDs1 ? '192.168.1.9/30' : '192.168.1.6/30';
  const oct = isDs1 ? '252' : '253';
  const prio = isDs1 ? '200' : '100';
  const rstp = isDs1 ? '4k' : '8k';
  const role = isDs1 ? 'MASTER' : 'BACKUP';
  const kea = '10.10.20.20';

  const svi = (vlan: number, floor: number) => {
    const ip = `10.1.${vlan}.${oct}`;
    const vip = `10.1.${vlan}.254`;
    return [
      `set vlans VLAN${vlan} vlan-id ${vlan}`,
      `set vlans VLAN${vlan} description "TANG-0${floor}"`,
      `set vlans VLAN${vlan} l3-interface irb.${vlan}`,
      `set interfaces irb unit ${vlan} description "TANG-0${floor} SVI ${role}"`,
      `set interfaces irb unit ${vlan} family inet address ${ip}/24 vrrp-group ${vlan} virtual-address ${vip}`,
      `set interfaces irb unit ${vlan} family inet address ${ip}/24 vrrp-group ${vlan} priority ${prio}`,
      `set interfaces irb unit ${vlan} family inet address ${ip}/24 vrrp-group ${vlan} preempt`,
      `set interfaces irb unit ${vlan} family inet address ${ip}/24 vrrp-group ${vlan} accept-data`,
      `set forwarding-options helpers bootp interface irb.${vlan}`,
    ].join('\n');
  };

  return `## ${device.name} (${device.ip}) — Distribution ${role}
## Keep mgmt: vlan mgmt / irb.10 / ge-0/0/9 — do not delete.
## Client VLAN 201/202/203 = Tang 1/2/3. GW VIP .254. DHCP relay ${kea}

set interfaces lo0 unit 0 family inet address ${lo}/32
set routing-options router-id ${lo}

delete interfaces ge-0/0/3 unit 0 family ethernet-switching
delete interfaces ge-0/0/4 unit 0 family ethernet-switching
set interfaces ge-0/0/3 description "L3_TO_CORE-01"
set interfaces ge-0/0/3 unit 0 family inet address ${toC1}
set interfaces ge-0/0/4 description "L3_TO_CORE-02"
set interfaces ge-0/0/4 unit 0 family inet address ${toC2}

set interfaces ge-0/0/0 description "TRUNK_PEER_DS"
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members all
set interfaces ge-0/0/1 description "TRUNK_TO_F1-AS"
set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members all
set interfaces ge-0/0/2 description "TRUNK_TO_F2-AS"
set interfaces ge-0/0/2 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members all
set interfaces ge-0/0/5 description "TRUNK_TO_F3-AS"
set interfaces ge-0/0/5 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members all

${svi(201, 1)}
${svi(202, 2)}
${svi(203, 3)}

set forwarding-options helpers bootp description "DHCP relay to Kea"
set forwarding-options helpers bootp server ${kea}
set forwarding-options helpers bootp relay-agent-option

set protocols ospf area 0.0.0.10 interface lo0.0 passive
set protocols ospf area 0.0.0.10 interface irb.201 passive
set protocols ospf area 0.0.0.10 interface irb.202 passive
set protocols ospf area 0.0.0.10 interface irb.203 passive
set protocols ospf area 0.0.0.10 interface ge-0/0/3.0 interface-type p2p
set protocols ospf area 0.0.0.10 interface ge-0/0/4.0 interface-type p2p
set protocols rstp bridge-priority ${rstp}
set protocols rstp interface all
set protocols lldp interface all
`;
}

function accessTemplate(device: DeviceLike): string {
  const isAs1 = /as-01|as_01|access-01/i.test(device.name) || device.ip.endsWith('.15');
  const pcNote = isAs1
    ? 'VPC5 vlan201 / VPC6 vlan202 / VPC9 vlan203'
    : 'VPC10 vlan201 / VPC11 vlan202 / VPC12 vlan203';

  return `${header(device, 'access')}
set interfaces me0 description "mgmt lab-net"
set interfaces me0 unit 0 family inet address ${device.ip}/24
set interfaces ge-0/0/0 description "uplink-to-SW-DS-01 trunk"
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members all
set interfaces ge-0/0/1 description "uplink-to-SW-DS-02 trunk"
set interfaces ge-0/0/1 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members all
set interfaces ge-0/0/2 description "${pcNote.split(' / ')[0]}"
set interfaces ge-0/0/2 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members VLAN201
set interfaces ge-0/0/3 description "${pcNote.split(' / ')[1]}"
set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members VLAN202
set interfaces ge-0/0/4 description "${pcNote.split(' / ')[2]}"
set interfaces ge-0/0/4 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/4 unit 0 family ethernet-switching vlan members VLAN203
set vlans VLAN201 vlan-id 201
set vlans VLAN202 vlan-id 202
set vlans VLAN203 vlan-id 203
set protocols rstp interface all
set protocols lldp interface all
`;
}

export function renderConfigTemplate(role: ConfigRole, device: DeviceLike): string {
  switch (role) {
    case 'core':
      return coreTemplate(device);
    case 'dist':
      return distTemplate(device);
    case 'access':
      return accessTemplate(device);
    default:
      return header(device, 'core');
  }
}

export function suggestRole(device: DeviceLike): ConfigRole {
  const hay = `${device.name} ${device.ip}`.toLowerCase();
  if (hay.includes('core') || hay.endsWith('.11') || hay.endsWith('.12')) {
    return 'core';
  }
  if (hay.includes('ds-') || hay.includes('dist') || hay.endsWith('.13') || hay.endsWith('.14')) {
    return 'dist';
  }
  return 'access';
}
