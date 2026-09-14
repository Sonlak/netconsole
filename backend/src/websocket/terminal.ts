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
          };

          const ssh = new SSH2Client();
          ws._ssh = ssh;

          // Handle keyboard-interactive auth (used by Juniper/cRPD for password prompts)
          ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
            finish([sshPass]);
          });

          ssh.on('ready', () => {
            console.log(`[terminal] Session ${session.id}: SSH connected`);
            send(ws, { type: 'ready' });

            // Try to get hostname - works for Juniper, silently fails for Cisco/IOS-XE
            ssh.exec('show system uptime | match hostname', (err, stream) => {
              if (err) {
                console.log(`[terminal] Session ${session.id}: hostname exec failed (non-fatal): ${err.message}`);
              } else {
                stream.on('data', (data: Buffer) => {
                  const match = data.toString().match(/hostname\s+(.+)/);
                  if (match) {
                    prisma.terminalSession.update({
                      where: { id: session.id },
                      data: { hostname: match[1].trim() },
                    }).catch(console.error);
                  }
                });
                // Drain stderr too to prevent hanging
                stream.stderr.on('data', () => {});
              }
            });

            // Delay shell open slightly to ensure connection is stable
            // Some devices (like Cisco IOS-XE) need time to be ready for shell channel
            setTimeout(() => {
              // Check if SSH is still connected
              if (!ws._ssh || (ws._ssh as SSH2Client)._state === undefined) {
                console.log(`[terminal] Session ${session.id}: SSH disconnected before shell open`);
                send(ws, { type: 'error', message: 'Connection closed before shell could be opened' });
                close(ws);
                return;
              }

              // Try with PTY first, then retry without PTY if it fails
              const tryOpenShell = (termType: string, withPty: boolean) => {
                const options: Record<string, unknown> = { term: termType, cols: 80, rows: 24 };
                if (withPty) {
                  options.modes = {};
                }
                console.log(`[terminal] Session ${session.id}: opening shell (pty=${withPty}, term=${termType})`);
                (ws._ssh as SSH2Client).shell(options, (err, stream) => {
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
              };
              tryOpenShell('xterm-256color', true);
            }, 2000); // 2 second delay
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
            send(ws, { type: 'closed' });
          });

          ssh.connect(sshConfig);
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
