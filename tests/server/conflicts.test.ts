// Several DBAs on one cluster: incompatible operations are refused at submission, with who/what/since; replays of the same request are not conflicts.
import assert from 'assert'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { conflictFor, activityOf } from '../../server/conflicts';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountOperatorRoutes } from '../../server/agents';

const op = (type: string, status: string, params: any = {}, by = 'mario', cid = 'c1') => ({ id: 'op-' + type + status, idempotencyKey: 'k-' + type, type, clusterId: cid, params, status, createdAt: '2026-10-11T10:00:00Z', updatedAt: '', createdBy: by, attempts: 0, ttlSeconds: 600, history: [] } as any);

// duplicates of singletons
let c = conflictFor([op('backup_run', 'running')], 'c1', 'backup_run', {}, 'luca');
assert(c && c.message.includes('da mario') && c.with.type === 'backup_run');
assert.strictEqual(conflictFor([op('backup_run', 'running')], 'c2', 'backup_run', {}), null, 'another cluster is independent');
assert.strictEqual(conflictFor([op('backup_run', 'succeeded')], 'c1', 'backup_run', {}), null, 'finished work does not block');
// retention vs readers of backup sets, both ways
assert(conflictFor([op('restore_database', 'running')], 'c1', 'backup_expire', {}));
assert(conflictFor([op('backup_expire', 'queued')], 'c1', 'restore_object', {}));
assert.strictEqual(conflictFor([op('backup_expire', 'queued')], 'c1', 'restore_plan', {}), null, 'a plan only reads');
// quarantine databases
assert(conflictFor([op('restore_promote', 'running', { stage_db: 'pgarca_stage_a' })], 'c1', 'restore_promote', { stage_db: 'pgarca_stage_a' }));
assert.strictEqual(conflictFor([op('restore_promote', 'running', { stage_db: 'pgarca_stage_a' })], 'c1', 'restore_promote', { stage_db: 'pgarca_stage_b' }), null);
assert(conflictFor([op('restore_object', 'queued', { stage_db: 'pgarca_stage_a' })], 'c1', 'restore_promote', { stage_db: 'pgarca_stage_a' }), 'not built yet');
assert(conflictFor([op('restore_database', 'running', { new_name: 'x' })], 'c1', 'restore_database', { new_name: 'x' }));
// HA actions vs data work: refused, overridable with force; data work refused while an HA action is pending
c = conflictFor([op('backup_run', 'running')], 'c1', 'patroni_switchover', {});
assert(c && c.overridable && c.message.includes('interromperebbe'));
assert.strictEqual(conflictFor([op('backup_run', 'running')], 'c1', 'patroni_switchover', { force: true }), null);
assert(conflictFor([op('patroni_switchover', 'queued')], 'c1', 'backup_run', {}));
// activity strip
assert.deepStrictEqual(activityOf([op('backup_run', 'running'), op('backup_info', 'succeeded'), op('wal_forensics', 'running', { background: true })], 'c1').map(a => a.type), ['backup_run']);

// through the API: the second DBA gets 409 with the colleague's operation; a replay of the same key is not refused
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'conf-'))); const app = new MiniApp();
  app.use((req: any, _r: any, next: any) => { req.actor = req.headers['x-user'] || 'mario'; req.role = 'admin'; return next(); });
  mountOperatorRoutes(app, store);
  await store.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'prod', environment: 'dev', source: 'agent' });
    d.nodes.n1 = { id: 'n1', name: 'db1', tokenHash: 'x', enrolledAt: '', clusterId: 'c1', lastSeen: new Date().toISOString(), snapshot: { postgres: { alive: true, is_in_recovery: false } } } as any;
  });
  const post = (user: string, key: string, type: string, params: any = {}) => app.call('POST', '/api/clusters/c1/operations', { body: { type, params }, headers: { 'idempotency-key': key, 'x-user': user } });
  const a = await post('mario', 'k1', 'backup_run', { type: 'full' }); assert.strictEqual(a.status, 202, JSON.stringify(a.body));
  const again = await post('mario', 'k1', 'backup_run', { type: 'full' }); assert.strictEqual(again.status, 200, 'same request replayed: not a conflict');
  const b = await post('luca', 'k2', 'backup_run', { type: 'incr' }); assert.strictEqual(b.status, 409); assert.strictEqual(b.body.with.createdBy, 'mario');
  const act = await app.call('GET', '/api/clusters/c1/activity'); assert.strictEqual(act.body.activity.length, 1); assert.strictEqual(act.body.activity[0].createdBy, 'mario');
  // standalone restart: interrupts data work like a Patroni restart; its dry run (how it would be done) never conflicts
assert(conflictFor([op('backup_run', 'running')], 'c1', 'pg_restart', { confirm: 'RIAVVIA' }), 'restart during a backup');
assert.strictEqual(conflictFor([op('backup_run', 'running')], 'c1', 'pg_restart', { dry_run: true }), null);
assert(conflictFor([op('pg_restart', 'queued', { confirm: 'RIAVVIA' })], 'c1', 'backup_run', {}), 'backup while a restart is queued');
console.log('conflicts tests OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
