import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert'; import http from 'http';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { evaluate, briefing } from '../../server/health';
import { notifyTick, mountNotifyRoutes, Sender } from '../../server/notify';
import { requiredRole } from '../../server/auth';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'hl-')));
  const now = Date.now(); const iso = (ms: number) => new Date(ms).toISOString(); const GB = 1024 ** 3;
  await store.mutate(d => {
    d.clusters.push({ id: 'p', name: 'prod-db', environment: 'prod', source: 'agent' } as any, { id: 'ok', name: 'good-db', environment: 'dev', source: 'agent' } as any, { id: 'demo', name: 'demo', environment: 'dev', isSandbox: true } as any);
    d.nodes.n1 = { id: 'n1', name: 'pg1', clusterId: 'p', lastSeen: iso(now), snapshot: {
      postgres: { is_in_recovery: false, connections: { used: 190, max: 200 }, settings: { archive_mode: 'on' }, pending_restart: ['shared_buffers'],
        archiver: { last_failed_time: iso(now - 60_000), last_failed_wal: '0000000100000000000000AA', last_archived_time: iso(now - 3600_000) },
        replication: [{ application_name: 'pg2', replay_lag_bytes: 2 * GB }], slots: [{ name: 'old_slot', active: false, retained_bytes: 12 * GB }, { name: 'live', active: true, retained_bytes: 5 * GB }] },
      wal: { gap_count: 2, conflicts: 0 }, system: { disks: { repo: { total_bytes: 100, free_bytes: 5 }, pgdata: { total_bytes: 100, free_bytes: 60 } } },
      backup: { configured: true, recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(now - 100 * 3600_000) }], last_failure: { start_time: iso(now - 3600_000), reason: 'disk full' } } } } as any;
    d.nodes.n2 = { id: 'n2', name: 'pg2', clusterId: 'p', lastSeen: iso(now - 600_000), snapshot: { postgres: { is_in_recovery: true } } } as any;
    d.nodes.n3 = { id: 'n3', name: 'g1', clusterId: 'ok', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false, connections: { used: 3, max: 100 }, settings: {} }, wal: { gap_count: 0, conflicts: 0 },
      system: { disks: { pgdata: { total_bytes: 100, free_bytes: 70 } } }, backup: { configured: true, recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(now - 3600_000) }] } } } as any;
    d.settings.policyAssignments = { 'env:prod': { templateId: 'prod-standard' } };
  });
  const codes = (cid: string) => evaluate(store.peek(), now).filter(i => i.clusterId === cid).map(i => i.code).sort();
  assert.deepStrictEqual(codes('p'), ['archiver_failing', 'backup_failed', 'backup_stale', 'connections', 'disk', 'drill_stale', 'node_offline', 'pending_restart', 'repl_lag', 'slot_stale', 'wal_gap'], JSON.stringify(codes('p')));
  assert.deepStrictEqual(codes('ok'), [], 'a healthy cluster raises nothing');
  assert(evaluate(store.peek(), now).every(i => i.clusterId !== 'demo'), 'demo cluster is not monitored');
  const slot = evaluate(store.peek(), now).find(i => i.code === 'slot_stale')!; assert.strictEqual(slot.severity, 'critical'); assert(/old_slot/.test(slot.title)); assert(!evaluate(store.peek(), now).some(i => /live/.test(i.title)), 'active slots are fine');
  const b = briefing(store.peek(), now); assert.strictEqual(b.status, 'critical'); assert(b.counts.critical >= 3); assert.strictEqual(b.issues[0].severity, 'critical');
  assert.strictEqual(b.clusters.find(c => c.id === 'p')!.worst, 'critical'); assert.strictEqual(b.clusters.find(c => c.id === 'ok')!.worst, 'ok');

  // a measured drill clears the reminder and shows the recovery time
  await store.mutate(d => { d.operations.push({ id: 'dr1', type: 'restore_drill', clusterId: 'p', status: 'succeeded', updatedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), result: { rto_seconds: 754, data_bytes: 5 * GB } } as any); });
  assert(!codes('p').includes('drill_stale')); assert.strictEqual(briefing(store.peek(), now).clusters.find(c => c.id === 'p')!.rto!.seconds, 754);
  // ---- notifications: webhooks, dedupe, reminders, recovery, retry
  const sent: any[] = []; let fail = false;
  const send: Sender = async (url, body) => { if (fail) return { ok: false, error: 'HTTP 500' }; sent.push({ url, body }); return { ok: true }; };
  const app = new MiniApp(); mountNotifyRoutes(app, store, send);
  const call = (m: string, u: string, body?: any) => app.call(m, u, { body });
  assert.strictEqual((await call('PUT', '/api/notifications', { webhooks: [{ name: 'x', url: 'ftp://a', format: 'slack', minSeverity: 'warning' }] })).status, 400);
  assert.strictEqual((await call('PUT', '/api/notifications', { webhooks: [{ name: 'x', url: 'https://hooks.example/abcd1234', format: 'zzz', minSeverity: 'warning' }] })).status, 400);
  const put = await call('PUT', '/api/notifications', { reminderHours: 24, webhooks: [{ name: 'Slack DBA', url: 'https://hooks.example/services/T0/B0/secretXYZ9', format: 'slack', minSeverity: 'critical', enabled: true }] });
  assert.strictEqual(put.status, 200); const wid = put.body.webhooks[0].id;
  assert(!JSON.stringify(put.body).includes('secretXYZ9'), 'the secret URL is never returned'); assert(put.body.webhooks[0].urlMasked.endsWith('XYZ9'));
  assert.strictEqual(requiredRole('GET', '/api/notifications'), 'admin'); assert.strictEqual(requiredRole('PUT', '/api/notifications'), 'admin'); assert.strictEqual(requiredRole('GET', '/api/health'), 'viewer');
  const tick = async (t: number) => { await store.mutate(d => { (d.nodes.n1 as any).lastSeen = iso(t); (d.nodes.n3 as any).lastSeen = iso(t); }); return notifyTick(store, t, send); };
  let r = await tick(now); assert.strictEqual(sent.length, 1); assert(r[wid].sent >= 3); assert(/archiver|WAL|Slot/i.test(sent[0].body.text));
  assert(!sent[0].body.text.includes('good-db'));
  r = await tick(now + 60_000); assert.strictEqual(sent.length, 1, 'nothing new -> nothing sent');
  r = await tick(now + 25 * 3600_000); assert.strictEqual(sent.length, 2, 'reminder after 24h'); assert(/Ancora aperto/.test(sent[1].body.text));
  // a problem disappears -> "Risolto"
  await store.mutate(d => { (d.nodes.n1 as any).snapshot.postgres.slots = []; });
  const t2 = now + 26 * 3600_000; await tick(t2);
  // the node lastSeen is now old, so more things open; just check that the slot recovery was announced
  assert(sent.some(s => /Risolto/.test(s.body.text) && /old_slot/.test(s.body.text)), sent.map(s => s.body.text).join('\n---\n'));
  // failed delivery is retried after the back-off, state not advanced
  const n0 = sent.length; fail = true; await store.mutate(d => { (d.nodes.n3 as any).snapshot.wal.gap_count = 1; });
  const t3 = t2 + 120_000; let rr = await tick(t3); assert.strictEqual(rr[wid].sent, 0); assert(rr[wid].error);
  fail = false; rr = await tick(t3 + 60_000); assert.strictEqual(sent.length, n0, 'back-off: not retried within 5 minutes');
  rr = await tick(t3 + 6 * 60_000); assert.strictEqual(sent.length, n0 + 1, 'retried after back-off'); assert(/good-db/.test(sent[sent.length - 1].body.text));
  // test button + real HTTP delivery of the default sender
  const got: any[] = []; const srv = http.createServer((q, s) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { got.push(JSON.parse(b)); s.end('ok'); }); });
  await new Promise<void>(res => srv.listen(0, '127.0.0.1', res)); const port = (srv.address() as any).port;
  const app2 = new MiniApp(); mountNotifyRoutes(app2, store);
  const p2 = await app2.call('PUT', '/api/notifications', { body: { webhooks: [{ name: 'local', url: `http://127.0.0.1:${port}/hook`, format: 'generic', minSeverity: 'info' }] } });
  const t = await app2.call('POST', '/api/notifications/test', { body: { id: p2.body.webhooks[0].id } }); assert.strictEqual(t.status, 200); assert.strictEqual(got[0].event, 'pg_arca.test');
  srv.close();
  console.log('health/notify tests OK');
})().catch(e => { console.error(e); process.exit(1); });
