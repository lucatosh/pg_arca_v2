// Store: transactional in-place mutations (undo journal), group commit, no-op without a write, no proxy ever leaks into the state.
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from '../../server/store';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
const st = new Store(dir);

await st.mutate(d => {
  d.clusters.push({ id: 'c1', name: 'one', tags: ['a', 'b'], nested: { x: 1 } });
  d.nodes['n1'] = { id: 'n1', name: 'node1', tokenHash: 'h', enrolledAt: 'now', clusterId: 'c1' } as any;
  d.settings.users = { u: { role: 'viewer' } };
});
const baseline = JSON.stringify(st.peek());
const w0 = st.writes;

// 1. a throwing mutation leaves EXACTLY the previous state, whatever it touched (set, delete, push, splice, sort, reassign, nested, spread of a live object)
await assert.rejects(st.mutate(d => {
  const c = d.clusters[0];
  c.name = 'changed'; c.tags.push('c'); c.tags.splice(0, 1); c.tags.sort(); delete c.nested.x; c.nested.y = 2;
  d.clusters = [...d.clusters, { ...c, id: 'c2' }];
  d.clusters.reverse();
  delete d.nodes['n1']; d.nodes['n2'] = { id: 'n2' } as any;
  d.settings.users.u.role = 'admin'; d.settings.extra = { deep: [1, 2, 3] };
  d.operations.push({} as any, {} as any); d.operations.length = 0;
  throw new Error('boom');
}), /boom/);
assert.strictEqual(JSON.stringify(st.peek()), baseline, 'rolled back to the byte');
assert.strictEqual(st.writes, w0, 'nothing written for a failed mutation');

// 2. a mutation that changes nothing returns at once and does not write
const r = await st.mutate(d => d.clusters.find((c: any) => c.id === 'c1')?.name);
assert.strictEqual(r, 'one'); assert.strictEqual(st.writes, w0);

// 3. results and the state never contain proxies (structuredClone throws on a Proxy)
const out = await st.mutate(d => { const c = d.clusters[0]; d.clusters[0] = { ...c, name: 'two', copy: { ref: c.nested } }; return { c: d.clusters[0], list: d.clusters.filter(() => true) }; });
structuredClone(out); structuredClone(st.peek());
assert.strictEqual(st.peek().clusters[0].name, 'two');
assert.strictEqual(st.peek().clusters[0].copy.ref, st.peek().clusters[0].nested, 'the live object itself was stored, not a wrapper');

// 4. group commit: many concurrent mutations, few writes, all durable when their promises resolve
const w1 = st.writes;
await Promise.all(Array.from({ length: 200 }, (_, i) => st.mutate(d => { d.audit.push({ i }); })));
assert.strictEqual(st.peek().audit.length, 200);
assert(st.writes - w1 <= 3, `200 mutations grouped into ${st.writes - w1} writes`);
const again = new Store(dir);
assert.strictEqual(again.peek().audit.length, 200, 'durable once resolved');
assert.strictEqual(JSON.stringify(again.peek()), JSON.stringify(st.peek()));
assert(fs.existsSync(path.join(dir, 'state.json.bak')), 'previous generation kept');

// 5. cost does not grow with the state for a small change: a 10 MB state, one heartbeat-like change
const big = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'store-big-')));
await big.mutate(d => { for (let i = 0; i < 3000; i++) d.operations.push({ id: 'op' + i, result: { rows: Array.from({ length: 200 }, (_, k) => ({ k, name: 'table_' + k })) }, history: [] } as any); d.nodes.n = { id: 'n' } as any; });
const t0 = performance.now();
for (let i = 0; i < 50; i++) big.mutate(d => { d.nodes.n.lastSeen = String(i); });     // not awaited: the event loop is what we measure
const sync = (performance.now() - t0) / 50;
await big.flush();
assert(sync < 5, `a small mutation blocks the event loop ${sync.toFixed(2)} ms on a big state`);
console.log(`store: small mutation on a ${(fs.statSync(path.join(big.dir, 'state.json')).size / 1e6).toFixed(1)} MB state = ${sync.toFixed(3)} ms of event loop; writes grouped`);
console.log('store tests OK');
