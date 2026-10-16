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
  { // heavy-work window: a due full waits for the window (incrementals do not); a cluster with no full at all is protected at once
    const { inWindow } = await import('../../server/policies');
    const at = (hr: number) => { const d = new Date(); d.setHours(hr, 30, 0, 0); return d.getTime(); };
    const w = { ...DEFAULT_POLICY, windowStart: 22, windowEnd: 6 };
    assert(inWindow(w, at(23)) && inWindow(w, at(2)) && !inWindow(w, at(12)) && !inWindow(w, at(6)) && inWindow(w, at(22)));
    assert(inWindow({ ...DEFAULT_POLICY, windowStart: 9, windowEnd: 17 }, at(12)) && !inWindow({ ...DEFAULT_POLICY, windowStart: 9, windowEnd: 17 }, at(20)));
    assert(inWindow({ ...DEFAULT_POLICY, windowStart: 3, windowEnd: 3 }, at(12)), 'equal hours = no window');
  }
  assert(!validatePolicy({ ...DEFAULT_POLICY, readLimitMBs: -1 }).ok); assert.strictEqual((validatePolicy({ ...DEFAULT_POLICY, readLimitMBs: '80' }) as any).policy.readLimitMBs, 80);
  assert.strictEqual((validatePolicy({ ...DEFAULT_POLICY, retentionDays: 30 }) as any).policy.retentionDays, 30); assert(!validatePolicy({ ...DEFAULT_POLICY, retentionDays: 9999 }).ok);
  const pol = validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: 168, incrEveryHours: 24, readLimitMBs: 80, retentionDays: 30 }) as any;
  await st.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'c1', environment: 'prod', source: 'agent', backupPolicy: pol.policy } as any);
    d.nodes['n1'] = { id: 'n1', name: 'pg1', clusterId: 'c1', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
  });
  // no backups at all -> a FULL is scheduled, exactly once even if ticked repeatedly
  let s1 = await tick(now); assert.strictEqual(s1.length, 1); assert(s1[0].includes(':full:'));
  assert.strictEqual((await tick(now + 1000)).length, 0, 'in flight: nothing else');
  const op = st.peek().operations[0]; assert.strictEqual(op.params.type, 'full'); assert.strictEqual(op.createdBy, 'scheduler');
  assert.strictEqual(op.params.read_limit_mb_s, 80, 'the policy read limit travels with the scheduled backup');
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
  const e = st.peek().operations.find(o => o.idempotencyKey === s3[0])!; assert.deepStrictEqual(e.params, { retention_full: 2, retention_days: 30 }, 'days of history travel with the retention run'); await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', e.id, 'succeeded', {});
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
  
