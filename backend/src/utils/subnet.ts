const IP4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function isValidOctets(ip: string): boolean {
  return ip.split('.').every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function expandCidr(cidr: string, maxHosts = 1024): string[] {
  const trimmed = cidr.trim();
  const [networkPart, prefixPart] = trimmed.split('/');

  if (!networkPart || !prefixPart || !IP4_PATTERN.test(networkPart) || !isValidOctets(networkPart)) {
    throw new Error('Invalid subnet format. Use e.g. 10.20.1.0/24');
  }

  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30) {
    throw new Error('Subnet prefix must be between /16 and /30');
  }

  const hostBits = 32 - prefix;
  const totalHosts = 2 ** hostBits - 2;
  if (totalHosts > maxHosts) {
    throw new Error(`Subnet too large (${totalHosts} hosts). Max allowed: ${maxHosts}`);
  }

  const networkInt = ipToInt(networkPart) & (~0 << hostBits);
  const ips: string[] = [];

  for (let i = 1; i <= totalHosts; i += 1) {
    ips.push(intToIp(networkInt + i));
  }

  return ips;
}

export function normalizeCidr(cidr: string): string {
  const ips = expandCidr(cidr, 1024);
  if (ips.length === 0) {
    throw new Error('Subnet has no usable host addresses');
  }

  const [networkPart, prefixPart] = cidr.trim().split('/');
  return `${networkPart}/${prefixPart}`;
}
