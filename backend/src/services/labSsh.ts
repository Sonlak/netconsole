import { Client } from 'ssh2';

export type LabSshResult = {
  sshOk: boolean;
  showVersion: string;
  showRun: string;
  error?: string;
};

function execCommand(
  conn: Client,
  command: string,
  timeoutMs = 15000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SSH command timeout: ${command}`)), timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      let output = '';
      stream
        .on('close', () => {
          clearTimeout(timer);
          resolve(output);
        })
        .on('data', (data: Buffer) => {
          output += data.toString('utf8');
        })
        .stderr.on('data', (data: Buffer) => {
          output += data.toString('utf8');
        });
    });
  });
}

export async function runLabSshProbe(
  host: string,
  options: {
    username: string;
    password: string;
    port?: number;
  },
): Promise<LabSshResult> {
  const conn = new Client();

  try {
    await new Promise<void>((resolve, reject) => {
      conn
        .on('ready', () => resolve())
        .on('error', reject)
        .connect({
          host,
          port: options.port ?? 22,
          username: options.username,
          password: options.password,
          readyTimeout: 15000,
        });
    });

    const showVersion = await execCommand(conn, 'show version');
    const showRun = await execCommand(conn, 'show configuration | display set');

    return {
      sshOk: true,
      showVersion,
      showRun,
    };
  } catch (error) {
    return {
      sshOk: false,
      showVersion: '',
      showRun: '',
      error: error instanceof Error ? error.message : 'SSH probe failed',
    };
  } finally {
    conn.end();
  }
}

export function parseJuniperShowVersion(output: string) {
  const parsed: Record<string, string> = { vendor: 'Juniper' };

  const hostname = output.match(/^Hostname:\s*(\S+)/m)?.[1];
  const model = output.match(/^Model:\s*(\S+)/m)?.[1];
  const version = output.match(/JUNOS Software Release \[([^\]]+)\]/)?.[1];
  const serial = output.match(/Serial number:\s*(\S+)/i)?.[1];

  if (hostname) parsed.hostname = hostname;
  if (model) parsed.model = model;
  if (version) parsed.version = version;
  if (serial) parsed.serial = serial;

  return parsed;
}
