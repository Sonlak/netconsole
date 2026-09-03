import cors from 'cors';
import express from 'express';
import { devicesRouter } from './routes/devices.js';
import { discoveryRouter } from './routes/discovery.js';
import { jobsRouter } from './routes/jobs.js';
import { arpAddressesRouter } from './routes/arpAddresses.js';
import { dhcpRouter } from './routes/dhcp.js';
import { interfacesRouter } from './routes/interfaces.js';
import { macAddressesRouter } from './routes/macAddresses.js';
import { scheduleDevicePing } from './services/devicePing.js';
import { scheduleArpCollection } from './services/arpAddress.js';
import { scheduleMacCollection } from './services/macAddress.js';
import { scheduleInterfacesCollection } from './services/interfaces.js';
import { scheduleConfigCollection } from './services/deviceTabCollection.js';
import { scheduleLogsCollection } from './services/logs.js';
import { scheduleJobWatchdog } from './services/jobWatchdog.js';
import { startLogRetentionCleanup } from './services/logRetention.js';
import { startSyslogReceiver, stopSyslogReceiver } from './services/syslogReceiver.js';
import { generateConfigRouter } from './routes/generateConfig.js';
import { fabricRouter } from './routes/fabric.js';
import { logsRouter } from './routes/logs.js';
import { authRouter } from './routes/auth.js';
import { authMiddleware } from './middleware/auth.js';
import { strictRateLimit, moderateRateLimit, authRateLimit, scanRateLimit } from './middleware/rateLimit.js';

// CORS whitelist - chỉ cho phép domain được cấp phép
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) {
      callback(null, true);
      return;
    }
    if (CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

const app = express();
const port = Number(process.env.PORT) || 3000;
const pingIntervalSeconds = Number(process.env.PING_INTERVAL_SECONDS) || 60;
const macCollectIntervalSeconds = Number(process.env.MAC_COLLECT_INTERVAL_SECONDS) || 120;
const arpCollectIntervalSeconds = Number(process.env.ARP_COLLECT_INTERVAL_SECONDS) || 120;
const interfacesCollectIntervalSeconds =
  Number(process.env.INTERFACES_COLLECT_INTERVAL_SECONDS) || 120;
const configCollectIntervalSeconds = Number(process.env.CONFIG_COLLECT_INTERVAL_SECONDS) || 300;
const logsCollectIntervalSeconds = Number(process.env.LOGS_COLLECT_INTERVAL_SECONDS) || 0;
const syslogUdpPort = Number(process.env.SYSLOG_UDP_PORT) || 1514;
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS) || 30;

// Graceful shutdown support
let isShuttingDown = false;
const httpServer = app.listen(port, () => {
  console.log(`NetConsole API running on http://localhost:${port}`);

  // UDP syslog receiver (no-auth, trusted LAN — always starts if port > 0)
  if (syslogUdpPort > 0) {
    try {
      const { port: boundPort } = startSyslogReceiver({ port: syslogUdpPort, address: '0.0.0.0' });
      console.log(`Syslog UDP receiver bound to :${boundPort}`);
    } catch (error) {
      console.error('[syslog] failed to bind:', error);
    }
  }

  // Log retention cleanup
  if (logRetentionDays > 0) {
    startLogRetentionCleanup(logRetentionDays);
    console.log(`Log retention cleanup enabled (keep ${logRetentionDays} days)`);
  }

  scheduleDevicePing(pingIntervalSeconds);
  console.log(`Ping monitor enabled (every ${pingIntervalSeconds}s)`);
  scheduleMacCollection(macCollectIntervalSeconds);
  console.log(`MAC auto-collect enabled (every ${macCollectIntervalSeconds}s)`);
  scheduleArpCollection(arpCollectIntervalSeconds);
  console.log(`ARP auto-collect enabled (every ${arpCollectIntervalSeconds}s)`);
  scheduleInterfacesCollection(interfacesCollectIntervalSeconds);
  console.log(`Ports auto-collect enabled (every ${interfacesCollectIntervalSeconds}s)`);
  scheduleConfigCollection(configCollectIntervalSeconds);
  console.log(`Config auto-collect enabled (every ${configCollectIntervalSeconds}s)`);
  if (logsCollectIntervalSeconds > 0) {
    scheduleLogsCollection(logsCollectIntervalSeconds);
    console.log(`Logs auto-collect enabled (every ${logsCollectIntervalSeconds}s)`);
  } else {
    console.log('Logs auto-collect disabled (set LOGS_COLLECT_INTERVAL_SECONDS to enable)');
  }
  scheduleJobWatchdog(30);
  console.log('Job watchdog enabled (reclaim stale RUNNING every 30s)');
  console.log(`CORS allowed origins: ${CORS_ORIGINS.join(', ')}`);
});

// CORS - phải đặt trước routes
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// Health check - không cần auth
app.get('/api/health', (_req, res) => {
  if (isShuttingDown) {
    res.status(503).json({ status: 'shutting_down', service: 'netconsole-api' });
    return;
  }
  res.json({
    status: 'ok',
    service: 'netconsole-api',
    modules: [
      'devices',
      'jobs',
      'device-operations',
      'ping-monitor',
      'discovery',
      'mac-addresses',
      'arp-addresses',
      'interfaces',
      'fabric',
      'dhcp',
      'generate-config',
      'logs',
      'auth',
    ],
    pingIntervalSeconds,
    macCollectIntervalSeconds,
    arpCollectIntervalSeconds,
    interfacesCollectIntervalSeconds,
    configCollectIntervalSeconds,
    logsCollectIntervalSeconds,
    logRetentionDays,
    syslogUdpPort,
    keaApiUrl: process.env.KEA_API_URL || null,
  });
});

// Auth routes - không cần auth để login/register
app.use('/api/auth', authRateLimit, authRouter);

// Protected API routes - tất cả cần auth
app.use('/api/devices', authMiddleware, strictRateLimit, devicesRouter);
app.use('/api/discovery', authMiddleware, scanRateLimit, discoveryRouter);
app.use('/api/mac-addresses', authMiddleware, moderateRateLimit, macAddressesRouter);
app.use('/api/arp-addresses', authMiddleware, moderateRateLimit, arpAddressesRouter);
app.use('/api/interfaces', authMiddleware, moderateRateLimit, interfacesRouter);
app.use('/api/fabric', authMiddleware, moderateRateLimit, fabricRouter);
app.use('/api/dhcp', authMiddleware, strictRateLimit, dhcpRouter);
app.use('/api/config', authMiddleware, strictRateLimit, generateConfigRouter);
app.use('/api/logs', authMiddleware, strictRateLimit, logsRouter);
app.use('/api/jobs', authMiddleware, moderateRateLimit, jobsRouter);

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  isShuttingDown = true;

  // Stop accepting new connections
  httpServer.close(async () => {
    console.log('HTTP server closed');

    // Close UDP syslog receiver
    try {
      await stopSyslogReceiver();
      console.log('Syslog UDP receiver closed');
    } catch (error) {
      console.error('[shutdown] syslog receiver error:', error);
    }

    // Close database connection
    try {
      const { prisma } = await import('./lib/prisma.js');
      await prisma.$disconnect();
      console.log('Database connection closed');
    } catch (error) {
      console.error('Error disconnecting from database:', error);
    }
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Error handler for CORS
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err.message.includes('CORS')) {
    res.status(403).json({ error: 'CORS not allowed' });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app };
