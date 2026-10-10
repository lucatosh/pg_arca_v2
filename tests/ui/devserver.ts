/**
 * UI test harness (tests only): serves the built console and the REAL server route modules (auth, clusters, agents, platform,
 * scheduler-less) over HTTP, with a scripted fake agent so the browser can drive complete flows without PostgreSQL.
 * Usage: tsx tests/ui/devserver.ts <port> <staticDir>
 */
import { createHash } from 'crypto'; import fs from 'fs'; import os from 'os'; import path from 'path'; import http from 'http';
import { MiniApp } from '../server/mini-express';
import { Store, loadSecretKey } from '../../server/store';
import { DirectDriver } from '../../server/direct';
import { mountAgentRoutes, mountOperatorRoutes } from '../../server/agents';
import { mountClusterRoutes, seedDemoOnFirstRun } from '../../server/clusters';
import { mountPlatformRoutes } from '../../server/platform';
import { mountHbaRoutes } from '../../server/hba';
import { mountPolicyRoutes } from '../../server/policies';
import { mountAuthRoutes, requireAdmin } from '../../server/auth';
import { mountNotifyRoutes } from '../../server/notify';
import { mountAdvancedRoutes } from '../../server/approvals';
import { briefing } from '../../server/health';
import { mountJoinRoutes } from '../../server/join';
import { audit } from '../../server/ops';

