import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountPolicyRoutes, resolvePolicy, BUILTIN_TEMPLATES } from '../../server/policies';
import { schedulerTick } from '../../server/scheduler';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pol-'))); const app = new MiniApp(); mountPolicyRoutes(app, store);
  const call = (m: string, u: string, body?: any) => app.call(m, u, { body });
  const now = Date.now();
  await store.mutate(d => {
    d.clusters.push({ id: 'a', name: 'a', environment: 'prod', folder: 'Finance/EMEA', source: 'agent' } as any, { id: 'b', name: 'b', environment: 'prod', folder: '', source: 'agent' } as any,
      { id: 'c', name: 'c', environment: 'dev', folder: 'Finance', source: 'agent' } as any, { id: 'demo', name: 'demo', environment: 'dev', isSandbox: true } as any);
    for (const [id, cl] of [['n1', 'a'], ['n2', 'b']]) d.nodes[id] = { id, name: id, clusterId: cl, lastSeen: new Date(now).toISOString(), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
  });
  const eff = (id: string) => resolvePolicy(store.peek(), store.peek().clusters.find((c: any) => c.id === id));
  assert.strictEqual(eff('a').policy, null, 'nothing assigned -> no backups');
  // env level
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'env', key: 'prod', templateId: 'prod-standard' })).status, 200);
  assert.strictEqual(eff('a').source.scope, 'env'); assert.strictEqual(eff('b').policy!.retentionFull, 2); assert.strictEqual(eff('c').policy, null);
  // folder beats env; deeper folder beats shallower
  await call('PUT', '/api/policies/assignments', { scope: 'folder', key: 'Finance', templateId: 'compliance' });
  assert.strictEqual(eff('a').source.templateId, 'compliance'); assert.strictEqual(eff('c').source.scope, 'folder'); assert.strictEqual(eff('b').source.scope, 'env');
  await call('PUT', '/api/policies/assignments', { scope: 'folder', key: 'Finance/EMEA', templateId: 'prod-critical' });
  assert.strictEqual(eff('a').source.templateId, 'prod-critical'); assert.strictEqual(eff('c').source.templateId, 'compliance');
  // cluster beats everything; "disabled" stops inheritance; inherit removes the override
  await call('PUT', '/api/policies/assignments', { scope: 'cluster', key: 'a', disabled: true });
  assert.strictEqual(eff('a').policy, null); assert(eff('a').source.disabled);
  await call('PUT', '/api/policies/assignments', { scope: 'cluster', key: 'a', policy: { fullEveryHours: 48, incrEveryHours: 6, retentionFull: 5 } });
  assert.strictEqual(eff('a').policy!.fullEveryHours, 48);
  await call('PUT', '/api/policies/assignments', { scope: 'cluster', key: 'a', inherit: true });
  assert.strictEqual(eff('a').source.templateId, 'prod-critical');
  // validation
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'env', key: 'moon', templateId: 'dev-light' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'env', key: 'dev', templateId: 'nope' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'cluster', key: 'demo', templateId: 'dev-light' })).status, 404, 'demo cluster is not schedulable');
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'folder', key: 'a<b', templateId: 'dev-light' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/policies/assignments', { scope: 'cluster', key: 'a', policy: { fullEveryHours: 2 } })).status, 400);
  // custom templates: builtin ids protected, in-use protected
  assert.strictEqual((await call('PUT', '/api/policies/templates/prod-standard', { name: 'x', policy: {} })).status, 400);
  const cr = await call('PUT', '/api/policies/templates/nightly', { name: 'Notturno', policy: { fullEveryHours: 24, incrEveryHours: 0, retentionFull: 7 } }); assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  await call('PUT', '/api/policies/assignments', { scope: 'env', key: 'test', templateId: 'nightly' });
  assert.strictEqual((await call('DELETE', '/api/policies/templates/nightly')).status, 409);
  assert.strictEqual((await call('PUT', '/api/policies/templates/bad', { name: 'x', policy: { fullEveryHours: 1 } })).status, 400);
  const list = (await call('GET', '/api/policies')).body; assert.strictEqual(list.templates.length, BUILTIN_TEMPLATES.length + 1); assert.deepStrictEqual(list.folders, ['Finance', 'Finance/EMEA']);
  assert(list.clusters.every((c: any) => c.id !== 'demo'));
  // scheduler consumes the resolved policy (no per-cluster copy): a (folder Finance/EMEA) and b (env prod) both get a full
  const s = await schedulerTick(store, now); assert.strictEqual(s.length, 2, JSON.stringify(s));
  // a template change applies at once to everyone using it
  await call('PUT', '/api/policies/templates/nightly', { name: 'Notturno', policy: { fullEveryHours: 48, incrEveryHours: 0, retentionFull: 3 } });
  assert.strictEqual(resolvePolicy(store.peek(), { id: 'z', environment: 'test', folder: '' }).policy!.fullEveryHours, 48);
  console.log('ALL POLICY TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
