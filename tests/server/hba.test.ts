import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountHbaRoutes, HBA_TEMPLATES, HBA_SUGGESTED, recordHbaHistory, hbaTarget } from '../../server/hba';
import { validateOp } from '../../server/optypes';
import { hbaExpiryTick } from '../../server/scheduler';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hba-'))); const app = new MiniApp();
  let role = 'admin'; app.use((req: any, _r: any, next: any) => { req.actor = 'mario'; req.role = role; return next(); }); mountHbaRoutes(app, store);
  const now = new Date().toISOString();
  await store.mutate(d => {
    d.clusters.push({ id: 'k1', name: 'k1', environment: 'prod', source: 'agent', haState: { managedByPatroni: false } } as any, { id: 'k2', name: 'k2', environment: 'prod', source: 'agent', haState: { managedByPatroni: true } } as any,
      { id: 'demo', name: 'd', environment: 'dev', isSandbox: true } as any, { id: 'dir', name: 'x', environment: 'dev', source: 'direct' } as any);
    for (const [id, cl, acc] of [['a', 'k1', false], ['b', 'k1', false], ['c', 'k2', false], ['d2', 'k2', true]] as any) d.nodes[id] = { id, name: id, clusterId: cl, lastSeen: now, snapshot: { patroni: { accessible: acc }, postgres: {} } } as any;
  });
  const call = (m: string, u: string, body?: any, h: any = {}) => app.call(m, u, { body, headers: h });
  const finish = () => store.mutate(d => { for (const o of d.operations) if (o.type.startsWith('hba_') && ['queued', 'leased', 'running'].includes(o.status)) o.status = 'succeeded'; });
  const t = (await call('GET', '/api/hba/templates')).body;
  assert(t.templates.length >= 6); for (const id of Object.values(HBA_SUGGESTED).flat()) assert(HBA_TEMPLATES.some(x => x.id === id), 'suggested id exists: ' + id);
  const rules = [{ type: 'hostssl', database: 'all', user: 'app', address: '10.0.0.0/24', method: 'scram-sha-256' }];
  assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules })).status, 400, 'idempotency key required');
  const k = { 'idempotency-key': 'h1' };
  const nc = await call('POST', '/api/clusters/k1/hba/apply', { rules, baseRevs: { a: '0123456789abcdef' } }, { 'idempotency-key': 'h0' });
  assert.strictEqual(nc.status, 409, 'a node whose rules were not read is not changed blindly'); assert.strictEqual(nc.body.error, 'not_checked');
  const r1 = await call('POST', '/api/clusters/k1/hba/apply', { rules, baseRevs: { a: '0123456789abcdef', b: 'fedcba9876543210' } }, k); assert.strictEqual(r1.status, 202);
  assert.strictEqual(r1.body.operations.length, 2, 'non-Patroni: every online node'); assert.strictEqual(r1.body.mode, 'per-node');
  assert.strictEqual(r1.body.operations.find((o: any) => o.nodeId === 'a').operation.params.base_rev, '0123456789abcdef');
  const r2 = await call('POST', '/api/clusters/k1/hba/apply', { rules, baseRevs: { a: '0123456789abcdef', b: 'fedcba9876543210' } }, k); assert(r2.body.operations.every((o: any) => o.replayed), 'same intent replays');
  assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules: [] }, k)).status, 422, 'same key, different request');
  const p = await call('POST', '/api/clusters/k2/hba/apply', { rules, baseRevs: { c: '00112233aabbccdd' } }, { 'idempotency-key': 'h2' });
  assert.strictEqual(p.body.operations.length, 1, 'Patroni: DCS edited once');
  assert.strictEqual(p.body.operations[0].operation.params.base_rev, '00112233aabbccdd', 'the DCS revision read through another node still protects the edit'); assert.strictEqual(p.body.operations[0].nodeId, 'd2'); assert.strictEqual(p.body.mode, 'patroni');
  assert.strictEqual((await call('POST', '/api/clusters/demo/hba/apply', { rules }, k)).status, 409);
  assert.strictEqual((await call('POST', '/api/clusters/dir/hba/apply', { rules }, k)).status, 409);
  assert.strictEqual((await call('POST', '/api/clusters/nope/hba/apply', { rules }, k)).status, 404);
  { // opening the server to the network without a password (trust) or with a clear-text one: administrators only; local trust stays an operator's call
    await finish();
    const open = [{ type: 'host', database: 'all', user: 'all', address: '0.0.0.0/0', method: 'trust' }];
    role = 'operator';
    const o = await call('POST', '/api/clusters/k1/hba/apply', { rules: open }, { 'idempotency-key': 'open-1' }); assert.strictEqual(o.status, 403, JSON.stringify(o.body)); assert(/0\.0\.0\.0\/0 trust/.test(o.body.message));
    assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules: [{ type: 'host', database: 'all', user: 'all', address: '10.0.0.0/8', method: 'password' }] }, { 'idempotency-key': 'open-2' })).status, 403);
    assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules: [{ type: 'host', database: 'all', user: 'all', address: '127.0.0.1/32', method: 'trust' }, { type: 'local', database: 'all', user: 'postgres', method: 'trust' }] }, { 'idempotency-key': 'open-3' })).status, 202, 'local trust is not an opening to the network');
    role = 'admin'; await finish();
    assert.strictEqual((await call('POST', '/api/clusters/k1/hba/apply', { rules: open }, { 'idempotency-key': 'open-4' })).status, 202); }
  assert.strictEqual(validateOp('hba_apply', { rules: 'x' }) !== null, true); assert.strictEqual(validateOp('hba_apply', { rules: [], base_rev: 'zz' }) !== null, true); assert.strictEqual(validateOp('hba_plan', { rules: [] }), null);
  // a second pg_hba change while one is still queued is refused (another DBA): who and since when
  const busy = await call('POST', '/api/clusters/k1/hba/apply', { rules: [] }, { 'idempotency-key': 'h-busy' }); assert.strictEqual(busy.status, 409); assert.strictEqual(busy.body.error, 'conflict');
  await finish();
  // adopt flag travels to the agent; temporary rules are remembered and expired by the scheduler on every online file-mode node
  const ad = await call('POST', '/api/clusters/k1/hba/apply', { rules, adopt: true }, { 'idempotency-key': 'h3' }); assert.strictEqual(ad.body.operations[0].operation.params.adopt, true);
  await finish();
  const soon = new Date(Date.now() + 120_000).toISOString().slice(0, 16);
  const tmp = [...rules, { type: 'hostssl', database: 'all', user: 'ext', address: '10.9.0.0/24', method: 'scram-sha-256', comment: `Consulente [until=${soon}Z]` }];
  await call('POST', '/api/clusters/k1/hba/apply', { rules: tmp }, { 'idempotency-key': 'h4' });
  await finish();
  assert.strictEqual(store.peek().settings.hbaExpiry.k1.length, 1);
  assert.deepStrictEqual(await hbaExpiryTick(store, Date.now()), [], 'not due yet');
  const later = Date.now() + 5 * 60_000; await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date(later).toISOString(); });
  const sub = await hbaExpiryTick(store, later); assert.strictEqual(sub.length, 2, JSON.stringify(sub));
  assert.deepStrictEqual(await hbaExpiryTick(store, later), [], 'same bucket: idempotent');
  assert.strictEqual(store.peek().operations.filter(o => o.type === 'hba_expire').length, 2);
  // one node confirms while the other is offline (rebooting): the entry stays until that one is back and done
  const exp = store.peek().operations.filter(o => o.type === 'hba_expire');
  const offNode = exp[1].nodeId;
  await store.mutate(d => { const x = d.operations.find(y => y.id === exp[0].id)!; x.status = 'succeeded'; x.createdAt = new Date(later + 1000).toISOString();
    const y = d.operations.find(z => z.id === exp[1].id)!; y.status = 'expired';
    for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date((n as any).id === offNode ? later - 3600_000 : later + 1000).toISOString(); });
  await hbaExpiryTick(store, later + 1000); assert.strictEqual(store.peek().settings.hbaExpiry?.k1?.length, 1, 'kept: a node has not removed the rule yet');
  await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date(later + 700_000).toISOString(); });
  const back = await hbaExpiryTick(store, later + 700_000); assert.deepStrictEqual(back, [`k1:${offNode}`], 'sent to the node that came back');
  // both nodes done -> the entry is pruned
  for (const o of store.peek().operations.filter(o => o.type === 'hba_expire' && o.status !== 'expired')) await store.mutate(d => { const x = d.operations.find(y => y.id === o.id)!; x.status = 'succeeded'; x.createdAt = new Date(later + 701_000).toISOString(); });
  await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date(later + 701_000).toISOString(); });
  await hbaExpiryTick(store, later + 701_000); assert.strictEqual(store.peek().settings.hbaExpiry?.k1, undefined);
  // Patroni: history of DCS lists kept by the console, restore goes to the DCS editor node, temporary rules expired by ONE member
  await store.mutate(d => { for (const n of Object.values(d.nodes)) (n as any).lastSeen = new Date().toISOString(); (d.nodes as any).c.snapshot = { patroni: { accessible: true, local_node: { role: 'leader' } }, postgres: { alive: true } }; });
  assert.strictEqual(hbaTarget(store.peek(), 'k2').id, 'c', 'leader preferred');
  await recordHbaHistory(store, { id: 'o1', clusterId: 'k2', createdBy: 'mario', result: { mode: 'patroni', changed: true, previous: null, seed_list: ['local all all peer'], list: ['local all all peer', 'host all app 10.0.0.0/24 scram-sha-256'] } });
  await recordHbaHistory(store, { id: 'o2', clusterId: 'k2', createdBy: 'anna', result: { mode: 'patroni', changed: true, previous: ['local all all peer', 'host all app 10.0.0.0/24 scram-sha-256'], previous_rev: '0123456789abcdef', list: ['local all all peer'] } });
  await recordHbaHistory(store, { id: 'o3', clusterId: 'k1', result: { mode: 'file', changed: true } });
  const hist = (await call('GET', '/api/clusters/k2/hba/history')).body.history;
  assert.strictEqual(hist.length, 2); assert.strictEqual(hist[0].by, 'anna'); assert.strictEqual(hist[0].rules, 2); assert.strictEqual(hist[1].seed, true);
  assert.strictEqual((await call('GET', '/api/clusters/k1/hba/history')).body.history.length, 0, 'file mode keeps backups on the node');
  const rs = await call('POST', '/api/clusters/k2/hba/restore', { index: 0, baseRev: 'fedcba9876543210' }, { 'idempotency-key': 'r1' });
  assert.strictEqual(rs.status, 202, JSON.stringify(rs.body)); assert.strictEqual(rs.body.operation.type, 'hba_restore'); assert.strictEqual(rs.body.operation.nodeId, 'c');
  assert.deepStrictEqual(rs.body.operation.params.list, hist[0].list);
  assert.strictEqual((await call('POST', '/api/clusters/k1/hba/restore', { index: 0 }, { 'idempotency-key': 'r2' })).status, 409);
  assert.strictEqual((await call('POST', '/api/clusters/k2/hba/restore', { index: 9 }, { 'idempotency-key': 'r3' })).status, 404);
  assert(validateOp('hba_restore', { list: ['a\nb'] }), 'no multi-line entries');
  await finish();
  const past = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
  await call('POST', '/api/clusters/k2/hba/apply', { rules: [{ type: 'hostssl', database: 'all', user: 'ext', address: '10.9.0.0/24', method: 'scram-sha-256', comment: `x [until=${past}Z]` }] }, { 'idempotency-key': 'h9' });
  await finish();
  const subP = await hbaExpiryTick(store, Date.now()); assert.deepStrictEqual(subP, ['k2:c'], 'Patroni: one member edits the DCS');
  console.log('ALL HBA TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
