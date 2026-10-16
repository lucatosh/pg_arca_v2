import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountApiTokenRoutes, mountAuthRoutes, requireAdmin } from '../../server/auth';
import { mountAdvancedRoutes } from '../../server/approvals';
import { audit } from '../../server/ops';
import { mountHbaRoutes } from '../../server/hba';
import { mountJoinRoutes } from '../../server/join';
import { mountWorkerRoutes } from '../../server/workers';
import { mountDestinationRoutes } from '../../server/destinations';
import { mountScopedRoutes } from '../../server/scoped';
import { mountPolicyRoutes } from '../../server/policies';
import { mountGeoRoutes } from '../../server/geo';
import { mountNotifyRoutes } from '../../server/notify';
import { mountPlatformRoutes } from '../../server/platform';
import { mountMetricsRoutes } from '../../server/metrics';
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-')); const store = new Store(dir), app = new MiniApp(); const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'DEMO', environment: 'dev', isSandbox: true, databases: [], haState: { nodes: [] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountApiTokenRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec }); mountClusterRoutes(app, store, direct, demo as any); mountAdvancedRoutes(app, store, audit); mountHbaRoutes(app, store);
  mountJoinRoutes(app, store); mountWorkerRoutes(app, store); mountDestinationRoutes(app, store); mountScopedRoutes(app, store); mountPolicyRoutes(app, store); mountGeoRoutes(app, store); mountNotifyRoutes(app, store); mountPlatformRoutes(app, store); mountMetricsRoutes(app, store);
  await seedDemoOnFirstRun(store, demo as any);
  const call = (m: string, u: string, body?: any, cookie?: string, key?: string, extra: Record<string,string> = {}) => app.call(m, u, { body, headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}), ...extra } });
  const PW = 'correct-horse-battery';
  const A = (await call('POST', '/api/auth/setup', { username: 'admin', password: PW })).headers['set-cookie'].split(';')[0];
  const login = async (u: string, p: string) => (await call('POST', '/api/auth/login', { username: u, password: p })).headers['set-cookie'].split(';')[0];
  await store.mutate(d => {
    d.clusters.push({ id: 'prod1', name: 'prod1', environment: 'prod', source: 'agent', clusterKey: 'sysid:7000000000000000001' } as any, { id: 'dev1', name: 'dev1', environment: 'dev', source: 'agent' } as any);
    for (const [id, cl] of [['np', 'prod1'], ['nd', 'dev1']]) d.nodes[id] = { id, name: id, clusterId: cl, tokenHash: 'x', lastSeen: new Date().toISOString(), snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
  });
  await call('POST', '/api/users', { username: 'admin2', password: 'second-admin-pass', role: 'admin' }, A);
  await call('POST', '/api/users', { username: 'ops', password: 'operator-password-1', role: 'operator' }, A);
  await call('POST', '/api/users', { username: 'view', password: 'viewer-password-1', role: 'viewer' }, A);
  const A2 = await login('admin2', 'second-admin-pass'), O = await login('ops', 'operator-password-1'), V = await login('view', 'viewer-password-1');
  return { dir, store, app, call, A, A2, O, V, login };
}

import assert from 'assert';
import { hbaOpenRule } from '../../server/optypes';
import { isRisky } from '../../server/approvals';
import { scrubSecrets } from '../../server/scrub';

