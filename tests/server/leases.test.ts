import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
// Connection robustness review (16/10): outages must not lose the outcome of work that kept running on the agents.
(async () => {
  const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')));
  const T0 = Date.now();
  // a scheduled backup (ttl 1 h) leased and running for 3 h: the console restarts, the agent's keep-alives come back after the outage
  const a = await ops.submit(st, { type: 'backup_run', clusterId: 'c1', nodeId: 'n1', idempotencyKey: 'bk', ttlSeconds: 3600 });
  await ops.lease(st, 'n1', 1, 120, T0); await ops.report(st, 'n1', a.op.id, 'running');
  await st.mutate(d => { const o = d.operations.find(x => x.id === a.op.id)!; o.createdAt = new Date(T0 - 3 * 3600_000).toISOString(); o.leaseUntil = new Date(T0 - 600_000).toISOString(); });
  // 1. console boot: every lease gets a fresh period - the first heartbeat does not hand running work back
  assert.strictEqual(await ops.graceLeasesOnBoot(st, 120, T0), 1);
  await ops.lease(st, 'other', 1, 120, T0 + 1000);
  assert.strictEqual(st.peek().operations.find(o => o.id === a.op.id)!.status, 'running', 'still running after the restart');
  // 2. a long cut: the lease lapses and the op is handed back - but the ttl (1 h, counted from creation 3 h ago) does not expire it at once
  await ops.lease(st, 'other', 1, 120, T0 + 10 * 60_000);
  let o = st.peek().operations.find(x => x.id === a.op.id)!;
  assert.strictEqual(o.status, 'queued', 'handed back for redelivery, not expired: ' + o.status);
  // 3. the owning agent comes back: its keep-alive adopts the operation again, its outcome is recorded
  assert((await ops.report(st, 'n1', a.op.id, 'running')).ok, 'keep-alive of a handed-back op');
  assert.strictEqual(st.peek().operations.find(x => x.id === a.op.id)!.status, 'running');
  assert((await ops.report(st, 'n1', a.op.id, 'succeeded', { set: 'S1' })).ok);
  assert.strictEqual(st.peek().operations.find(x => x.id === a.op.id)!.status, 'succeeded');
  // 4. given up while the agent was away (max attempts): its real outcome still wins over 'agent did not report a result'
  const b = await ops.submit(st, { type: 'backup_run', clusterId: 'c2', nodeId: 'n2', idempotencyKey: 'bk2' });
  let now = T0; for (let i = 0; i < ops.MAX_ATTEMPTS + 1; i++) { now += 10 * 60_000; await ops.lease(st, 'n2', 1, 60, now); }
  assert.strictEqual(st.peek().operations.find(x => x.id === b.op.id)!.status, 'failed');
  assert((await ops.report(st, 'n2', b.op.id, 'succeeded', { set: 'S2' })).ok, 'the real outcome after a give-up');
  o = st.peek().operations.find(x => x.id === b.op.id)!; assert.strictEqual(o.status, 'succeeded'); assert.strictEqual(o.error, undefined);
  // 5. cancel: the agent re-sends 'failed' after the console recorded 'cancelled' (its first reply was lost): the same outcome, accepted
  const c = await ops.submit(st, { type: 'restore_instance', clusterId: 'c3', nodeId: 'n3', idempotencyKey: 'rc' });
  await ops.lease(st, 'n3', 1); await ops.report(st, 'n3', c.op.id, 'running');
  await st.mutate(d => { d.operations.find(x => x.id === c.op.id)!.cancelRequested = true; });
  assert((await ops.report(st, 'n3', c.op.id, 'failed', undefined, 'cancelled')).ok);
  assert.strictEqual(st.peek().operations.find(x => x.id === c.op.id)!.status, 'cancelled');
  assert((await ops.report(st, 'n3', c.op.id, 'failed', undefined, 'cancelled')).ok, 'a re-sent failed after cancelled is not a conflict');
  assert(!(await ops.report(st, 'n3', c.op.id, 'succeeded')).ok, 'a real conflict still is');
  // 6. never started within its ttl: still expires
  const d0 = await ops.submit(st, { type: 'wal_switch', clusterId: 'c4', nodeId: 'n4', idempotencyKey: 'ws', ttlSeconds: 10 });
  await ops.lease(st, 'nobody', 1, 60, Date.now() + 60_000);
  assert.strictEqual(st.peek().operations.find(x => x.id === d0.op.id)!.status, 'expired');
  // 6b. cut off while running: handed back, it keeps its lane (no second restore starts), a cancel is passed on when the agent returns
  { const r1 = await ops.submit(st, { type: 'restore_instance', clusterId: 'c5', nodeId: 'n5', idempotencyKey: 'r51' });
    await ops.lease(st, 'n5', 1); await ops.report(st, 'n5', r1.op.id, 'running');
    await ops.lease(st, 'n5', 0, 60, Date.now() + 300_000);                                  // the lease lapses: handed back
    assert.strictEqual(st.peek().operations.find(x => x.id === r1.op.id)!.status, 'queued');
    const r2 = await ops.submit(st, { type: 'restore_database', clusterId: 'c5', nodeId: 'n5b', idempotencyKey: 'r52' });
    assert.strictEqual((await ops.lease(st, 'n5b', 1, 60, Date.now() + 301_000)).length, 0, 'the lane stays taken while the first may still run');
    const cx = await ops.cancel(st, r1.op.id, 'dba');
    assert(cx.ok && /passed on/.test(cx.reason || ''), JSON.stringify(cx));
    assert.strictEqual(st.peek().operations.find(x => x.id === r1.op.id)!.status, 'queued', 'not marked cancelled while it may run');
    const k = await ops.report(st, 'n5', r1.op.id, 'running');                                // the agent is back: adopted, told to cancel
    assert(k.ok && k.cancel, JSON.stringify(k));
    await ops.report(st, 'n5', r1.op.id, 'failed', undefined, 'cancelled');
    assert.strictEqual(st.peek().operations.find(x => x.id === r1.op.id)!.status, 'cancelled');
    assert.strictEqual((await ops.lease(st, 'n5b', 1)).length, 1, 'then the lane is free');
    void r2; }
  // 6c. an agentless (direct) operation running when the console stopped: failed at the next boot, not 'running' for ever
  { await st.mutate(d => { d.operations.push({ id: 'dir1', type: 'patroni_switchover', clusterId: 'c6', status: 'running', attempts: 1, idempotencyKey: 'd1', createdBy: 'x',
      params: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [], ttlSeconds: 600 } as any); });
    await ops.graceLeasesOnBoot(st);
    const o = st.peek().operations.find(x => x.id === 'dir1')!; assert.strictEqual(o.status, 'failed'); assert(/outcome unknown/.test(o.error || '')); }
  // 7. tombstones are bounded
  await st.mutate(d => { for (let i = 0; i < 520; i++) ops.tombstone(d, 'node-' + i); });
  assert.strictEqual(Object.keys((st.peek().settings as any).revokedNodes).length, 500);
  console.log('leases OK');
})().catch(e => { console.error(e); process.exit(1); });