// preferStandby: a scheduled backup goes to a healthy streaming standby ONLY when the destination is shared; otherwise (local per-node archive) the primary
{
  const st2 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sch2-')));
  const polS = (validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: 168, incrEveryHours: 24, preferStandby: true }) as any).policy;
  assert.strictEqual(polS.preferStandby, true);
  const t = Date.now();
  await st2.mutate(d => {
    d.clusters.push({ id: 'c2', name: 'c2', environment: 'prod', source: 'agent', backupPolicy: polS } as any);
    d.nodes['p'] = { id: 'p', name: 'pgp', clusterId: 'c2', lastSeen: iso(t), snapshot: { postgres: { alive: true, is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
    d.nodes['s'] = { id: 's', name: 'pgs', clusterId: 'c2', lastSeen: iso(t), snapshot: { postgres: { alive: true, is_in_recovery: true, wal_receiver: { status: 'streaming' } }, backup: { recent_sets: [] } } } as any;
  });
  await schedulerTick(st2, t);
  assert.strictEqual(st2.peek().operations[0].nodeId, 'p', 'no shared destination: the primary backs up');
  await st2.mutate(d => { d.operations = []; (d.settings as any).scoped = { destination: { 'cluster:c2': { type: 'nfs', repoPath: '/mnt/bk/repo', walPath: '/mnt/bk/wal', requireMount: true } } }; });
  await schedulerTick(st2, t + 1000);
  assert.strictEqual(st2.peek().operations[0].nodeId, 's', 'shared destination: the streaming standby backs up');
  await st2.mutate(d => { d.operations = []; d.nodes['s'].snapshot.postgres.wal_receiver.status = 'waiting'; });
  await schedulerTick(st2, t + 2000);
  assert.strictEqual(st2.peek().operations[0].nodeId, 'p', 'standby not streaming: back to the primary');
}
// heavy-work window: with a full older than the policy, a window that excludes this hour holds the full back (an incremental is taken instead);
// a window that includes it lets the full through; a cluster with no full at all is protected whatever the window
{
  const st3 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sch3-')));
  const t = Date.now(); const hr = new Date(t).getHours();
  const closed = { windowStart: (hr + 2) % 24, windowEnd: (hr + 4) % 24 }, open = { windowStart: (hr + 23) % 24, windowEnd: (hr + 2) % 24 };
  const mk = (w: any) => (validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: 24, incrEveryHours: 6, ...w }) as any).policy;
  await st3.mutate(d => {
    d.clusters.push({ id: 'c3', name: 'c3', environment: 'prod', source: 'agent', backupPolicy: mk(closed) } as any);
    d.nodes['w'] = { id: 'w', name: 'pgw', clusterId: 'c3', lastSeen: iso(t), snapshot: { postgres: { alive: true, is_in_recovery: false }, backup: { recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(t - 30 * 3600_000) }] } } } as any;
  });
  let k = await schedulerTick(st3, t); assert(k.length === 1 && k[0].includes(':incr:'), 'outside the window: the due full waits, an incremental runs: ' + JSON.stringify(k));
  await st3.mutate(d => { d.operations = []; d.clusters[0].backupPolicy = mk(open); });
  k = await schedulerTick(st3, t + 1000); assert(k.length === 1 && k[0].includes(':full:'), 'inside the window: the full runs: ' + JSON.stringify(k));
  await st3.mutate(d => { d.operations = []; d.clusters[0].backupPolicy = mk(closed); d.nodes['w'].snapshot.backup.recent_sets = []; });
  k = await schedulerTick(st3, t + 2000); assert(k.length === 1 && k[0].includes(':full:'), 'no full at all: protected now, window or not');
}
{ // the same scheduled backup failing again and again: the wait doubles (30 min, 60, 120…, at most 6 h); a success resets it
  const st4 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sch4-'))); const t = Date.now();
  const pol4 = (validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: 168, incrEveryHours: 24, retryAfterMinutes: 30 }) as any).policy;
  await st4.mutate(d => {
    d.clusters.push({ id: 'b', name: 'b', environment: 'prod', source: 'agent', backupPolicy: pol4 } as any);
    d.nodes['bn'] = { id: 'bn', name: 'b1', clusterId: 'b', lastSeen: new Date(t).toISOString(), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
    for (let i = 0; i < 3; i++) d.operations.push({ id: 'f' + i, type: 'backup_run', clusterId: 'b', nodeId: 'bn', status: 'failed', idempotencyKey: 'sched:b:full:' + i, createdBy: 'scheduler',
      params: { type: 'full' }, createdAt: new Date(t - (3 - i) * 60_000).toISOString(), updatedAt: new Date(t - (3 - i) * 60_000).toISOString(), history: [] } as any);
  });
  const k4 = (x: number) => { st4.peek().nodes['bn'].lastSeen = new Date(x).toISOString(); return schedulerTick(st4, x); };
  assert.strictEqual((await k4(t + 61 * 60_000)).length, 0, 'three failures in a row: 120 min, not 30');
  assert.strictEqual((await k4(t + 125 * 60_000)).length, 1, 'then it tries again');
}
console.log('ALL SCHEDULER TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