const port = Number(process.argv[2] || 5188); const staticDir = process.argv[3] || '/tmp/claude-0/ui';
const withAgent = process.env.NO_AGENT !== '1';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-'));
  const store = new Store(dir), app = new MiniApp(); const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'Cluster demo', environment: 'dev', isSandbox: true, status: 'healthy', pgVersion: '16', databases: [{ name: 'demo', size: 1e9 }], totalSizeBytes: 1e9, tps: 0, haState: { nodes: [{ name: 'demo-1', role: 'primary', online: true, state: 'running', host: 'demo', port: 5432, replicationLagBytes: 0, cpuPercent: 0, memoryPercent: 0, connections: 0, maxConnections: 100, source: 'agent' }] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec });
  mountClusterRoutes(app, store, direct, demo); mountPlatformRoutes(app, store); mountHbaRoutes(app, store); mountPolicyRoutes(app, store); mountNotifyRoutes(app, store, async () => ({ ok: true })); mountAdvancedRoutes(app, store, audit); mountJoinRoutes(app, store);
  app.get('/api/briefing', (_q: any, r: any) => r.json(briefing(store.peek())));
  await seedDemoOnFirstRun(store, demo);

  // --- scripted fake agent -------------------------------------------------------------------------------
  const sid = (d: Date, t: string) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${t}`; };
  const sets: any[] = [];
  const addSet = (d: Date, type: string, parent?: string) => { const id = parent ? `${parent.slice(0, 16)}_${sid(d, type)}`.replace(/^(.{16}).*_/, '$1_') : sid(d, type); sets.push({ id: parent ? `${parent}_${sid(d, type)}` : id, type: ({ F: 'full', D: 'diff', I: 'incr' } as any)[type], parent, status: 'COMPLETE', start_time: new Date(d.getTime() - 90_000).toISOString(), stop_time: d.toISOString(), duration_sec: 90, start_lsn: '0/1000000', stop_lsn: '0/2000000', timeline: 1, bytes_logical: 5e9, bytes_written: type === 'F' ? 1.4e9 : 8e7, pg_version: '16.4' }); return sets[sets.length - 1].id; };
  let agent: any = null;
  if (withAgent) {
    const tok = (await app.call('POST', '/api/auth/setup', { body: { username: 'admin', password: 'correct-horse-battery' } }));
    const cookie = tok.headers['set-cookie'].split(';')[0];
    const t = await app.call('POST', '/api/enrollment-tokens', { body: { label: 'ui', environment: 'prod' }, headers: { cookie } });
    const disc = { postgres_instances: [{ cluster_key: 'sysid:42', patroni: { scope: 'prodpg' } }], patroni_clusters: [{ scope: 'prodpg' }] };
    const en = await app.call('POST', '/api/agent/enroll', { body: { enrollment_token: t.body.token, node_name: 'db1', agent_version: '2.0', discovery: disc } });
    agent = { h: { authorization: 'Bearer ' + en.body.agent_token, 'x-arca-node': en.body.node_id } };
    const full = addSet(new Date(Date.now() - 6 * 86400e3), 'F');
    for (let i = 5; i >= 1; i--) addSet(new Date(Date.now() - i * 86400e3), 'I', full);
    let xact = 1000;
    let hbaManaged: any[] = []; const hbaRev = () => createHash('sha1').update(JSON.stringify(hbaManaged)).digest('hex').slice(0, 16);
    const snap = () => ({
      postgres: { alive: true, is_in_recovery: false, role: 'primary', version: '16.4', current_lsn: '0/5000000', timeline: 1, xact_total: (xact += 400), connections: { used: 12, max: 100 },
        databases: [{ oid: 16384, name: 'appdb', size: 4e9 }, { oid: 16385, name: 'billing', size: 1e9 }], settings: { archive_mode: process.env.ARCHIVE_OFF ? 'off' : 'on', max_connections: '100', shared_buffers: '16384', work_mem: '4096' },
        archiver: { archived_count: 120, failed_count: 0, last_archived_time: new Date().toISOString() } },
      wal: { continuous: true, total_segments: 64, gaps: [] },
      backup: { configured: true, sets: sets.filter(s => s.status === 'COMPLETE').length, failed_sets: 0, last_backup: sets[sets.length - 1], last_backup_age_hours: (Date.now() - Date.parse(sets[sets.length - 1].stop_time)) / 3.6e6, stored_bytes: 2.1e9, dedup_ratio: 5.6, recent_sets: sets.slice(-60) },
      system: { load_avg_1m: 0.4, cpu_count: 4, memory_used_percent: 38, memory_total_bytes: 16 * 1024 ** 3 }, patroni: { accessible: false },
    });
    const report = (id: string, body: any) => app.call('POST', `/api/agent/ops/${id}/report`, { body, headers: agent.h });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const handle = async (op: any) => {
      const p = op.params;
      await report(op.id, { status: 'running', progress: { phase: 'starting' } });
      if (op.type === 'pg_set_param') { await sleep(300); return report(op.id, { status: 'succeeded', result: { name: p.name, value: p.value, applied: true } }); }
      if (op.type === 'restore_drill') { await sleep(400); return report(op.id, { status: 'succeeded', result: { full_cluster: true, set: 'x', rto_seconds: 754, data_bytes: 5368709120, throughput_mb_s: 6.8, databases_checked: ['appdb', 'billing'] } }); }
      if (op.type === 'restore_diff') { await sleep(300); return report(op.id, { status: 'succeeded', result: { object: p.object, primary_key: ['id'], restored_rows: 500, live_rows: 6, columns_only_in_one_side: [], counts: { missing_now: 2, added_since: 1, changed: 1 }, limit: 200,
        missing_now: [{ key: [200], restored: { id: 200, name: 'c200' } }, { key: [201], restored: { id: 201, name: 'c201' } }], added_since: [{ key: [900], live: { id: 900, name: 'new' } }], changed: [{ key: [1], restored: { id: 1, name: 'old' }, live: { id: 1, name: 'live1' } }] } }); }
      if (op.type === 'restore_apply_rows') { await sleep(300); return report(op.id, { status: 'succeeded', result: { object: p.object, inserted: (p.restore_keys || []).length, updated: 0, deleted: (p.delete_keys || []).length, safety_copy: 'public.pgarca_rowsafe_20260101_orders' } }); }
      if (op.type === 'restore_promote') {
        await sleep(300);
        const plan = { mode: p.mode, tables: [{ schema: 'public', name: 'orders', kind: 'r', action: p.mode === 'as_new' ? 'copy' : 'swap', exists_now: true, rows_at_target: 1234, old_kept_as: 'orders_old_20260101000000', new_name: 'orders_pitr_20260101000000' }],
          inbound_fks: [{ name: 'items_order_fk', schema: 'public', table: 'items', ref_schema: 'public', ref_table: 'orders' }], outbound_fks: [], views: [{ schema: 'public', name: 'v_totals', kind: 'v' }], warnings: [], missing_prereq: { extensions: [], schemas: [], types: [], functions: [] } };
        if (p.dry_run) return report(op.id, { status: 'succeeded', result: { ...plan, dry_run: true } });
        return report(op.id, { status: 'succeeded', result: { mode: p.mode, promoted: ['public.orders'], promoted_as: 'public.orders', old_kept: ['public.orders_old_20260101000000'], old_kept_as: 'public.orders_old_20260101000000', foreign_keys_reattached: 1, views_recreated: 1, plan, stage_dropped: !!p.drop_stage } });
      }
      if (op.type === 'hba_read') {
        const eff = [{ line_number: 90, type: 'local', database: ['all'], user_name: ['postgres'], address: null, netmask: null, auth_method: 'peer', options: null, error: null },
          { line_number: 95, type: 'host', database: ['all'], user_name: ['all'], address: '10.0.0.0', netmask: '255.0.0.0', auth_method: 'md5', options: null, error: null }];
        const mrules = hbaManaged.map(r => ({ ...r }));
        return report(op.id, { status: 'succeeded', result: { hba_file: '/etc/postgresql/16/main/pg_hba.conf', mode: 'file', rev: hbaRev(), raw: '# fake pg_hba\nlocal all postgres peer\nhost all all 10.0.0.0/8 md5\n', truncated: false,
          managed: { present: mrules.length > 0, rules: mrules, rev: hbaRev() }, effective: [...hbaManaged.map((r, i) => ({ line_number: 10 + i, type: r.type, database: r.database.split(','), user_name: r.user.split(','), address: r.address.split('/')[0] || null, netmask: null, auth_method: r.method, options: null, error: null })), ...eff],
          errors: [], ssl: true, has_includes: false, rule_count: 2, suggest: { replication_clients: [{ user: 'replicator', address: '10.0.2.7', ssl: true }], roles: ['app', 'replicator', 'dba'], databases: ['appdb', 'billing', 'postgres'] }, backups: [] } });
      }
      if (op.type === 'hba_plan') { await sleep(300); const rs = p.rules || []; return report(op.id, { status: 'succeeded', result: { valid: true, errors: [], warnings: [], changed: JSON.stringify(rs) !== JSON.stringify(hbaManaged), mode: 'file', base_rev: hbaRev(),
        diff: ['--- pg_hba (attuale)', '+++ pg_hba (nuovo)', ...rs.map((r: any) => `+${r.type} ${r.database} ${r.user} ${r.address || ''} ${r.method}`)], simulation: [{ label: 'locale: utente postgres (peer)', before: true, after: true, critical: true }, { label: 'replica 10.0.2.7 (replicator)', before: true, after: true, critical: true }], would_lock_out: [] } }); }
      if (op.type === 'hba_apply') { await sleep(400); hbaManaged = (p.rules || []).map((r: any) => ({ ...r })); return report(op.id, { status: 'succeeded', result: { changed: true, mode: 'file', rev: hbaRev(), backup: 'pg_hba.conf.pgarca-1', rules: hbaManaged.length } }); }
      if (op.type === 'backup_run') {
        for (let i = 1; i <= 4; i++) { await sleep(700); const r = await report(op.id, { status: 'running', progress: { phase: 'copy', files: i * 100, files_total: 400, bytes: i * 1e8, bytes_total: 4e8 } }); if (r.body.cancel) return report(op.id, { status: 'failed', error: 'cancelled' }); }
        const parent = [...sets].reverse().find(s => s.type === 'full')?.id;
        const id = addSet(new Date(), p.type === 'full' ? 'F' : p.type === 'diff' ? 'D' : 'I', p.type === 'full' ? undefined : parent);
        return report(op.id, { status: 'succeeded', result: { set: id, type: p.type, bytes_logical: 5e9, bytes_written: 9e7, duration_sec: 3, chunks_dedup: 70000 } });
      }
      if (op.type === 'backup_catalog') {
        if (!p.database) return report(op.id, { status: 'succeeded', result: { set: 'x', databases: [{ name: 'appdb', oid: 16384, size: 4e9, objects: 42, connectable: true }, { name: 'billing', oid: 16385, size: 1e9, objects: 8, connectable: true }] } });
        return report(op.id, { status: 'succeeded', result: { set: 'x', database: p.database, schemas: [{ name: 'public', objects: [{ name: 'orders', kind: 'r', size: 3e9 }, { name: 'customers', kind: 'r', size: 4e8 }].filter(o => !p.search || o.name.includes(p.search)) }], total_objects: 2, truncated: false } });
      }
      if (op.type === 'restore_plan') {
        if (p.target_time && Date.parse(p.target_time) > Date.now() + 60_000) return report(op.id, { status: 'failed', error: 'PGA-PITR-002: target is in the future' });
        return report(op.id, { status: 'succeeded', result: { set: sets[sets.length - 1].id, chain: sets.slice(-3).map(s => s.id), target: p.target_time || 'end of archive', extract_bytes: 4.2e9, cluster_bytes: 5e9, saved_pct: 16, bytes: 5e9, files: 1200, missing_wal: [], destination_database: p.new_name, destination: p.destination } });
      }
      if (op.type === 'restore_database' || op.type === 'restore_object' || op.type === 'restore_instance') {
        for (let i = 1; i <= 3; i++) { await sleep(500); await report(op.id, { status: 'running', progress: { phase: 'extract', files: i * 40, files_total: 120, bytes: i * 1e8, bytes_total: 3e8 } }); }
        return report(op.id, { status: 'succeeded', result: { result_database: p.new_name || 'pgarca_stage_1', destination: p.destination, start_hint: 'pg_ctl -D ' + p.destination + ' start', inspect: 'SELECT 1' } });
      }
      if (op.type === 'wal_forensics') { await sleep(600); return report(op.id, { status: 'succeeded', result: { segments_scanned: 64, events: [{ lsn: '0/4A000028', kind: 'DROP', time: new Date(Date.now() - 3 * 3600e3).toISOString(), xid: '812', names: ['appdb.public.orders'], rels: [] }] } }); }
      if (op.type === 'backup_verify') { await sleep(800); return report(op.id, { status: 'succeeded', result: { ok: true, problems: [], chunks_checked: p.deep ? 90000 : 0, restore_test: p.restore_test ? { ok: true } : undefined } }); }
      if (op.type === 'backup_expire') return report(op.id, { status: 'succeeded', result: { delete_sets: [], keep_sets: sets.map(s => s.id), retention_full: p.retention_full || 2, dry_run: !!p.dry_run } });
      return report(op.id, { status: 'succeeded', result: {} });
    };
    const beat = async () => { try { const hb = await app.call('POST', '/api/agent/heartbeat', { body: { snapshot: snap(), max_ops: 3, agent_version: '2.0' }, headers: agent.h }); for (const op of hb.body.ops || []) handle(op).catch(e => console.error(e)); } catch (e) { console.error(e); } };
    await beat(); setInterval(beat, 1000);
  }

  const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  http.createServer((rq, rs) => {
    const url = rq.url || '/';
    if (url.startsWith('/api/')) {
      let raw = ''; rq.on('data', c => (raw += c)); rq.on('end', async () => {
        let body: any; try { body = raw ? JSON.parse(raw) : undefined; } catch { /* bad json */ }
        const r = await app.call(rq.method || 'GET', url, { body, headers: rq.headers as any });
        const h: Record<string, string> = { 'content-type': 'application/json' }; if (r.headers['set-cookie']) h['set-cookie'] = r.headers['set-cookie'];
        rs.writeHead(r.status, h); rs.end(JSON.stringify(r.body ?? {}));
      }); return;
    }
    const f = url === '/' ? 'index.html' : url.split('?')[0].slice(1);
    const fp = path.join(staticDir, f);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { rs.writeHead(200, { 'content-type': mime[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(rs); }
    else { rs.writeHead(404); rs.end('no'); }
  }).listen(port, () => console.log('ui test server on', port));
})();
