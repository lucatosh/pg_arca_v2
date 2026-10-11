import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

import { Store, loadSecretKey } from './server/store';
import { DirectDriver } from './server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from './server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from './server/clusters';
import { startScheduler } from './server/scheduler';
import { mountPlatformRoutes } from './server/platform';
import { mountPolicyRoutes } from './server/policies';
import { mountScopedRoutes } from './server/scoped';
import { mountDestinationRoutes } from './server/destinations';
import { mountHbaRoutes } from './server/hba';
import { mountNotifyRoutes, startNotifier } from './server/notify';
import { briefing } from './server/health';
import { mountAdvancedRoutes } from './server/approvals';
import { mountJoinRoutes } from './server/join';
import { audit as auditLog, setResultsDir } from './server/ops';
import { mountAuthRoutes, requireAdmin, bootstrapAdminFromEnv, initSetupCode } from './server/auth';
import { runSelfTest } from './server/selftest';
import { attachLogSocket, broadcastLiveLog, mountLogRoutes } from './server/logs';
import { mountNetscanRoutes } from './server/netscan';
import { mountWorkerRoutes } from './server/workers';
import { buildDemoCluster } from './server/demo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('case sensitive routing', true);
if (process.env.PG_ARCA_TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.PG_ARCA_TRUST_PROXY) ? Number(process.env.PG_ARCA_TRUST_PROXY) : process.env.PG_ARCA_TRUST_PROXY);   // behind a reverse proxy: req.ip = the real client (login back-off, audit)   // defence in depth: the auth gate also lower-cases
process.on('unhandledRejection', (e: any) => console.error('[pg_arca] unhandled rejection (kept running):', e?.stack || e));
const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);

const DATA_DIR = process.env.PG_ARCA_DATA_DIR || path.join(process.cwd(), 'data');
const store = new Store(DATA_DIR);
setResultsDir(path.join(DATA_DIR, 'results'));          // large operation results live next to the state, not inside it
const direct = new DirectDriver(store, loadSecretKey(DATA_DIR));

// Same-origin console: no open CORS. Basic hardening headers.
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    // everything the console loads comes from itself; inline style ATTRIBUTES are used by React components (widths of bars), inline scripts never
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (_req.secure || process.env.PG_ARCA_COOKIE_SECURE === '1') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use(requireAdmin(store));
attachLogSocket(server);

// Everything below is real: persisted, authenticated, idempotent (see server/*.ts).
mountAuthRoutes(app, store);
mountAgentRoutes(app, store, {
  onLogs: (node, clusterName, logs) => {
    for (const l of logs) {
      broadcastLiveLog({
        timestamp: String(l.timestamp || new Date().toISOString()), clusterId: node.clusterId || '', clusterName, nodeName: node.name, nodeHost: node.remoteIp || '',
        service: ['patroni', 'postgres', 'wal_archiver', 'agent', 'etcd'].includes(l.service) ? l.service : 'agent',
        level: ['INFO', 'WARN', 'ERROR', 'FATAL', 'DEBUG'].includes(l.level) ? l.level : 'INFO',
        message: String(l.message || '').slice(0, 2000), raw: String(l.raw || l.message || '').slice(0, 4000),
      });
    }
  },
});
mountOperatorRoutes(app, store, { directExec: direct.exec });
mountClusterRoutes(app, store, direct, buildDemoCluster);
mountPlatformRoutes(app, store);
mountPolicyRoutes(app, store);
mountScopedRoutes(app, store);
mountDestinationRoutes(app, store);
mountHbaRoutes(app, store);
mountNotifyRoutes(app, store);
mountAdvancedRoutes(app, store, auditLog);
mountJoinRoutes(app, store);
mountWorkerRoutes(app, store);
app.get('/api/briefing', (_req: any, res: any) => res.json(briefing(store.peek())));
mountLogRoutes(app);
mountNetscanRoutes(app);

app.post('/api/selftest', async (_req: Request, res: Response) => {
  const tests = await runSelfTest();
  res.json({ status: tests.every(t => t.ok) ? 'passed' : 'failed', timestamp: new Date().toISOString(), tests });
});

// Agent bundle served by the console itself: `curl .../agent/install.sh | bash` needs no other infrastructure.
app.get('/agent/install.sh', (_req: Request, res: Response) => res.type('text/x-shellscript').sendFile(path.join(__dirname, 'unix-agent', 'install-agent.sh')));
app.get('/agent/pg-arca-agent.tar.gz', (_req: Request, res: Response) => {
  res.type('application/gzip');
  const tar = spawn('tar', ['czf', '-', '-C', path.join(__dirname, 'unix-agent'), '--exclude=__pycache__', '--exclude=tests', '.']);
  tar.stdout.pipe(res); tar.on('error', () => res.destroy());
});
app.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true, time: new Date().toISOString() }));

bootstrapAdminFromEnv(store);
initSetupCode(store);
seedDemoOnFirstRun(store, buildDemoCluster).catch(e => console.error('[pg_arca] demo seed failed', e));
direct.startPolling();
startScheduler(store);
startNotifier(store);

// Static / Vite
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req: Request, res: Response) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
} else {
  import('vite').then(async ({ createServer }) => {
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  });
}

// a clean stop writes what is still only in memory (telemetry is written lazily, within seconds)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { store.flush().catch(() => undefined).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pg_arca] Console on http://0.0.0.0:${PORT} (live logs on /ws/logs)`);
});
