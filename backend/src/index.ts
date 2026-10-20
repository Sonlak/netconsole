import cors from 'cors';
import compression from 'compression';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { devicesRouter } from './routes/devices.js';
import { registerDeviceOperationRoutes } from './routes/deviceOperations.js';
import { devicePingRouter } from './routes/devicePing.js';
import { discoveryRouter } from './routes/discovery.js';
import { jobsRouter } from './routes/jobs.js';
import { arpAddressesRouter } from './routes/arpAddresses.js';
import { dhcpRouter } from './routes/dhcp.js';
import { interfacesRouter } from './routes/interfaces.js';
import { macAddressesRouter } from './routes/macAddresses.js';
import { scheduleDevicePing } from './services/devicePing.js';
import { scheduleManagedCheck } from './services/managedCheck.js';
import { scheduleArpCollection } from './services/arpAddress.js';
import { scheduleMacCollection } from './services/macAddress.js';
import { scheduleInterfacesCollection } from './services/interfaces.js';
import { scheduleConfigCollection } from './services/deviceTabCollection.js';
import { scheduleLogsCollection } from './services/logs.js';
import { scheduleJobWatchdog } from './services/jobWatchdog.js';
import { scheduleInterfaceCounterPoll, interfaceCounterConfig, interfaceCounterFeatureEnabled } from './services/interfaceCounters.js';
import { startLogRetentionCleanup } from './services/logRetention.js';
import { startJobRetentionCleanup } from './services/jobRetention.js';
import { startSyslogReceiver, stopSyslogReceiver } from './services/syslogReceiver.js';
import { scheduleNetboxSync } from './services/netboxSync.js';
import { startKeccFailbackScheduler, stopKeaFailbackScheduler } from './services/keaFailback.js';
import { configCompareRouter } from './routes/configCompare.js';
import { generateConfigRouter } from './routes/generateConfig.js';
import { templatesRouter } from './routes/templates.js';
import { fabricRouter } from './routes/fabric.js';
import { logsRouter } from './routes/logs.js';
import { netboxRouter } from './routes/netbox.js';
import { authRouter } from './routes/auth.js';
import { totpRouter } from './routes/totp.js';
import { auditLogRouter } from './routes/auditLog.js';
import { searchRouter } from './routes/search.js';
import { terminalRouter } from './routes/terminal.js';
import { interfaceCountersRouter } from './routes/interfaceCounters.js';
import { assistantRouter } from './routes/assistant.js';
import { startTerminalWebSocket } from './websocket/terminal.js';
import { authMiddleware } from './middleware/auth.js';
import { auditLogMiddleware } from './middleware/auditLog.js';
import { strictRateLimit, moderateRateLimit, scanRateLimit } from './middleware/rateLimit.js';

// CORS whitelist - chỉ cho phép domain được cấp phép. SECURITY (H12,
// see docs/agents/16-security-audit-preprod.md): production compose
// must override CORS_ORIGINS via secrets.env to strip dev origins
// (localhost:5173 etc.). Default below is `*` only to avoid breaking
// local development; the helper probes for the literal `*` token and
// refuses it when NODE_ENV === 'production'.
function parseCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS || 'http://localhost:5173';
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && (parts.includes('*') || parts.length === 0)) {
    throw new Error(
      'CORS_ORIGINS must be an explicit allowlist in production (no "*", no empty). ' +
      'Set it in secrets.env to the prod origin(s). See docs/agents/16-security-audit-preprod.md (H12, H13).',
    );
  }
  return parts;
}
const CORS_ORIGINS = parseCorsOrigins();
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // SECURITY (H13): require an Origin header for all CORS-eligible
    // requests (i.e. anything not a same-origin browser fetch). curl /
    // server-to-server callers can still hit us by setting `Origin: null`
    // explicitly; we treat that as "machine" and allow it ONLY for the
    // non-mutating health endpoint and the auth login endpoint.
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  // SECURITY (H13): 1 hour aligns with the access JWT TTL.
  maxAge: 3600,
};

const app = express();
const port = Number(process.env.PORT) || 3000;
const pingIntervalSeconds = Number(process.env.PING_INTERVAL_SECONDS) || 60;
const managedCheckIntervalSeconds = Number(process.env.MANAGED_CHECK_INTERVAL_SECONDS) || 300;
const macCollectIntervalSeconds = Number(process.env.MAC_COLLECT_INTERVAL_SECONDS) || 900;
const arpCollectIntervalSeconds = Number(process.env.ARP_COLLECT_INTERVAL_SECONDS) || 900;
const interfacesCollectIntervalSeconds =
  Number(process.env.INTERFACES_COLLECT_INTERVAL_SECONDS) || 900;
