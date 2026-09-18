/**
 * WebSocket Terminal Handler
 *
 * Provides a web-based SSH terminal to network devices.
 * Sessions are logged for compliance.
 *
 * Credentials are resolved server-side from environment variables
 * (LAB_SSH_USER / LAB_SSH_PASSWORD), matching the worker config.
 *
 * Protocol:
 *   Client -> Server:
 *     { type: 'connect', deviceIp: string }    // auto-auth via env vars
 *     { type: 'input', data: string }          // keystrokes
 *     { type: 'resize', cols: number, rows: number }
 *     { type: 'disconnect' }
 *
 *   Server -> Client:
 *     { type: 'ready' }                        // connection established
 *     { type: 'data', data: string }           // terminal output
 *     { type: 'error', message: string }
 *     { type: 'closed' }
 */

import { WebSocket, WebSocketServer } from 'ws';
import { Server } from 'http';
import { Client as SSH2Client, ConnectConfig } from 'ssh2';
import { prisma } from '../lib/prisma.js';
import type { Request } from 'express';

const TIMEOUT_MS = 180000; // 3 minutes idle timeout
const SHELL_OPEN_TIMEOUT_MS = parseInt(
  process.env.SHELL_OPEN_TIMEOUT_MS || '15000',
  10,
);
// Per-user and global limits protect the backend container from runaway
// terminals (and from a sync-throw bug in ssh2 that crashed the whole
// process when a device dropped the SSH connection mid-handshake — see
// session log 2026-09-18). Both are env-overridable so prod can tune
// up without a code change.
const MAX_TERMINALS_PER_USER = parseInt(
  process.env.MAX_TERMINALS_PER_USER || '5',
  10,
);
const MAX_TERMINALS_GLOBAL = parseInt(
  process.env.MAX_TERMINALS_GLOBAL || '30',
  10,
);

// Tracks active SSH terminal sessions across all WebSocket connections
// so we can enforce the per-user and global caps. Map is keyed by
// userId and decremented on every disconnect/cleanup.
const activeTerminalsByUser = new Map<string, number>();
let activeTerminalsGlobal = 0;

function acquireTerminalSlot(userId: string): { ok: true } | { ok: false; reason: string } {
  const perUser = activeTerminalsByUser.get(userId) || 0;
  if (perUser >= MAX_TERMINALS_PER_USER) {
    return {
      ok: false,
      reason: `Too many active terminals for this user (max ${MAX_TERMINALS_PER_USER}). Close one before opening another.`,
    };
  }
  if (activeTerminalsGlobal >= MAX_TERMINALS_GLOBAL) {
    return {
      ok: false,
      reason: `Server is at capacity (${activeTerminalsGlobal}/${MAX_TERMINALS_GLOBAL} active terminals). Try again in a moment.`,
    };
  }
  activeTerminalsByUser.set(userId, perUser + 1);
  activeTerminalsGlobal++;
  return { ok: true };
}

function releaseTerminalSlot(userId: string): void {
  const perUser = activeTerminalsByUser.get(userId) || 0;
  if (perUser <= 1) {
    activeTerminalsByUser.delete(userId);
  } else {
    activeTerminalsByUser.set(userId, perUser - 1);
  }
  if (activeTerminalsGlobal > 0) activeTerminalsGlobal--;
}

// Safety net: ssh2 sometimes throws synchronously from
// Client.shell()/connect() when the underlying socket is torn down
// mid-handshake (verified 2026-09-18: backend crashed twice in 3 min
// when a lab device dropped SSH right after banner). Without these
// handlers a single bad device takes the whole API down. We log
// loudly but do NOT exit — each per-session handler is responsible
// for closing its own WebSocket.
process.on('uncaughtException', (err: Error) => {
  console.error('[uncaughtException] survived:', err?.message || err);
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[unhandledRejection] survived:', msg);
});

interface ClientMessage {
  type: 'connect' | 'input' | 'resize' | 'disconnect';
  deviceIp?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

// Extended WebSocket with our custom properties
interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  username?: string;
  role?: string;
  sessionId?: string;
  deviceIp?: string;
  idleTimer?: NodeJS.Timeout;
  _ssh?: SSH2Client;
  _stream?: unknown;
  _released?: boolean; // marks terminal-slot released, prevents double-release
}

