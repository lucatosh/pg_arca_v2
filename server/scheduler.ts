/**
 * Backup scheduler. Decisions are DERIVED from persisted state (operations journal + agent telemetry), never from in-memory timers,
 * so a console restart / duplicate tick / two console instances cannot double-run anything:
 *   - every scheduled operation gets a deterministic Idempotency-Key  sched:<cluster>:<kind>:<time bucket>
 *   - at most one data operation per cluster in flight (the ops lane enforces it too)
 *   - after a failed scheduled backup a back-off window applies (no hammering a broken cluster)
 */
import { Store, NodeRecord, nowIso } from './store';
import * as ops from './ops';
import { hbaTarget } from './hba';
import { conflictFor } from './conflicts';
import { geoOf } from './geo';
import { destinationFor } from './destinations';
import { isTerminal } from './ops';

import { type BackupPolicy, DEFAULT_POLICY, validatePolicy, resolvePolicy, inWindow } from './policies';
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
    // the primary by default (archive_mode=on is only guaranteed there). With preferStandby and a SHARED destination (NFS/SMB) a healthy streaming
    // standby takes the load instead: the console asks the primary to switch its WAL segment when the backup reaches the WAL phase.
    const primary = nodes.find(n => n.snapshot?.postgres?.is_in_recovery === false) || undefined;
    let target = primary;
    if (pol.preferStandby && primary) {
      const shared = (destinationFor(st, c).dest?.type || 'local') !== 'local';
      const standby = shared ? nodes.find(n => n.snapshot?.postgres?.alive === true && n.snapshot?.postgres?.is_in_recovery === true && n.snapshot?.postgres?.wal_receiver?.status === 'streaming') : undefined;
      if (standby) target = standby;
    }
    if (!target) continue;
    const myOps = st.operations.filter(o => o.clusterId === c.id);
    if (myOps.some(o => !isTerminal(o.status) && ['backup_run', 'backup_verify', 'backup_expire', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote', 'restore_drill'].includes(o.type))) continue;

    const bk = target.snapshot?.backup;
    const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
    // the telemetry lags behind: a backup that has just succeeded may not be in the agent's snapshot yet. Without counting it the next tick saw "no full this
    // week" again and took a second full 10 s later, which with retention 2 left only today's two fulls (seen on the lab: the PITR window was lost)
    const okRuns = myOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').map(o => ({ type: String(o.result?.type || o.params?.type || 'incr'), at: ts(o.createdAt) }));
    const newest = (xs: number[]) => { const f = xs.filter(Number.isFinite); return f.length ? Math.max(...f) : NaN; };
    const lastAny = newest([sets.length ? ts(sets[sets.length - 1].start_time) : NaN, ...okRuns.map(r => r.at)]);
    const lastFull = newest([(() => { const f = sets.filter(s => s.type === 'full'); return f.length ? ts(f[f.length - 1].start_time) : NaN; })(), ...okRuns.filter(r => r.type === 'full').map(r => r.at)]);
    const h = 3600_000;

    // back-off after a failed scheduled backup
    // consecutive failures with no success in between double the wait (retry, ×2, ×4… capped at 6 h): the same broken destination used to
    // be hit every 30 minutes all day (the lab counted 78 failed operations in 24 h, the same NFS error each time)
    const lastRunOk = Math.max(0, ...myOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').map(o => ts(o.updatedAt)).filter(Number.isFinite));   // a manual success ends the streak too
    const fails = myOps.filter(o => o.type === 'backup_run' && o.status === 'failed' && o.idempotencyKey.startsWith('sched:') && ts(o.updatedAt) > lastRunOk).map(o => ts(o.updatedAt)).filter(Number.isFinite);
    const streak = fails.length; const lastFail = streak ? Math.max(...fails) : NaN;
    const wait = Math.min(pol.retryAfterMinutes * 60_000 * 2 ** Math.max(0, streak - 1), 6 * 3600_000);
    if (streak && now - lastFail < wait) continue;

    const limit = pol.readLimitMBs ? { read_limit_mb_s: pol.readLimitMBs } : {};
    const submit = async (type: string, params: any, key: string) => {
      if (conflictFor(store.peek().operations, c.id, type, params, 'scheduler')) return false;     // a switchover / promotion / manual run in progress: next tick
      const r = await ops.submit(store, { type, clusterId: c.id, nodeId: target.id, params, idempotencyKey: key, createdBy: 'scheduler', ttlSeconds: 3600 });
      if (r.created) submitted.push(key);
      return r.created;
    };

    // a tablespace created after the latest FULL: every restore replays its CREATE TABLESPACE on the live path (refused on this server) until a new full
    // exists -> take one now, once per such tablespace (the agent reports the tablespaces the latest full knows)
    const fullTs: string[] | null = Array.isArray(bk?.full_tablespace_oids) ? bk.full_tablespace_oids.map(String) : null;
    const newTs = fullTs ? ((target.snapshot?.postgres?.tablespaces || []) as any[]).map(t => String(t.oid)).filter(o => !fullTs.includes(o)).sort() : [];
    const recentFull = okRuns.some(r => r.type === 'full' && now - r.at < 30 * 60_000);
    if (newTs.length && !recentFull) {
      const key = `sched:${c.id}:tsfull:${newTs.join('-')}`;
      const attempts = myOps.filter(o => o.idempotencyKey.startsWith(key)).length;
      if (attempts < 3 && await submit('backup_run', { type: 'full', note: 'new tablespace since the last full backup' }, `${key}:${attempts}`)) continue;
    }

    const needFull = !Number.isFinite(lastFull) || now - lastFull >= pol.fullEveryHours * h;
    const heavyOk = inWindow(pol, now) || !Number.isFinite(lastFull);              // a cluster with NO full yet is protected right away, window or not
    // a full that is due outside the hours the policy allows for heavy work waits for the window; incrementals keep going meanwhile
    if (needFull && heavyOk) {
      const bucket = Math.floor(now / (pol.fullEveryHours * h));
      // a full that failed in this bucket is retried through a new key after the back-off (attempt counter)
      const attempts = myOps.filter(o => o.idempotencyKey.startsWith(`sched:${c.id}:full:${bucket}`)).length;
      if (await submit('backup_run', { type: 'full', note: 'scheduled', ...limit }, `sched:${c.id}:full:${bucket}:${attempts}`)) continue;
    } else if (pol.incrEveryHours && (!Number.isFinite(lastAny) || now - lastAny >= pol.incrEveryHours * h)) {
      const bucket = Math.floor(now / (pol.incrEveryHours * h));
      const attempts = myOps.filter(o => o.idempotencyKey.startsWith(`sched:${c.id}:incr:${bucket}`)).length;
      if (await submit('backup_run', { type: 'incr', note: 'scheduled', ...limit }, `sched:${c.id}:incr:${bucket}:${attempts}`)) continue;
    }

    // retention: once after every successful scheduled backup
    const lastOk = myOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).pop();
    if (lastOk && !myOps.some(o => o.idempotencyKey === `sched:${c.id}:expire:${lastOk.id}`)) {
      if (await submit('backup_expire', { retention_full: pol.retentionFull, ...(pol.retentionDays ? { retention_days: pol.retentionDays } : {}) }, `sched:${c.id}:expire:${lastOk.id}`)) continue;
    }
    // periodic verification (optionally by really recovering the newest set)
    if (pol.verifyEveryHours && inWindow(pol, now)) {
      const bucket = Math.floor(now / (pol.verifyEveryHours * h));
      if (sets.length && await submit('backup_verify', { deep: pol.verifyDeep, restore_test: true }, `sched:${c.id}:verify:${bucket}`)) continue;
    }
    // periodic disaster recovery drill: due when the last SUCCESSFUL one is older than the period (kept as evidence beyond the history's
    // retention); one attempt per period bucket - a failed drill is a finding to act on, not something to repeat all night
    if (pol.drillEveryDays && inWindow(pol, now) && sets.length) {
      const period = pol.drillEveryDays * 24 * h;
      const lastDrill = newest(myOps.filter(o => o.type === 'restore_drill' && o.status === 'succeeded').map(o => ts(o.updatedAt)));
      if (!Number.isFinite(lastDrill) || now - lastDrill >= period) {
        const bucket = Math.floor(now / period);
        if (await submit('restore_drill', { note: 'scheduled' }, `sched:${c.id}:drill:${bucket}`)) continue;
      }
    }
  }
  return submitted;
}

/** Temporary pg_hba rules ([until=...] in the comment): once the earliest expiry has passed, ask every online file-mode node to drop the elapsed ones
 *  (Patroni: one member, through the DCS). Retried every 10 minutes until an hba_expire operation succeeds after the expiry. */
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
    if (!c) continue;
    const latestDue = Math.max(...due);
    // Patroni: the temporary rules live in the DCS list, one member edits it for everyone
    const tgt = c.haState?.managedByPatroni ? hbaTarget(st, cid) : null;
    const nodes = c.haState?.managedByPatroni ? (tgt ? [tgt] : []) : Object.values(st.nodes).filter(n => n.clusterId === cid && online(n, now));
    const mine = st.operations.filter(o => o.clusterId === cid && o.type === 'hba_expire');
    const okAfter = (n: NodeRecord) => mine.some(o => (c.haState?.managedByPatroni || o.nodeId === n.id) && o.status === 'succeeded' && ts(o.createdAt) >= latestDue);
    const pending = nodes.filter(n => !okAfter(n));
    if (!pending.length && nodes.length) { await store.mutate(d => { const m = d.settings.hbaExpiry; m[cid] = (m[cid] || []).filter((t: number) => t > now); if (!m[cid].length) delete m[cid]; }); continue; }
    if (conflictFor(st.operations, cid, 'hba_expire', {})) continue;        // someone is changing pg_hba right now: retried at the next tick
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
    let primary = Object.values(st.nodes).find(n => n.clusterId === o.clusterId && online(n, now) && n.snapshot?.postgres?.is_in_recovery === false);
    // a standby SITE (geo-redundancy) has no primary of its own: the WAL it waits for is written by the primary site's leader
    if (!primary) { const g = geoOf(st, o.clusterId); const ps = g?.role === 'standby' ? g.peers.find(p => p.role === 'primary') : null;
      if (ps?.leaderNodeId) { const n = st.nodes[ps.leaderNodeId]; if (n && online(n, now) && n.snapshot?.postgres?.is_in_recovery === false) primary = n; } }
    if (!primary) continue;
    const key = `standbykick:${o.id}:${Math.floor(now / 20_000)}`;
    const r = await ops.submit(store, { type: 'wal_switch', clusterId: primary.clusterId || o.clusterId, nodeId: primary.id, params: {}, idempotencyKey: key, createdBy: 'scheduler', ttlSeconds: 120 });
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