const configCollectIntervalSeconds = Number(process.env.CONFIG_COLLECT_INTERVAL_SECONDS) || 900;
const logsCollectIntervalSeconds = Number(process.env.LOGS_COLLECT_INTERVAL_SECONDS) || 0;
const syslogUdpPort = Number(process.env.SYSLOG_UDP_PORT) || 1514;
const logRetentionDays = Number(process.env.LOG_RETENTION_DAYS) || 30;
const jobRetentionDays = Number(process.env.JOB_RETENTION_DAYS) || 30;
// NetBox periodic sync. 0 = disabled (default for stacks that haven't
// configured a NetBox instance yet). 300s = 5 min matches the other
// collect intervals; tune lower for small fleets or higher for very
// large ones (the worker's per-job timeout will catch stuck syncs).
const netboxSyncIntervalSeconds = Number(process.env.NETBOX_SYNC_INTERVAL_SECONDS) || 0;

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

  // Job retention cleanup — prerequisite for Tier-B 5-minute collect intervals
  if (jobRetentionDays > 0) {
    startJobRetentionCleanup(jobRetentionDays);
    console.log(`Job retention cleanup enabled (keep ${jobRetentionDays} days, terminal rows only)`);
  }

  scheduleDevicePing(pingIntervalSeconds);
  console.log(`Ping monitor enabled (every ${pingIntervalSeconds}s)`);
  scheduleManagedCheck(managedCheckIntervalSeconds);
  console.log(`Managed check enabled (every ${managedCheckIntervalSeconds}s)`);
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

  if (interfaceCounterFeatureEnabled()) {
    scheduleInterfaceCounterPoll(interfaceCounterConfig.pollIntervalSeconds);
    console.log(`Interface counter auto-poll enabled (every ${interfaceCounterConfig.pollIntervalSeconds}s, retain ${interfaceCounterConfig.retentionHours}h)`);
  } else {
    console.log('Interface counter auto-poll disabled (INTERFACE_COUNTERS_ENABLED=false)');
  }

  // NetBox periodic sync — only starts if NETBOX_SYNC_INTERVAL_SECONDS > 0.
  // The worker still has to have NETBOX_URL/NETBOX_TOKEN set, otherwise
  // the enqueued jobs will all fail with "NetBox sync is not configured".
  if (netboxSyncIntervalSeconds > 0) {
    scheduleNetboxSync({ intervalSeconds: netboxSyncIntervalSeconds });
    console.log(`NetBox sync scheduler enabled (every ${netboxSyncIntervalSeconds}s)`);
  } else {
    console.log('NetBox sync scheduler disabled (set NETBOX_SYNC_INTERVAL_SECONDS > 0 to enable)');
  }

  // Kea DC↔DR auto-failback scheduler. The scheduler is always started
  // (so the /api/dhcp/auto-failback status endpoint works) but only
  // ACTUALLY triggers switchovers when KEA_AUTO_FAILBACK=true AND the
  // runtime flag (toggleable via API) is also true. Both must be set
  // to avoid accidentally swapping primary during maintenance.
  startKeccFailbackScheduler();
  const keaFailbackWanted = process.env.KEA_AUTO_FAILBACK === 'true';
  console.log(
    `Kea auto-failback scheduler enabled (env flag: ${keaFailbackWanted ? 'on' : 'off (toggleable via API)'})`,
  );

  console.log(`CORS allowed origins: ${CORS_ORIGINS.join(', ')}`);

  // Start WebSocket terminal server
  startTerminalWebSocket(httpServer);
  console.log('WebSocket terminal server enabled at /ws/terminal');
});

// SECURITY: trust the first hop in front of the API container. The
// docker-compose prod stack has nginx on host port :8443 forwarding to
// this container on :3000. Without trust-proxy, req.ip returns the
// docker bridge IP (the same for every user), breaking per-IP rate
// limits and shipping bogus X-Forwarded-For values into the audit log.
//
// `1` means "trust the closest proxy" — exactly the nginx hop. If we
// later add another load balancer in front of nginx, bump this.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

// SECURITY (H10): helmet adds a stack of security headers that we were
// previously relying on nginx to set (and were not). With nginx as the
// public edge, the API still benefits from emitting the headers itself
// — defense-in-depth and CSP for clients that bypass nginx (e.g.
// backend's own workers).
//
// CSP: allow our own + the OpenAI API for the assistant endpoint.
// frame-ancestors 'none' is the X-Frame-Options modern equivalent and
// prevents clickjacking for the SPA.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // The SPA only makes same-origin /api/* calls. OpenAI proxy is
        // called server-side, but allow it in case a future revision
        // proxies via the browser.
        connectSrc: ["'self'", 'https://api.openai.com'],
        imgSrc: ["'self'", 'data:'],
        // Inline styles are required by AntD's runtime CSS-in-JS.
        // Disabling unsafe-inline breaks every AntD component.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // AntD does not run any user-supplied JS, so script-src stays
        // tight.
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // HSTS: 2 years, include subdomains. Production-only because HSTS
    // over HTTP would break local dev.
    strictTransportSecurity:
      process.env.NODE_ENV === 'production'
        ? { maxAge: 63072000, includeSubDomains: true, preload: false }
        : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false, // AntD + Vite need this off
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }),
);

// Compress all JSON/text responses (logs inventory is ~500KB without this).
app.use(compression({ threshold: 1024 }));

