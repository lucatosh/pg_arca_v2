// Geo-redundancy: sites paired by system identifier, replication between sites measured, DR promotion guarded against split-brain,
// planned switchover = demote primary site -> wait until the other site has everything -> promote it (each step through the site's own agent / DCS).
import assert from 'assert'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { sameTimelineDiverged, parseHistory, followsPrimary } from '../../server/geodr';
import { knownPeerEndpoints } from '../../server/geo';
import { geoGroups, mountGeoRoutes, geoSlotFor, geoParamGuard, geoStanzaPlan, stanzaOf, geoReadiness } from '../../server/geo';
import { evaluate } from '../../server/health';
import { GEO_DR_TIMING, geoMonitorTick, watchOf, recoverInterruptedGeoJobs, pruneGeoJobs, startFailover } from '../../server/geodr';
import { deriveCluster } from '../../server/view';

(async () => {
  { // finished site-role jobs are bounded, running ones kept
    const d: any = { settings: { geoJobs: {} } };
    for (let i = 0; i < 250; i++) d.settings.geoJobs['j' + i] = { id: 'j' + i, status: 'failed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() };
    d.settings.geoJobs.run = { id: 'run', status: 'running', createdAt: '2025-01-01T00:00:00Z' };
    pruneGeoJobs(d); assert.strictEqual(Object.keys(d.settings.geoJobs).length, 201); assert(d.settings.geoJobs.run && d.settings.geoJobs.j249 && !d.settings.geoJobs.j0);
  }
  Object.assign(GEO_DR_TIMING, { stableMs: 300, pollMs: 50, maxCatchupMs: 3000, rejoinPollMs: 50, rejoinStreamMs: 1500 });
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
  assert(/standby sites/.test(geoParamGuard(store.peek(), 'c1', 'max_connections', 200) || ''), 'raise on the primary above the standby site: refused');
  assert.strictEqual(geoParamGuard(store.peek(), 'c1', 'max_connections', 100), null);
  assert.strictEqual(geoParamGuard(store.peek(), 'c2', 'max_connections', 300), null, 'raising on the standby site first is the right order');
  assert.strictEqual(geoParamGuard(store.peek(), 'c1', 'work_mem', '64MB'), null);
  // the standby site must be able to archive the moment it becomes the primary: said in the readiness
  const rd = () => geoReadiness(store.peek(), geoGroups(store.peek())[0]).checks.find(c => c.id === 'standby_archive');
  await store.mutate(d => { d.nodes.b.snapshot.postgres.settings = { max_connections: '100', archive_mode: 'off' }; });
  assert.strictEqual(rd()?.level, 'warn', 'archiving off on the standby site');
  await store.mutate(d => { d.nodes.b.snapshot.postgres.settings = { max_connections: '100', archive_mode: 'on', archive_command: '/usr/local/bin/pg-arca-wal archive %p %f' }; });
  assert.strictEqual(rd()?.level, 'ok');
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
  // 2c. WAN down but archive fallback configured and the site keeps close: degraded (warn), not lost
  await store.mutate(d => { d.nodes.b.snapshot = snapS('0/8F00000', 'waiting', 400); d.nodes.b.snapshot.patroni.standby_cluster.restore_command = 'pg-arca-wal get %f %p'; });
  s2 = geoGroups(store.peek())[0].sites.find(s => s.clusterId === 'c2')!;
  assert.strictEqual(s2.health, 'warn', JSON.stringify(s2.problems)); assert(/WAL archive/.test(s2.problems[0]));
  await store.mutate(d => { d.nodes.b.snapshot = snapS('0/5000000', 'stopping', 300); });
  // 3. DR promotion refused while the primary site is alive (split-brain), accepted when the operator states it is lost
  const k = (x: string) => ({ 'idempotency-key': x });
  const r1 = await app.call('POST', '/api/geo/promote', { body: { clusterId: 'c2', confirm: 'PROMUOVI' }, headers: k('p1') });
  assert.strictEqual(r1.status, 409); assert.strictEqual(r1.body.error, 'primary_site_alive');
  const r2 = await app.call('POST', '/api/geo/promote', { body: { clusterId: 'c2', confirm: 'PROMOTE', primaryLost: true }, headers: k('p2') });
  assert.strictEqual(r2.status, 202, JSON.stringify(r2.body)); assert.strictEqual(r2.body.job.type, 'failover', 'a manual DR promotion runs the failover procedure (archive catch-up, loss estimate, slot, rejoin)');
  {
    const want = async (type: string) => { for (let i = 0; i < 100; i++) { const o = store.peek().operations.find(x => x.type === type && x.status === 'queued'); if (o) return o; await new Promise(r => setTimeout(r, 50)); } throw new Error('no ' + type + ': ' + JSON.stringify(store.peek().settings.geoJobs)); };
    const fb = await want('geo_archive_fallback'); assert.strictEqual(fb.nodeId, 'b'); assert.strictEqual(fb.params.enable, true);
    await store.mutate(d => { const x = d.operations.find(y => y.id === fb.id)!; x.status = 'succeeded'; });
    const pp = await want('geo_promote'); assert.strictEqual(pp.nodeId, 'b'); assert.strictEqual(pp.params.slot_for_peer, geoSlotFor('geo-dc1'));
    await store.mutate(d => { const x = d.operations.find(y => y.id === pp.id)!; x.status = 'cancelled'; });
    for (let i = 0; i < 60 && store.peek().settings.geoJobs[r2.body.job.id].status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(store.peek().settings.geoJobs[r2.body.job.id].status, 'failed', 'promotion not done: the job says so');
    assert(!store.peek().settings.geoFailovers?.[geoGroups(store.peek())[0].sysid], 'no failover recorded when the promotion did not happen');
  }
  await store.mutate(d => { d.operations = []; d.nodes.b.snapshot = snapS('0/9000000'); d.settings.geoJobs = {}; });

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
    assert(gs.sites.every(s => s.health === 'bad' && /TWO PRIMARY SITES/.test(s.problems[0])), JSON.stringify(gs.sites.map(s => [s.name, s.health, s.problems[0]])));
    assert(evaluate(store.peek()).some(i => i.code === 'geo_replication' && i.severity === 'critical' && /TWO PRIMARY SITES/.test(i.title)));
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
  assert.strictEqual(c5.health, 'bad'); assert(c5.problems.some(p => /different database/.test(p)));
  // the lab case: a WRITABLE cluster of another database declared as replica -> still shown, flagged, never a second primary site
  await store.mutate(d => { d.clusters.push({ id: 'c6', name: 'erp', environment: 'prod', source: 'agent' } as any);
    d.nodes.f = { id: 'f', name: 'erp-pg1', clusterId: 'c6', lastSeen: now(), snapshot: { postgres: { alive: true, is_in_recovery: false, current_lsn: '0/2000', system_identifier: '2222', timeline: 1 } } } as any; });
  assert.strictEqual((await app.call('PUT', '/api/clusters/c6/geo-link', { body: { primary: prim } })).status, 200);
  const g6 = geoGroups(st0()).find(x => x.sites.some(s => s.clusterId === 'c6'))!;
  const c6 = g6.sites.find(s => s.clusterId === 'c6')!;
  assert.strictEqual(c6.health, 'bad'); assert(c6.problems.some(p => /different database/.test(p)), JSON.stringify(c6.problems)); assert.strictEqual(g6.primary, prim);
  assert(!g6.sites.find(s => s.clusterId === prim)!.problems.some(p => /TWO PRIMARY SITES|erp/.test(p)), 'not a split-brain nor a copy');
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
      patroni: { accessible: true, scope: 'a', local_node: { role: 'leader' }, permanent_slots: extra.perm ?? ['geo_b'], use_pg_rewind: true, members: [{ name: 'a1', host: 'a1' }], ...(extra.norc ? {} : { recovery_restore_command: 'pg-arca-wal get %f %p' }) }, backup: { recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: new Date().toISOString() }] } });
    const S = (extra: any = {}) => ({ postgres: { alive: true, is_in_recovery: true, version: extra.version || '16.4', current_lsn: '0/9000000', system_identifier: '42', timeline: 1, settings: { max_connections: extra.maxc || '200' }, replay_ts: now(), wal_receiver: { status: 'streaming', sender_host: 'x', sender_port: 5000, silent_sec: 1 }, hba_patroni_local: { ok: true } },
      patroni: { accessible: true, scope: 'b', local_node: { role: 'standby_leader' }, use_pg_rewind: true, standby_cluster: { host: extra.host || 'a-haproxy', port: 5000, primary_slot_name: 'geo_b', ...(extra.rc ? { restore_command: 'pg-arca-wal get %f %p' } : {}) } } });
    await st3.mutate(d => { d.clusters.push({ id: 'A', name: 'site-a', environment: 'prod', source: 'agent', geoEndpoint: { host: 'a-haproxy', port: 5000 } } as any, { id: 'B', name: 'site-b', environment: 'prod', source: 'agent', geoEndpoint: { host: 'b-haproxy', port: 5000 } } as any);
      d.nodes.a1 = { id: 'a1', name: 'a1', clusterId: 'A', lastSeen: now(), snapshot: P() } as any; d.nodes.b1 = { id: 'b1', name: 'b1', clusterId: 'B', lastSeen: now(), snapshot: S({ rc: true }) } as any;
      d.settings.geoJobs = { j1: { id: 'j1', from: 'A', to: 'B', fromName: 'site-a', toName: 'site-b', status: 'succeeded', createdAt: new Date(Date.now() - 86400_000).toISOString(), finishedAt: new Date(Date.now() - 86400_000 + 7000).toISOString() } }; });
    const rd = () => geoReadiness(st3.peek(), geoGroups(st3.peek())[0]);
    let r = rd(); assert.strictEqual(r.status, 'ready', JSON.stringify(r.checks.filter(c => c.level !== 'ok'))); assert.strictEqual(r.rpoSec, 0); assert.strictEqual(r.lastTest!.seconds, 7);
    // the lab-style traps, one at a time
    await st3.mutate(d => { d.nodes.a1.snapshot = P({ norc: true }); });
    assert.strictEqual(rd().checks.find(c => c.id === 'archive_primary')!.level, 'warn', 'a primary site that cannot see the shared archive may re-use a timeline number');
    await st3.mutate(d => { d.nodes.a1.snapshot = P({ perm: [] }); });
    r = rd(); assert.strictEqual(r.status, 'not_ready'); assert(r.checks.some(c => c.id === 'slot' && c.level === 'bad' && /not permanent/.test(c.text)));
    await st3.mutate(d => { d.nodes.a1.snapshot = P(); d.nodes.b1.snapshot = S({ host: 'a1', rc: true, maxc: '100' }); });
    r = rd(); assert(r.checks.some(c => c.id === 'upstream' && c.level === 'warn')); assert(r.checks.some(c => c.id === 'param:max_connections' && c.level === 'bad'));
    await st3.mutate(d => { d.nodes.b1.snapshot = S({ version: '15.6' }); });
    r = rd(); assert(r.checks.some(c => c.id === 'version' && c.level === 'bad')); assert(r.checks.some(c => c.id === 'archive' && c.level === 'warn'));
    const app3 = new MiniApp(); app3.use((req: any, _r: any, next: any) => { req.actor = 'mario'; req.role = 'admin'; return next(); }); mountGeoRoutes(app3, st3);
    assert.strictEqual((await app3.call('PUT', '/api/geo/settings', { body: { rpoSec: 0 } })).status, 400);
    assert.strictEqual((await app3.call('PUT', '/api/geo/settings', { body: { rpoSec: 30 } })).status, 200);
    const gg3 = (await app3.call('GET', '/api/geo')).body; assert.strictEqual(gg3.rpoTargetSec, 30); assert.strictEqual(gg3.groups[0].readiness.rpoTargetSec, 30);
  }
  // ---- automatic failover and rejoin (geodr): two witnesses, confirmation window, loss limit, primary back -> standby of the new primary
  {
    const st4 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'geodr-')));
    const app4 = new MiniApp(); app4.use((req: any, _r: any, next: any) => { req.actor = 'mario'; req.role = 'admin'; return next(); }); mountGeoRoutes(app4, st4);
    await st4.mutate(d => {
      d.clusters.push({ id: 'm', name: 'hy-mi', environment: 'prod', source: 'agent', geoEndpoint: { host: '192.168.1.179', port: 15432 } } as any, { id: 'r', name: 'hy-rm', environment: 'prod', source: 'agent', geoEndpoint: { host: '192.168.1.232', port: 5000 } } as any);
      d.nodes.m1 = { id: 'm1', name: 'hy1', clusterId: 'm', lastSeen: now(), snapshot: snapP('0/7000000') } as any;
      d.nodes.r1 = { id: 'r1', name: 'hyb1', clusterId: 'r', lastSeen: now(), snapshot: snapS('0/7000000') } as any;
    });
    const key = geoGroups(st4.peek())[0].sysid; const T0 = Date.now();
    // simulated clock: the nodes that are "up" heard from just now (in simulated time), the others 2 minutes ago
    const up: Record<string, boolean> = { m1: true, r1: true };
    const tick = async (dt = 0) => { await st4.mutate(d => { for (const id of ['m1', 'r1']) d.nodes[id].lastSeen = new Date(T0 + dt - (up[id] ? 1000 : 120_000)).toISOString(); }); return geoMonitorTick(st4, T0 + dt); };
    const jobs = () => Object.values(st4.peek().settings.geoJobs || {}) as any[];
    await tick(); assert.strictEqual(st4.peek().settings.geoLastPrimary[key].clusterId, 'm', 'the pair remembers its primary and its position');
    // policy: off by default; admin sets it
    assert.strictEqual((await app4.call('GET', '/api/geo')).body.groups[0].policy.autoFailover, false);
    assert.strictEqual((await app4.call('PUT', `/api/geo/policy/${key}`, { body: { confirmSec: 5 } })).status, 400);
    assert.strictEqual((await app4.call('PUT', `/api/geo/policy/${key}`, { body: { autoFailover: true, confirmSec: 20, maxLossMB: 16 } })).status, 409, 'automatic failover needs the console declared outside both sites');
    assert.strictEqual((await app4.call('PUT', `/api/geo/policy/${key}`, { body: { autoFailover: true, consoleOutside: true, confirmSec: 20, maxLossMB: 16 } })).status, 200);
    // a) WAN cut: the standby site is blind, the console still hears the primary -> nothing
    await st4.mutate(d => { d.nodes.r1.snapshot = snapS('0/7000000', 'waiting', 200); });
    await tick(30_000); assert.strictEqual(jobs().length, 0); assert(/not a disaster/.test(watchOf(key)?.note || '') || !watchOf(key), JSON.stringify(watchOf(key)));
    // b) the console loses the primary but the standby site still streams from it -> nothing
    up.m1 = false; await st4.mutate(d => { d.nodes.r1.snapshot = snapS('0/7000000', 'streaming', 1); });
    await tick(60_000); await tick(120_000); assert.strictEqual(jobs().length, 0, 'one witness only: no failover');
    // c) both witnesses: waits the confirmation window, then fails over to the standby site
    await st4.mutate(d => { d.nodes.r1.snapshot = snapS('0/7000000', 'waiting', 60); });
    await tick(130_000); assert.strictEqual(jobs().length, 0); const w = watchOf(key)!; assert(w.downSince && w.witnesses.console && w.witnesses.standby, JSON.stringify(w)); assert(w.actInSec! > 0);
    await tick(152_000); assert.strictEqual(jobs().length, 1); const fj = jobs()[0]; assert.strictEqual(fj.type, 'failover_auto'); assert.strictEqual(fj.to, 'r');
    const answer4 = async (type: string, then?: (d: any) => void) => { for (let i = 0; i < 100; i++) { const o = st4.peek().operations.find(x => x.type === type && x.status === 'queued');
      if (o) { await st4.mutate(d => { const x = d.operations.find(y => y.id === o.id)!; x.status = 'succeeded'; x.result = { timeline: 2 }; then?.(d); }); return o; } await new Promise(r => setTimeout(r, 50)); } throw new Error('no ' + type + ' ' + JSON.stringify(jobs())); };
    await answer4('geo_archive_fallback', d => { d.nodes.r1.snapshot.patroni.standby_cluster.restore_command = 'pg-arca-wal get %f %p'; });
    const pr = await answer4('geo_promote', d => { d.nodes.r1.snapshot = snapP('0/7000100'); d.nodes.r1.snapshot.patroni.scope = 'hy-rm'; });
    assert.strictEqual(pr.params.slot_for_peer, 'geo_hy_mi');
    for (let i = 0; i < 80 && jobs()[0].status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(jobs()[0].status, 'succeeded', JSON.stringify(jobs()[0].steps)); assert.strictEqual(jobs()[0].lossBytes, 0);
    const fo = st4.peek().settings.geoFailovers[key]; assert.deepStrictEqual([fo.from, fo.to, fo.auto], ['m', 'r', true]);
    await tick(160_000); assert.strictEqual(st4.peek().settings.geoLastPrimary[key].clusterId, 'r', 'the promoted site is now the primary of the pair');
    // d) the old primary comes back WRITABLE (split-brain) -> becomes a standby site of the new primary by itself, divergence reported
    up.m1 = true; await st4.mutate(d => { d.nodes.m1.lastSeen = now(); d.nodes.m1.snapshot = snapP('0/7400000'); });
    assert.strictEqual(geoGroups(st4.peek())[0].primary, 'r', 'the promoted site stays the primary while the old one is back');
    await tick(170_000);
    // it promoted itself on coming back: SAME timeline number as hy-rm (3) but another history -> the demotion forces pg_rewind
    const answerTl = async (cid: string, result: any) => { for (let i = 0; i < 200; i++) { const o = st4.peek().operations.find(x => x.type === 'pg_timeline' && x.clusterId === cid && x.status === 'queued');
      if (o) { await st4.mutate(d => { const x = d.operations.find(y => y.id === o.id)!; x.status = 'succeeded'; x.result = result; }); return o; } await new Promise(r => setTimeout(r, 50)); } throw new Error('no pg_timeline on ' + cid); };
    const histNew = '1\t0/5000000\tno recovery target specified\n2\t0/7000100\tno recovery target specified\n', histOld = '1\t0/5000000\tno recovery target specified\n2\t0/7400000\tno recovery target specified\n';
    // fenced FIRST (no more writes on the old primary while its history is analysed), rebuilt after
    const fence0 = await answer4('geo_demote'); assert(!fence0.params.force_rewind, 'the fence is a plain demotion'); assert(fence0.idempotencyKey.endsWith(':fence'));
    await answerTl('m', { timeline: 3, history: histOld, lsn: '0/7400100' }); await answerTl('r', { timeline: 3, history: histNew, lsn: '0/7100000' });
    const dm = await answer4('geo_demote', d => { d.nodes.m1.snapshot = { ...snapS('0/7000100', 'streaming', 1), patroni: { ...snapS('0').patroni, scope: 'hy-mi', standby_cluster: { host: '192.168.1.232', port: 5000, primary_slot_name: 'geo_hy_mi' } } }; });
    assert.strictEqual(dm.nodeId, 'm1'); assert.deepStrictEqual([dm.params.host, dm.params.port, dm.params.primary_slot_name], ['192.168.1.232', 5000, 'geo_hy_mi']);
    assert.strictEqual(dm.params.force_rewind, true, 'same timeline number, different history: pg_rewind forced');
    // after the demotion it must follow hy-rm's history (the post check): answered as identical
    await answerTl('m', { timeline: 3, history: histNew, lsn: '0/7100000' }); await answerTl('r', { timeline: 3, history: histNew, lsn: '0/7100000' });
    const rj = () => jobs().find(j => j.type === 'rejoin');
    for (let i = 0; i < 80 && rj()?.status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(rj()!.status, "succeeded", JSON.stringify(rj()!.steps)); assert(rj()!.divergedBytes > 0 && /discarded/.test(rj()!.steps[0].text), JSON.stringify(rj()!.steps)); assert(rj()!.steps.some((x: any) => /SAME timeline/.test(x.text)), 'the forced rewind is said');
    assert(st4.peek().settings.geoFailovers[key].rejoinedAt);
    // e) loss above the limit: an AUTOMATIC failover stops and asks a person
    // the promoted site was also asked to keep seeing the shared archive (restore_command in its DCS, fire-and-forget)
    assert(st4.peek().operations.some(o => o.type === 'geo_archive_fallback' && o.clusterId === 'r' && o.params.enable === true), 'the new primary keeps seeing the archive');
    await st4.mutate(d => { for (const o of d.operations) if (o.status === 'queued') o.status = 'succeeded'; });
    await st4.mutate(d => { d.settings.geoJobs = {}; delete d.settings.geoFailovers; d.settings.geoLastPrimary[key] = { clusterId: 'r', name: 'hy-rm', lsn: '0/9000000', at: now() };
      d.nodes.m1.snapshot = { ...d.nodes.m1.snapshot, postgres: { ...d.nodes.m1.snapshot.postgres, current_lsn: '0/7000100', wal_receiver: { status: 'waiting', sender_host: '192.168.1.232', sender_port: 5000, silent_sec: 90 } } }; });
    up.r1 = false; up.m1 = true; await tick(200_000); await tick(230_000);
    const held = jobs()[0]; assert(held, 'failover started');
    await answer4('geo_archive_fallback');
    for (let i = 0; i < 80 && jobs()[0].status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(jobs()[0].status, 'held', JSON.stringify(jobs()[0].steps)); assert(/exceeds the automatic failover limit/.test(jobs()[0].error));
    assert(!st4.peek().operations.some(o => o.type === 'geo_promote' && o.status === 'queued'), 'nothing promoted');
    // f) FENCING: after a failover the old site answers again with Patroni up but PostgreSQL still starting (site role unknown):
    //    it is demoted NOW, not once it is primary and writable (that wait was the split-brain window)
    await st4.mutate(d => { d.settings.geoJobs = {}; for (const o of d.operations) if (o.status === 'queued') o.status = 'cancelled';
      d.settings.geoFailovers = { [key]: { from: 'm', to: 'r', fromName: 'hy-mi', toName: 'hy-rm', at: now(), forkLsn: '0/9000000', lossBytes: 0, auto: true, timeline: 3 } };
      d.nodes.r1.snapshot = snapP('0/9100000'); d.nodes.r1.snapshot.patroni.scope = 'hy-rm';
      d.nodes.m1.snapshot = { postgres: { alive: false, system_identifier: '7695' }, patroni: { accessible: true, scope: 'hy-mi', local_node: { role: null, state: 'starting' }, standby_cluster: null } }; });
    up.m1 = true; up.r1 = true; await tick(400_000);
    const fence = jobs().find(j => j.type === 'rejoin'); assert(fence, 'rejoin (fence) started at the first sign of life');
    for (let i = 0; i < 40 && !fence.steps.length; i++) await new Promise(r => setTimeout(r, 50));
    assert(/fenced as a standby site/.test(jobs().find(j => j.type === 'rejoin')!.steps[0].text), JSON.stringify(jobs()));
    const dq = await answer4('geo_demote', d => { d.nodes.m1.snapshot = { ...snapS('0/9100000', 'streaming', 1), patroni: { ...snapS('0').patroni, scope: 'hy-mi', standby_cluster: { host: '192.168.1.232', port: 5000, primary_slot_name: 'geo_hy_mi' } } }; });
    assert.strictEqual(dq.clusterId, 'm'); assert.strictEqual(dq.params.confirm, 'DEMOTE'); assert(!dq.params.force_rewind, 'no self-promotion happened: plain demotion');
    const hist = '1\t0/5000000\tno recovery target specified\n2\t0/9000000\tno recovery target specified\n';
    await answerTl('m', { timeline: 3, history: hist, lsn: '0/9100000' }); await answerTl('r', { timeline: 3, history: hist, lsn: '0/9100000' });
    for (let i = 0; i < 80 && jobs().find(j => j.type === 'rejoin')!.status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(jobs().find(j => j.type === 'rejoin')!.status, 'succeeded', JSON.stringify(jobs()));
    // g) the old site is on a HIGHER timeline than the new primary (it promoted itself while away): after the demotion it never streams
    //    ("highest timeline 12 of the primary is behind recovery timeline 13"): rebuilt from the new primary (second demotion with force_rewind)
    await st4.mutate(d => { d.settings.geoJobs = {}; for (const o of d.operations) if (o.status === 'queued') o.status = 'cancelled';
      d.settings.geoFailovers = { [key]: { from: 'm', to: 'r', fromName: 'hy-mi', toName: 'hy-rm', at: now(), forkLsn: '0/9000000', lossBytes: 0, auto: true, timeline: 3 } };
      d.nodes.r1.snapshot = snapP('0/9200000'); d.nodes.r1.snapshot.patroni.scope = 'hy-rm';
      d.nodes.m1.snapshot = { ...snapP('0/9300000'), patroni: { accessible: true, scope: 'hy-mi', local_node: { role: 'leader', state: 'running' }, standby_cluster: null } }; });
    await tick(500_000);
    const hist3 = '1\t0/5000000\tno recovery target specified\n2\t0/9000000\tno recovery target specified\n';
    // fenced first (plain demotion), but the site stays a standby leader that does NOT stream (waiting)
    const d1 = await answer4('geo_demote', d => { d.nodes.m1.snapshot = { ...snapS('0/9300000', 'waiting', 30), patroni: { ...snapS('0').patroni, scope: 'hy-mi', standby_cluster: { host: '192.168.1.232', port: 5000, primary_slot_name: 'geo_hy_mi' } } }; });
    assert(!d1.params.force_rewind, 'first demotion is plain (different timeline numbers)');
    await answerTl('m', { timeline: 4, history: hist3 + '3\t0/9200000\tno recovery target specified\n', lsn: '0/9300000' }); await answerTl('r', { timeline: 3, history: hist3, lsn: '0/9200000' });
    await answerTl('m', { timeline: 4, history: hist3 + '3\t0/9200000\tno recovery target specified\n', lsn: '0/9300000' }); await answerTl('r', { timeline: 3, history: hist3, lsn: '0/9200000' });
    // its abandoned timeline 4 is set aside in the archive first, on the primary site and on the old site
    const rt = await answer4('wal_retire_branch'); assert.deepStrictEqual([rt.clusterId, rt.params.timeline, rt.params.abandoned], ['r', 4, true]);
    const rt2 = await answer4('wal_retire_branch'); assert.deepStrictEqual([rt2.clusterId, rt2.params.primary_timeline], ['m', 3]);
    const d2 = await answer4('geo_demote', d => { d.nodes.m1.snapshot = { ...snapS('0/9200000', 'streaming', 1), patroni: { ...snapS('0').patroni, scope: 'hy-mi', standby_cluster: { host: '192.168.1.232', port: 5000, primary_slot_name: 'geo_hy_mi' } } }; });
    assert.strictEqual(d2.params.force_rewind, true, 'higher timeline on the old site: rebuilt from the new primary');
    await answerTl('m', { timeline: 3, history: hist3, lsn: '0/9200000' }); await answerTl('r', { timeline: 3, history: hist3, lsn: '0/9200000' });
    for (let i = 0; i < 120 && jobs().find(j => j.type === 'rejoin')!.status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    const rj3 = jobs().find(j => j.type === 'rejoin')!; assert.strictEqual(rj3.status, 'succeeded', JSON.stringify(rj3.steps)); assert(rj3.steps.some((x: any) => /ahead of hy-rm/.test(x.text)));
    // h) seen on the lab: the old site, a standby AHEAD of the new primary (timeline 13 vs 12), whose WAL receiver starts and dies, had been
    //    marked 'rejoined' on one 'streaming' sample. That mark is reopened, and the rejoin rebuilds it straight away (force_rewind on the first demotion)
    await st4.mutate(d => { d.settings.geoJobs = {}; for (const o of d.operations) if (o.status === 'queued') o.status = 'cancelled';
      d.settings.geoFailovers = { [key]: { from: 'm', to: 'r', fromName: 'hy-mi', toName: 'hy-rm', at: now(), forkLsn: '0/9000000', lossBytes: 0, auto: true, timeline: 12, rejoinedAt: now() } };
      d.nodes.r1.snapshot = snapP('0/9500000'); d.nodes.r1.snapshot.patroni.scope = 'hy-rm'; d.nodes.r1.snapshot.postgres.timeline = 12;
      d.nodes.m1.snapshot = { ...snapS('0/9300000', 'streaming', 1), patroni: { ...snapS('0').patroni, scope: 'hy-mi', standby_cluster: { host: '192.168.1.232', port: 5000, primary_slot_name: 'geo_hy_mi' } } }; d.nodes.m1.snapshot.postgres.timeline = 13; });
    assert.strictEqual(followsPrimary({ role: 'standby', receiver: { status: 'streaming' }, timeline: 13 }, { timeline: 12 }), false);
    assert.strictEqual(followsPrimary({ role: 'standby', receiver: { status: 'streaming' }, timeline: 12 }, { timeline: 12 }), true);
    await tick(600_000);
    assert(!st4.peek().settings.geoFailovers[key].rejoinedAt, 'a false rejoin is reopened');
    assert(st4.peek().audit.some((a: any) => a.action === 'geo.rejoin' && a.status === 'REOPENED'));
    await tick(610_000);
    for (const want of [['r', undefined], ['m', 12]]) { const r = await answer4('wal_retire_branch'); assert.deepStrictEqual([r.clusterId, r.params.timeline, r.params.primary_timeline], [want[0], 13, want[1]]); }
    const d3 = await answer4('geo_demote', d => { d.nodes.m1.snapshot.postgres.timeline = 12; d.nodes.m1.snapshot.postgres.current_lsn = '0/9500000'; });
    assert.strictEqual(d3.params.force_rewind, true, 'a standby ahead of the primary is rebuilt at once');
    await answerTl('m', { timeline: 12, history: hist3, lsn: '0/9500000' }); await answerTl('r', { timeline: 12, history: hist3, lsn: '0/9500000' });
    for (let i = 0; i < 120 && jobs().find(j => j.type === 'rejoin')!.status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    const rj4 = jobs().find(j => j.type === 'rejoin')!; assert.strictEqual(rj4.status, 'succeeded', JSON.stringify(rj4.steps)); assert(/ahead of hy-rm \(12\)/.test(rj4.steps[0].text), rj4.steps[0].text); assert(rj4.steps.some((x: any) => /timeline 13 of hy-mi abandoned/.test(x.text)), JSON.stringify(rj4.steps));
    assert(st4.peek().settings.geoFailovers[key].rejoinedAt, 'rejoined for real');
  }
  { // peers a site may be demoted under: live peers, and the partner of a recorded failover (a site whose PostgreSQL does not start has no live group)
    const st6: any = { clusters: [{ id: 'x', name: 'hy-mi' }, { id: 'y', name: 'hy-rm', geoEndpoint: { host: '192.168.1.232', port: 5000 } }, { id: 'z', name: 'other', geoEndpoint: { host: '10.0.0.9', port: 5000 } }],
      nodes: {}, operations: [], settings: { geoFailovers: { k: { from: 'x', to: 'y' } } } };
    assert.deepStrictEqual(knownPeerEndpoints(st6, 'x'), [{ host: '192.168.1.232', port: 5000 }]);
    assert.deepStrictEqual(knownPeerEndpoints(st6, 'z'), [], 'an unrelated cluster is never a peer');
  }
  { // a console restart while a geo job runs: the job is closed as interrupted and the pair released (it blocked switchover, failover and rejoin for good)
    const st5 = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'geojobs-')));
    await st5.mutate(d => { d.settings.geoJobs = { g1: { id: 'g1', type: 'rejoin', from: 'm', to: 'r', status: 'running', steps: [] }, g2: { id: 'g2', type: 'switchover', from: 'a', to: 'b', status: 'succeeded', steps: [] } };
      d.settings.geoFailovers = { k: { from: 'm', to: 'r', rejoinJob: 'g1', rejoinFailedAt: now() } }; });
    assert.deepStrictEqual(await recoverInterruptedGeoJobs(st5), ['g1']);
    const p5 = st5.peek(); assert.strictEqual(p5.settings.geoJobs.g1.status, 'interrupted'); assert.strictEqual(p5.settings.geoJobs.g2.status, 'succeeded');
    assert(!p5.settings.geoFailovers.k.rejoinJob, 'the pair is released'); assert(/console restarted/.test(p5.settings.geoJobs.g1.error));
    assert.deepStrictEqual(await recoverInterruptedGeoJobs(st5), [], 'idempotent');
  }
  { // a site never takes over from itself (an interrupted switchover left the pair's last primary = the site promoted again)
    const sx = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'geoself-')));
    await sx.mutate(d => { d.clusters.push({ id: 'a', name: 'a', environment: 'prod', source: 'agent' } as any); });
    const r = await startFailover(sx, { key: 'k', from: 'a', to: 'a', auto: false, actor: 't' });
    assert.strictEqual(r.code, 409); assert.strictEqual(r.body.error, 'same_site');
  }
  console.log('geo tests OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
// same timeline number, different history (the old primary promoted itself on coming back)
{
  const h1 = '1\t0/3000000\tno recovery target specified\n2\t0/5000060\tno recovery target specified\n', h2 = '1\t0/3000000\tx\n2\t0/50000A0\tx\n';
  assert.deepStrictEqual(parseHistory(h1), [[1, '0/3000000'], [2, '0/5000060']]);
  assert.strictEqual(sameTimelineDiverged({ timeline: 3, history: h1 }, { timeline: 3, history: h2 }), true);
  assert.strictEqual(sameTimelineDiverged({ timeline: 3, history: h1 }, { timeline: 3, history: h1.replace(/no recovery target specified/g, 'y') }), false, 'reasons do not matter');
  assert.strictEqual(sameTimelineDiverged({ timeline: 4, history: h1 }, { timeline: 3, history: h2 }), false, 'different numbers: Patroni rewinds by itself');
  assert.strictEqual(sameTimelineDiverged({ timeline: 3, history: null }, { timeline: 3, history: h2 }), false, 'unknown: not concluded');
  console.log('geo timeline divergence OK');
}
