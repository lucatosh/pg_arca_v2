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
  assert(/curl -fsSL \S+\/agent\/install.sh \| sudo PG_ARCA_URL=/.test(tok.body.installCommand), tok.body.installCommand); assert.strictEqual(tok.body.installCommandPrivateCa, undefined, 'the private-CA variant exists only for an https console');
  const disc = { postgres_instances: [{ cluster_key: 'sysid:111', patroni: { scope: 'prodpg' } }], patroni_clusters: [{ scope: 'prodpg' }] };
  const en = await call('POST', '/api/agent/enroll', { enrollment_token: token, node_name: 'db1', agent_version: '2.0', discovery: disc });
  assert.strictEqual(en.status, 201);
  assert.strictEqual((await call('POST', '/api/agent/enroll', { enrollment_token: token, node_name: 'other', discovery: disc })).status, 403);  // single use
  assert.strictEqual((await call('POST', '/api/agent/enroll', { enrollment_token: 'bogus', node_name: 'db1' })).status, 401);
  // one command for the nodes of a Patroni cluster: a token for up to 2 servers, both join the SAME cluster (same system identifier), the third is refused
  assert.strictEqual((await call('POST', '/api/enrollment-tokens', { label: 'x', maxUses: 21 }, H())).status, 400);
  const tok2 = await call('POST', '/api/enrollment-tokens', { label: 'pat', environment: 'prod', maxUses: 2 }, H()); assert.strictEqual(tok2.body.maxUses, 2);
  const disc2 = { postgres_instances: [{ cluster_key: 'sysid:222', patroni: { scope: 'pat' } }], patroni_clusters: [{ scope: 'pat' }] };
  const e1 = await call('POST', '/api/agent/enroll', { enrollment_token: tok2.body.token, node_name: 'pat1', discovery: disc2 }); assert.strictEqual(e1.status, 201);
  const e1b = await call('POST', '/api/agent/enroll', { enrollment_token: tok2.body.token, node_name: 'pat1', discovery: disc2 }); assert.strictEqual(e1b.status, 201, 'installer re-run on the same server is not a new use');
  const e2 = await call('POST', '/api/agent/enroll', { enrollment_token: tok2.body.token, node_name: 'pat2', discovery: disc2 }); assert.strictEqual(e2.status, 201);
  assert.strictEqual(e1.body.cluster_id, e2.body.cluster_id);
  assert.strictEqual((await call('POST', '/api/agent/enroll', { enrollment_token: tok2.body.token, node_name: 'pat3', discovery: disc2 })).status, 403);
  const tl = (await call('GET', '/api/enrollment-tokens', undefined, H())).body.tokens.find((t: any) => t.id === tok2.body.id);
  assert.strictEqual(tl.uses, 2); assert.strictEqual(tl.active, false);
  await call('DELETE', `/api/clusters/${e1.body.cluster_id}`, undefined, H());
  const A = (x: any = {}) => ({ authorization: 'Bearer ' + en.body.agent_token, 'x-arca-node': en.body.node_id, ...x });
  assert.strictEqual((await call('POST', '/api/agent/heartbeat', {}, { authorization: 'Bearer nope', 'x-arca-node': en.body.node_id })).status, 401);
  const snap = { postgres: { alive: true, is_in_recovery: false, role: 'primary', version: '16.4', current_lsn: '0/3000000', timeline: 2, xact_total: 1000, connections: { used: 2, max: 100 }, databases: [{ oid: 5, name: 'app', size: 1234 }] }, patroni: { accessible: true, role: 'leader', scope: 'prodpg' }, system: { load_avg_1m: 0.5, cpu_count: 2, memory_used_percent: 30 } };
  const hb1 = await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1 }, A());
  assert.strictEqual(hb1.status, 200); assert.deepStrictEqual(hb1.body.ops, []);
  assert.strictEqual(hb1.body.log_mode, 'alerts', 'nobody watches the logs: agents ship warnings and errors only');
  { const lg = await call('POST', '/api/agent/logs', { logs: [{ level: 'ERROR', message: 'boom', service: 'postgres' }] }, A()); assert.strictEqual(lg.status, 200); assert.strictEqual(lg.body.log_mode, 'alerts'); }
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
  { // the agent process restarts while holding it: the new process gets it back at once (no 2-minute lease wait); same process: not redelivered
    assert.strictEqual((await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1, agent_started: 1000 }, A())).body.ops.length, 0, 'first start time seen: nothing to hand back');
    assert.strictEqual((await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1, agent_started: 1000 }, A())).body.ops.length, 0);
    const again = await call('POST', '/api/agent/heartbeat', { snapshot: snap, max_ops: 1, agent_started: 2000 }, A());
    assert.strictEqual(again.body.ops.length, 1, 'restarted agent: leased op handed back'); assert.strictEqual(again.body.ops[0].id, hb2.body.ops[0].id);
  }
  const rid = hb2.body.ops[0].id;
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'succeeded', result: { segment: 'x' } }, A())).status, 200);
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'succeeded', result: { segment: 'x' } }, A())).status, 200);  // duplicate report ok
  assert.strictEqual((await call('POST', `/api/agent/ops/${rid}/report`, { status: 'failed', error: 'x' }, A())).status, 409);
  assert.strictEqual((await call('GET', `/api/operations/${rid}`, undefined, H())).body.operation.status, 'succeeded');
  { // a backup running on a STANDBY: the moment it reports the wal phase, the console asks the PRIMARY to switch its WAL segment (once)
    const t3 = await call('POST', '/api/enrollment-tokens', { label: 's', environment: 'prod' }, H());
    const en2 = await call('POST', '/api/agent/enroll', { enrollment_token: t3.body.token, node_name: 'db2', agent_version: '2.0', discovery: disc });
    assert.strictEqual(en2.status, 201); assert.strictEqual(en2.body.cluster_id, cl.id, 'same cluster (same system identifier)');
    const A2 = (x: any = {}) => ({ authorization: 'Bearer ' + en2.body.agent_token, 'x-arca-node': en2.body.node_id, ...x });
    const ssnap = { ...snap, postgres: { ...snap.postgres, is_in_recovery: true, role: 'replica' }, patroni: { accessible: true, role: 'replica', scope: 'prodpg' } };
    await call('POST', '/api/agent/heartbeat', { snapshot: ssnap, max_ops: 0 }, A2());
    const bo = await call('POST', `/api/clusters/${cl.id}/operations`, { type: 'backup_run', params: { type: 'full' }, nodeId: en2.body.node_id }, H({ 'idempotency-key': 'bk-standby' }));
    assert.strictEqual(bo.status, 202, JSON.stringify(bo.body));
    const lease = await call('POST', '/api/agent/heartbeat', { snapshot: ssnap, max_ops: 1 }, A2());
    assert.strictEqual(lease.body.ops[0]?.type, 'backup_run');
    const bid = lease.body.ops[0].id;
    await call('POST', `/api/agent/ops/${bid}/report`, { status: 'running', progress: { phase: 'copy', set: 's1' } }, A2());
    let sw = store.peek().operations.filter(o => o.type === 'wal_switch' && o.idempotencyKey === bid + ':walswitch');
    assert.strictEqual(sw.length, 0, 'no switch while copying');
    await call('POST', `/api/agent/ops/${bid}/report`, { status: 'running', progress: { phase: 'wal', set: 's1' } }, A2());
    await call('POST', `/api/agent/ops/${bid}/report`, { status: 'running', progress: { phase: 'wal', set: 's1', waited_sec: 15 } }, A2());
    sw = store.peek().operations.filter(o => o.type === 'wal_switch' && o.idempotencyKey === bid + ':walswitch');
    assert.strictEqual(sw.length, 1, 'exactly one wal_switch per backup, however many wal-phase reports arrive');
    assert.strictEqual(sw[0].nodeId, en.body.node_id, 'the switch goes to the PRIMARY');
    assert.strictEqual(sw[0].createdBy, 'pg_arca (backup on a standby)');
    await call('POST', `/api/agent/ops/${bid}/report`, { status: 'succeeded', result: { set: 's1', status: 'COMPLETE' } }, A2());
  }
  { // the activity dock's feed: slim (no result/history/params), newest first, finished operations only while recent
    const sl = await call('GET', '/api/operations?slim=1&recent=3600', undefined, H()); assert.strictEqual(sl.status, 200);
    const one = sl.body.operations.find((o: any) => o.id === rid); assert.ok(one, 'recently finished operation is listed');
    for (const k of ['result', 'history', 'params']) assert.ok(!(k in one), `slim feed must not carry ${k}`);
    assert.ok(['id', 'type', 'status', 'clusterId', 'createdAt'].every(k => k in one));
  }
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
    await store.mutate((d: any) => { for (const n of Object.values(d.nodes) as any[]) if (n.clusterId === cid) n.snapshot = { postgres: { alive: false } };
      for (const o of d.operations) if (o.clusterId === cid) o.status = 'succeeded'; });          // the first backup is done (a queued one would be a conflict, not the point here)
    const b2 = await call('POST', `/api/clusters/${cid}/operations`, { type: 'backup_run', params: { type: 'full' } }, H({ 'idempotency-key': 'pick-2' }));
    assert.strictEqual(b2.status, 409); assert.strictEqual(b2.body.error, 'no_suitable_node');
  }

  // login + brute-force throttle
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password-1' })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'admin', password: 'correct-horse-battery' })).status, 429);
  console.log('ALL API TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
