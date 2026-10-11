// Geo-redundancy: sites paired by system identifier, replication between sites measured, DR promotion guarded against split-brain,
// planned switchover = demote primary site -> wait until the other site has everything -> promote it (each step through the site's own agent / DCS).
import assert from 'assert'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { geoGroups, mountGeoRoutes, geoSlotFor } from '../../server/geo';
import { evaluate } from '../../server/health';
import { deriveCluster } from '../../server/view';

(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'))); const app = new MiniApp();
  app.use((req: any, _r: any, next: any) => { req.actor = 'mario'; req.role = 'admin'; return next(); });
  mountGeoRoutes(app, store);
  const now = () => new Date().toISOString();
  const snapP = (lsn: string) => ({ postgres: { alive: true, is_in_recovery: false, current_lsn: lsn, system_identifier: '7695', timeline: 1, slots: [{ name: 'geo_dc2', active: true, retained_bytes: 1024 }] }, patroni: { accessible: true, scope: 'geo-dc1', local_node: { role: 'leader', state: 'running' }, standby_cluster: null } });
  const snapS = (lsn: string, status = 'streaming', silent = 1) => ({ postgres: { alive: true, is_in_recovery: true, current_lsn: lsn, system_identifier: '7695', timeline: 1, replay_ts: now(), wal_receiver: { status, sender_host: 'dc1-haproxy', sender_port: 5000, silent_sec: silent } }, patroni: { accessible: true, scope: 'geo-dc2', local_node: { role: 'standby_leader', state: 'streaming' }, standby_cluster: { host: 'dc1-haproxy', port: 5000, primary_slot_name: 'geo_dc2' } } });
  await store.mutate(d => {
    d.clusters.push({ id: 'c1', name: 'geo-dc1', environment: 'prod', source: 'agent' }, { id: 'c2', name: 'geo-dc2', environment: 'prod', source: 'agent' });
    d.nodes.a = { id: 'a', name: 'dc1-pg1', clusterId: 'c1', lastSeen: now(), snapshot: snapP('0/5000000') } as any;
    d.nodes.b = { id: 'b', name: 'dc2-pg1', clusterId: 'c2', lastSeen: now(), snapshot: snapS('0/5000000') } as any;
  });

  // 1. pairing + replication state
  assert.strictEqual(geoSlotFor('geo-dc1'), 'geo_dc1'); assert.strictEqual(geoSlotFor('Milano Nord'), 'geo_milano_nord');
  let g = geoGroups(store.peek()); assert.strictEqual(g.length, 1); assert.strictEqual(g[0].primary, 'c1');
  assert.deepStrictEqual(g[0].sites.find(s => s.clusterId === 'c1')!.endpoint, { host: 'dc1-haproxy', port: 5000 }, 'primary address detected from the standby site');
  let s2 = g[0].sites.find(s => s.clusterId === 'c2')!;
  assert.strictEqual(s2.role, 'standby'); assert.strictEqual(s2.lagBytes, 0); assert.strictEqual(s2.health, 'ok'); assert.strictEqual(s2.slot?.name, 'geo_dc2');
  // a standby cluster is not "degraded" for lacking a primary, and the briefing has no "no primary" / "no backup" for it
  const view = deriveCluster({ id: 'c2', name: 'geo-dc2', environment: 'prod', nodes: [store.peek().nodes.b as any] });
  assert.strictEqual(view.status, 'healthy'); assert(view.haState.standbyCluster);
  assert(!evaluate(store.peek()).some(i => i.clusterId === 'c2' && ['no_primary', 'no_backup'].includes(i.code)));
  // 2. the WAN breaks: receiver down, lag grows -> critical finding on the standby site
  await store.mutate(d => { d.nodes.a.snapshot = snapP('0/9000000'); d.nodes.b.snapshot = snapS('0/5000000', 'stopping', 300); });
  s2 = geoGroups(store.peek())[0].sites.find(s => s.clusterId === 'c2')!;
  assert.strictEqual(s2.health, 'bad'); assert.strictEqual(s2.lagBytes, 0x4000000);
  assert(evaluate(store.peek()).some(i => i.code === 'geo_replication' && i.severity === 'critical'));

  // 3. DR promotion refused while the primary site is alive (split-brain), accepted when the operator states it is lost
  const k = (x: string) => ({ 'idempotency-key': x });
  const r1 = await app.call('POST', '/api/geo/promote', { body: { clusterId: 'c2', confirm: 'PROMUOVI' }, headers: k('p1') });
  assert.strictEqual(r1.status, 409); assert.strictEqual(r1.body.error, 'primary_site_alive');
  const r2 = await app.call('POST', '/api/geo/promote', { body: { clusterId: 'c2', confirm: 'PROMUOVI', primaryLost: true }, headers: k('p2') });
  assert.strictEqual(r2.status, 202, JSON.stringify(r2.body)); assert.strictEqual(r2.body.operation.type, 'geo_promote'); assert.strictEqual(r2.body.operation.nodeId, 'b');
  assert.strictEqual(r2.body.operation.params.slot_for_peer, geoSlotFor('geo-dc1'));
  await store.mutate(d => { d.operations = []; d.nodes.b.snapshot = snapS('0/9000000'); });

  // 4. planned switchover: needs the endpoint of the target site; then demote c1 -> wait -> promote c2
  const nope = await app.call('POST', '/api/geo/switchover', { body: { from: 'c1', to: 'c2', confirm: 'SWITCHOVER' } });
  assert.strictEqual(nope.status, 409); assert.strictEqual(nope.body.error, 'endpoint_required');
  assert.strictEqual((await app.call('PUT', '/api/clusters/c2/geo-endpoint', { body: { host: 'dc2-haproxy', port: 5000 } })).status, 200);
  const sw = await app.call('POST', '/api/geo/switchover', { body: { from: 'c1', to: 'c2', confirm: 'SWITCHOVER' } });
  assert.strictEqual(sw.status, 202, JSON.stringify(sw.body)); const job = sw.body.job.id;
  // fake agents: answer the demote on c1 (becomes standby leader following dc2), then the promote on c2
  const answer = async (type: string, then: (d: any) => void) => {
    for (let i = 0; i < 100; i++) {
      const o = store.peek().operations.find(x => x.type === type && x.status === 'queued');
      if (o) { await store.mutate(d => { const x = d.operations.find(y => y.id === o.id)!; x.status = 'succeeded'; x.result = { ok: true }; then(d); }); return o; }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('no ' + type + ' submitted: ' + JSON.stringify(store.peek().settings.geoJobs));
  };
  const dem = await answer('geo_demote', d => { d.nodes.a.snapshot = { ...snapS('0/9000100'), patroni: { ...snapS('0').patroni, scope: 'geo-dc1', standby_cluster: { host: 'dc2-haproxy', port: 5000, primary_slot_name: 'geo_dc1' } } }; d.nodes.b.snapshot = snapS('0/9000100'); });
  assert.strictEqual(dem.nodeId, 'a'); assert.deepStrictEqual([dem.params.host, dem.params.port, dem.params.primary_slot_name], ['dc2-haproxy', 5000, 'geo_dc1']);
  assert.deepStrictEqual(dem.params.drop_slots, ['geo_dc2'], 'the slot DC2 used on DC1 is dropped when DC1 becomes a standby site');
  assert.deepStrictEqual(store.peek().clusters.find((c: any) => c.id === 'c1').geoEndpoint, { host: 'dc1-haproxy', port: 5000, detected: true }, 'DC1 address remembered from what DC2 used');
  const pro = await answer('geo_promote', d => { d.nodes.b.snapshot = snapP('0/9000200'); d.nodes.b.snapshot.patroni.scope = 'geo-dc2'; });
  assert.strictEqual(pro.nodeId, 'b'); assert.strictEqual(pro.params.slot_for_peer, geoSlotFor('geo-dc1'));
  for (let i = 0; i < 50 && store.peek().settings.geoJobs[job].status === 'running'; i++) await new Promise(r => setTimeout(r, 100));
  const j = store.peek().settings.geoJobs[job];
  assert.strictEqual(j.status, 'succeeded', JSON.stringify(j.steps)); assert.strictEqual(j.steps.length, 4);
  console.log('geo tests OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
