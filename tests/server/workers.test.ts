// Operational machines: enrollment without a cluster, heartbeat tells the agent its role, inventory view, limited operations, conversion of a node without database.
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert'; import crypto from 'crypto';
import { MiniApp } from './mini-express';
import { Store, sha256 } from '../../server/store';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountJoinRoutes } from '../../server/join';
import { mountWorkerRoutes } from '../../server/workers';
import { requiredRole } from '../../server/auth';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'workers-'))); const app = new MiniApp();
  app.use((req: any, _res: any, next: any) => { req.role = req.headers['x-role'] || 'admin'; req.actor = req.role; return next(); });
  mountAgentRoutes(app, store); mountOperatorRoutes(app, store); mountJoinRoutes(app, store); mountWorkerRoutes(app, store);
  const call = (m: string, u: string, body?: any, headers: any = {}) => app.call(m, u, { body, headers });

  // 1. a "macchina operativa" token enrolls a node WITHOUT creating a cluster
  const tok = await call('POST', '/api/enrollment-tokens', { label: 'backup server', kind: 'worker' });
  assert.strictEqual(tok.status, 201); assert(tok.body.installCommand.includes('PG_ARCA_ROLE=worker'));
  assert.strictEqual((await call('POST', '/api/enrollment-tokens', { kind: 'worker', clusterId: 'x' })).status, 400, 'a worker has no cluster');
  const en = await call('POST', '/api/agent/enroll', { enrollment_token: tok.body.token, node_name: 'bk01', agent_version: '2.0', discovery: { node_kind: 'worker', postgres_instances: [] } });
  assert.strictEqual(en.status, 201, JSON.stringify(en.body)); assert.strictEqual(en.body.node_kind, 'worker'); assert.strictEqual(en.body.cluster_id, null);
  assert.strictEqual(store.peek().clusters.length, 0, 'no phantom cluster');
  const H = { 'x-arca-node': en.body.node_id, authorization: 'Bearer ' + en.body.agent_token };

  // 2. heartbeat with the inventory; the answer carries the role
  const inv = { node_kind: 'worker', worker: { role: 'worker', pg_installations: [{ major: 16, version: '16.4', bindir: '/usr/lib/postgresql/16/bin', source: 'system' }, { major: 15, version: '15.8', bindir: '/opt/pg15/bin', source: 'private' }],
    host: { os: 'Debian 12', cpus: 8, mem_total: 32e9, mem_available: 20e9, root: false, sudo_nopasswd: true },
    mounts: [{ mount: '/', fstype: 'ext4', remote: false, total_bytes: 1e11, free_bytes: 5e10 }, { mount: '/backup', fstype: 'nfs4', remote: true, total_bytes: 8e12, free_bytes: 6e12 }],
    dirs: { scratch: { path: '/var/tmp/pg_arca_scratch', exists: true, free_bytes: 5e10, total_bytes: 1e11 } } } };
  const hb = await call('POST', '/api/agent/heartbeat', { snapshot: inv }, H);
  assert.strictEqual(hb.status, 200); assert.strictEqual(hb.body.node_kind, 'worker');
  const list = (await call('GET', '/api/workers')).body.workers;
  assert.strictEqual(list.length, 1); assert.deepStrictEqual(list[0].pgMajors, [16, 15]); assert.strictEqual(list[0].remoteMounts, 1); assert.strictEqual(list[0].online, true);
  const det = (await call('GET', `/api/workers/${en.body.node_id}`)).body; assert.strictEqual(det.mounts.length, 2); assert.strictEqual(det.installations.length, 2);

  // 3. label + roles (admin), validated
  assert.strictEqual(requiredRole('PATCH', `/api/workers/${en.body.node_id}`), 'admin');
  assert.strictEqual((await call('PATCH', `/api/workers/${en.body.node_id}`, { roles: ['recovery', 'nope'] })).status, 400);
  assert.strictEqual((await call('PATCH', `/api/workers/${en.body.node_id}`, { label: 'Backup server DC1', roles: ['recovery', 'repository'] })).status, 200);
  assert.deepStrictEqual(store.peek().nodes[en.body.node_id].roles, ['recovery', 'repository']);

  // 4. operations: only what makes sense without a database; the install is admin-only; lane = this machine
  assert.strictEqual(requiredRole('POST', `/api/workers/${en.body.node_id}/operations`), 'operator');
  const k = { 'idempotency-key': 'w1' };
  assert.strictEqual((await call('POST', `/api/workers/${en.body.node_id}/operations`, { type: 'backup_run', params: {} }, k)).status, 400, 'no backups on a machine without a database');
  const opr = await call('POST', `/api/workers/${en.body.node_id}/operations`, { type: 'ephemeral_install', params: { major: 17, mode: 'private', confirm: 'INSTALL' } }, { 'idempotency-key': 'w2', 'x-role': 'operator' });
  assert.strictEqual(opr.status, 403, 'installing software is for administrators');
  const pf = await call('POST', `/api/workers/${en.body.node_id}/operations`, { type: 'ephemeral_preflight', params: { major: 16 } }, k);
  assert.strictEqual(pf.status, 202, JSON.stringify(pf.body)); assert.strictEqual(pf.body.operation.clusterId, `worker:${en.body.node_id}`);
  const hb2 = await call('POST', '/api/agent/heartbeat', { snapshot: inv, max_ops: 2 }, H);
  assert.strictEqual(hb2.body.ops.length, 1); assert.strictEqual(hb2.body.ops[0].type, 'ephemeral_preflight');

  // 5. a node enrolled the old way, no database ever found: converted, its empty cluster removed
  const tok2 = await call('POST', '/api/enrollment-tokens', { label: 'old' });
  const en2 = await call('POST', '/api/agent/enroll', { enrollment_token: tok2.body.token, node_name: 'oldbk', agent_version: '2.0', discovery: { postgres_instances: [] } });
  assert.strictEqual(store.peek().clusters.length, 1, 'the old behaviour created an empty cluster');
  await call('POST', '/api/agent/heartbeat', { snapshot: { postgres: { alive: false } } }, { 'x-arca-node': en2.body.node_id, authorization: 'Bearer ' + en2.body.agent_token });
  const cand = (await call('GET', '/api/workers')).body.candidates; assert.strictEqual(cand.length, 1); assert.strictEqual(cand[0].name, 'oldbk');
  const mk = await call('POST', `/api/nodes/${en2.body.node_id}/make-worker`, {});
  assert.strictEqual(mk.status, 200); assert.strictEqual(mk.body.clusterRemoved, true); assert.strictEqual(store.peek().clusters.length, 0);
  const hb3 = await call('POST', '/api/agent/heartbeat', { snapshot: {} }, { 'x-arca-node': en2.body.node_id, authorization: 'Bearer ' + en2.body.agent_token });
  assert.strictEqual(hb3.body.node_kind, 'worker', 'the agent learns its new role at the next heartbeat');

  // 6. self-announced server approved as an operational machine
  const secret = crypto.randomBytes(32).toString('hex'); const fp = 'fpworker0000000000000001';
  await call('POST', '/api/agent/request-join', { fingerprint: fp, secret_hash: sha256(secret), node_name: 'rec01', agent_version: '2.0', node_role: 'worker', discovery: {} });
  const rq = store.peek().settings.joinRequests.find((r: any) => r.nodeName === 'rec01');
  assert.strictEqual(rq.summary.node_role, 'worker');
  const ap = await call('POST', `/api/join-requests/${rq.id}/approve`, {});
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.body)); assert.strictEqual(ap.body.kind, 'worker');
  const js = (await call('POST', '/api/agent/join-status', { fingerprint: fp, secret })).body; assert.strictEqual(js.node_kind, 'worker'); assert.strictEqual(js.cluster_id, null);
  assert.strictEqual(store.peek().clusters.length, 0);
  // 7. health: a recovery host that is used and offline is critical; missing binaries for the clusters' versions are reported
  const { evaluate } = await import('../../server/health');
  await store.mutate(d => { d.settings.scoped = { ephemeral: { global: { placement: 'central', centralNode: en.body.node_id } } }; d.clusters.push({ id: 'cx', name: 'pg17', environment: 'prod', pgVersion: '17.2', source: 'agent' }); d.nodes[en.body.node_id].lastSeen = new Date(Date.now() - 600_000).toISOString(); });
  const iss = evaluate(store.peek()).filter(i => i.clusterId === `worker:${en.body.node_id}`);
  assert(iss.some(i => i.code === 'worker_offline' && i.severity === 'critical'), JSON.stringify(iss));
  assert(iss.some(i => i.code === 'worker_pg_missing' && i.title.includes('17') && i.cause.includes('pg17')));
  // lab finding: a cluster that restores ELSEWHERE (its own folder/cluster scope says node) must not make this machine "miss" its version
  await store.mutate(d => { d.clusters.push({ id: 'cy', name: 'pg15solo', environment: 'prod', pgVersion: '15.8', source: 'agent' }); d.settings.scoped.ephemeral['cluster:cy'] = { placement: 'node' };
                            d.nodes[en.body.node_id].snapshot = { worker: { pg_installations: [{ major: 17 }] } }; });
  const iss2 = evaluate(store.peek()).filter(i => i.clusterId === `worker:${en.body.node_id}` && i.code === 'worker_pg_missing');
  assert.strictEqual(iss2.length, 0, JSON.stringify(iss2));
  console.log('workers tests OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