// SECURITY (H13): CORS runs BEFORE cookieParser so the Access-Control
// headers are present even on preflight requests. Must come before any
// route handler. Critical: `cors()` short-circuits OPTIONS preflight,
// so we never need a manual OPTIONS handler.
app.use(cors(corsOptions));

// SECURITY (H9): cap request bodies at 1 MB. The largest legitimate
// JSON we receive today is a config push (≤ 50 KB). 25 MB was set
// defensively for a one-off NetBox CSV import that has since moved to
// its own multipart endpoint — leaving 25 MB exposes a denial-of-
// service surface via JSON body fills.
app.use(express.json({ limit: '1mb' }));
// cookieParser: SECURITY (C13). We now serve `nc_refresh` as an
// HttpOnly + SameSite=Strict cookie. `signed: false` — the JWT is the
// integrity check; the cookie carries an opaque random secret.
app.use(cookieParser());

// Audit middleware: capture every mutating request, registered EARLY so it
// sees the original method/path even when auth rejects the request.
app.use(auditLogMiddleware);

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
      'interface-counters',
      'fabric',
      'dhcp',
      'generate-config',
      'logs',
      'auth',
      'audit-log',
      'terminal',
      'assistant',
      'netbox',
    ],
    pingIntervalSeconds,
    macCollectIntervalSeconds,
    arpCollectIntervalSeconds,
    interfacesCollectIntervalSeconds,
    configCollectIntervalSeconds,
    logsCollectIntervalSeconds,
    logRetentionDays,
    jobRetentionDays,
    syslogUdpPort,
    keaApiUrl: process.env.KEA_API_URL || null,
    keaStandbyApiUrl: process.env.KEA_STANDBY_API_URL || null,
    keaAutoFailback: process.env.KEA_AUTO_FAILBACK === 'true',
    netboxEnabled: netboxSyncIntervalSeconds > 0,
    netboxSyncIntervalSeconds: netboxSyncIntervalSeconds > 0 ? netboxSyncIntervalSeconds : null,
    // Read version from package.json (written at build time by docker-compose)
    version: process.env.NETCONSOLE_VERSION || null,
    gitCommit: process.env.NETCONSOLE_GIT_COMMIT || null,
  });
});

// Auth routes - không cần auth để login/register. NOTE (2026-10-20):
// the `authRateLimit` middleware is no longer applied GLOBALLY here —
// only to the credential-challenge endpoints inside `authRouter`
// (`POST /login` and `POST /mfa/verify`). Read-write endpoints like
// `/api/auth/me`, `/api/auth/refresh`, etc. are not credential
// challenges and were tripping when the frontend auto-re-logged-in
// after session drops. See `rateLimit.ts` for the new failuresOnly
// behaviour that lets successful logins NOT consume the budget.
app.use('/api/auth', authRouter);

// TOTP management — all endpoints require authentication.
// Mounted after authRouter so /api/auth/mfa/verify is handled there.
app.use('/api/totp', authMiddleware, totpRouter);

// Register per-device operation routes (config/arp/mac/connect) on the devices router
registerDeviceOperationRoutes(devicesRouter);

// Protected API routes - tất cả cần auth
app.use('/api/devices', authMiddleware, strictRateLimit, devicesRouter);
app.use('/api/ping', authMiddleware, strictRateLimit, devicePingRouter);
app.use('/api/discovery', authMiddleware, scanRateLimit, discoveryRouter);
app.use('/api/mac-addresses', authMiddleware, moderateRateLimit, macAddressesRouter);
app.use('/api/arp-addresses', authMiddleware, moderateRateLimit, arpAddressesRouter);
app.use('/api/interfaces', authMiddleware, moderateRateLimit, interfacesRouter);
app.use('/api/fabric', authMiddleware, moderateRateLimit, fabricRouter);
app.use('/api/dhcp', authMiddleware, strictRateLimit, dhcpRouter);
app.use('/api/config', authMiddleware, strictRateLimit, generateConfigRouter);
app.use('/api/config-snapshots', authMiddleware, strictRateLimit, configCompareRouter);
app.use('/api/templates', authMiddleware, strictRateLimit, templatesRouter);
app.use('/api/logs', authMiddleware, strictRateLimit, logsRouter);
app.use('/api/jobs', authMiddleware, moderateRateLimit, jobsRouter);
app.use('/api/audit-log', authMiddleware, strictRateLimit, auditLogRouter);
app.use('/api/search', authMiddleware, strictRateLimit, searchRouter);
app.use('/api/terminal', authMiddleware, strictRateLimit, terminalRouter);
app.use('/api/devices', authMiddleware, moderateRateLimit, interfaceCountersRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/netbox', authMiddleware, moderateRateLimit, netboxRouter);

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

    // Stop Kea failback scheduler (no in-flight action, just clear the interval)
    try {
      stopKeaFailbackScheduler();
      console.log('Kea failback scheduler stopped');
    } catch (error) {
      console.error('[shutdown] kea-failback scheduler error:', error);
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
