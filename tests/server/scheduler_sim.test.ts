/**
 * Scheduler simulation: 30 simulated days, a tick every 10 minutes, a simulated agent whose backups succeed, fail or run long at random, and whose
 * telemetry lags behind by a random number of ticks. Invariants checked at every tick:
 *   - never two backup-type operations active at once on the cluster
 *   - no two successful FULL backups closer than half the full interval (the duplicate full that wiped the PITR history)
 *   - once a full exists, never longer than incr interval + slack without a successful backup, unless the backups keep failing
 *   - a full at least every full interval + slack (same exception)
 *   - retention never queued while a backup runs
 * Seeded: FUZZ_SEED=<n>.
 */
import assert from 'node:assert/strict';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
import { schedulerTick, validatePolicy, DEFAULT_POLICY } from '../../server/scheduler';

const SEED = Number(process.env.FUZZ_SEED || Math.floor(Math.random() * 1e9));
let s = SEED;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const H = 3600_000, M = 60_000;
let simNow = 0;
const RealDate = Date;
class SimDate extends RealDate {                // the whole console lives in simulated time (operations stamp themselves with new Date() / Date.now())
  constructor(...a: any[]) { if (a.length === 0 && simNow) super(simNow); else super(...(a as [any])); }
  static now() { return simNow || RealDate.now(); }
}
(globalThis as any).Date = SimDate;

