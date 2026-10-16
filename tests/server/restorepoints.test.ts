import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import { recordRestorePoint } from '../../server/agents';
import { OP_SPECS } from '../../server/optypes';
(async () => {
  // the name is checked before anything reaches the agent (it ends up in pg_create_restore_point)
  const v = OP_SPECS.restore_point.validate;
  assert.strictEqual(v({ name: 'Before release 4.2' }), null);
  assert.strictEqual(v({ name: 'migration #12 (orders)' }), null);
  for (const bad of ['', ' ', "x'; DROP TABLE t; --", 'a'.repeat(61), 'tab\there', 'line\nbreak']) assert.notStrictEqual(v({ name: bad }), null, JSON.stringify(bad));
  assert.strictEqual(OP_SPECS.restore_point.target, 'primary');
  assert.strictEqual(OP_SPECS.restore_point.mutating, true);
  // remembered per cluster, newest first, once per operation, bounded
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')));
  const op = (id: string, name: string, lsn = '0/9A000028') => ({ id, type: 'restore_point', clusterId: 'c', createdBy: 'alice', params: { name }, result: { name, lsn, at: '2026-10-16T02:00:00.000000Z', timeline: 1 } });
  await recordRestorePoint(store, op('o1', 'Before release 4.2'));
  await recordRestorePoint(store, op('o1', 'Before release 4.2'));                       // a replayed report
  await recordRestorePoint(store, op('o2', 'After the migration', '0/9B000028'));
  await recordRestorePoint(store, { ...op('o3', 'bad'), result: { name: 'bad', lsn: 'not-an-lsn' } });
  const list = (store.peek().settings as any).restorePoints.c;
  assert.deepStrictEqual(list.map((x: any) => x.name), ['After the migration', 'Before release 4.2']);
  assert.strictEqual(list[1].by, 'alice'); assert.strictEqual(list[1].lsn, '0/9A000028');
  for (let i = 0; i < 250; i++) await recordRestorePoint(store, op('m' + i, 'p' + i));
  assert.strictEqual((store.peek().settings as any).restorePoints.c.length, 200);
  console.log('restore points OK');
})().catch(e => { console.error(e); process.exit(1); });
