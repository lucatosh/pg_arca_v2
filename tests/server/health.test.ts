import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert'; import http from 'http';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { evaluate, briefing, objectives } from '../../server/health';
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
  // Patroni readiness for failover: pg_rewind off / unusable, local replication connection refused by pg_hba (one finding per cluster)
  {
    const st: any = JSON.parse(JSON.stringify(store.peek()));
    st.clusters.push({ id: 'pt', name: 'pat', environment: 'dev', source: 'agent' });
    const snap = (rewind: any, hints: string, plc: any) => ({ postgres: { is_in_recovery: false, settings: { wal_log_hints: hints, data_checksums: 'off' }, hba_patroni_local: plc }, backup: { configured: true, recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(now - 3600_000) }] },
      patroni: { accessible: true, members: [{ name: 'a' }, { name: 'b' }], use_pg_rewind: rewind } });
    st.nodes.pa = { id: 'pa', name: 'a', clusterId: 'pt', lastSeen: iso(now), snapshot: snap(false, 'on', { ok: false, denied: ['replicator'], suggest: ['host replication replicator 127.0.0.1/32 scram-sha-256'] }) };
    st.nodes.pb = { id: 'pb', name: 'b', clusterId: 'pt', lastSeen: iso(now), snapshot: snap(false, 'on', { ok: false, denied: ['replicator'], suggest: [] }) };
    let c = evaluate(st, now).filter(i => i.clusterId === 'pt');
    assert.strictEqual(c.filter(i => i.code === 'patroni_rewind').length, 1); assert.strictEqual(c.filter(i => i.code === 'patroni_local_replication').length, 1);
    assert(/127\.0\.0\.1/.test(c.find(i => i.code === 'patroni_local_replication')!.cause));
    st.nodes.pa.snapshot = snap(true, 'off', { ok: true }); st.nodes.pb.snapshot = snap(true, 'off', { ok: true });
    c = evaluate(st, now).filter(i => i.clusterId === 'pt');
    assert(c.some(i => i.code === 'patroni_rewind' && /wal_log_hints/.test(i.cause))); assert(!c.some(i => i.code === 'patroni_local_replication'));
    st.nodes.pa.snapshot = snap(true, 'on', { ok: true }); st.nodes.pb.snapshot = snap(true, 'on', { ok: true });
    assert(!evaluate(st, now).some(i => i.clusterId === 'pt' && /patroni_/.test(i.code)), 'ready: nothing');
  }
  { // Patroni members without an agent raise node_without_agent (one issue per missing member), enrolled ones don't
    const base = store.peek(); const g1: any = base.nodes.n3;
    const st: any = { ...base, clusters: [...base.clusters, { id: 'q', name: 'q-db', environment: 'dev', source: 'agent' }],
      nodes: { ...base.nodes, nq: { ...g1, id: 'nq', name: 'q1', clusterId: 'q', snapshot: { ...g1.snapshot, patroni: { scope: 'q', members: [{ name: 'q1', role: 'leader', state: 'running' }, { name: 'q2', role: 'replica', state: 'streaming' }, { name: 'q3', role: 'replica', state: 'stopped' }] } } } } };
    const w = evaluate(st, now).filter(i => i.clusterId === 'q' && i.code === 'node_without_agent');
    assert.deepStrictEqual(w.map(i => i.nodeName).sort(), ['q2', 'q3']); assert(w.every(i => i.severity === 'warning'));
  }
  { // two online nodes with DIFFERENT storage ids (each writes its own local archive) -> warning; same ids -> nothing
    const base = store.peek(); const g1: any = base.nodes.n3;
    const mk = (idA: string, idB: string): any => ({ ...base, clusters: [...base.clusters, { id: 's', name: 's-db', environment: 'dev', source: 'agent' }],
      nodes: { ...base.nodes, s1: { ...g1, id: 's1', name: 's1', clusterId: 's', snapshot: { ...g1.snapshot, storage: { wal_id: idA, repo_id: 'R' } } }, s2: { ...g1, id: 's2', name: 's2', clusterId: 's', snapshot: { ...g1.snapshot, postgres: { ...g1.snapshot.postgres, is_in_recovery: true }, storage: { wal_id: idB, repo_id: 'R' } } } } });
    const split = evaluate(mk('A', 'B'), now).filter(i => i.clusterId === 's').map(i => i.code);
    assert.deepStrictEqual(split, ['wal_not_shared'], JSON.stringify(split));
    assert.deepStrictEqual(evaluate(mk('A', 'A'), now).filter(i => i.clusterId === 's').map(i => i.code), []);
  }
  { // no python zstandard on a node -> backups use zlib: warning when a policy is active, info otherwise; present (or an old agent that does not report it) -> nothing
    const base = store.peek(); const g1: any = base.nodes.n3;
    const mk = (tc: any, env = 'dev'): any => ({ ...base, clusters: [...base.clusters, { id: 'z', name: 'z-db', environment: env, source: 'agent' }],
      nodes: { ...base.nodes, z1: { ...g1, id: 'z1', name: 'z1', clusterId: 'z', snapshot: { ...g1.snapshot, toolchain: tc } } } });
    const f = (tc: any, env?: string) => evaluate(mk(tc, env), now).filter(i => i.clusterId === 'z' && i.code === 'no_zstd_python');
    assert.strictEqual(f({ python_zstandard: null, zstd: '/usr/bin/zstd' }).length, 1); assert.strictEqual(f({ python_zstandard: null, zstd: '/usr/bin/zstd' })[0].severity, 'info');
    assert(/gzip/.test(f({ python_zstandard: null, zstd: null })[0].cause), 'zstd binary missing too: WAL falls back to gzip');
    assert.strictEqual(f({ python_zstandard: null }, 'prod')[0].severity, 'warning');
    assert.strictEqual(f({ python_zstandard: 'installed', zstd: null }).length, 0); assert.strictEqual(f(undefined).length, 0); assert.strictEqual(f({ psql: '/usr/bin/psql' }).length, 0);
  }
  { // PG17+ with summarize_wal off and a policy with incrementals -> one info finding per cluster; on/absent (older PG) or standby -> nothing
    const base = store.peek(); const g1: any = base.nodes.n1;                      // n1 is in 'p' (prod policy with incrementals)
    const mk = (settings: any, rec = false): any => ({ ...base, nodes: { ...base.nodes, n1: { ...g1, snapshot: { ...g1.snapshot, postgres: { ...g1.snapshot.postgres, is_in_recovery: rec, settings: { ...g1.snapshot.postgres.settings, ...settings } } } } } });
    const f = (settings: any, rec?: boolean) => evaluate(mk(settings, rec), now).filter(i => i.clusterId === 'p' && i.code === 'summarize_wal_off');
    assert.strictEqual(f({ summarize_wal: 'off' }).length, 1); assert.strictEqual(f({ summarize_wal: 'off' })[0].severity, 'info');
    assert.strictEqual(f({ summarize_wal: 'on' }).length, 0); assert.strictEqual(f({}).length, 0); assert.strictEqual(f({ summarize_wal: 'off' }, true).length, 0);
  }
  { // asynchronous archiving spool: failing -> critical; deep or old -> behind; pusher dead with pending -> warning; empty -> nothing
    const base = store.peek(); const g1: any = base.nodes.n3;
    const mk = (spool: any): any => ({ ...base, clusters: [...base.clusters, { id: 'sp', name: 'sp-db', environment: 'dev', source: 'agent' }], nodes: { ...base.nodes, s1: { ...g1, id: 's1', name: 's1', clusterId: 'sp', snapshot: { ...g1.snapshot, wal: { gap_count: 0, conflicts: 0, spool } } } } });
    const f = (spool: any) => evaluate(mk(spool), now).filter(i => i.clusterId === 'sp' && /wal_spool/.test(i.code));
    assert.strictEqual(f({ enabled: true, pending: 0, alive: true }).length, 0);
    assert.strictEqual(f({ enabled: true, pending: 3, alive: true, oldest_age_sec: 20 }).length, 0, 'a few fresh segments: normal');
    assert.deepStrictEqual(f({ enabled: true, pending: 70, alive: true, oldest_age_sec: 100 }).map(i => [i.code, i.severity]), [['wal_spool_behind', 'warning']]);
    assert.strictEqual(f({ enabled: true, pending: 300, alive: true, oldest_age_sec: 100 })[0].severity, 'critical');
    assert.strictEqual(f({ enabled: true, pending: 5, alive: true, oldest_age_sec: 4000 })[0].severity, 'critical');
    assert.deepStrictEqual(f({ enabled: true, pending: 2, alive: true, last_error: { segment: '0000000100000000000000AA', error: 'PGA-WAL-031 divergent' } }).map(i => i.code), ['wal_spool_failing']);
    assert.deepStrictEqual(f({ enabled: true, pending: 2, alive: false, oldest_age_sec: 10 }).map(i => [i.code, i.severity]), [['wal_spool_behind', 'warning']]);
  }
  { // archiver lag: current LSN far ahead of the last archived segment -> warning at 16 segments, critical at 128; caught up -> nothing
    const base = store.peek(); const g1: any = base.nodes.n3;
    const mk = (lsn: string, last: string): any => ({ ...base, clusters: [...base.clusters, { id: 'al', name: 'al-db', environment: 'dev', source: 'agent' }],
      nodes: { ...base.nodes, a1: { ...g1, id: 'a1', name: 'a1', clusterId: 'al', snapshot: { ...g1.snapshot, postgres: { ...g1.snapshot.postgres, current_lsn: lsn, settings: { wal_segment_size: '16777216' }, archiver: { last_archived_wal: last, last_archived_time: iso(now - 5000) } } } } } });
    const f = (lsn: string, last: string) => evaluate(mk(lsn, last), now).filter(i => i.clusterId === 'al' && i.code === 'archiver_lag');
    assert.strictEqual(f('0/5000000', '000000010000000000000004').length, 0, 'segment 5 being written, 4 archived: caught up');
    const w = f('0/15000000', '000000010000000000000004'); assert.strictEqual(w.length, 1); assert.strictEqual(w[0].severity, 'warning'); assert(/16 segments/.test(w[0].title), w[0].title);
    assert.strictEqual(f('1/00000000', '000000010000000000000004')[0].severity, 'critical');
    assert.strictEqual(f('0/15000000', 'garbage').length, 0);
  }
  { // offsite copy: failing or behind -> finding; fresh -> nothing; not configured -> nothing
    const base = store.peek(); const g1: any = base.nodes.n3;
    const mk = (off: any): any => ({ ...base, clusters: [...base.clusters, { id: 'o', name: 'o-db', environment: 'dev', source: 'agent' }], nodes: { ...base.nodes, o1: { ...g1, id: 'o1', name: 'o1', clusterId: 'o', snapshot: { ...g1.snapshot, offsite: off } } } });
    const f = (off: any) => evaluate(mk(off), now).filter(i => i.clusterId === 'o' && i.code === 'offsite_behind');
    assert.strictEqual(f(null).length, 0); assert.strictEqual(f({ configured: true, enabled: true, last_ok: now / 1000 - 600, bucket: 'b', endpoint: 'e' }).length, 0);
    assert.strictEqual(f({ configured: true, enabled: false, last_ok: null, bucket: 'b', endpoint: 'e' }).length, 0, 'paused: no finding');
    const b = f({ configured: true, enabled: true, last_ok: now / 1000 - 8 * 3600, bucket: 'b', endpoint: 'e' }); assert.strictEqual(b.length, 1); assert.strictEqual(b[0].severity, 'warning'); assert(/behind/.test(b[0].title));
    const e = f({ configured: true, enabled: true, last_ok: now / 1000 - 600, last_error: '403 AccessDenied', bucket: 'b', endpoint: 'e' }); assert.strictEqual(e.length, 1); assert(/failing/.test(e[0].title) && /AccessDenied/.test(e[0].cause));
    assert.strictEqual(f({ configured: true, enabled: true, last_ok: null, bucket: 'b', endpoint: 'e' })[0].severity, 'critical', 'never synced');
  }
  { // recovery objectives: RPO from the archiver (failing -> bad; fresh -> ok with the archive_timeout bound), RTO from the last drill scaled to today's size
    const base = store.peek();
    const o1 = objectives(base, 'p', now)!; assert.strictEqual(o1.rpo.state, 'bad'); assert(/failing/.test(o1.rpo.text)); assert.strictEqual(o1.rto.state, 'unknown');
    const st: any = JSON.parse(JSON.stringify(base));
    st.nodes.n1.snapshot.postgres.archiver = { last_archived_time: iso(now - 20_000), last_failed_time: null }; st.nodes.n1.snapshot.postgres.settings.archive_timeout = '60';
    st.nodes.n1.snapshot.postgres.databases = [{ name: 'a', size: 4 * GB }];
    st.operations.push({ id: 'd1', clusterId: 'p', type: 'restore_drill', status: 'succeeded', updatedAt: iso(now - 86400_000), createdAt: iso(now - 86400_000), result: { rto_seconds: 300, data_bytes: 2 * GB, throughput_mb_s: 7 } });
    const o2 = objectives(st, 'p', now)!;
    assert.deepStrictEqual([o2.rpo.state, o2.rpo.seconds], ['ok', 60], JSON.stringify(o2.rpo));
    assert.deepStrictEqual([o2.rto.state, o2.rto.estimateSeconds], ['ok', 600], JSON.stringify(o2.rto));
    st.nodes.n1.snapshot.postgres.archiver = { last_archived_time: iso(now - 2 * 3600_000) };
    assert.strictEqual(objectives(st, 'p', now)!.rpo.state, 'bad');
    assert.strictEqual(objectives(st, 'nope', now), null);
    // declared objectives (prod-standard: RPO 60 min, RTO 8 h): within -> ok and said so; archive_timeout above the RPO -> warn + finding with the exact setting;
    // measured RPO above -> bad + critical finding; RTO estimate above -> bad + finding; no objectives declared -> nothing of this
    assert.deepStrictEqual(objectives(st, 'p', now)!.targets, { rpoSeconds: 3600, rtoSeconds: 28800 });
    st.nodes.n1.snapshot.postgres.archiver = { last_archived_time: iso(now - 20_000) };
    assert(/Within the 60 min objective/.test(objectives(st, 'p', now)!.rpo.text)); assert(/Within the 8 h objective/.test(objectives(st, 'p', now)!.rto.text));
    assert(!evaluate(st, now).some(i => i.clusterId === 'p' && /_target$/.test(i.code)), 'no finding while within the objectives');
    st.nodes.n1.snapshot.postgres.settings.archive_timeout = '7200';
    { const o = objectives(st, 'p', now)!; assert.strictEqual(o.rpo.state, 'bad'); assert(/Above the 60 min objective: archive_timeout \(7200 s\) alone.*archive_timeout = 3600 s/.test(o.rpo.text), o.rpo.text);
      const f = evaluate(st, now).find(i => i.clusterId === 'p' && i.code === 'rpo_target')!; assert.strictEqual(f.severity, 'critical'); assert(/archive_timeout = 3600 s/.test(f.cause) && f.action?.page === 'params'); }
    st.nodes.n1.snapshot.postgres.settings.archive_timeout = '0';
    { const o = objectives(st, 'p', now)!; assert.strictEqual(o.rpo.state, 'warn'); assert(/not guaranteed/.test(o.rpo.text));
      const f = evaluate(st, now).find(i => i.clusterId === 'p' && i.code === 'rpo_target')!; assert.strictEqual(f.severity, 'warning'); assert(/archive_timeout is not set/.test(f.cause)); }
    st.nodes.n1.snapshot.postgres.settings.archive_timeout = '60'; st.nodes.n1.snapshot.postgres.archiver = { last_archived_time: iso(now - 90 * 60_000) };
    { const o = objectives(st, 'p', now)!; assert.strictEqual(o.rpo.state, 'bad'); assert(/Above the 60 min objective/.test(o.rpo.text));
      const f = evaluate(st, now).find(i => i.clusterId === 'p' && i.code === 'rpo_target')!; assert.strictEqual(f.severity, 'critical'); assert(/above the 60 min objective/.test(f.title)); }
    st.nodes.n1.snapshot.postgres.archiver = { last_archived_time: iso(now - 20_000) }; st.nodes.n1.snapshot.postgres.databases = [{ name: 'a', size: 400 * GB }];
    { const o = objectives(st, 'p', now)!; assert.strictEqual(o.rto.state, 'bad'); assert.strictEqual(o.rto.estimateSeconds, 60000);
      const f = evaluate(st, now).find(i => i.clusterId === 'p' && i.code === 'rto_target')!; assert(/above the 8 h objective/.test(f.title), f.title); }
    st.settings.policyAssignments = { 'env:prod': { templateId: 'preprod' } };
    { const o = objectives(st, 'p', now)!; assert.deepStrictEqual(o.targets, { rpoSeconds: null, rtoSeconds: null }); assert.strictEqual(o.rto.state, 'ok'); assert(!/objective/.test(o.rpo.text + o.rto.text));
      assert(!evaluate(st, now).some(i => i.clusterId === 'p' && /_target$/.test(i.code))); }
  }
  { // agent transport: clear http:// or certificate check disabled -> finding (warning in prod, info elsewhere); https with verification -> nothing
    const st: any = JSON.parse(JSON.stringify(store.peek()));
    const f = () => evaluate(st, now).filter(i => i.clusterId === 'p' && i.code === 'agent_insecure_transport');
    assert.strictEqual(f().length, 0);
    st.nodes.n1.tlsInsecure = true; st.nodes.n1.consoleUrl = 'http://console.lan:3000';
    assert.strictEqual(f().length, 1); assert.strictEqual(f()[0].severity, 'warning'); assert(/without TLS/.test(f()[0].title) && /PG_ARCA_TLS_CERT/.test(f()[0].cause));
    st.nodes.n1.consoleUrl = 'https://console.lan';
    assert(/does not verify/.test(f()[0].title) && /tls_insecure_skip_verify/.test(f()[0].cause));
    st.nodes.n1.tlsInsecure = false; assert.strictEqual(f().length, 0);
  }
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
  assert.strictEqual(requiredRole('GET', '/api/notifications'), 'admin'); assert.strictEqual(requiredRole('PUT', '/api/notifications'), 'admin'); assert.strictEqual(requiredRole('GET', '/api/briefing'), 'viewer');
  const tick = async (t: number) => { await store.mutate(d => { (d.nodes.n1 as any).lastSeen = iso(t); (d.nodes.n3 as any).lastSeen = iso(t); }); return notifyTick(store, t, send); };
  let r = await tick(now); assert.strictEqual(sent.length, 1); assert(r[wid].sent >= 3); assert(/archiver|WAL|Slot/i.test(sent[0].body.text));
  assert(!sent[0].body.text.includes('good-db'));
  r = await tick(now + 60_000); assert.strictEqual(sent.length, 1, 'nothing new -> nothing sent');
  r = await tick(now + 25 * 3600_000); assert.strictEqual(sent.length, 2, 'reminder after 24h'); assert(/Still open/.test(sent[1].body.text));
  // a problem disappears -> "Resolved"
  await store.mutate(d => { (d.nodes.n1 as any).snapshot.postgres.slots = []; });
  const t2 = now + 26 * 3600_000; await tick(t2);
  // the node lastSeen is now old, so more things open; just check that the slot recovery was announced
  assert(sent.some(s => /Resolved/.test(s.body.text) && /old_slot/.test(s.body.text)), sent.map(s => s.body.text).join('\n---\n'));
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
