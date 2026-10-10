import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountPlatformRoutes } from '../../server/platform';
import { mountAuthRoutes, requireAdmin } from '../../server/auth';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  const store = new Store(dir), app = new MiniApp();
  const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'DEMO', environment: 'dev', isSandbox: true, databases: [], haState: { nodes: [] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec });
  mountClusterRoutes(app, store, direct, demo); mountPlatformRoutes(app, store);
  await seedDemoOnFirstRun(store, demo); await seedDemoOnFirstRun(store, demo);
  const call = (m: string, u: string, body?: any, h: any = {}) => app.call(m, u, { body, headers: h });

  // --- auth gate
  assert.strictEqual((await call('GET', '/api/clusters')).status, 428);                    // setup required
  assert.strictEqual((await call('POST', '/api/auth/setup', { username: 'admin', password: 'short' })).status, 400);
  const setup = await call('POST', '/api/auth/setup', { username: 'admin', password: 'correct-horse-battery' });
  assert.strictEqual(setup.status, 201);
  assert.strictEqual((await call('POST', '/api/auth/setup', { username: 'second-admin', password: 'another-long-password' })).status, 409);
  assert.strictEqual((await call('GET', '/api/clusters')).status, 401);                    // no cookie
  const cookie = setup.headers['set-cookie'].split(';')[0];
  const H = (extra: any = {}) => ({ cookie, ...extra });
  const list = await call('GET', '/api/clusters', undefined, H());
  assert.strictEqual(list.body.clusters.length, 1); assert.strictEqual(list.body.clusters[0].isSandbox, true);   // exactly one demo, seeded once

  // --- operations refused on demo
  const dr = await call('POST', '/api/clusters/cluster-demo/operations', { type: 'pg_reload' }, H({ 'idempotency-key': 'a' }));
  assert.strictEqual(dr.status, 409);

  // --- enrollment -> heartbeat -> operation -> report
  const tok = await call('POST', '/api/enrollment-tokens', { label: 't', environment: 'prod' }, H());
  assert.strictEqual(tok.status, 201); const token = tok.body.token;
  const disc = { postgres_instances: [{ cluster_key: 'sysid:111', patroni: { scope: 'prodpg' } }], patroni_clusters: [{ scope: 'prodpg' }] };
  const en = await call('POST', '/api/agent/enroll', { enrollment_token: token, node_name: 'db1', agent_version: '2.0', discovery: disc });
  assert.strictEqual(en.status, 201);
  assert.strictEqual((await call('POST', '/api/agent/enroll', { enrollment_token: token, node_name: 'other', discovery: disc })).status, 403);  // single use
  assert.strictEqual((await call('POST', '/api/agent/enroll', { enrollment_token: 'bogus', node_name: 'db1' })).status, 401);
  const A = (x: any = {}) => ({ authorization: 'Bearer ' + en.body.agent_token, 'x-arca-node': en.body.node_id, ...x });
  assert.strictEqual((await call('POST', '/api/agent/heartbeat', {}, { authorization: 'Bearer nope', 'x-arca-node': en.body.node_id })).status, 401);
  const snap = { postgres: { alive: true, is_in_recovery: false, role: 'primary', version: '16.4', current_lsn: '0/3000000', timeline: 2, xact_total: 1000, connections: { used: 2, max: 100 }, databases: [{ oid: 5, name: 'app', size: 1234 }] }, patroni: { accessible: true, role: 'leader', scope: 'prodpg' }, system: { load_avg_1m: 0.5, cpu_count: 2, memory_used_percent: 30 } };
  const hb1 = await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1 }, A());
  assert.strictEqual(hb1.status, 200); assert.deepStrictEqual(hb1.body.ops, []);
  const cl = (await call('GET', '/api/clusters', undefined, H())).body.clusters.find((c: any) => !c.isSandbox);
  assert.strictEqual(cl.name, 'prodpg'); assert.strictEqual(cl.environment, 'prod'); assert.strictEqual(cl.pgVersion, '16.4');
  assert.strictEqual(cl.haState.nodes[0].role, 'primary'); assert.strictEqual(cl.status, 'healthy');
  assert.strictEqual(cl.capabilities.backup_restore_pitr, true);

  // validation + idempotency
  assert.strictEqual((await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'rm_rf' }, H({ 'idempotency-key': 'z' }))).status, 400);
  assert.strictEqual((await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'pg_reload' }, H())).status, 400);   // key required
  const k = { 'idempotency-key': 'reload-1' };
  const o1 = await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'wal_switch' }, H(k));
  const o2 = await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'wal_switch' }, H(k));
  assert.strictEqual(o1.status, 202); assert.strictEqual(o2.status, 200); assert.strictEqual(o2.body.replayed, true); assert.strictEqual(o1.body.operation.id, o2.body.operation.id);
  assert.strictEqual((await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'pg_reload' }, H(k))).status, 422);     // same key, different request
  // agent receives it exactly once
  const hb2 = await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1 }, A());
  assert.strictEqual(hb2.body.ops.length, 1); assert.strictEqual(hb2.body.ops[0].type, 'wal_switch');
  assert.strictEqual((await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1 }, A())).body.ops.length, 0);
  const rid = hb2.body.ops[0].id;
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'succeeded', result: { segment: 'x' } }, A())).status, 200);
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'succeeded', result: { segment: 'x' } }, A())).status, 200);  // duplicate report ok
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'failed', error: 'x' }, A())).status, 409);
  assert.strictEqual((await call('GET', `/api/operations/${rid}`, undefined, H())).body.operation.status, 'succeeded');
  // switchover validation
  assert.strictEqual((await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'patroni_switchover', params: {} }, H({ 'idempotency-key': 's' }))).status, 400);
  // audit visible
  const aud = await call('GET', '/api/audit/history?limit=50', undefined, H()); assert(aud.body.total >= 4);
  // detach is atomic + idempotent, revokes agent
  // backup policy + read model
  {
    const c2 = cl;
    {
      const bad = await call('PUT', `/api/clusters/${c2.id}/backup-policy`, { enabled: true, fullEveryHours: 2 }, H()); assert.strictEqual(bad.status, 400);
      const good = await call('PUT', `/api/clusters/${c2.id}/backup-policy`, { enabled: true, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 3 }, H()); assert.strictEqual(good.status, 200, JSON.stringify(good.body));
      const bk = await call('GET', `/api/clusters/${c2.id}/backups`, undefined, H()); assert.strictEqual(bk.body.policy.retentionFull, 3);
    }
  }
  const d1 = await call('DELETE', `/api/clusters/${cl.id}`, undefined, H()); assert.strictEqual(d1.body.ok, true);
  assert.strictEqual((await call('DELETE', `/api/clusters/${cl.id}`, undefined, H())).body.already, true);
  assert.strictEqual((await call('POST', '/api/agent/heartbeat', {}, A())).status, 401);
  // demo can be deleted and restored exactly once
  await call('DELETE', '/api/clusters/cluster-demo', undefined, H());
  const l2 = await call('GET', '/api/clusters', undefined, H()); assert.strictEqual(l2.body.clusters.length, 0); assert.strictEqual(l2.body.demoAvailable, true);
  assert.strictEqual((await call('POST', '/api/clusters/demo', {}, H())).body.result, 'created');
  assert.strictEqual((await call('POST', '/api/clusters/demo', {}, H())).body.result, 'exists');
  // restart keeps state; demo is NOT re-seeded after deletion
  await call('DELETE', '/api/clusters/cluster-demo', undefined, H());
  const store2 = new Store(dir); await seedDemoOnFirstRun(store2, demo); assert.strictEqual(store2.peek().clusters.length, 0);
  // --- node choice for backups: a node whose PostgreSQL is not up (replica being cloned) must never be picked
  {
    const cid = 'cl-pick'; const now = new Date().toISOString();
    await store.mutate((d: any) => {
      d.clusters.push({ id: cid, name: 'pick', environment: 'prod', source: 'agent', isSandbox: false, status: 'degraded', databases: [], hbaRules: [], features: {}, createdAt: now });
      d.nodes['n-prim'] = { id: 'n-prim', name: 'zzz-prim', tokenHash: 'x', enrolledAt: now, lastSeen: now, clusterId: cid, snapshot: { postgres: { alive: true, is_in_recovery: false } } };
      d.nodes['n-sick'] = { id: 'n-sick', name: 'aaa-sick', tokenHash: 'x', enrolledAt: now, lastSeen: now, clusterId: cid, snapshot: { postgres: { alive: false } } };
      d.nodes['n-rep'] = { id: 'n-rep', name: 'bbb-rep', tokenHash: 'x', enrolledAt: now, lastSeen: now, clusterId: cid, snapshot: { postgres: { alive: true, is_in_recovery: true } } };
    });
    const b1 = await call('POST', `/api/clusters/${cid}/operations`, { type: 'backup_run', params: { type: 'full' } }, H({ 'idempotency-key': 'pick-1' }));
    assert.strictEqual(b1.status, 202, JSON.stringify(b1.body)); assert.notStrictEqual(b1.body.operation.nodeId, 'n-sick', 'never the node without a running PostgreSQL');
    assert.strictEqual(b1.body.operation.nodeId, 'n-prim', 'primary preferred over a replica');
    await store.mutate((d: any) => { for (const n of Object.values(d.nodes) as any[]) if (n.clusterId === cid) n.snapshot = { postgres: { alive: false } }; });
    const b2 = await call('POST', `/api/clusters/${cid}/operations`, { type: 'backup_run', params: { type: 'full' } }, H({ 'idempotency-key': 'pick-2' }));
    assert.strictEqual(b2.status, 409); assert.strictEqual(b2.body.error, 'no_suitable_node');
  }

  // login + brute-force throttle
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password-1' })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'admin', password: 'correct-horse-battery' })).status, 429);
  console.log('ALL API TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
