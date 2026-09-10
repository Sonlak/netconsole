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

    // Build a script that sends every command then exits config mode.
    // Key insight: IOS-XE sub-blocks (e.g. `vlan 990` then `  name FOO`)
    // require NO prompt-barrier between parent and child. The device stays in
    // sub-config mode until it sees a line that ends the block (e.g. `exit`,
    // a new top-level command, or `end`). So we send the entire script as
    // one batch with embedded newlines, then wait for the final # prompt.
    //
    // Lines that are pure noise (empty, IOS comments "! ...") are skipped.
    const ios_commands = options.commands
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && !c.startsWith('!'));

    if (ios_commands.length === 0) {
      stream.write('end\r\n');
      await readUntilPrompt(stream, promptRe, promptTimeoutMs).catch(() => undefined);
      return { ok: true, commandCount: 0, outputs: [] };
    }

    const script = ios_commands.join('\n') + '\n';
    stream.write(script);
    // Wait long enough for the whole script to be absorbed. Long configs with
    // interface shutdowns can take 5-10 s on IOS-XE; cap at promptTimeoutMs * 4.
    const absorbTime = Math.min(promptTimeoutMs * 4, 30_000);
    let raw: string;
    try {
      raw = await readUntilPrompt(stream, promptRe, absorbTime);
    } catch {
      // If the device is slow (e.g. spanning-tree recalc) the prompt may come
      // late. Do one more read attempt before declaring failure.
      try {
        raw = await readUntilPrompt(stream, promptRe, promptTimeoutMs * 2);
      } catch {
        raw = '';
      }
    }

    // Parse the output: each line of the raw buffer is either an echo of the
    // command, an IOS result/error line, or a prompt.  We reconstruct
    // per-command output by splitting on the echoed command lines.
    const all_lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // The last line should be the prompt; everything before it is command
    // echoes + results.  The echoes start with the first command string.
    let cur_cmd = '';
    let cur_body: string[] = [];

    for (const line of all_lines) {
      // If this line exactly matches one of our commands it is an echo (prompt
      // is excluded because prompt has trailing # not in commands).
      if (ios_commands.includes(line.trim())) {
        // Flush previous command
        if (cur_cmd) {
          const body_text = cur_body.join('\n').trim();
          const is_error =
            body_text.startsWith('% ') || /% Invalid input detected/i.test(body_text);
          outputs.push({
            command: cur_cmd,
            output: body_text,
            ...(is_error ? { error: body_text } : {}),
          });
          if (is_error) {
            // Abort: end config mode and report.
            stream.write('end\r\n');
            await readUntilPrompt(stream, promptRe, promptTimeoutMs).catch(() => undefined);
            return {
              ok: false,
              error: `IOS-XE rejected "${cur_cmd}": ${body_text}`,
              outputs,
            };
          }
        }
        cur_cmd = line.trim();
        cur_body = [];
      } else if (cur_cmd) {
        cur_body.push(line);
      }
    }
    // Flush last command
    if (cur_cmd) {
      const body_text = cur_body.join('\n').trim();
      const is_error =
        body_text.startsWith('% ') || /% Invalid input detected/i.test(body_text);
      outputs.push({
        command: cur_cmd,
        output: body_text,
        ...(is_error ? { error: body_text } : {}),
      });
      if (is_error) {
        stream.write('end\r\n');
        await readUntilPrompt(stream, promptRe, promptTimeoutMs).catch(() => undefined);
        return { ok: false, error: `IOS-XE rejected "${cur_cmd}": ${body_text}`, outputs };
      }
    }

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

export type IosxeSshCommandResult = {
  ok: boolean;
  output: string;
  error?: string;
};

export async function runIosxeSshCommand(
  host: string,
  command: string,
  options?: {
    port?: number;
    username?: string;
    password?: string;
    timeoutMs?: number;
  },
): Promise<IosxeSshCommandResult> {
  const port = options?.port ?? 22;
  const username = options?.username ?? process.env.LAB_SSH_USER ?? 'admin';
  const password = options?.password ?? process.env.LAB_SSH_PASSWORD ?? 'Admin@123';
  const timeoutMs = options?.timeoutMs ?? 20000;

  const conn = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      conn
        .on('ready', () => resolve())
        .on('error', reject)
        .connect({
          host,
          port,
          username,
          password,
          readyTimeout: 15000,
        });
    });
    const output = await execCommand(conn, command, timeoutMs);
    return { ok: true, output };
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : 'SSH command failed',
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