(async () => {
  { // 1. dry_run must be a real boolean: [] / {} are "a dry run" for JavaScript and a real run for the agent
    const { call, A, O, store } = await setup();
    await call('PUT', '/api/advanced', { approvals: { prod: true } }, A);
    for (const [type, params] of [['pg_restart', { dry_run: [] }], ['restore_instance', { replace_production: true, dry_run: {}, confirm: 'REPLACE' }],
                                  ['restore_db_swap', { restored: 'shop_r', original: 'shop', dry_run: [], confirm: 'REPLACE' }], ['wal_retire_branch', { timeline: 3, dry_run: 'false', confirm: 'RETIRE' }]] as [string, any][]) {
      const r = await call('POST', '/api/clusters/prod1/operations', { type, params }, O, 'k-' + type);
      assert.strictEqual(r.status, 400, type + ' ' + JSON.stringify(r.body));
      assert.match(String(r.body.message || r.body.error), /true or false/);
    }
    assert.strictEqual(store.peek().operations.length, 0);
    assert.strictEqual(isRisky('pg_restart', { dry_run: 1 }), true, 'anything but true is the real thing');
    assert.strictEqual(isRisky('pg_restart', { dry_run: true }), false);
    const ok = await call('POST', '/api/clusters/prod1/operations', { type: 'pg_restart', params: { dry_run: true } }, O, 'k-dry');
    assert.ok(ok.status === 202 && !ok.body.approval, 'a real dry run is still free');
  }
  { // 2. opening pg_hba to the network: every method that is not a challenge or a certificate
    for (const m of ['trust', 'password', ' password', 'ident', 'ldap', 'radius', 'pam', 'PASSWORD ']) assert.ok(hbaOpenRule([{ type: 'host', address: '0.0.0.0/0', method: m }]), m);
    for (const m of ['scram-sha-256', 'md5', 'cert', 'reject']) assert.strictEqual(hbaOpenRule([{ type: 'hostssl', address: '10.0.0.0/8', method: m }]), null, m);
    assert.strictEqual(hbaOpenRule([{ type: 'local', method: 'trust' }]), null);
    assert.strictEqual(hbaOpenRule([{ type: 'host', address: '127.0.0.1/32', method: 'trust' }]), null);
    const { call, O } = await setup();
    const r = await call('POST', '/api/clusters/dev1/hba/apply', { rules: [{ type: 'hostssl', database: 'all', user: 'postgres', address: '0.0.0.0/0', method: 'ident' }] }, O, 'h1');
    assert.strictEqual(r.status, 403, 'operator cannot open with ident');
  }
  { // 3. credentials never leave discovery
    const { store, call, V } = await setup();
    await store.mutate(d => { d.nodes['np'].discovery = { postgres_instances: [{ data_directory: '/d', settings: { primary_conninfo: "host=10.0.0.1 user=replicator password=S3cretRepl sslmode=require", archive_command: 'env PGPASSWORD=Xyz AWS_SECRET_ACCESS_KEY=Abc wal-g wal-push %p' } }] } as any; });
    const s = JSON.stringify((await call('GET', '/api/discovery/results', undefined, V)).body);
    assert.ok(!s.includes('S3cretRepl') && !s.includes('Xyz') && !s.includes('Abc'), s);
    assert.ok(s.includes('host=10.0.0.1'));
    assert.strictEqual(scrubSecrets('postgres://rep:pw1@db:5432/x'), 'postgres://rep:•••@db:5432/x');
    assert.deepStrictEqual(scrubSecrets({ a: { password: 'p', port: 5 } }), { a: { password: '•••', port: 5 } });
  }
  { // 4. an API token dies with its creator (disabled, deleted) and never outranks it
    const { app, call, A, A2 } = await setup();
    const tk = (await call('POST', '/api/api-tokens', { label: 'mine', role: 'admin' }, A2)).body.token;
    assert.ok(tk);
    const use = () => app.call('GET', '/api/users', { headers: { authorization: 'Bearer ' + tk } });
    assert.strictEqual((await use()).status, 200);
    await call('PATCH', '/api/users/admin2', { role: 'viewer' }, A);
    assert.strictEqual((await use()).status, 403, 'creator demoted: token capped');
    await call('PATCH', '/api/users/admin2', { disabled: true }, A);
    assert.strictEqual((await use()).status, 401);
    await call('DELETE', '/api/users/admin2', undefined, A);
    await call('POST', '/api/users', { username: 'admin2', password: 'second-admin-pass', role: 'admin' }, A);
    assert.strictEqual((await use()).status, 401, 'a re-created account does not inherit the tokens');
  }
  { // 5. an enrollment token of one environment never joins a cluster of another
    const { store, call, A } = await setup();
    const t = await call('POST', '/api/enrollment-tokens', { label: 'dev box', environment: 'dev' }, A);
    const r = await call('POST', '/api/agent/enroll', { enrollment_token: t.body.token, node_name: 'evil', discovery: { postgres_instances: [{ cluster_key: 'sysid:7000000000000000001' }] } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.body.error, 'environment_mismatch');
    assert.ok(!Object.values(store.peek().nodes).some((n: any) => n.name === 'evil'));
  }
  { // 6. failures from rotating addresses do not lock the owner out from where they signed in before
    const { app } = await setup();
    assert.strictEqual((await app.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'correct-horse-battery' }, ip: '10.1.1.1' })).status, 200);
    for (let i = 0; i < 55; i++) await app.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' + i }, ip: `198.51.100.${i}` });
    assert.strictEqual((await app.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'correct-horse-battery' }, ip: '10.1.1.1' })).status, 200);
    assert.strictEqual((await app.call('POST', '/api/auth/login', { body: { username: 'admin', password: 'correct-horse-battery' }, ip: '203.0.113.7' })).status, 429, 'a new address still waits');
  }
  { // 7. a state-changing call from another site is refused, also without a body
    const { app, call, A, O } = await setup();
    await call('PUT', '/api/advanced', { approvals: { prod: true } }, A);
    const id = (await call('POST', '/api/clusters/prod1/operations', { type: 'pg_set_param', params: { name: 'work_mem', value: '1GB' } }, O, 'c1')).body.approval.id;
    const x = await app.call('POST', `/api/approvals/${id}/approve`, { headers: { cookie: A, 'content-type': 'text/plain;charset=UTF-8', 'content-length': '0', origin: 'https://wiki.corp.example', host: 'console.corp.example' } });
    assert.strictEqual(x.status, 403); assert.strictEqual(x.body.error, 'cross_origin');
    const y = await app.call('POST', `/api/approvals/${id}/approve`, { headers: { cookie: A, origin: 'https://console.corp.example', host: 'console.corp.example' } });
    assert.strictEqual(y.status, 200, JSON.stringify(y.body));
  }
  console.log('review security OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