// Send helper — casts to any to satisfy TS strict mode on ws types
const send = (ws: AuthenticatedWebSocket, msg: object) => ws.send(JSON.stringify(msg));
const close = (ws: AuthenticatedWebSocket) => ws.close();

export function startTerminalWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request: Request, socket, head) => {
    // Only handle /ws/terminal path
    if (request.url?.startsWith('/ws/terminal')) {
      // Authenticate via JWT from query param
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      try {
        // Quick JWT verification (reuse auth logic)
        const decoded = await verifyToken(token);
        if (!decoded) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws: AuthenticatedWebSocket) => {
          ws.userId = decoded.userId;
          ws.username = decoded.username;
          ws.role = decoded.role;
          wss.emit('connection', ws, request);
        });
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    }
  });

  wss.on('connection', async (ws: AuthenticatedWebSocket) => {
    console.log(`[terminal] WebSocket connected: user=${ws.username}`);

    let currentSessionId: string | null = null;

    const cleanup = () => {
      if (ws.idleTimer) clearTimeout(ws.idleTimer);
      if (ws._ssh) {
        try { (ws._ssh as SSH2Client).end(); } catch { /* ignore */ }
      }
      // Free the terminal slot so the next session can be opened.
      // Guard with sessionId so we only release once per connect —
      // disconnect/disconnect-from-server both call cleanup.
      if (ws.sessionId && !ws._released) {
        ws._released = true;
        releaseTerminalSlot(ws.userId!);
      }
    };

    const resetIdleTimer = () => {
      if (ws.idleTimer) clearTimeout(ws.idleTimer);
      ws.idleTimer = setTimeout(() => {
        send(ws, { type: 'error', message: 'Session timed out' });
        close(ws);
      }, TIMEOUT_MS);
    };

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      resetIdleTimer();

      switch (msg.type) {
        case 'connect': {
          if (!msg.deviceIp) {
            send(ws, { type: 'error', message: 'Missing deviceIp' });
            return;
          }

          // Enforce per-user and global session caps before we open any
          // SSH socket. Without this, a single admin opening many tabs
          // could exhaust the container's ephemeral ports / FDs / memory.
          const slot = acquireTerminalSlot(ws.userId!);
          if (!slot.ok) {
            send(ws, { type: 'error', message: slot.reason });
            close(ws);
            return;
          }

          // Resolve credentials from environment (same as worker uses)
          const sshUser = process.env.LAB_SSH_USER || 'admin';
          const sshPass = process.env.LAB_SSH_PASSWORD || 'Admin@123';

          // Look up device in DB to get deviceId and deviceName for the session record
          const device = await prisma.device.findUnique({
            where: { ip: msg.deviceIp },
            select: { id: true, name: true },
          }).catch(() => null);

          // Create session record
          const session = await prisma.terminalSession.create({
            data: {
              userId: ws.userId!,
              deviceId: device?.id ?? null,
              deviceIp: msg.deviceIp,
              deviceName: device?.name ?? null,
              startTime: new Date(),
            },
          });
          currentSessionId = session.id;
          ws.sessionId = session.id;
          ws.deviceIp = msg.deviceIp;

          console.log(`[terminal] Session ${session.id}: connecting to ${msg.deviceIp} as ${sshUser}`);

          const sshConfig: ConnectConfig = {
            host: msg.deviceIp,
            username: sshUser,
            password: sshPass,
            // Use both keyboard-interactive (for Juniper) and password (for Cisco)
            tryKeyboard: true,
            readyTimeout: 30000,
            keepaliveInterval: 30000,
            // Enable legacy KEX/HMAC/cipher algorithms so the terminal works
            // against old IOS / IOSv images (15.x) that only support
            // diffie-hellman-group1-sha1, hmac-sha1, and aes*-cbc. Modern
            // Juniper/Arista/NX-OS pick the newer algorithms first — these
            // are just fallbacks for old peers. Verified 2026-09-16 against
            // LAB-F3-AS-01 (10.10.20.211, IOS 15.2 vios_l2) which had been
            // failing with "Incompatible ssh peer (no acceptable kex algorithm)"
            // before this change. See gotcha #4 / 16 in docs.
            algorithms: {
              kex: [
                'ecdh-sha2-nistp521',
                'ecdh-sha2-nistp384',
                'ecdh-sha2-nistp256',
                'diffie-hellman-group-exchange-sha256',
                'diffie-hellman-group14-sha256',
                'diffie-hellman-group14-sha1',
                'diffie-hellman-group1-sha1',  // legacy IOS 12.x / 15.x
              ],
              cipher: [
                'aes128-ctr',
                'aes192-ctr',
                'aes256-ctr',
                'aes128-cbc',
                'aes192-cbc',
                'aes256-cbc',
                '3des-cbc',  // very old IOS
              ],
              hmac: [
                'hmac-sha2-512',
                'hmac-sha2-256',
                'hmac-sha1',  // legacy IOS
                'hmac-sha1-96',
                'hmac-md5',   // very old IOS
              ],
            },
          };

          const ssh = new SSH2Client();
          ws._ssh = ssh;

          // Watchdog: if the shell channel never opens within the
          // timeout (e.g. device accepted SSH then hung), kill the
          // connection instead of letting the session leak forever.
          let shellOpened = false;
          const shellOpenTimer = setTimeout(() => {
            if (shellOpened) return;
            console.error(`[terminal] Session ${session.id}: shell open timed out after ${SHELL_OPEN_TIMEOUT_MS}ms`);
            send(ws, { type: 'error', message: 'Shell open timed out' });
            try { ssh.end(); } catch { /* ignore */ }
            close(ws);
          }, SHELL_OPEN_TIMEOUT_MS);

          // Handle keyboard-interactive auth (used by Juniper/cRPD for password prompts)
          // Some devices send multiple prompts - handle them all
          ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
            console.log(`[terminal] Session ${session.id}: keyboard-interactive (name=${name}, prompts=${prompts.length})`);
            // Answer each prompt with the password
            const answers = prompts.map(() => sshPass);
            finish(answers);
          });

          ssh.on('ready', () => {
            console.log(`[terminal] Session ${session.id}: SSH connected, opening shell immediately`);
            send(ws, { type: 'ready' });

            // Try with PTY first, then retry without PTY if it fails.
            // CRITICAL: ssh.shell() can THROW SYNCHRONOUSLY (not via
            // the callback) when the underlying client has already
            // closed — verified 2026-09-18: a lab device dropped SSH
            // right after the banner, ssh.shell() threw `Not connected`
            // from inside Client.shell(), and the whole backend Node
            // process died (uncaughtException). Wrap in try-catch and
            // fall through to the error path so the WebSocket closes
            // cleanly instead of crashing the API.
            const tryOpenShell = (termType: string, withPty: boolean) => {
              const options: Record<string, unknown> = { term: termType, cols: 80, rows: 24 };
              if (withPty) {
                options.modes = {};
              }
              console.log(`[terminal] Session ${session.id}: opening shell (pty=${withPty}, term=${termType})`);
              let invokedCallback = false;
              try {
                ssh.shell(options, (err, stream) => {
                  invokedCallback = true;
                  clearTimeout(shellOpenTimer);
                  if (err) {
                    console.error(`[terminal] Session ${session.id}: shell (pty=${withPty}) error:`, err.message);
                    // If PTY failed, try without PTY
                    if (withPty) {
                      console.log(`[terminal] Session ${session.id}: retrying without PTY`);
                      tryOpenShell(termType, false);
                      return;
                    }
                    send(ws, { type: 'error', message: `Shell error: ${err.message}` });
                    close(ws);
                    return;
                  }
                  console.log(`[terminal] Session ${session.id}: shell opened`);
                  shellOpened = true;

                stream.on('data', (data: Buffer) => {
                  const text = data.toString();
                  console.log(`[terminal] Session ${session.id}: shell data len=${text.length} preview=${JSON.stringify(text.substring(0, 80))}`);
                  send(ws, { type: 'data', data: text });
                });

                stream.stderr.on('data', (data: Buffer) => {
                  send(ws, { type: 'data', data: data.toString() });
                });

                stream.on('close', () => {
                  console.log(`[terminal] Session ${session.id}: stream closed`);
                  close(ws);
                });

                ws._stream = stream;
                });
              } catch (syncErr: unknown) {
                if (invokedCallback) {
                  // The error already went through the callback path.
                  return;
                }
                const msg = syncErr instanceof Error ? syncErr.message : String(syncErr);
                console.error(`[terminal] Session ${session.id}: shell() threw synchronously: ${msg}`);
                clearTimeout(shellOpenTimer);
                // Same recovery logic as the callback's error path:
                // try without PTY once, then give up.
                if (withPty) {
                  console.log(`[terminal] Session ${session.id}: retrying without PTY (sync throw)`);
                    try {
                      tryOpenShell(termType, false);
                    } catch {
                      send(ws, { type: 'error', message: `Shell error: ${msg}` });
                      close(ws);
                    }
                    return;
                }
                send(ws, { type: 'error', message: `Shell error: ${msg}` });
                close(ws);
              }
            };
            tryOpenShell('xterm-256color', true);
          });

          ssh.on('error', async (err) => {
            console.error(`[terminal] Session ${session.id}: SSH error:`, err.message);
            // Provide more helpful error messages
            let userMessage = err.message;
            if (err.message.includes('authentication')) {
              userMessage = 'Authentication failed. Check SSH credentials in environment variables.';
            } else if (err.message.includes('ECONNREFUSED')) {
              userMessage = 'Connection refused. SSH may not be enabled on this device or port 22 is blocked.';
            } else if (err.message.includes('ETIMEDOUT') || err.message.includes('timed out')) {
              userMessage = 'Connection timed out. Check device IP address and network connectivity.';
            } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
              userMessage = 'DNS resolution failed. Check device IP address.';
            }
            send(ws, { type: 'error', message: userMessage });

            // Update session with error
            if (currentSessionId) {
              await prisma.terminalSession.update({
                where: { id: currentSessionId },
                data: { endTime: new Date(), error: err.message },
              }).catch(console.error);
            }
          });

          ssh.on('close', () => {
            console.log(`[terminal] Session ${session.id}: SSH closed unexpectedly`);
            clearTimeout(shellOpenTimer);
            send(ws, { type: 'closed' });
          });

          // ssh.connect() can also throw synchronously on bad config
          // or a DNS failure — wrap defensively.
          try {
            ssh.connect(sshConfig);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[terminal] Session ${session.id}: ssh.connect() threw: ${msg}`);
            clearTimeout(shellOpenTimer);
            send(ws, { type: 'error', message: `SSH connect failed: ${msg}` });
            close(ws);
          }
          break;
        }

        case 'input': {
          if (!ws._stream) {
            send(ws, { type: 'error', message: 'Not connected' });
            return;
          }
          (ws._stream as NodeJS.WritableStream & { write: (d: string) => void }).write(msg.data || '');
          break;
        }

        case 'resize': {
          if (!ws._stream) return;
          const stream = ws._stream as { setWindow?: (r: number, c: number, w: number, h: number) => void };
          if (stream.setWindow) {
            stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
          }
          break;
        }

        case 'disconnect': {
          cleanup();
          close(ws);
          break;
        }

        default:
          send(ws, { type: 'error', message: 'Unknown message type' });
      }
    });

    ws.on('close', async () => {
      console.log(`[terminal] WebSocket closed: user=${ws.username}, session=${ws.sessionId}`);
      cleanup();

      // End session in DB
      if (currentSessionId) {
        await prisma.terminalSession.update({
          where: { id: currentSessionId },
          data: { endTime: new Date() },
        }).catch(console.error);
      }
    });

    ws.on('error', (err) => {
      console.error(`[terminal] WebSocket error:`, err.message);
    });
  });

  return wss;
}

// Simple JWT verification (same logic as auth middleware)
async function verifyToken(token: string): Promise<{ userId: string; username: string; role: string } | null> {
  const jwt = await import('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'netconsole-dev-secret';
  try {
    const decoded = jwt.default.verify(token, secret) as any;
    return { userId: decoded.userId, username: decoded.username, role: decoded.role };
  } catch {
    return null;
  }
}
