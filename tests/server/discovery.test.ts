import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountPlatformRoutes } from '../../server/platform';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'))); const app = new MiniApp(); mountPlatformRoutes(app, store);
  const inst = (s: any) => ({ postgres_instances: [{ settings: s }], summary: { postgres_instances_found: 1, findings_critical: 1, findings_warning: 0 }, findings: [{ severity: 'critical', code: 'X' }] });
  await store.mutate(d => {
    d.clusters.push({ id: 'k', name: 'prodpg', environment: 'prod' } as any);
    d.nodes.a = { id: 'a', name: 'db1', clusterId: 'k', discovery: inst({ port: '5432', max_connections: '200', work_mem: '4MB', ssl: 'on' }) } as any;
    d.nodes.b = { id: 'b', name: 'db2', clusterId: 'k', discovery: inst({ port: '5433', max_connections: '100', work_mem: '4MB', ssl: 'on' }) } as any;
    d.nodes.c = { id: 'c', name: 'solo', clusterId: undefined, discovery: inst({ max_connections: '1' }) } as any;
  });
  const r = (await app.call('GET', '/api/discovery/results')).body;
  assert.strictEqual(r.drift.length, 1, JSON.stringify(r.drift));                       // port is ignored, work_mem/ssl equal, max_connections differs
  assert.deepStrictEqual(r.drift[0].values, { db1: '200', db2: '100' }); assert.strictEqual(r.drift[0].clusterName, 'prodpg');
  assert.strictEqual(r.summary.critical, 3); assert.strictEqual(r.summary.drift, 1); assert.strictEqual(r.nodes[0].findings.length, 1);
  console.log('ALL DISCOVERY TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
