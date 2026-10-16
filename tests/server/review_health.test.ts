// Regression tests of the health / scheduler / notification review (16/10 night): each case was a scenario where the console said something false.
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import * as ops from '../../server/ops';
import { evaluate, protectionOf } from '../../server/health';
import { renderMetrics } from '../../server/metrics';
import { notifyTick, sealUrl, Sender } from '../../server/notify';
import { schedulerTick } from '../../server/scheduler';

const H = 3600_000; const now = Date.now(); const iso = (t: number) => new Date(t).toISOString();
const base = () => ({ clusters: [{ id: 'c', name: 'prod1', environment: 'prod', source: 'agent' }] as any[], nodes: {} as any, operations: [] as any[],
  settings: { policyAssignments: { 'env:prod': { templateId: 'prod-standard' } } } as any });
const snapP = (sets?: any[]) => ({ postgres: { is_in_recovery: false, alive: true, settings: { archive_mode: 'on', archive_timeout: '60', wal_segment_size: String(16 * 1048576) }, current_lsn: '0/5000100', timeline: 1,
  archiver: { last_archived_wal: '000000010000000000000004', last_archived_time: iso(now - 30_000) } }, wal: { gap_count: 0, conflicts: 0 },
  backup: { configured: true, sets: (sets || []).length || 2, recent_sets: sets || [{ id: 'f', status: 'COMPLETE', type: 'full', start_time: iso(now - 20 * H) }, { id: 'i', status: 'COMPLETE', type: 'incr', start_time: iso(now - 2 * H) }] } });
const codes = (st: any) => evaluate(st, now).filter(i => i.clusterId === 'c').map(i => i.code);

