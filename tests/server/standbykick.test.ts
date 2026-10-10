import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import { standbyKickTick } from '../../server/scheduler';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')));
  const now = Date.now(); const iso = (ms: number) => new Date(ms).toISOString();
  await store.mutate(d => {
    d.clusters.push({ id: 'c', name: 'c', environment: 'prod', source: 'agent' } as any);
    d.nodes.p = { id: 'p', name: 'pg-p', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false, alive: true } } } as any;
    d.nodes.r = { id: 'r', name: 'pg-r', clusterId: 'c', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: true, alive: true } } } as any;
    const op = (id: string, nodeId: string, phase: string, status = 'running'): any => ({ id, type: 'backup_run', clusterId: 'c', nodeId, status, progress: { phase }, params: {}, createdAt: iso(now), updatedAt: iso(now), idempotencyKey: id, history: [], attempts: 1 });
    d.operations.push(op('o-standby-wal', 'r', 'wal'), op('o-standby-copy', 'r', 'copy'), op('o-primary-wal', 'p', 'wal'), op('o-done', 'r', 'wal', 'succeeded'));
  });
  const first = await standbyKickTick(store, now);
  assert.strictEqual(first.length, 1, JSON.stringify(first)); assert(first[0].includes('o-standby-wal'));
  const sw = store.peek().operations.filter((o: any) => o.type === 'wal_switch'); assert.strictEqual(sw.length, 1); assert.strictEqual(sw[0].nodeId, 'p');
  assert.deepStrictEqual(await standbyKickTick(store, now + 5_000), [], 'same 20 s window: idempotent');
  assert.strictEqual((await standbyKickTick(store, now + 25_000)).length, 1, 'next window kicks again');
  console.log('standby kick OK');
})().catch(e => { console.error(e); process.exit(1); });
