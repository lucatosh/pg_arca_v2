import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
import { schedulerTick, validatePolicy, DEFAULT_POLICY } from '../../server/scheduler';
import { evaluate } from '../../server/health';
// scheduled disaster recovery drills: due after the period since the last SUCCESSFUL one, once per period; a failed one is a finding
(async () => {
  const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'drill-')));
  const now = Date.now(); const iso = (t: number) => new Date(t).toISOString();
  assert(!validatePolicy({ ...DEFAULT_POLICY, drillEveryDays: 400 }).ok);
  const pol = (validatePolicy({ ...DEFAULT_POLICY, enabled: true, verifyEveryHours: 0, drillEveryDays: 30 }) as any).policy;
  assert.strictEqual(pol.drillEveryDays, 30);
  const sets = [{ id: 'F', type: 'full', status: 'COMPLETE', start_time: iso(now - 3600_000), stop_time: iso(now - 3000_000) }, { id: 'I', type: 'incr', status: 'COMPLETE', start_time: iso(now - 600_000), stop_time: iso(now - 500_000) }];
  await st.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'c1', environment: 'prod', source: 'agent', backupPolicy: pol } as any);
    d.nodes['n1'] = { id: 'n1', name: 'pg1', clusterId: 'c1', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false, alive: true }, backup: { recent_sets: sets } } } as any;
  });
  const tick = async (t: number) => { await st.mutate(d => { d.nodes['n1'].lastSeen = iso(t); }); return schedulerTick(st, t); };
  const s1 = await tick(now); assert.deepStrictEqual(s1.map(k => k.split(':')[2]), ['drill'], JSON.stringify(s1));
  assert.strictEqual((await tick(now + 1000)).length, 0, 'in flight');
  const op = st.peek().operations.find(o => o.type === 'restore_drill')!;
  await ops.lease(st, 'n1', 1); await ops.report(st, 'n1', op.id, 'failed', undefined, 'PGA-RST-053: the restored copy stopped during recovery');
  // failed: a finding, and no retry in the same period
  assert.strictEqual((await tick(now + 3600_000)).filter(k => k.includes(':drill:')).length, 0, 'one attempt per period');
  const f = evaluate(st.peek(), now + 3600_000).filter(i => i.clusterId === 'c1');
  assert(f.some(i => i.code === 'drill_failed' && i.severity === 'warning'), JSON.stringify(f.map(i => i.code)));
  assert(!f.some(i => i.code === 'drill_stale'), 'failed is said once, not also as stale');
  // a success clears it; nothing due before 30 days
  await st.mutate(d => { d.operations.push({ ...op, id: 'ok1', idempotencyKey: 'manual', status: 'succeeded', error: undefined, updatedAt: iso(now + 7200_000), history: [] } as any); });
  assert(!evaluate(st.peek(), now + 7200_000).some(i => i.code === 'drill_failed'));
  assert.strictEqual((await tick(now + 10 * 86400_000)).filter(k => k.includes(':drill:')).length, 0);
  console.log('drills OK');
})().catch(e => { console.error(e); process.exit(1); });
