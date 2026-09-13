/**
 * WebSocket Terminal Handler
 *
 * Provides a web-based SSH terminal to network devices.
 * Sessions are logged for compliance.
 *
 * Protocol:
 *   Client -> Server:
 *     { type: 'connect', deviceIp: string, username: string, password: string }
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
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import type { Request } from 'express';

const TIMEOUT_MS = 60000; // 1 minute idle timeout

interface ClientMessage {
  type: 'connect' | 'input' | 'resize' | 'disconnect';
  deviceIp?: string;
  username?: string;
  password?: string;
  data?: string;
  cols?: number;
  rows?: number;
}

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  username?: string;
  role?: string;
  sessionId?: string;
  sshClient?: SSH2Client;
  deviceIp?: string;
  idleTimer?: NodeJS.Timeout;
}

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
      if (ws.sshClient) {
        try { ws.sshClient.end(); } catch { /* ignore */ }
      }
    };

    const resetIdleTimer = () => {
      if (ws.idleTimer) clearTimeout(ws.idleTimer);
      ws.idleTimer = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'error', message: 'Session timed out' }));
        ws.close();
      }, TIMEOUT_MS);
    };

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      resetIdleTimer();

      switch (msg.type) {
        case 'connect': {
          if (!msg.deviceIp || !msg.username || !msg.password) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing deviceIp, username, or password' }));
            return;
          }

          // Create session record
          const session = await prisma.terminalSession.create({
            data: {
              userId: ws.userId!,
              deviceIp: msg.deviceIp,
              startTime: new Date(),
            },
          });
          currentSessionId = session.id;
          ws.sessionId = session.id;
          ws.deviceIp = msg.deviceIp;

          console.log(`[terminal] Session ${session.id}: connecting to ${msg.deviceIp}`);

          const sshConfig: ConnectConfig = {
            host: msg.deviceIp,
            username: msg.username,
            password: msg.password,
            readyTimeout: 20000,
            keepaliveInterval: 10000,
          };

          const ssh = new SSH2Client();
          ws.sshClient = ssh;

          ssh.on('ready', () => {
            console.log(`[terminal] Session ${session.id}: SSH connected`);
            ws.send(JSON.stringify({ type: 'ready' }));

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
                ws.send(JSON.stringify({ type: 'error', message: `Shell error: ${err.message}` }));
                ws.close();
                return;
              }

              stream.on('data', (data: Buffer) => {
                ws.send(JSON.stringify({ type: 'data', data: data.toString() }));
              });

              stream.stderr.on('data', (data: Buffer) => {
                ws.send(JSON.stringify({ type: 'data', data: data.toString() }));
              });

              stream.on('close', () => {
                console.log(`[terminal] Session ${session.id}: stream closed`);
                ws.close();
              });

              // Store stream reference for input/resize
              (ws as any)._stream = stream;
            });
          });

          ssh.on('error', async (err) => {
            console.error(`[terminal] Session ${session.id}: SSH error:`, err.message);
            ws.send(JSON.stringify({ type: 'error', message: err.message }));

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
            ws.send(JSON.stringify({ type: 'closed' }));
          });

          ssh.connect(sshConfig);
          break;
        }

        case 'input': {
          if (!(ws as any)._stream) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not connected' }));
            return;
          }
          (ws as any)._stream.write(msg.data || '');
          break;
        }

        case 'resize': {
          if (!(ws as any)._stream) return;
          const stream = (ws as any)._stream;
          if (stream.setWindow) {
            stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
          }
          break;
        }

        case 'disconnect': {
          cleanup();
          ws.close();
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
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
