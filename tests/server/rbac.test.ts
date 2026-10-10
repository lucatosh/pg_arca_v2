import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountPlatformRoutes } from '../../server/platform';
import { mountHbaRoutes } from '../../server/hba';
import { mountPolicyRoutes } from '../../server/policies';
import { mountNotifyRoutes } from '../../server/notify';
import { mountAdvancedRoutes } from '../../server/approvals';
import { mountJoinRoutes } from '../../server/join';
import { briefing } from '../../server/health';
import { audit } from '../../server/ops';
import { mountAuthRoutes, requireAdmin, requiredRole, can } from '../../server/auth';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbac-')); const store = new Store(dir), app = new MiniApp(); const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'DEMO', environment: 'dev', isSandbox: true, databases: [], haState: { nodes: [] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec }); mountClusterRoutes(app, store, direct, demo); mountPlatformRoutes(app, store); mountHbaRoutes(app, store); mountPolicyRoutes(app, store); mountNotifyRoutes(app, store); mountAdvancedRoutes(app, store, audit); mountJoinRoutes(app, store); app.get('/api/briefing', (_q: any, r: any) => r.json(briefing(store.peek())));
  await seedDemoOnFirstRun(store, demo);
  const call = (m: string, u: string, body?: any, cookie?: string) => app.call(m, u, { body, headers: cookie ? { cookie } : {} });
  const PW = 'correct-horse-battery';

  // pure permission table
  assert.equal(requiredRole('GET', '/api/clusters'), 'viewer'); assert.equal(requiredRole('GET', '/api/users'), 'admin'); assert.equal(requiredRole('GET', '/api/enrollment-tokens'), 'admin');
  assert.equal(requiredRole('POST', '/api/clusters/x/operations'), 'operator'); assert.equal(requiredRole('POST', '/api/clusters/x/hba/apply'), 'operator');
  assert.equal(requiredRole('DELETE', '/api/clusters/x'), 'admin'); assert.equal(requiredRole('PUT', '/api/policies/assignments'), 'admin');
  assert.equal(requiredRole('POST', '/api/something/new'), 'admin');                       // deny by default
  assert(can('operator', 'GET', '/api/clusters') && !can('viewer', 'POST', '/api/clusters/x/operations'));

  // every mutating route that is mounted: print its required role so a human can review, and never leave one open to viewers by accident
  for (const r of app.routes.filter(r => r.method !== 'GET')) {
    const sample = r.re.source.replace(/^\^|\$$/g, '').replace(/\(\[\^\/\]\+\)/g, 'x').replace(/\\\//g, '/');
    if (sample.startsWith('/api/auth/') || sample.startsWith('/api/agent/')) continue;
    assert.notEqual(requiredRole(r.method, sample), 'viewer', `${r.method} ${sample} must not be open to viewers`);
  }

  const setup = await call('POST', '/api/auth/setup', { username: 'admin', password: PW }); const A = setup.headers['set-cookie'].split(';')[0];
  // no mounted API route may answer without a session, except the explicit public ones (login, agent gateway, liveness)
  const SAMPLE = (r: any) => r.re.source.replace(/^\^|\$$/g, '').replace(/\(\[\^\/\]\+\)/g, 'x').replace(/\\\//g, '/');
  for (const r of app.routes) { const u = SAMPLE(r); if (!u.startsWith('/api/') || u.startsWith('/api/auth/') || u.startsWith('/api/agent/') || u === '/api/health') continue;
    const x = await call(r.method, u, r.method === 'GET' ? undefined : {}); assert.equal(x.status, 401, `${r.method} ${u} must require login (got ${x.status})`); }
  for (const u of ['/API/users', '/Api/clusters', '/api/CLUSTERS']) assert.equal((await call('GET', u)).status, 401, `${u}: upper-case paths must not bypass the gate`);   // Express routes case-insensitively
  assert.equal((await call('GET', '/api/agent/heartbeat', undefined, undefined)).status !== 200, true);
  { const f = await app.call('POST', '/api/agent/heartbeat', { body: { snapshot: {} }, headers: { 'x-arca-node': '__proto__', authorization: 'Bearer x' } }); assert.equal(f.status, 401, 'prototype keys must not resolve to a node'); }
  assert.equal((await call('POST', '/api/users', { username: 'ops', password: 'operator-password-1', role: 'operator' }, A)).status, 201);
  assert.equal((await call('POST', '/api/users', { username: 'viewer1', password: 'viewer-password-12', role: 'viewer' }, A)).status, 201);
  assert.equal((await call('POST', '/api/users', { username: 'viewer1', password: 'viewer-password-12', role: 'viewer' }, A)).status, 409);
  assert.equal((await call('POST', '/api/users', { username: 'bad', password: 'short', role: 'viewer' }, A)).status, 400);
  assert.equal((await call('POST', '/api/users', { username: 'bad', password: 'long-enough-password', role: 'root' }, A)).status, 400);
  const login = async (u: string, p: string) => { const r = await call('POST', '/api/auth/login', { username: u, password: p }); assert.equal(r.status, 200, u); return r.headers['set-cookie'].split(';')[0]; };
  const O = await login('ops', 'operator-password-1'), V = await login('viewer1', 'viewer-password-12');
  assert.equal((await call('GET', '/api/auth/status', undefined, V)).body.role, 'viewer');

  // viewer: read only
  assert.equal((await call('GET', '/api/clusters', undefined, V)).status, 200);
  assert.equal((await call('POST', '/api/clusters/cluster-demo/operations', { type: 'pg_reload', params: {} }, V)).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, V)).status, 403);
  // operator: operate, but not administer
  assert.notEqual((await call('POST', '/api/clusters/cluster-demo/operations', { type: 'pg_reload', params: {} }, O)).status, 403);
  assert.equal((await call('DELETE', '/api/clusters/cluster-demo', undefined, O)).status, 403);
  assert.equal((await call('PUT', '/api/policies/assignments', { scope: 'global', inherit: true }, O)).status, 403);
  assert.equal((await call('POST', '/api/users', { username: 'x1x', password: 'long-enough-password', role: 'admin' }, O)).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, A)).body.users.length, 3);

  // audit carries the real user
  const aud = store.peek().audit.filter((e: any) => e.action === 'user.create').map((e: any) => e.actor); assert.deepEqual(aud, ['admin', 'admin']);

  // last admin cannot be removed; demotion/disable ends the session at once
  assert.equal((await call('POST', '/api/users', { username: 'adm2', password: 'second-admin-pass1', role: 'admin' }, A)).status, 201);
  assert.equal((await call('PATCH', '/api/users/adm2', { role: 'viewer' }, A)).status, 200);          // allowed: bootstrap admin still exists
  assert.equal((await call('PATCH', '/api/users/ops', { disabled: true }, A)).status, 200);
  assert.equal((await call('GET', '/api/clusters', undefined, O)).status, 401);                          // disabled → session revoked
  assert.equal((await call('POST', '/api/auth/login', { username: 'ops', password: 'operator-password-1' })).status, 401);
  assert.equal((await call('PATCH', '/api/users/viewer1', { role: 'operator' }, A)).status, 200);
  assert.equal((await call('GET', '/api/clusters', undefined, V)).status, 401);                          // role change → re-login
  assert.equal((await call('DELETE', '/api/users/viewer1', undefined, A)).status, 200);
  assert.equal((await call('PATCH', '/api/users/nobody', { role: 'viewer' }, A)).status, 404);

  // own password change works for a non-bootstrap user
  assert.equal((await call('PATCH', '/api/users/ops', { disabled: false }, A)).status, 200);
  await new Promise(r => setTimeout(r, 1200));
  const O2 = await login('ops', 'operator-password-1');
  assert.equal((await call('POST', '/api/auth/change-password', { currentPassword: 'operator-password-1', newPassword: 'operator-password-2' }, O2)).status, 200);
  await login('ops', 'operator-password-2');
  console.log('ALL RBAC TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
