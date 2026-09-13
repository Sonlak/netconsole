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

const TIMEOUT_MS = 60000; // 1 minute idle timeout

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
            tryKeyboard: true,
            readyTimeout: 20000,
            keepaliveInterval: 10000,
          };

          const ssh = new SSH2Client();
          ws._ssh = ssh;

          // Handle keyboard-interactive auth (used by Juniper/cRPD for password prompts)
          ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
            finish([sshPass]);
          });

          ssh.on('ready', () => {
            console.log(`[terminal] Session ${session.id}: SSH connected, opening shell`);
            send(ws, { type: 'ready' });

            // Update session with device name from SSH
            ssh.exec('show system uptime | match hostname', (err, stream) => {
              if (err) return;
              stream.on('data', (data: Buffer) => {
                const match = data.toString().match(/hostname\s+(.+)/);
                if (match) {
                  prisma.terminalSession.update({
                    where: { id: session.id },
                    data: { hostname: match[1].trim() },
                  }).catch(console.error);
                }
              });
            });

            ssh.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
              if (err) {
                console.error(`[terminal] Session ${session.id}: shell error:`, err.message);
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
          });

          ssh.on('error', async (err) => {
            console.error(`[terminal] Session ${session.id}: SSH error:`, err.message);
            send(ws, { type: 'error', message: err.message });

            // Update session with error
            if (currentSessionId) {
              await prisma.terminalSession.update({
                where: { id: currentSessionId },
                data: { endTime: new Date(), error: err.message },
              }).catch(console.error);
            }
          });

          ssh.on('close', () => {
            console.log(`[terminal] Session ${session.id}: SSH closed`);
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
