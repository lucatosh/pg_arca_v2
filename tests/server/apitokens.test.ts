import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountAuthRoutes, mountApiTokenRoutes, requireAdmin } from '../../server/auth';
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-')); const store = new Store(dir), app = new MiniApp();
  app.use(requireAdmin(store)); mountAuthRoutes(app, store); mountApiTokenRoutes(app, store);
  app.get('/api/clusters', (_q: any, r: any) => r.json({ clusters: [], actor: _q.actor, role: _q.role }));
  app.post('/api/clusters/c1/operations', (_q: any, r: any) => r.status(202).json({ by: _q.actor }));
  const call = (m: string, u: string, body?: any, h: any = {}) => app.call(m, u, { body, headers: h });
  const setup = await call('POST', '/api/auth/setup', { username: 'admin', password: 'correct-horse-battery' }); const cookie = setup.headers['set-cookie'].split(';')[0];
  const H = (x: any = {}) => ({ cookie, ...x });
  // create: admin only, label and role validated, token shown once
  assert.strictEqual((await call('POST', '/api/api-tokens', { label: 'ci', role: 'operator' })).status, 401);
  assert.strictEqual((await call('POST', '/api/api-tokens', { label: 'x', role: 'operator' }, H())).status, 400);
  assert.strictEqual((await call('POST', '/api/api-tokens', { label: 'ci deploy', role: 'root' }, H())).status, 400);
  const t1 = await call('POST', '/api/api-tokens', { label: 'ci deploy', role: 'operator' }, H()); assert.strictEqual(t1.status, 201);
  assert(/^arca_api_[A-Za-z0-9_-]{30,}$/.test(t1.body.token)); assert.strictEqual(t1.body.expiresAt, null);
  const lst = await call('GET', '/api/api-tokens', undefined, H()); assert.strictEqual(lst.body.tokens.length, 1); assert(!('token' in lst.body.tokens[0]) && !('hash' in lst.body.tokens[0]), 'the secret is never listed');
  // use it: role operator -> reads and operations yes, admin routes no; the actor is token:<label>
  const B = { authorization: 'Bearer ' + t1.body.token };
  const g = await call('GET', '/api/clusters', undefined, B); assert.strictEqual(g.status, 200); assert.strictEqual(g.body.actor, 'token:ci deploy'); assert.strictEqual(g.body.role, 'operator');
  assert.strictEqual((await call('POST', '/api/clusters/c1/operations', { type: 'x' }, { ...B, 'content-type': 'application/json' })).body.by, 'token:ci deploy');
  assert.strictEqual((await call('GET', '/api/api-tokens', undefined, B)).status, 403, 'an operator token cannot list tokens');
  assert.strictEqual((await call('GET', '/api/clusters', undefined, { authorization: 'Bearer arca_api_nope' })).status, 401);
  assert.strictEqual((await call('GET', '/api/clusters', undefined, { authorization: 'Bearer other-scheme' })).status, 401);
  assert(store.peek().settings.apiTokens[t1.body.id].lastUsedAt, 'use is recorded');
  // viewer token: read only
  const t2 = await call('POST', '/api/api-tokens', { label: 'grafana', role: 'viewer', ttlDays: 1 }, H()); assert(t2.body.expiresAt);
  const V = { authorization: 'Bearer ' + t2.body.token };
  assert.strictEqual((await call('GET', '/api/clusters', undefined, V)).status, 200);
  assert.strictEqual((await call('POST', '/api/clusters/c1/operations', { type: 'x' }, { ...V, 'content-type': 'application/json' })).status, 403);
  // expiry and revocation
  await store.mutate(d => { d.settings.apiTokens[t2.body.id].expiresAt = new Date(Date.now() - 1000).toISOString(); });
  assert.strictEqual((await call('GET', '/api/clusters', undefined, V)).status, 401, 'expired');
  assert.strictEqual((await call('DELETE', `/api/api-tokens/${t1.body.id}`, undefined, H())).status, 200);
  assert.strictEqual((await call('GET', '/api/clusters', undefined, B)).status, 401, 'revoked');
  assert.strictEqual((await call('DELETE', '/api/api-tokens/nope', undefined, H())).status, 404);
  assert(store.peek().audit.some((a: any) => a.action === 'apitoken.create') && store.peek().audit.some((a: any) => a.action === 'apitoken.revoke'));
  console.log('api tokens OK');
})();
