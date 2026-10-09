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
import { mountAuthRoutes, requireAdmin, bootstrapAdminFromEnv } from './server/auth';
import { runSelfTest } from './server/selftest';
import { attachLogSocket, broadcastLiveLog, mountLogRoutes } from './server/logs';
import { mountNetscanRoutes } from './server/netscan';
import { buildDemoCluster } from './server/demo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);

const DATA_DIR = process.env.PG_ARCA_DATA_DIR || path.join(process.cwd(), 'data');
const store = new Store(DATA_DIR);
const direct = new DirectDriver(store, loadSecretKey(DATA_DIR));

// Same-origin console: no open CORS. Basic hardening headers.
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
seedDemoOnFirstRun(store, buildDemoCluster).catch(e => console.error('[pg_arca] demo seed failed', e));
direct.startPolling();
startScheduler(store);

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[pg_arca] Console on http://0.0.0.0:${PORT} (live logs on /ws/logs)`);
});
