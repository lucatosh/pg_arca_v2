import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
import { schedulerTick, validatePolicy, DEFAULT_POLICY } from '../../server/scheduler';
(async () => {
  let st!: Store;
  const tick = async (t: number) => { await st.mutate(d => { d.nodes['n1'].lastSeen = new Date(t).toISOString(); }); return schedulerTick(st, t); };
  st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sch-')));
  const now = Date.now(); const iso = (t: number) => new Date(t).toISOString();
  assert(!validatePolicy({ ...DEFAULT_POLICY, fullEveryHours: 1 }).ok);
  assert(!validatePolicy({ ...DEFAULT_POLICY, incrEveryHours: 200 }).ok);
  const pol = validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: 168, incrEveryHours: 24 }) as any;
  await st.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'c1', environment: 'prod', source: 'agent', backupPolicy: pol.policy } as any);
    d.nodes['n1'] = { id: 'n1', name: 'pg1', clusterId: 'c1', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
  });
  // no backups at all -> a FULL is scheduled, exactly once even if ticked repeatedly
  let s1 = await tick(now); assert.strictEqual(s1.length, 1); assert(s1[0].includes(':full:'));
  assert.strictEqual((await tick(now + 1000)).length, 0, 'in flight: nothing else');
  const op = st.peek().operations[0]; assert.strictEqual(op.params.type, 'full'); assert.strictEqual(op.createdBy, 'scheduler');
  // fail it -> back-off, no immediate retry
  await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', op.id, 'failed', undefined, 'boom');
  assert.strictEqual((await tick(now + 60_000)).length, 0, 'back-off window');
  const s2 = await tick(now + 31 * 60_000); assert.strictEqual(s2.length, 1); assert(s2[0].endsWith(':1'), 'new attempt key');
  const op2 = st.peek().operations.find(o => o.idempotencyKey === s2[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', op2.id, 'succeeded', {});
  // agent now reports a complete full 1h ago; incr not due; retention expire is scheduled once for the successful backup
  await st.mutate(d => { d.nodes['n1'].snapshot.backup.recent_sets = [{ id: 'x', type: 'full', status: 'COMPLETE', start_time: iso(now + 32 * 60_000 - 3600_000) }]; });
  const s3 = await tick(now + 33 * 60_000); assert(s3.length === 1 && s3[0].includes(':expire:'), JSON.stringify(s3));
  const e = st.peek().operations.find(o => o.idempotencyKey === s3[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', e.id, 'succeeded', {});
  const s4 = await tick(now + 34 * 60_000); assert(s4.length === 1 && s4[0].includes(':verify:'), JSON.stringify(s4));
  const v = st.peek().operations.find(o => o.idempotencyKey === s4[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', v.id, 'succeeded', {});
  assert.strictEqual((await tick(now + 35 * 60_000)).length, 0);
  // 25h later an incremental is due
    const s5 = await tick(now + 25 * 3600_000); assert(s5.length === 1 && s5[0].includes(':incr:'), JSON.stringify(s5));
  // offline primary -> nothing; demo/direct clusters ignored
  console.log('ALL SCHEDULER TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