(async () => {
  for (const [fullH, incrH, failP] of [[168, 24, 0.15], [24, 6, 0.3], [72, 1, 0.05]] as const) {
    const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ssim-')));
    const pol = validatePolicy({ ...DEFAULT_POLICY, enabled: true, fullEveryHours: fullH, incrEveryHours: incrH, retryAfterMinutes: 30, verifyEveryHours: 0 }) as any;
    assert(pol.ok, JSON.stringify(pol));
    const t0 = Date.UTC(2026, 9, 1, 0, 3);
    await st.mutate(d => {
      d.clusters.push({ id: 'c1', name: 'c1', environment: 'prod', source: 'agent', backupPolicy: pol.policy } as any);
      d.nodes['n1'] = { id: 'n1', name: 'pg1', clusterId: 'c1', lastSeen: new Date(t0).toISOString(), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any;
      d.nodes['n2'] = { id: 'n2', name: 'pg2', clusterId: 'c1', lastSeen: new Date(t0).toISOString(), snapshot: { postgres: { is_in_recovery: true }, backup: { recent_sets: [] } } } as any;
    });
    let primary = 'n1'; let offlineUntil = 0; let offlineSince = 0; let offlineTotal = 0;
    const agentSets: any[] = [];               // what the agent really has
    const running: Record<string, number> = {}; // op id -> tick when it finishes
    let reportedUpTo = 0;                       // telemetry lag: the snapshot shows agentSets[0..reportedUpTo)
    const okFulls: number[] = []; const okAny: number[] = []; const fails: number[] = [];
    const ctx = (t: number) => `fullH=${fullH} incrH=${incrH} failP=${failP} day ${((t - t0) / (24 * H)).toFixed(2)} seed=${SEED}`;
    for (let tick = 0, t = t0; t < t0 + 30 * 24 * H; tick++, t += 10 * M) {
      simNow = t;
      // telemetry (lags 0..3 ticks)
      if (rnd() < 0.5) reportedUpTo = agentSets.length;
      if (rnd() < 0.002) primary = primary === 'n1' ? 'n2' : 'n1';                       // Patroni failover: the other node becomes primary (shared repository)
      if (t >= offlineUntil && rnd() < 0.003) { const d = (1 + Math.floor(rnd() * 6)) * H; offlineSince = t; offlineUntil = t + d; offlineTotal += d; }   // agents unreachable
      const online = t >= offlineUntil;
      await st.mutate(d => { for (const id of ['n1', 'n2']) { const n = d.nodes[id]; if (online) n.lastSeen = new Date(t).toISOString(); n.snapshot.postgres.is_in_recovery = id !== primary;
        n.snapshot.backup.recent_sets = agentSets.slice(0, reportedUpTo).slice(-60); } });
      await schedulerTick(st, t);
      // the agent: lease what is queued, finish what is due
      const ops_ = st.peek().operations.filter(o => o.clusterId === 'c1');
      for (const o of online ? ops_.filter(o => o.status === 'queued') : []) {
        await ops.lease(st, o.nodeId || primary, 5);
        running[o.id] = tick + (o.type === 'backup_run' ? (rnd() < 0.1 ? 3 + Math.floor(rnd() * 12) : 1) : 0);
      }
      for (const o of st.peek().operations.filter(o => o.clusterId === 'c1' && ['leased', 'running'].includes(o.status))) {
        if (!online || running[o.id] === undefined || running[o.id] > tick) continue;
        if (o.type === 'backup_run' && rnd() < failP) { await ops.report(st, o.nodeId || primary, o.id, 'failed', undefined, 'simulated failure'); fails.push(t); continue; }
        if (o.type === 'backup_run') {
          // the engine turns an incremental without a complete full into a full
          const type = o.params.type === 'full' || !agentSets.some(x => x.type === 'full') ? 'full' : 'incr';
          agentSets.push({ id: `s${tick}`, type, status: 'COMPLETE', start_time: new Date(t - 5 * M).toISOString() });
          if (type === 'full') okFulls.push(t); okAny.push(t);
          await ops.report(st, o.nodeId || primary, o.id, 'succeeded', { type, set: `s${tick}` });
        } else await ops.report(st, o.nodeId || primary, o.id, 'succeeded', {});
      }
      // invariants
      const dump = () => '\n' + st.peek().operations.filter(o => o.clusterId === 'c1').slice(-8).map(o => `   ${o.createdAt} ${o.type} ${JSON.stringify(o.params).slice(0, 60)} ${o.status} ${o.idempotencyKey}`).join('\n')
        + `\n   agent sets: ${agentSets.slice(-4).map(x => x.type + '@' + x.start_time).join(', ')}; reported ${reportedUpTo}/${agentSets.length}`;
      const active = st.peek().operations.filter(o => o.clusterId === 'c1' && !['succeeded', 'failed', 'cancelled', 'expired'].includes(o.status));
      assert(active.filter(o => ['backup_run', 'backup_expire', 'backup_verify'].includes(o.type)).length <= 1, `two backup-type operations at once (${ctx(t)}): ${active.map(o => o.type)}`);
      for (let i = 1; i < okFulls.length; i++) assert(okFulls[i] - okFulls[i - 1] >= fullH * H / 2, `two fulls ${((okFulls[i] - okFulls[i - 1]) / M).toFixed(0)} min apart (${ctx(okFulls[i])})` + dump());
      const recentFail = (since: number) => fails.some(f => f > since);
      if (okFulls.length) {
        const lastOk = okAny[okAny.length - 1];
        // the whole length of an outage that overlaps the waiting period is slack (an operation leased just before the outage finishes in the
        // tick the agents come back, after the scheduler ran: that success must not erase the outage, or the invariant fires one tick early)
        const outage = (since: number) => (offlineUntil > since ? offlineUntil - Math.max(offlineSince, since) : 0);
        const slack = 3 * H + (offlineUntil > lastOk ? offlineUntil - lastOk : 0);
        assert(t - lastOk <= incrH * H + slack || recentFail(lastOk), `no successful backup for ${((t - lastOk) / H).toFixed(1)} h without failures (${ctx(t)})` + dump());
        const lastFull = okFulls[okFulls.length - 1];
        assert(t - lastFull <= fullH * H + Math.max(slack, 3 * H + outage(lastFull)) + 2 * H || recentFail(lastFull + fullH * H - H), `no full for ${((t - lastFull) / H).toFixed(1)} h (${ctx(t)})` + dump());
      } else assert(t - t0 <= 2.5 * H + (offlineUntil > t0 ? offlineUntil - Math.max(offlineSince, t0) : 0) || fails.length, `no first full after ${((t - t0) / H).toFixed(1)} h (${ctx(t)}) offline ${offlineSince ? `${((offlineSince - t0) / H).toFixed(1)}h→${((offlineUntil - t0) / H).toFixed(1)}h` : 'never'}` + dump());
    }
    console.log(`  fullH=${fullH} incrH=${incrH} failP=${failP}: ${okFulls.length} fulls, ${okAny.length} backups, ${fails.length} failures, ${(offlineTotal / H).toFixed(0)} h offline in 30 days`);
  }
  console.log(`scheduler simulation OK (seed ${SEED})`);
})().catch(e => { console.error(e); process.exit(1); });
