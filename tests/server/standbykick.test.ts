import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { Store } from '../../server/store';
import { standbyKickTick } from '../../server/scheduler';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')));
  const now = Math.floor(Date.now() / 20_000) * 20_000 + 1_000;   // start of a 20 s window: +5 s stays in it (the test was flaky near a boundary)
  const iso = (ms: number) => new Date(ms).toISOString();
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
  // a backup on a standby SITE (geo): the WAL switch goes to the primary site's leader, in the primary site's cluster
  const t = Date.now(); const w = Math.floor(t / 20_000) * 20_000 + 1_000 > t ? Math.floor(t / 20_000) * 20_000 + 1_000 : t;
  await store.mutate(d => {
    d.clusters.push({ id: 'g1', name: 'geo-a', environment: 'prod', source: 'agent' } as any, { id: 'g2', name: 'geo-b', environment: 'prod', source: 'agent' } as any);
    d.nodes.gp = { id: 'gp', name: 'a1', clusterId: 'g1', lastSeen: iso(t), snapshot: { postgres: { is_in_recovery: false, alive: true, system_identifier: '77', current_lsn: '0/100' }, patroni: { accessible: true, local_node: { role: 'leader' } } } } as any;
    d.nodes.gs = { id: 'gs', name: 'b1', clusterId: 'g2', lastSeen: iso(t), snapshot: { postgres: { is_in_recovery: true, alive: true, system_identifier: '77', current_lsn: '0/100', wal_receiver: { status: 'streaming' } }, patroni: { accessible: true, local_node: { role: 'standby_leader' }, standby_cluster: { host: 'a-haproxy', port: 5000 } } } } as any;
    d.operations.push({ id: 'o-site-wal', type: 'backup_run', clusterId: 'g2', nodeId: 'gs', status: 'running', progress: { phase: 'wal' }, params: {}, createdAt: iso(t), updatedAt: iso(t), idempotencyKey: 'o-site-wal', history: [], attempts: 1 } as any);
  });
  const geoKick = await standbyKickTick(store, w);
  assert(geoKick.some(k => k.includes('o-site-wal')), JSON.stringify(geoKick));
  const gsw = store.peek().operations.find((o: any) => o.type === 'wal_switch' && o.idempotencyKey.includes('o-site-wal'))!;
  assert.strictEqual(gsw.nodeId, 'gp'); assert.strictEqual(gsw.clusterId, 'g1');
  console.log('standby kick OK');
})().catch(e => { console.error(e); process.exit(1); });
