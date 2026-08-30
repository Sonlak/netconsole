import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

export type PingResult = {
  ip: string;
  alive: boolean;
  latencyMs: number | null;
};

export function isValidIp(ip: string): boolean {
  if (!IP_PATTERN.test(ip)) {
    return false;
  }

  return ip.split('.').every((part) => {
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

export async function pingHost(ip: string, timeoutMs = 3000): Promise<PingResult> {
  if (!isValidIp(ip)) {
    throw new Error(`Invalid IP address: ${ip}`);
  }

  const isWindows = process.platform === 'win32';
  const args = isWindows
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ip];

  try {
    const { stdout } = await execFileAsync('ping', args, {
      timeout: timeoutMs + 2000,
      windowsHide: true,
    });

    const output = stdout.toString();
    const alive =
      /ttl=/i.test(output) ||
      /bytes from/i.test(output) ||
      /reply from/i.test(output);

    const latencyMatch = output.match(/time[<=](\d+(?:\.\d+)?)\s*ms/i);
    const latencyMs = latencyMatch ? Math.round(Number(latencyMatch[1])) : alive ? 0 : null;

    return { ip, alive, latencyMs };
  } catch {
    return { ip, alive: false, latencyMs: null };
  }
}
