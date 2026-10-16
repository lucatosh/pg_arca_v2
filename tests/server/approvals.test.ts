import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountApiTokenRoutes, mountAuthRoutes, requireAdmin, requiredRole } from '../../server/auth';
import { mountAdvancedRoutes, isRisky, describeOp } from '../../server/approvals';
import { audit } from '../../server/ops';
import { mountHbaRoutes } from '../../server/hba';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-')); const store = new Store(dir), app = new MiniApp(); const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'DEMO', environment: 'dev', isSandbox: true, databases: [], haState: { nodes: [] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountApiTokenRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec }); mountClusterRoutes(app, store, direct, demo); mountAdvancedRoutes(app, store, audit); mountHbaRoutes(app, store);
  await seedDemoOnFirstRun(store, demo);
  const call = (m: string, u: string, body?: any, cookie?: string, key?: string) => app.call(m, u, { body, headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
  const PW = 'correct-horse-battery';
  const A = (await call('POST', '/api/auth/setup', { username: 'admin', password: PW })).headers['set-cookie'].split(';')[0];
  const login = async (u: string, p: string) => (await call('POST', '/api/auth/login', { username: u, password: p })).headers['set-cookie'].split(';')[0];
  await store.mutate(d => {
    d.clusters.push({ id: 'prod1', name: 'prod1', environment: 'prod', source: 'agent' } as any, { id: 'dev1', name: 'dev1', environment: 'dev', source: 'agent' } as any);
    for (const [id, cl] of [['np', 'prod1'], ['nd', 'dev1']]) d.nodes[id] = { id, name: id, clusterId: cl, lastSeen: new Date().toISOString(), snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
  });
  assert(isRisky('restore_instance', { replace_production: true, confirm: 'SOSTITUISCI' }) && !isRisky('restore_instance', { replace_production: true, dry_run: true }) && !isRisky('restore_instance', {}) && isRisky('restore_kept_drop', {}));
  assert(isRisky('hba_apply') && isRisky('restore_promote', { mode: 'replace' }) && !isRisky('restore_promote', { mode: 'as_new' }) && !isRisky('backup_run'));
  // the approver sees WHAT will be replaced and to which point, not a raw operation type
  assert(/database shop .*2026-10-01T10:00/.test(describeOp('restore_database', { database: 'shop', replace_original: true, target_time: '2026-10-01T10:00:00Z' })));
  assert(/shop\.public\.orders/.test(describeOp('restore_object', { object: 'shop.public.orders', finish: 'rows_all', target_xid: '991' })));
  assert(/LSN 0\/5000000/.test(describeOp('restore_instance', { replace_production: true, target_lsn: '0/5000000' })));
  // one admin only -> cannot switch four-eyes on (nobody could approve)
  let r = await call('PUT', '/api/advanced', { approvals: { prod: true } }, A); assert.equal(r.status, 409); assert.equal(r.body.error, 'need_two_admins');
  assert.equal((await call('POST', '/api/users', { username: 'admin2', password: 'second-admin-pass', role: 'admin' }, A)).status, 201);
  assert.equal((await call('POST', '/api/users', { username: 'ops', password: 'operator-password-1', role: 'operator' }, A)).status, 201);
  const A2 = await login('admin2', 'second-admin-pass'), O = await login('ops', 'operator-password-1');
  assert.equal((await call('PUT', '/api/advanced', { approvals: { moon: true } }, A)).status, 400);
  assert.equal((await call('PUT', '/api/advanced', { approvals: { prod: true } }, O)).status, 403, 'operators cannot change the policy');
  assert.equal((await call('PUT', '/api/advanced', { approvals: { prod: true } }, A)).status, 200);

  const setp = { type: 'pg_set_param', params: { name: 'work_mem', value: '64MB' } };
  r = await call('POST', '/api/clusters/prod1/operations', setp, O, 'k1'); assert.equal(r.status, 202); assert(r.body.approval && !r.body.operation, JSON.stringify(r.body));
  const id = r.body.approval.id; assert.equal(store.peek().operations.length, 0, 'nothing executed yet');
  assert.equal((await call('POST', '/api/clusters/prod1/operations', setp, O, 'k1')).body.approval.id, id, 'same click twice = same request');
  assert.equal((await call('POST', '/api/clusters/prod1/operations', { ...setp, params: { ...setp.params, confirm: 'x' } }, O, 'k1-again')).body.approval.id, id, 'the same request submitted again (new key) while the first waits = the same request');
  assert.equal((await call('POST', '/api/clusters/dev1/operations', setp, O, 'k2')).body.operation.type, 'pg_set_param', 'dev is not protected');
  assert.equal((await call('POST', '/api/clusters/prod1/operations', { type: 'backup_run', params: { type: 'incr' } }, O, 'k3')).body.operation.type, 'backup_run', 'non-risky ops are not delayed');
  assert.equal((await call('POST', `/api/approvals/${id}/approve`, {}, O)).status, 403, 'operators cannot approve');
  assert.equal((await call('GET', '/api/approvals', undefined, O)).body.approvals[0].status, 'pending');
  r = await call('POST', `/api/approvals/${id}/approve`, {}, A); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.operation.createdBy, 'ops', 'runs as the requester'); assert.equal(r.body.operation.type, 'pg_set_param');
  assert.equal((await call('GET', '/api/approvals', undefined, O)).body.approvals.find((x: any) => x.id === id).operationId, r.body.operation.id, 'the requester can follow the operation the approval started');
  assert.equal((await call('POST', `/api/approvals/${id}/approve`, {}, A2)).status, 409, 'cannot be approved twice');
  const a = store.peek().audit.filter((e: any) => e.action.startsWith('approval.')); assert(a.some((e: any) => e.action === 'approval.requested' && e.actor === 'ops') && a.some((e: any) => e.action === 'approval.approve' && e.actor === 'admin'));
  // an admin cannot approve their own request
  r = await call('POST', '/api/clusters/prod1/operations', { type: 'hba_rollback', params: {} }, A2, 'k4'); assert.equal(r.status, 202); const id2 = r.body.approval.id;
  r = await call('POST', `/api/approvals/${id2}/approve`, {}, A2); assert.equal(r.status, 403); assert.equal(r.body.error, 'self_approval');
  // ...nor by signing in with another capitalisation of the same name (one person, one account)
  { const A2u = await login('ADMIN2', 'second-admin-pass');
    r = await call('POST', `/api/approvals/${id2}/approve`, {}, A2u); assert.equal(r.status, 403); assert.equal(r.body.error, 'self_approval');
    assert(!Object.keys(store.peek().settings.users || {}).includes('ADMIN2'), 'no second account'); }
  // ...nor with an API token of their own (the token acts for its creator), in either direction
  { const tk = (await call('POST', '/api/api-tokens', { label: 'ci', role: 'admin' }, A2)).body.token; const T = { authorization: 'Bearer ' + tk };
    r = await app.call('POST', `/api/approvals/${id2}/approve`, { body: {}, headers: T }); assert.equal(r.status, 403); assert.equal(r.body.error, 'self_approval');
    r = await app.call('POST', '/api/clusters/prod1/operations', { body: { type: 'hba_rollback', params: {} }, headers: { ...T, 'idempotency-key': 'k4t' } }); assert.equal(r.status, 202); const id3 = r.body.approval.id;
    r = await call('POST', `/api/approvals/${id3}/approve`, {}, A2); assert.equal(r.status, 403, 'request made with my token, approved with my session'); assert.equal(r.body.error, 'self_approval');
    assert.equal((await call('POST', `/api/approvals/${id3}/approve`, {}, A)).status, 200, 'another administrator can');
    await store.mutate(d => { for (const o of d.operations) if (o.createdBy === 'token:ci') o.status = 'succeeded'; }); }
  assert.equal((await call('POST', `/api/approvals/${id2}/cancel`, {}, A2)).status, 200, 'the requester can withdraw');
  // expiry
  r = await call('POST', '/api/clusters/prod1/operations', setp, O, 'k5'); const id3 = r.body.approval.id;
  await store.mutate(d => { d.settings.approvalRequests.find((x: any) => x.id === id3).expiresAt = new Date(Date.now() - 1000).toISOString(); });
  r = await call('POST', `/api/approvals/${id3}/approve`, {}, A); assert.equal(r.status, 409); assert.equal(r.body.error, 'expired');
  assert.equal((await call('GET', '/api/approvals', undefined, O)).body.approvals.find((x: any) => x.id === id3).status, 'expired');
  // the cluster-wide pg_hba apply is gated too, and approving it fans out to the nodes
  const hr = await call('POST', '/api/clusters/prod1/hba/apply', { rules: [{ type: 'hostssl', database: 'all', user: 'app', address: '10.0.0.0/24', method: 'scram-sha-256' }] }, O, 'k7');
  assert.equal(hr.status, 202); assert(hr.body.approval && !hr.body.operations, JSON.stringify(hr.body)); assert.equal(store.peek().operations.filter((o: any) => o.type === 'hba_apply').length, 0);
  const hok = await call('POST', `/api/approvals/${hr.body.approval.id}/approve`, {}, A); assert.equal(hok.status, 200, JSON.stringify(hok.body)); assert.equal(hok.body.operations.length, 1);
  assert.equal(store.peek().operations.filter((o: any) => o.type === 'hba_apply')[0].createdBy, 'ops');
  // switched off -> immediate again
  await call('PUT', '/api/advanced', { approvals: {} }, A);
  assert.equal((await call('POST', '/api/clusters/prod1/operations', setp, O, 'k6')).body.operation.type, 'pg_set_param');
  assert.equal(requiredRole('POST', '/api/approvals/x/cancel'), 'operator'); assert.equal(requiredRole('POST', '/api/approvals/x/approve'), 'admin');
  // geo: a standby site is never promoted as a plain operation (only through Geo-redundancy, which checks the primary site)
  assert.equal((await call('POST', '/api/clusters/prod1/operations', { type: 'geo_promote', params: { confirm: 'PROMOTE' } }, O, 'kg1')).body.error, 'use_geo_promote');
  // a DR promotion approved after the primary site came back is refused (requested while it was down)
  { const now = () => new Date().toISOString();
    const P = { postgres: { alive: true, is_in_recovery: false, current_lsn: '0/5000000', system_identifier: '8888', timeline: 1 }, patroni: { accessible: true, scope: 'g1', local_node: { role: 'leader', state: 'running' }, standby_cluster: null } };
    const S = { postgres: { alive: true, is_in_recovery: true, current_lsn: '0/5000000', system_identifier: '8888', timeline: 1, replay_ts: now(), wal_receiver: { status: 'streaming', sender_host: 'g1-haproxy', sender_port: 5000, silent_sec: 1 } }, patroni: { accessible: true, scope: 'g2', local_node: { role: 'standby_leader', state: 'streaming' }, standby_cluster: { host: 'g1-haproxy', port: 5000 } } };
    await store.mutate(d => { d.clusters.push({ id: 'g1', name: 'g1', environment: 'prod', source: 'agent' } as any, { id: 'g2', name: 'g2', environment: 'prod', source: 'agent' } as any);
      d.nodes.ng1 = { id: 'ng1', name: 'ng1', clusterId: 'g1', lastSeen: now(), snapshot: P } as any; d.nodes.ng2 = { id: 'ng2', name: 'ng2', clusterId: 'g2', lastSeen: now(), snapshot: S } as any;
      (d.settings.approvalRequests ||= []).push({ id: 'apr-geo', type: 'geo_failover', clusterId: 'g2', status: 'pending', requestedBy: 'admin2', createdAt: now(), expiresAt: new Date(Date.now() + 3600e3).toISOString(),
        params: { from: 'g1', to: 'g2', key: '8888', primaryWasAlive: false } }); });
    r = await call('POST', '/api/approvals/apr-geo/approve', {}, A); assert.equal(r.status, 409, JSON.stringify(r.body)); assert.equal(r.body.error, 'primary_site_back'); }
  console.log('approvals tests OK');
})().catch(e => { console.error(e); process.exit(1); });
