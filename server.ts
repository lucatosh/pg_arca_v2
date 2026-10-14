import express, { Request, Response } from 'express';
import path from 'path';
import http from 'http';
import https from 'https';
import fs from 'fs';
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
import { mountGeoRoutes } from './server/geo';
import { startGeoMonitor } from './server/geodr';
import { buildDemoCluster } from './server/demo';
import { makeAsyncSafe, asyncErrorHandler } from './server/asyncsafe';
import { APP_ROOT, APP_VERSION } from './server/version';

const app = express();
app.set('case sensitive routing', true);
if (process.env.PG_ARCA_TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.PG_ARCA_TRUST_PROXY) ? Number(process.env.PG_ARCA_TRUST_PROXY) : process.env.PG_ARCA_TRUST_PROXY);   // behind a reverse proxy: req.ip = the real client (login back-off, audit)   // defence in depth: the auth gate also lower-cases
process.on('unhandledRejection', (e: any) => console.error('[pg_arca] unhandled rejection (kept running):', e?.stack || e));
const PORT = parseInt(process.env.PORT || '3000', 10);
// Native TLS (PG_ARCA_TLS_CERT + PG_ARCA_TLS_KEY, PEM): the console serves https and wss directly; SIGHUP reloads the files (certificate renewal
// without a restart). Without them: plain http, meant for a reverse proxy that terminates TLS (then PG_ARCA_TRUST_PROXY and PG_ARCA_COOKIE_SECURE=1).
const TLS_CERT = process.env.PG_ARCA_TLS_CERT, TLS_KEY = process.env.PG_ARCA_TLS_KEY;
if (!!TLS_CERT !== !!TLS_KEY) { console.error('[pg_arca] PG_ARCA_TLS_CERT and PG_ARCA_TLS_KEY go together: set both or neither'); process.exit(2); }
const tlsFiles = () => ({ cert: fs.readFileSync(TLS_CERT!), key: fs.readFileSync(TLS_KEY!) });
const server = (TLS_CERT ? https.createServer({ ...tlsFiles(), minVersion: 'TLSv1.2' }, app) : http.createServer(app)) as unknown as http.Server;
if (TLS_CERT) process.on('SIGHUP', () => {
  try { (server as unknown as https.Server).setSecureContext(tlsFiles()); console.log('[pg_arca] TLS certificate reloaded'); }
  catch (e: any) { console.error('[pg_arca] TLS certificate NOT reloaded (the previous one stays in use):', e?.message || e); }
});
const LISTEN = process.env.PG_ARCA_LISTEN || '0.0.0.0';

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
// Diagnostics: requests that take long and event-loop stalls are logged with what was in flight (an agent heartbeat that times out
// is otherwise invisible on the console side). Long-poll heartbeats are expected to last up to their wait_seconds.
const inflight = new Map<number, { m: string; u: string; t: number }>(); let reqSeq = 0;
app.use((req, res, next) => {
  const id = ++reqSeq; const t = Date.now(); inflight.set(id, { m: req.method, u: req.path, t });
  res.on('close', () => { inflight.delete(id); const ms = Date.now() - t; const limit = req.path === '/api/agent/heartbeat' ? 25_000 : 5_000;
    if (ms > limit) console.warn(`[slow] ${req.method} ${req.path} ${ms} ms (status ${res.statusCode})`); });
  next();
});
{ let last = Date.now(); setInterval(() => { const now = Date.now(); const lag = now - last - 500; last = now;
  if (lag > 2000) console.warn(`[stall] event loop blocked ~${lag} ms; in flight: ${[...inflight.values()].slice(0, 8).map(r => `${r.m} ${r.u} (${now - r.t} ms)`).join(', ') || 'none'}`); }, 500).unref(); }
app.use(express.json({ limit: '4mb' }));
makeAsyncSafe(app);          // an async route that throws answers 500 instead of hanging the request
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
mountGeoRoutes(app, store);
app.get('/api/briefing', (_req: any, res: any) => res.json(briefing(store.peek())));
mountLogRoutes(app);
mountNetscanRoutes(app);

app.post('/api/selftest', async (_req: Request, res: Response) => {
  const tests = await runSelfTest();
  res.json({ status: tests.every(t => t.ok) ? 'passed' : 'failed', timestamp: new Date().toISOString(), tests });
});

// Agent bundle served by the console itself: `curl .../agent/install.sh | bash` needs no other infrastructure.
app.get('/agent/install.sh', (_req: Request, res: Response) => res.type('text/x-shellscript').sendFile(path.join(APP_ROOT, 'unix-agent', 'install-agent.sh')));
app.get('/agent/pg-arca-agent.tar.gz', (_req: Request, res: Response) => {
  res.type('application/gzip');
  const tar = spawn('tar', ['czf', '-', '-C', path.join(APP_ROOT, 'unix-agent'), '--exclude=__pycache__', '--exclude=tests', '.']);
  tar.stdout.pipe(res); tar.on('error', () => res.destroy());
});
app.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true, time: new Date().toISOString(), version: APP_VERSION, stateSnapshot: store.lastSnapshot()?.at || null }));
// the console protects its own state: a compressed snapshot every day (and one shortly after every start), the newest 14 kept in <data>/snapshots/
const SNAPSHOT_MS = 24 * 3600_000;
const snap = () => store.snapshot(14).catch(e => console.error('[pg_arca] state snapshot failed:', e?.message || e));
setTimeout(snap, 60_000).unref?.(); setInterval(snap, SNAPSHOT_MS).unref?.();
app.use('/api', asyncErrorHandler);

bootstrapAdminFromEnv(store);
initSetupCode(store);
seedDemoOnFirstRun(store, buildDemoCluster).catch(e => console.error('[pg_arca] demo seed failed', e));
direct.startPolling();
startScheduler(store);
startGeoMonitor(store);
startNotifier(store);

// Static / Vite
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(APP_ROOT, 'dist')));
  app.get('*', (_req: Request, res: Response) => res.sendFile(path.join(APP_ROOT, 'dist', 'index.html')));
} else {
  import('vite').then(async ({ createServer }) => {
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  });
}

// a clean stop writes what is still only in memory (telemetry is written lazily, within seconds)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { store.flush().catch(() => undefined).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });

server.listen(PORT, LISTEN, () => {
  console.log(`[pg_arca] Console ${APP_VERSION} on ${TLS_CERT ? 'https' : 'http'}://${LISTEN.includes(':') ? `[${LISTEN}]` : LISTEN}:${PORT} (live logs on /ws/logs)`);
});
