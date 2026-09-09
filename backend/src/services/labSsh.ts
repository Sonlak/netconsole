import { Client, type Channel } from 'ssh2';

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

/**
 * Apply a list of IOS CLI commands to a Cisco IOS-XE device via SSH.
 *
 * Designed for the Config Studio `apply_config` flow: worker can't reach
 * lab IOS-XE on port 22 (broken pipe), so it asks the backend container
 * (which can) to push the commands.
 *
 * Strategy: open an interactive shell, send `configure terminal`, then each
 * command line-by-line with the prompt pattern as a barrier, then `end`.
 * Each command's output is captured individually; if any line starts with
 * "% " (IOS error marker) we abort immediately.
 *
 * Returns one of:
 *   { ok: true,  commandCount, outputs }
 *   { ok: false, error, partialOutputs? }
 */
export type IosxeSshApplyOptions = {
  username: string;
  password: string;
  port?: number;
  commands: string[];
  promptTimeoutMs?: number;
  overallTimeoutMs?: number;
};

export type IosxeSshApplyResult = {
  ok: boolean;
  commandCount?: number;
  outputs?: Array<{ command: string; output: string; error?: string }>;
  error?: string;
};

function readUntilPrompt(
  stream: Channel,
  regex: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for prompt /^[${regex.source.slice(1)}/`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
      if (regex.test(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SSH channel closed before prompt matched'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

export async function runIosxeSshApply(
  host: string,
  options: IosxeSshApplyOptions,
): Promise<IosxeSshApplyResult> {
  const port = options.port ?? 22;
  const promptTimeoutMs = options.promptTimeoutMs ?? 8000;
  const overallTimeoutMs = options.overallTimeoutMs ?? 90_000;

  const conn = new Client();
  const outputs: Array<{ command: string; output: string; error?: string }> = [];

  // IOS prompts end in '#' (privileged exec) or '(config)#' / '(config-if)#'
  // after `configure terminal` and sub-commands. The router hostname prefix
  // is variable so we match any `<word>(...)#` tail.
  const promptRe = /\r?\n[^\r\n]*[#>]\s*$/;

  let overallTimer: NodeJS.Timeout | null = null;

  try {
    overallTimer = setTimeout(() => {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
    }, overallTimeoutMs);

    await new Promise<void>((resolve, reject) => {
      conn
        .on('ready', () => resolve())
        .on('error', reject)
        .connect({
          host,
          port,
          username: options.username,
          password: options.password,
          readyTimeout: 15000,
        });
    });

    const stream = await new Promise<Channel>((resolve, reject) => {
      conn.shell((err, s) => {
        if (err) {
          reject(err);
        } else {
          resolve(s);
        }
      });
    });

    // Wait for initial prompt
    await readUntilPrompt(stream, promptRe, promptTimeoutMs * 2);

    // Disable paging so long output doesn't hang the channel. `terminal
    // length 0` is the IOS-XE equivalent of Junos `set cli screen-length 0`.
    stream.write('terminal length 0\r\n');
    await readUntilPrompt(stream, promptRe, promptTimeoutMs);

    // Enter config mode
    stream.write('configure terminal\r\n');
    await readUntilPrompt(stream, promptRe, promptTimeoutMs);

    // Send each command, wait for prompt, capture output
    for (const cmd of options.commands) {
      const trimmed = cmd.trim();
      if (!trimmed || trimmed.startsWith('!')) continue; // skip blanks and IOS comments

      stream.write(`${trimmed}\r\n`);
      const raw = await readUntilPrompt(stream, promptRe, promptTimeoutMs);

      // Pull just the chunk between the echo and the trailing prompt.
      // IOS echoes the command back, then prints the result.
      const lines = raw.split(/\r?\n/);
      // Drop first line (echo of the command) and last line (prompt itself)
      const body = lines.slice(1, lines.length >= 2 ? -1 : undefined).join('\n').trim();
      const isError = body.startsWith('% ') || /% Invalid input detected/i.test(body);
      outputs.push({
        command: trimmed,
        output: body,
        ...(isError ? { error: body } : {}),
      });
      if (isError) {
        // Best-effort: leave config mode cleanly so the device isn't half-mutated.
        stream.write('end\r\n');
        await readUntilPrompt(stream, promptRe, promptTimeoutMs).catch(() => undefined);
        return {
          ok: false,
          error: `IOS-XE rejected command "${trimmed}": ${body}`,
          outputs,
        };
      }
    }

    // Exit config mode cleanly
    stream.write('end\r\n');
    await readUntilPrompt(stream, promptRe, promptTimeoutMs).catch(() => undefined);

    return { ok: true, commandCount: outputs.length, outputs };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'SSH apply failed',
      outputs,
    };
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
    try {
      conn.end();
    } catch {
      /* ignore */
    }
  }
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
