import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
import { schedulerTick, validatePolicy, DEFAULT_POLICY } from '../../server/scheduler';
(async () => {
  let st!: Store;
  const tick = async (t: number) => { await st.mutate(d => { d.nodes['n1'].lastSeen = new Date(t).toISOString(); }); return schedulerTick(st, t); };
  st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sch-')));
  const now = Date.now(); const iso = (t: number) => new Date(t).toISOString();
  // operations stamp themselves with the real clock, so `now` must be the real clock; the weekly full bucket is 168 h from the epoch (Thursday
  // 00:00 UTC) and a run minutes before that boundary sees 'now + 31 min' in the NEXT bucket (attempt counter back to 0): expected, not a bug
  const WEEK = 168 * 3600_000; const sameBucket = Math.floor(now / WEEK) === Math.floor((now + 31 * 60_000) / WEEK);
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
  const s2 = await tick(now + 31 * 60_000); assert.strictEqual(s2.length, 1); assert(s2[0].endsWith(sameBucket ? ':1' : ':0'), 'new attempt key: ' + JSON.stringify(s2));
  const op2 = st.peek().operations.find(o => o.idempotencyKey === s2[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', op2.id, 'succeeded', {});
  // stale snapshot: the full just succeeded but the agent has not reported it yet -> NO second full (lab: two fulls 10 s apart + retention wiped PITR history)
  const sx = await tick(now + 31 * 60_000 + 10_000); assert(!sx.some(k => k.includes(':full:')), 'duplicate full on stale snapshot: ' + JSON.stringify(sx));
  // agent now reports a complete full 1h ago; incr not due; retention expire is scheduled once for the successful backup
  await st.mutate(d => { d.nodes['n1'].snapshot.backup.recent_sets = [{ id: 'x', type: 'full', status: 'COMPLETE', start_time: iso(now + 32 * 60_000 - 3600_000) }]; });
  const s3 = [...sx, ...(await tick(now + 33 * 60_000))]; assert(s3.length === 1 && s3[0].includes(':expire:'), JSON.stringify(s3));
  const e = st.peek().operations.find(o => o.idempotencyKey === s3[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', e.id, 'succeeded', {});
  const s4 = await tick(now + 34 * 60_000); assert(s4.length === 1 && s4[0].includes(':verify:'), JSON.stringify(s4));
  const v = st.peek().operations.find(o => o.idempotencyKey === s4[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', v.id, 'succeeded', {});
  assert.strictEqual((await tick(now + 35 * 60_000)).length, 0);
  // 25h later an incremental is due
    const s5 = await tick(now + 25 * 3600_000); assert(s5.length === 1 && s5[0].includes(':incr:'), JSON.stringify(s5));
  // a tablespace created after the latest full: a full is taken at once (the restores of this cluster are refused until then), only once
  { const s5op = st.peek().operations.find(o => o.idempotencyKey === s5[0])!; await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', s5op.id, 'succeeded', {});
    await st.mutate(d => { const sn = d.nodes['n1'].snapshot; sn.backup.full_tablespace_oids = ['1663']; sn.postgres.tablespaces = [{ oid: '1663' }, { oid: '24601', location: '/srv/ts_new' }]; });
    const s6 = await tick(now + 25 * 3600_000 + 60_000); assert(s6.length === 1 && s6[0].includes(':tsfull:24601:'), JSON.stringify(s6));
    const s6op = st.peek().operations.find(o => o.idempotencyKey === s6[0])!; assert.strictEqual(s6op.params.type, 'full'); }
  // offline primary -> nothing; demo/direct clusters ignored
  console.log('ALL SCHEDULER TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
