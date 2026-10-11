// Geo-redundancy: sites paired by system identifier, replication between sites measured, DR promotion guarded against split-brain,
// planned switchover = demote primary site -> wait until the other site has everything -> promote it (each step through the site's own agent / DCS).
import assert from 'assert'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { geoGroups, mountGeoRoutes, geoSlotFor, geoParamGuard, geoStanzaPlan, stanzaOf, geoReadiness } from '../../server/geo';
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
  // one backup catalogue for the database: the primary site's own stanza, or the one that already holds backups
  assert.strictEqual(stanzaOf('patroni:geo-dc1'), 'patroni-geo-dc1');
  await store.mutate(d => { d.nodes.a.clusterKey = 'patroni:geo-dc1'; d.nodes.b.clusterKey = 'patroni:geo-dc2'; });
  assert.deepStrictEqual(geoStanzaPlan(store.peek(), 'c2'), { ids: ['c1', 'c2'], stanza: 'patroni-geo-dc1' });
  await store.mutate(d => { d.nodes.b.snapshot.backup = { stanza: 'patroni-geo-dc2', sets: 4 }; });
  assert.strictEqual(geoStanzaPlan(store.peek(), 'c1')!.stanza, 'patroni-geo-dc2', 'the catalogue that already has backups wins');
  await store.mutate(d => { delete d.nodes.b.snapshot.backup; });
  // parameters a standby needs at least as high: raising them on the primary site first is refused
  await store.mutate(d => { d.nodes.b.snapshot.postgres.settings = { max_connections: '100' }; });
  assert(/siti di replica/.test(geoParamGuard(store.peek(), 'c1', 'max_connections', 200) || ''), 'raise on the primary above the standby site: refused');
  assert.strictEqual(geoParamGuard(store.peek(), 'c1', 'max_connections', 100), null);
  assert.strictEqual(geoParamGuard(store.peek(), 'c2', 'max_connections', 300), null, 'raising on the standby site first is the right order');
  assert.strictEqual(geoParamGuard(store.peek(), 'c1', 'work_mem', '64MB'), null);
  // 2. the WAN breaks: receiver down, lag grows -> critical finding on the standby site
  await store.mutate(d => { d.nodes.a.snapshot = snapP('0/9000000'); d.nodes.b.snapshot = snapS('0/5000000', 'stopping', 300); });
  s2 = geoGroups(store.peek())[0].sites.find(s => s.clusterId === 'c2')!;
  assert.strictEqual(s2.health, 'bad'); assert.strictEqual(s2.lagBytes, 0x4000000);
  assert(evaluate(store.peek()).some(i => i.code === 'geo_replication' && i.severity === 'critical'));

  // 2b. the primary site failed over to timeline 2 from a point DC2 had passed: DC2 stays on timeline 1, receiver waiting -> named as a divergence
  await store.mutate(d => { d.nodes.a.snapshot = { ...snapP('0/9000000'), postgres: { ...snapP('0/9000000').postgres, timeline: 2 } }; d.nodes.b.snapshot = snapS('0/9000100', 'waiting', 3); });
  s2 = geoGroups(store.peek())[0].sites.find(s => s.clusterId === 'c2')!;
  assert.strictEqual(s2.health, 'bad'); assert(/timeline 2/.test(s2.problems[0]) && /pg_rewind/.test(s2.problems[0]), s2.problems[0]);
  await store.mutate(d => { d.nodes.a.snapshot = snapP('0/9000000'); d.nodes.b.snapshot = snapS('0/5000000', 'stopping', 300); });
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
  // ---- split-brain: the other site (it was a site: it has an address/catalogue) becomes writable too
  {
    const saved = JSON.parse(JSON.stringify(store.peek().nodes));
    const prim0 = geoGroups(store.peek())[0].primary!; const other = prim0 === 'c1' ? 'c2' : 'c1'; const on = other === 'c1' ? 'a' : 'b';
    await store.mutate(d => { const c = d.clusters.find((x: any) => x.id === other); c.geoEndpoint = c.geoEndpoint || { host: 'x', port: 5000 }; d.nodes[on].snapshot = snapP('0/9999999'); d.nodes[on].snapshot.patroni.scope = 'geo-' + other; });
    const gs = geoGroups(store.peek())[0];
    assert(gs.sites.every(s => s.health === 'bad' && /DUE SITI PRIMARI/.test(s.problems[0])), JSON.stringify(gs.sites.map(s => [s.name, s.health, s.problems[0]])));
    assert(evaluate(store.peek()).some(i => i.code === 'geo_replication' && i.severity === 'critical' && /DUE SITI PRIMARI/.test(i.title)));
    assert.strictEqual((await app.call('POST', '/api/geo/demote', { body: { clusterId: other, to: prim0, confirm: 'no' }, headers: k('dm0') })).status, 400);
    const dm = await app.call('POST', '/api/geo/demote', { body: { clusterId: other, to: prim0, confirm: 'DECLASSA' }, headers: k('dm1') });
    assert.strictEqual(dm.status, 202, JSON.stringify(dm.body)); assert.strictEqual(dm.body.operation.type, 'geo_demote'); assert.strictEqual(dm.body.operation.nodeId, on);
    await store.mutate(d => { d.operations = d.operations.filter((o: any) => o.id !== dm.body.operation.id); d.nodes = saved; });
  }
  // ---- relationships set by the operator, and false pairs avoided
  const st0 = () => store.peek();
  await store.mutate(d => {
    d.clusters.push({ id: 'c3', name: 'geo-copy', environment: 'test', source: 'agent' }, { id: 'c4', name: 'dr-direct', environment: 'prod', source: 'direct' }, { id: 'c5', name: 'other-db', environment: 'prod', source: 'agent' });
    d.nodes.c = { id: 'c', name: 'copy-pg1', clusterId: 'c3', lastSeen: now(), snapshot: { postgres: { alive: true, is_in_recovery: false, current_lsn: '0/1000', system_identifier: '7695', timeline: 2 } } } as any;
    d.nodes.e = { id: 'e', name: 'other-pg1', clusterId: 'c5', lastSeen: now(), snapshot: { postgres: { alive: true, is_in_recovery: true, current_lsn: '0/1000', system_identifier: '1111', timeline: 1, wal_receiver: { status: 'streaming', sender_host: 'x', sender_port: 5432, silent_sec: 1 } } } } as any;
  });
  let gg = geoGroups(st0()).find(x => x.sites.some(s => s.clusterId === 'c1'))!;
  assert(!gg.sites.some(s => s.clusterId === 'c3'), 'a restored copy (same sysid, writable, not followed by anyone) is not a site');
  assert(gg.sites.find(s => s.clusterId === gg.primary)!.problems.some(p => /geo-copy/.test(p)), 'but it is mentioned');
  // a cluster without agent declared as DR of the current primary
  const prim = gg.primary!;
  assert.strictEqual((await app.call('PUT', '/api/clusters/c4/geo-link', { body: { primary: prim } })).status, 200);
  gg = geoGroups(st0()).find(x => x.sites.some(s => s.clusterId === 'c4'))!;
  const c4 = gg.sites.find(s => s.clusterId === 'c4')!;
  assert.strictEqual(c4.link, 'manual'); assert.strictEqual(c4.role, 'standby'); assert.strictEqual(c4.health, 'warn');
  // declared link to a DIFFERENT database: kept but flagged as impossible
  assert.strictEqual((await app.call('PUT', '/api/clusters/c5/geo-link', { body: { primary: prim } })).status, 200);
  const c5 = geoGroups(st0()).flatMap(x => x.sites).find(s => s.clusterId === 'c5')!;
  assert.strictEqual(c5.health, 'bad'); assert(c5.problems.some(p => /altro database/.test(p)));
  // the lab case: a WRITABLE cluster of another database declared as replica -> still shown, flagged, never a second primary site
  await store.mutate(d => { d.clusters.push({ id: 'c6', name: 'erp', environment: 'prod', source: 'agent' } as any);
    d.nodes.f = { id: 'f', name: 'erp-pg1', clusterId: 'c6', lastSeen: now(), snapshot: { postgres: { alive: true, is_in_recovery: false, current_lsn: '0/2000', system_identifier: '2222', timeline: 1 } } } as any; });
  assert.strictEqual((await app.call('PUT', '/api/clusters/c6/geo-link', { body: { primary: prim } })).status, 200);
  const g6 = geoGroups(st0()).find(x => x.sites.some(s => s.clusterId === 'c6'))!;
  const c6 = g6.sites.find(s => s.clusterId === 'c6')!;
  assert.strictEqual(c6.health, 'bad'); assert(c6.problems.some(p => /altro database/.test(p)), JSON.stringify(c6.problems)); assert.strictEqual(g6.primary, prim);
  assert(!g6.sites.find(s => s.clusterId === prim)!.problems.some(p => /DUE SITI PRIMARI|erp/.test(p)), 'not a split-brain nor a copy');
  await app.call('PUT', '/api/clusters/c6/geo-link', { body: { primary: null } });
  // cycles and self links refused; back to automatic; detach
  assert.strictEqual((await app.call('PUT', '/api/clusters/c5/geo-link', { body: { primary: 'c5' } })).status, 400);
  assert.strictEqual((await app.call('PUT', `/api/clusters/${prim}/geo-link`, { body: { primary: 'c4' } })).status, 400, 'cycle');
  assert.strictEqual((await app.call('PUT', '/api/clusters/c5/geo-link', { body: { primary: null } })).status, 200);
  assert(!geoGroups(st0()).some(x => x.sites.some(s => s.clusterId === 'c5' && s.link === 'manual')));
  const stby = gg.sites.find(s => s.role === 'standby' && s.link === 'auto')!.clusterId;
  assert.strictEqual((await app.call('PUT', `/api/clusters/${stby}/geo-link`, { body: { none: true } })).status, 200);
  assert(!geoGroups(st0()).some(x => x.sites.some(s => s.clusterId === stby)), 'detached from automatic pairing');
  // DR readiness of a pair: permanent slot, upstream that follows the leader, params, RPO, rewind, local replication, backups, last switchover test
  {
    const st3 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'geor-')));
    const P = (extra: any = {}) => ({ postgres: { alive: true, is_in_recovery: false, version: '16.4', current_lsn: '0/9000000', system_identifier: '42', timeline: 1, settings: { max_connections: '200' }, slots: [{ name: 'geo_b', active: true }], hba_patroni_local: { ok: true }, ...extra.pg },
      patroni: { accessible: true, scope: 'a', local_node: { role: 'leader' }, permanent_slots: extra.perm ?? ['geo_b'], use_pg_rewind: true, members: [{ name: 'a1', host: 'a1' }] }, backup: { recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: new Date().toISOString() }] } });
    const S = (extra: any = {}) => ({ postgres: { alive: true, is_in_recovery: true, version: extra.version || '16.4', current_lsn: '0/9000000', system_identifier: '42', timeline: 1, settings: { max_connections: extra.maxc || '200' }, replay_ts: now(), wal_receiver: { status: 'streaming', sender_host: 'x', sender_port: 5000, silent_sec: 1 }, hba_patroni_local: { ok: true } },
      patroni: { accessible: true, scope: 'b', local_node: { role: 'standby_leader' }, use_pg_rewind: true, standby_cluster: { host: extra.host || 'a-haproxy', port: 5000, primary_slot_name: 'geo_b', ...(extra.rc ? { restore_command: 'pg-arca-wal get %f %p' } : {}) } } });
    await st3.mutate(d => { d.clusters.push({ id: 'A', name: 'site-a', environment: 'prod', source: 'agent', geoEndpoint: { host: 'a-haproxy', port: 5000 } } as any, { id: 'B', name: 'site-b', environment: 'prod', source: 'agent', geoEndpoint: { host: 'b-haproxy', port: 5000 } } as any);
      d.nodes.a1 = { id: 'a1', name: 'a1', clusterId: 'A', lastSeen: now(), snapshot: P() } as any; d.nodes.b1 = { id: 'b1', name: 'b1', clusterId: 'B', lastSeen: now(), snapshot: S({ rc: true }) } as any;
      d.settings.geoJobs = { j1: { id: 'j1', from: 'A', to: 'B', fromName: 'site-a', toName: 'site-b', status: 'succeeded', createdAt: new Date(Date.now() - 86400_000).toISOString(), finishedAt: new Date(Date.now() - 86400_000 + 7000).toISOString() } }; });
    const rd = () => geoReadiness(st3.peek(), geoGroups(st3.peek())[0]);
    let r = rd(); assert.strictEqual(r.status, 'ready', JSON.stringify(r.checks.filter(c => c.level !== 'ok'))); assert.strictEqual(r.rpoSec, 0); assert.strictEqual(r.lastTest!.seconds, 7);
    // the lab-style traps, one at a time
    await st3.mutate(d => { d.nodes.a1.snapshot = P({ perm: [] }); });
    r = rd(); assert.strictEqual(r.status, 'not_ready'); assert(r.checks.some(c => c.id === 'slot' && c.level === 'bad' && /non è permanente/.test(c.text)));
    await st3.mutate(d => { d.nodes.a1.snapshot = P(); d.nodes.b1.snapshot = S({ host: 'a1', rc: true, maxc: '100' }); });
    r = rd(); assert(r.checks.some(c => c.id === 'upstream' && c.level === 'warn')); assert(r.checks.some(c => c.id === 'param:max_connections' && c.level === 'bad'));
    await st3.mutate(d => { d.nodes.b1.snapshot = S({ version: '15.6' }); });
    r = rd(); assert(r.checks.some(c => c.id === 'version' && c.level === 'bad')); assert(r.checks.some(c => c.id === 'archive' && c.level === 'info'));
    const app3 = new MiniApp(); app3.use((req: any, _r: any, next: any) => { req.actor = 'mario'; req.role = 'admin'; return next(); }); mountGeoRoutes(app3, st3);
    assert.strictEqual((await app3.call('PUT', '/api/geo/settings', { body: { rpoSec: 0 } })).status, 400);
    assert.strictEqual((await app3.call('PUT', '/api/geo/settings', { body: { rpoSec: 30 } })).status, 200);
    const gg3 = (await app3.call('GET', '/api/geo')).body; assert.strictEqual(gg3.rpoTargetSec, 30); assert.strictEqual(gg3.groups[0].readiness.rpoTargetSec, 30);
  }
  console.log('geo tests OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
