import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountHbaRoutes, HBA_TEMPLATES, HBA_SUGGESTED } from '../../server/hba';
import { validateOp } from '../../server/optypes';
import { hbaExpiryTick } from '../../server/scheduler';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hba-'))); const app = new MiniApp(); mountHbaRoutes(app, store);
  const now = new Date().toISOString();
  await store.mutate(d => {
    d.clusters.push({ id: 'k1', name: 'k1', environment: 'prod', source: 'agent', haState: { managedByPatroni: false } } as any, { id: 'k2', name: 'k2', environment: 'prod', source: 'agent', haState: { managedByPatroni: true } } as any,
      { id: 'demo', name: 'd', environment: 'dev', isSandbox: true } as any, { id: 'dir', name: 'x', environment: 'dev', source: 'direct' } as any);
    for (const [id, cl, acc] of [['a', 'k1', false], ['b', 'k1', false], ['c', 'k2', false], ['d2', 'k2', true]] as any) d.nodes[id] = { id, name: id, clusterId: cl, lastSeen: now, snapshot: { patroni: { accessible: acc }, postgres: {} } } as any;
  });
  const call = (m: string, u: string, body?: any, h: any = {}) => app.call(m, u, { body, headers: h });
  const t = (await call('GET', '/api/hba/templates')).body;
  assert(t.templates.length >= 6); for (const id of Object.values(HBA_SUGGESTED).flat()) assert(HBA_TEMPLATES.some(x => x.id === id), 'suggested id exists: ' + id);
  const rules = [{ type: 'hostssl', database: 'all', user: 'app', address: '10.0.0.0/24', method: 'scram-sha-256' }];
  assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules })).status, 400, 'idempotency key required');
  const k = { 'idempotency-key': 'h1' };
  const r1 = await call('POST', '/api/clusters/k1/hba/apply', { rules, baseRevs: { a: '0123456789abcdef' } }, k); assert.strictEqual(r1.status, 202);
  assert.strictEqual(r1.body.operations.length, 2, 'non-Patroni: every online node'); assert.strictEqual(r1.body.mode, 'per-node');
  assert.strictEqual(r1.body.operations.find((o: any) => o.nodeId === 'a').operation.params.base_rev, '0123456789abcdef');
  const r2 = await call('POST', '/api/clusters/k1/hba/apply', { rules, baseRevs: { a: '0123456789abcdef' } }, k); assert(r2.body.operations.every((o: any) => o.replayed), 'same intent replays');
  assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules: [] }, k)).status, 422, 'same key, different request');
  const p = await call('POST', '/api/clusters/k2/hba/apply', { rules }, { 'idempotency-key': 'h2' });
  assert.strictEqual(p.body.operations.length, 1, 'Patroni: DCS edited once'); assert.strictEqual(p.body.operations[0].nodeId, 'd2'); assert.strictEqual(p.body.mode, 'patroni');
  assert.strictEqual((await call('POST', '/api/clusters/demo/hba/apply', { rules }, k)).status, 409);
  assert.strictEqual((await call('POST', '/api/clusters/dir/hba/apply', { rules }, k)).status, 409);
  assert.strictEqual((await call('POST', '/api/clusters/nope/hba/apply', { rules }, k)).status, 404);
  assert.strictEqual(validateOp('hba_apply', { rules: 'x' }) !== null, true); assert.strictEqual(validateOp('hba_apply', { rules: [], base_rev: 'zz' }) !== null, true); assert.strictEqual(validateOp('hba_plan', { rules: [] }), null);
  // adopt flag travels to the agent; temporary rules are remembered and expired by the scheduler on every online file-mode node
  const ad = await call('POST', '/api/clusters/k1/hba/apply', { rules, adopt: true }, { 'idempotency-key': 'h3' }); assert.strictEqual(ad.body.operations[0].operation.params.adopt, true);
  const soon = new Date(Date.now() + 120_000).toISOString().slice(0, 16);
  const tmp = [...rules, { type: 'hostssl', database: 'all', user: 'ext', address: '10.9.0.0/24', method: 'scram-sha-256', comment: `Consulente [until=${soon}Z]` }];
  await call('POST', '/api/clusters/k1/hba/apply', { rules: tmp }, { 'idempotency-key': 'h4' });
  assert.strictEqual(store.peek().settings.hbaExpiry.k1.length, 1);
  assert.deepStrictEqual(await hbaExpiryTick(store, Date.now()), [], 'not due yet');
  const later = Date.now() + 5 * 60_000; await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date(later).toISOString(); });
  const sub = await hbaExpiryTick(store, later); assert.strictEqual(sub.length, 2, JSON.stringify(sub));
  assert.deepStrictEqual(await hbaExpiryTick(store, later), [], 'same bucket: idempotent');
  assert.strictEqual(store.peek().operations.filter(o => o.type === 'hba_expire').length, 2);
  // both nodes confirm -> the entry is pruned
  for (const o of store.peek().operations.filter(o => o.type === 'hba_expire')) await store.mutate(d => { const x = d.operations.find(y => y.id === o.id)!; x.status = 'succeeded'; x.createdAt = new Date(later + 1000).toISOString(); });
  await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date(later + 1000).toISOString(); });
  await hbaExpiryTick(store, later + 1000); assert.strictEqual(store.peek().settings.hbaExpiry?.k1, undefined);
  console.log('ALL HBA TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
