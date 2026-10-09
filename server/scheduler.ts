/**
 * Backup scheduler. Decisions are DERIVED from persisted state (operations journal + agent telemetry), never from in-memory timers,
 * so a console restart / duplicate tick / two console instances cannot double-run anything:
 *   - every scheduled operation gets a deterministic Idempotency-Key  sched:<cluster>:<kind>:<time bucket>
 *   - at most one data operation per cluster in flight (the ops lane enforces it too)
 *   - after a failed scheduled backup a back-off window applies (no hammering a broken cluster)
 */
import { Store, NodeRecord, nowIso } from './store';
import * as ops from './ops';
import { isTerminal } from './ops';

import { type BackupPolicy, DEFAULT_POLICY, validatePolicy, resolvePolicy } from './policies';
export { type BackupPolicy, DEFAULT_POLICY, validatePolicy };

const online = (n: NodeRecord, now: number) => !!n.lastSeen && now - Date.parse(n.lastSeen) < 45_000;
const ts = (s?: string) => (s ? Date.parse(s) : NaN);

/** One scheduler pass. Returns the keys of operations it submitted (for tests/logging). */
export async function schedulerTick(store: Store, now = Date.now()): Promise<string[]> {
  const submitted: string[] = [];
  const st = store.peek();
  for (const c of st.clusters as any[]) {
    const pol: BackupPolicy | undefined = resolvePolicy(st, c).policy || undefined;
    if (!pol?.enabled || c.isSandbox || c.source === 'direct') continue;
    const nodes = Object.values(st.nodes).filter(n => n.clusterId === c.id && online(n, now));
    // prefer the primary: archive_mode=on is only guaranteed there; standbys need archive_mode=always
    const target = nodes.find(n => n.snapshot?.postgres?.is_in_recovery === false) || undefined;
    if (!target) continue;
    const myOps = st.operations.filter(o => o.clusterId === c.id);
    if (myOps.some(o => !isTerminal(o.status) && ['backup_run', 'backup_verify', 'backup_expire', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote'].includes(o.type))) continue;

    const bk = target.snapshot?.backup;
    const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
    const lastAny = sets.length ? ts(sets[sets.length - 1].start_time) : NaN;
    const lastFull = (() => { const f = sets.filter(s => s.type === 'full'); return f.length ? ts(f[f.length - 1].start_time) : NaN; })();
    const h = 3600_000;

    // back-off after a failed scheduled backup
    const lastFail = myOps.filter(o => o.type === 'backup_run' && o.status === 'failed' && o.idempotencyKey.startsWith('sched:')).map(o => ts(o.updatedAt)).sort().pop();
    if (lastFail && now - lastFail < pol.retryAfterMinutes * 60_000) continue;

    const submit = async (type: string, params: any, key: string) => {
      const r = await ops.submit(store, { type, clusterId: c.id, nodeId: target.id, params, idempotencyKey: key, createdBy: 'scheduler', ttlSeconds: 3600 });
      if (r.created) submitted.push(key);
      return r.created;
    };

    const needFull = !Number.isFinite(lastFull) || now - lastFull >= pol.fullEveryHours * h;
    if (needFull) {
      const bucket = Math.floor(now / (pol.fullEveryHours * h));
      // a full that failed in this bucket is retried through a new key after the back-off (attempt counter)
      const attempts = myOps.filter(o => o.idempotencyKey.startsWith(`sched:${c.id}:full:${bucket}`)).length;
      if (await submit('backup_run', { type: 'full', note: 'scheduled' }, `sched:${c.id}:full:${bucket}:${attempts}`)) continue;
    } else if (pol.incrEveryHours && (!Number.isFinite(lastAny) || now - lastAny >= pol.incrEveryHours * h)) {
      const bucket = Math.floor(now / (pol.incrEveryHours * h));
      const attempts = myOps.filter(o => o.idempotencyKey.startsWith(`sched:${c.id}:incr:${bucket}`)).length;
      if (await submit('backup_run', { type: 'incr', note: 'scheduled' }, `sched:${c.id}:incr:${bucket}:${attempts}`)) continue;
    }

    // retention: once after every successful scheduled backup
    const lastOk = myOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).pop();
    if (lastOk && !myOps.some(o => o.idempotencyKey === `sched:${c.id}:expire:${lastOk.id}`)) {
      if (await submit('backup_expire', { retention_full: pol.retentionFull }, `sched:${c.id}:expire:${lastOk.id}`)) continue;
    }
    // periodic verification (optionally by really recovering the newest set)
    if (pol.verifyEveryHours) {
      const bucket = Math.floor(now / (pol.verifyEveryHours * h));
      if (sets.length && await submit('backup_verify', { deep: pol.verifyDeep, restore_test: true }, `sched:${c.id}:verify:${bucket}`)) continue;
    }
  }
  return submitted;
}

export function startScheduler(store: Store, everyMs = 30_000) {
  const t = setInterval(() => { schedulerTick(store).catch(e => console.error('[scheduler]', e.message)); }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
