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
    if (myOps.some(o => !isTerminal(o.status) && ['backup_run', 'backup_verify', 'backup_expire', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote', 'restore_drill'].includes(o.type))) continue;

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

/** Temporary pg_hba rules ([until=...] in the comment): once the earliest expiry has passed, ask every online file-mode node to drop the elapsed ones.
 *  Retried every 10 minutes until an hba_expire operation succeeds after the expiry; Patroni clusters are not handled (the UI does not offer expiry there). */
/** Apply the history retention even when nothing new is submitted. */
export async function pruneTick(store: Store, now = Date.now()): Promise<number> {
  if (!ops.prunable(store.peek(), now)) return 0;
  let n = 0;
  await store.mutate(d => { n = ops.pruneOps(d, now); });
  return n;
}

export async function hbaExpiryTick(store: Store, now = Date.now()): Promise<string[]> {
  const submitted: string[] = [];
  const st = store.peek();
  for (const [cid, list] of Object.entries((st.settings.hbaExpiry || {}) as Record<string, number[]>)) {
    const due = list.filter(t => t <= now); if (!due.length) continue;
    const c = (st.clusters as any[]).find(x => x.id === cid);
    if (!c || c.haState?.managedByPatroni) continue;
    const latestDue = Math.max(...due);
    const nodes = Object.values(st.nodes).filter(n => n.clusterId === cid && online(n, now));
    const mine = st.operations.filter(o => o.clusterId === cid && o.type === 'hba_expire');
    const okAfter = (n: NodeRecord) => mine.some(o => o.nodeId === n.id && o.status === 'succeeded' && ts(o.createdAt) >= latestDue);
    const pending = nodes.filter(n => !okAfter(n));
    if (!pending.length && nodes.length) { await store.mutate(d => { const m = d.settings.hbaExpiry; m[cid] = (m[cid] || []).filter((t: number) => t > now); if (!m[cid].length) delete m[cid]; }); continue; }
    for (const n of pending) {
      const bucket = Math.floor(now / 600_000);
      const r = await ops.submit(store, { type: 'hba_expire', clusterId: cid, nodeId: n.id, params: {}, idempotencyKey: `sched:${cid}:hbaexp:${n.id}:${bucket}`, createdBy: 'scheduler', ttlSeconds: 600 });
      if (r.created) submitted.push(`${cid}:${n.id}`);
    }
  }
  return submitted;
}

/**
 * Backups taken FROM A STANDBY end by waiting for the last WAL segment of the backup to be archived. That segment belongs to the PRIMARY, which only closes
 * it on its own when it has more WAL to write: on a quiet server the standby would wait until the timeout and the backup would fail. Only the primary can
 * switch the segment, and only the console knows both nodes, so it does it: while a running backup_run on a standby is in its 'wal' phase, ask the primary's
 * agent for a WAL switch (one per 20 s window, idempotent per window).
 */
export async function standbyKickTick(store: Store, now = Date.now()): Promise<string[]> {
  const out: string[] = [];
  const st = store.peek();
  for (const o of st.operations as any[]) {
    if (o.type !== 'backup_run' || o.status !== 'running' || o.progress?.phase !== 'wal') continue;
    const node: NodeRecord | undefined = st.nodes[o.nodeId];
    if (!node || node.snapshot?.postgres?.is_in_recovery !== true) continue;
    const primary = Object.values(st.nodes).find(n => n.clusterId === o.clusterId && online(n, now) && n.snapshot?.postgres?.is_in_recovery === false);
    if (!primary) continue;
    const key = `standbykick:${o.id}:${Math.floor(now / 20_000)}`;
    const r = await ops.submit(store, { type: 'wal_switch', clusterId: o.clusterId, nodeId: primary.id, params: {}, idempotencyKey: key, createdBy: 'scheduler', ttlSeconds: 120 });
    if (r.created) out.push(key);
  }
  return out;
}

export function startScheduler(store: Store, everyMs = 30_000) {
  const t = setInterval(() => { schedulerTick(store).catch(e => console.error('[scheduler]', e.message)); pruneTick(store).catch(e => console.error('[prune]', e.message)); hbaExpiryTick(store).catch(e => console.error('[hba-expiry]', e.message)); }, everyMs);
  const k = setInterval(() => { standbyKickTick(store).catch(e => console.error('[standby-kick]', e.message)); }, 10_000);
  k.unref?.();
  t.unref?.();
  return () => { clearInterval(t); clearInterval(k); };
}
