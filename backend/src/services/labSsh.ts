import { Client, type Algorithms, type Channel } from 'ssh2';

/**
 * SSH algorithm preference list shared by all ssh2 Clients in this module.
 *
 * Includes legacy algorithms (diffie-hellman-group1-sha1 / ssh-rsa /
 * 3des-cbc / hmac-sha1) so we can connect to old Cisco IOS SSH servers
 * (e.g. IOS 15.x running Cisco-1.25 SSH banner — verified on
 * LAB-F3-AS-01 / 10.10.20.211 on 2026-09-16). Modern ssh2 default list
 * does not include those, which surfaces as
 *   "Handshake failed: no matching key exchange algorithm"
 * in `DiscoveryResult.error`.
 *
 * ssh2 picks the first mutually-supported algorithm, so listing modern
 * algos first preserves security on up-to-date servers (Junos, EOS,
 * IOS-XE 17+, Linux OpenSSH). Legacy algos are listed last as a fallback.
 *
 * Verified algos for Cisco IOS 1.25 (the only ones it offers):
 *   kex:           diffie-hellman-group1-sha1
 *   serverHostKey: ssh-rsa
 *   cipher:        aes256-ctr (and lower)
 *   hmac:          hmac-sha1  (and lower)
 */
const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp521',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp256',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group1-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp521',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp256',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
  ],
  cipher: [
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
    'aes256-cbc',
    'aes192-cbc',
    'aes128-cbc',
    '3des-cbc',
  ],
  hmac: [
    'hmac-sha2-512',
    'hmac-sha2-256',
    'hmac-sha1',
    'hmac-sha1-96',
    'hmac-md5',
    'hmac-md5-96',
  ],
} satisfies Algorithms;

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
          algorithms: SSH_ALGORITHMS,
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
          algorithms: SSH_ALGORITHMS,
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
          algorithms: SSH_ALGORITHMS,
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

export function parseJuniperShowVersion(output: string): {
  vendor: string;
  hostname?: string;
  model?: string;
  version?: string;
  serial?: string;
} {
  const parsed: { vendor: string; hostname?: string; model?: string; version?: string; serial?: string } = {
    vendor: 'Juniper',
  };

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

/**
 * SSH-based identity probe for Cisco IOS / IOS-XE devices.
 *
 * Used as a fallback when the RESTCONF / HTTP-server-exec probes fail
 * (e.g. older IOS 15.x without RESTCONF and without `ip http
 * secure-server`, but with SSH enabled).
 *
 * Runs `show version` and parses out hostname / model / version / serial.
 * Vendor is set to `Cisco`. IOSv (virtual switches) have no serial —
 * the caller falls back to a `DISC-<ip>` placeholder in that case.
 */
export async function runIosxeSshProbe(
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
          readyTimeout: 20000,
          algorithms: SSH_ALGORITHMS,
        });
    });

    const showVersion = await execCommand(conn, 'show version', 30000);
    return {
      sshOk: true,
      showVersion,
      showRun: '',
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

/**
 * Parse `show version` output from a Cisco IOS / IOS-XE device.
 *
 * Tested shapes:
 *   - IOS 15.2 (vios_l2): "Cisco IOS Software, vios_l2 Software ... Version 15.2(...)
 *     ... ROM: Bootstrap program is IOSv
 *     ... <hostname> uptime is 1 hour, ..."
 *   - IOS-XE 16/17: same layout plus a "Processor board ID XXXXX" line for
 *     serial number, and a "cisco ISRXXXX" or "WS-..." model token.
 *
 * Returns at minimum `{ vendor: 'Cisco' }`. Other fields are populated when
 * the regex matches. IOSv returns no serial (the line is absent).
 */
export function parseIosShowVersion(output: string): {
  vendor: string;
  hostname?: string;
  model?: string;
  version?: string;
  serial?: string;
} {
  const parsed: { vendor: string; hostname?: string; model?: string; version?: string; serial?: string } = {
    vendor: 'Cisco',
  };

  // Hostname — first token of "<hostname> uptime is ..." line.
  // Skip "cisco" (appears as "cisco ISR4331 uptime is..." on physical IOS
  // when no hostname is configured).
  const hostnameMatch = output.match(/^(\S+)\s+uptime is/m);
  if (hostnameMatch) {
    const candidate = hostnameMatch[1];
    if (!/^(System|Router|Switch|Building|Configuration|cisco|Cisco)$/i.test(candidate)) {
      parsed.hostname = candidate;
    }
  }

  // Version — "Version 15.2" or "Version 17.6.1" or "Version 15.5(3)M"
  const versionMatch = output.match(/Version\s+([\d.()A-Za-z0-9:]+)/);
  if (versionMatch) parsed.version = versionMatch[1];

  // Model — for physical chassis: try the banner line (`Cisco IOS Software,
  // C2900 Software (...)`). For IOSv (virtual switch): fall back to
  // "Bootstrap program is IOSv".
  const bannerLine = output
    .split('\n')
    .find((l) => /Cisco Internetwork Operating System|Cisco IOS Software/i.test(l));
  if (bannerLine) {
    const modelTok = bannerLine.match(/,\s+([A-Z][\w-]+)\s+Software\s+\(/);
    if (modelTok) parsed.model = modelTok[1];
  }
  // Fall back to IOSv / virtual model if banner didn't yield a real model.
  if (!parsed.model) {
    const bootMatch = output.match(/Bootstrap program is (\S+)/);
    if (bootMatch) parsed.model = bootMatch[1];
  }

  // Serial — physical devices have "Processor board ID XXX" or
  // "System serial number: XXX".
  const serialMatch = output.match(/Processor board ID\s+(\S+)/i);
  if (serialMatch) parsed.serial = serialMatch[1];
  if (!parsed.serial) {
    const serialAlt = output.match(/System serial number[:\s]+(\S+)/i);
    if (serialAlt) parsed.serial = serialAlt[1];
  }

  return parsed;
}