(async () => {
  { // no reachable primary: not "Protected"
    const st = base();
    st.nodes.p = { id: 'p', name: 'pg1', clusterId: 'c', lastSeen: iso(now - 30 * 60_000), snapshot: snapP() };
    st.nodes.s = { id: 's', name: 'pg2', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: true, alive: true } } };
    const iss = evaluate(st, now); assert(iss.some(i => i.code === 'no_primary'));
    assert.strictEqual(protectionOf(st, 'c', iss, now).state, 'bad');
    // metrics: the last known backups, not zeros
    const m = renderMetrics(st, now); assert(!/last_backup_timestamp_seconds\{[^}]*\} 0$/m.test(m), 'never 1970'); assert(/backup_sets\{[^}]*\} 2$/m.test(m));
  }
  { // the backups of an offline node's frozen snapshot do not hide an online primary with none, and failed runs count
    const st = base();
    st.nodes.old = { id: 'old', name: 'old', clusterId: 'c', lastSeen: iso(now - 5 * 24 * H), snapshot: snapP() };
    st.nodes.p = { id: 'p', name: 'pg1', clusterId: 'c', lastSeen: iso(now), snapshot: snapP([]) };
    st.nodes.p.snapshot.backup.sets = 0;
    for (let i = 0; i < 3; i++) st.operations.push({ id: 'r' + i, type: 'backup_run', clusterId: 'c', nodeId: 'p', status: 'failed', error: 'PGA-REPO-001: destination not mounted', params: {}, createdAt: iso(now - (3 - i) * H), updatedAt: iso(now - (3 - i) * H), idempotencyKey: 'sched:c:full:' + i, history: [] });
    const c = codes(st); assert(c.includes('no_backup'), c.join()); assert(c.includes('backup_failed'), c.join());
    assert.strictEqual(evaluate(st, now).find(i => i.code === 'backup_failed')!.severity, 'critical');
  }
  { // a node clock 72 h ahead: the real age of its last backup (60 h) is stale, and protection is not ok
    const st = base();
    st.nodes.p = { id: 'p', name: 'pg1', clusterId: 'c', lastSeen: iso(now), clockSkewMs: 72 * H, snapshot: snapP([{ id: 'f', status: 'COMPLETE', type: 'full', start_time: iso(now + 12 * H) }]) };
    const c = codes(st); assert(c.includes('clock_ahead') && c.includes('backup_stale'), c.join());
    assert.notStrictEqual(protectionOf(st, 'c', evaluate(st, now), now).state, 'ok');
  }
  { // a failed verification stays open until a later one of this cluster succeeds, whatever its age, on any node
    const st = base();
    st.nodes.p = { id: 'p', name: 'pg1', clusterId: 'c', lastSeen: iso(now), snapshot: snapP() };
    st.operations.push({ id: 'v1', type: 'backup_verify', clusterId: 'c', nodeId: 'old', status: 'failed', params: { deep: false }, error: 'PGA-VRF-050: chunks missing', createdAt: iso(now - 8 * 24 * H), updatedAt: iso(now - 8 * 24 * H), idempotencyKey: 'a', history: [] });
    assert(codes(st).includes('verify_failed'), '8 days old and nothing succeeded since');
    st.operations.push({ id: 'v2', type: 'backup_verify', clusterId: 'c', nodeId: 'p', status: 'succeeded', params: { deep: false }, createdAt: iso(now - H), updatedAt: iso(now - H), idempotencyKey: 'b', history: [] });
    assert(!codes(st).includes('verify_failed'), 'a later verification on another node clears it');
  }
  { // a verification that found problems, reported as a success by an older agent, is a failure
    const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-')));
    await st.mutate(d => { d.clusters.push({ id: 'c', name: 'c', environment: 'prod', source: 'agent' } as any); d.nodes.n = { id: 'n', name: 'n', clusterId: 'c', lastSeen: iso(now) } as any; });
    const s = await ops.submit(st, { type: 'backup_verify', clusterId: 'c', nodeId: 'n', params: {}, idempotencyKey: 'v' });
    await ops.lease(st, 'n', 1);
    assert((await ops.report(st, 'n', s.op.id, 'succeeded', { ok: false, problems: ['20261010-010000F: 12 missing chunks'] })).ok);
    const o = st.peek().operations.find(x => x.id === s.op.id)!;
    assert.strictEqual(o.status, 'failed'); assert(/PGA-VRF-050.*12 missing chunks/.test(String(o.error)));
    assert((await ops.report(st, 'n', s.op.id, 'succeeded', { ok: false, problems: ['x'] })).ok, 'the same report again is idempotent');
  }
  { // notifications: worse = said at once; flapping = no storm; resolved only after it stays gone
    const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rn-')));
    const sent: any[] = []; const send: Sender = async (_u, b) => { sent.push(b); return { ok: true }; };
    const disk = (free: number) => ({ repo: { total_bytes: 100, free_bytes: free } });
    await st.mutate(d => {
      d.clusters.push({ id: 'c', name: 'c', environment: 'prod', source: 'agent' } as any);
      d.nodes.n = { id: 'n', name: 'pg1', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false }, system: { disks: disk(12) } } } as any;
      d.nodes.s = { id: 's', name: 'pg2', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: true } } } as any;
      d.settings.notifications = { webhooks: [{ id: 'w', name: 'ops', url: sealUrl(st.dir, 'https://example.invalid/x'), format: 'generic', minSeverity: 'warning', enabled: true }], reminderHours: 24 };
    });
    const at = async (t: number, f?: (d: any) => void) => { await st.mutate(d => { d.nodes.n.lastSeen = iso(t); d.nodes.s.lastSeen = iso(t); f?.(d); }); return notifyTick(st, t, send); };
    await at(now); await at(now + 130_000);                                  // the warning lasts 2 minutes: sent
    assert(sent.some(b => b.opened.some((i: any) => i.code === 'disk')), JSON.stringify(sent.map(b => b.opened.map((i: any) => i.code))));
    const n0 = sent.length; await at(now + 190_000, d => { d.nodes.n.snapshot.system.disks = disk(3); });
    assert.strictEqual(sent.length, n0 + 1, 'warning -> critical is said at once'); assert(sent[n0].opened.some((i: any) => i.code === 'disk' && i.severity === 'critical'));
    const n1 = sent.length;
    for (let k = 4; k < 10; k++) { const t = now + k * 60_000; await st.mutate(d => { d.nodes.n.lastSeen = iso(t); d.nodes.s.lastSeen = iso(t - (k % 2 ? 50_000 : 10_000)); }); await notifyTick(st, t, send); }
    assert.strictEqual(sent.length, n1, 'a heartbeat flapping around the limit sends nothing');
  }
  { // an operator who cancels a scheduled backup is not overruled 30 s later
    const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')));
    await st.mutate(d => { d.clusters.push({ id: 'c', name: 'c', environment: 'prod', source: 'agent', backupPolicy: { enabled: true, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 0, verifyDeep: false, retryAfterMinutes: 30 } } as any);
      d.nodes.n = { id: 'n', name: 'n', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false }, backup: { recent_sets: [] } } } as any; });
    const tick = async (t: number) => { await st.mutate(d => { d.nodes.n.lastSeen = iso(t); }); return schedulerTick(st, t); };
    assert.strictEqual((await tick(now)).length, 1);
    const op = st.peek().operations.at(-1)!; await ops.lease(st, 'n', 1); await ops.cancel(st, op.id, 'alice'); await ops.report(st, 'n', op.id, 'failed', undefined, 'cancelled');
    assert.deepStrictEqual(await tick(now + 30_000), [], 'held back like a failure');
  }
  { // the newest full older than the 60 listed sets is still known: no "no full" full at noon outside the heavy-work hours
    const st = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-')));
    const noon = new Date(); noon.setHours(12, 0, 0, 0); const t = noon.getTime();
    const incrs = Array.from({ length: 60 }, (_, i) => ({ id: 'i' + i, status: 'COMPLETE', type: 'incr', start_time: iso(t - (60 - i) * H) }));
    await st.mutate(d => { d.clusters.push({ id: 'c', name: 'c', environment: 'prod', source: 'agent', backupPolicy: { enabled: true, fullEveryHours: 168, incrEveryHours: 1, retentionFull: 2, verifyEveryHours: 0, verifyDeep: false, retryAfterMinutes: 30, windowStart: 1, windowEnd: 5 } } as any);
      d.nodes.n = { id: 'n', name: 'n', clusterId: 'c', lastSeen: iso(t), snapshot: { postgres: { is_in_recovery: false }, backup: { configured: true, sets: 61, recent_sets: incrs, last_full: { id: 'f', start_time: iso(t - 70 * H) } } } } as any; });
    const keys = await schedulerTick(st, t);
    assert(!keys.some(k => k.includes(':full:')), keys.join());
  }
  console.log('review health/scheduler OK');
})().catch(e => { console.error(e); process.exit(1); });
