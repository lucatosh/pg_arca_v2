// Real HTTP server around the real route modules (express replaced by the MiniApp shim) for agent<->console wire tests.
import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from '../server/mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountPlatformRoutes } from '../../server/platform';
import { mountAuthRoutes, requireAdmin } from '../../server/auth';
import { mountJoinRoutes } from '../../server/join';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const store = new Store(dir), app = new MiniApp(), direct = new DirectDriver(store, loadSecretKey(dir));
const demo = () => ({ id: 'cluster-demo', name: 'DEMO', environment: 'dev', isSandbox: true, databases: [], haState: { nodes: [] } });
app.use(requireAdmin(store));
mountAuthRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec });
mountClusterRoutes(app, store, direct, demo); mountPlatformRoutes(app, store); mountJoinRoutes(app, store);
seedDemoOnFirstRun(store, demo);
const srv = http.createServer((req, res) => {
  let data = ''; req.on('data', c => (data += c));
  req.on('end', async () => {
    const r = await app.call(req.method!, req.url!, { body: data ? JSON.parse(data) : undefined, headers: req.headers as any });
    const h: Record<string, string> = { 'content-type': 'application/json' }; if (r.headers['set-cookie']) h['set-cookie'] = r.headers['set-cookie'];
    res.writeHead(r.status, h); res.end(JSON.stringify(r.body ?? {}));
  });
});
srv.listen(0, '127.0.0.1', () => console.log('READY ' + (srv.address() as any).port));
