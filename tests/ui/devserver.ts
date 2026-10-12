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
import { mountScopedRoutes } from '../../server/scoped';
import { mountDestinationRoutes } from '../../server/destinations';
import { mountAuthRoutes, requireAdmin } from '../../server/auth';
import { mountNotifyRoutes } from '../../server/notify';
import { mountAdvancedRoutes } from '../../server/approvals';
import { briefing } from '../../server/health';
import { mountJoinRoutes } from '../../server/join';
import { mountWorkerRoutes } from '../../server/workers';
import { mountGeoRoutes } from '../../server/geo';
import { audit } from '../../server/ops';

const port = Number(process.argv[2] || 5188); const staticDir = process.argv[3] || '/tmp/claude-0/ui';
const withAgent = process.env.NO_AGENT !== '1';

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-'));
  const store = new Store(dir), app = new MiniApp(); const direct = new DirectDriver(store, loadSecretKey(dir));
  const demo = () => ({ id: 'cluster-demo', name: 'Cluster demo', environment: 'dev', isSandbox: true, status: 'healthy', pgVersion: '16', databases: [{ name: 'demo', size: 1e9 }], totalSizeBytes: 1e9, tps: 0, haState: { nodes: [{ name: 'demo-1', role: 'primary', online: true, state: 'running', host: 'demo', port: 5432, replicationLagBytes: 0, cpuPercent: 0, memoryPercent: 0, connections: 0, maxConnections: 100, source: 'agent' }] } });
  app.use(requireAdmin(store));
  mountAuthRoutes(app, store); mountAgentRoutes(app, store); mountOperatorRoutes(app, store, { directExec: direct.exec });
  mountClusterRoutes(app, store, direct, demo); mountPlatformRoutes(app, store); mountHbaRoutes(app, store); mountPolicyRoutes(app, store); mountScopedRoutes(app, store); mountDestinationRoutes(app, store); mountNotifyRoutes(app, store, async () => ({ ok: true })); mountAdvancedRoutes(app, store, audit); mountJoinRoutes(app, store); mountWorkerRoutes(app, store); mountGeoRoutes(app, store);
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
    let migrated = false;                 // the previous backup location left by a destination change (until the migration below)
    const snap = () => ({
      postgres: { alive: true, is_in_recovery: false, role: 'primary', version: '16.4', current_lsn: '0/5000000', timeline: 1, xact_total: (xact += 400), connections: { used: 12, max: 100 },
        databases: [{ oid: 16384, name: 'appdb', size: 4e9 }, { oid: 16385, name: 'billing', size: 1e9 }], settings: { archive_mode: process.env.ARCHIVE_OFF ? 'off' : 'on', max_connections: '100', shared_buffers: '16384', work_mem: '4096' },
        archiver: { archived_count: 120, failed_count: 0, last_archived_time: new Date().toISOString() } },
      wal: { continuous: true, total_segments: 64, gaps: [] },
      storage: { repo_path: '/mnt/backup/repo/prodpg', wal_path: '/mnt/backup/wal/prodpg', ...(migrated ? {} : { repo_previous: [{ path: '/var/lib/pgarca/repo', readable: true }], wal_previous: [{ path: '/var/lib/pgarca/wal', readable: true }] }) },
      backup: { configured: true, sets: sets.filter(s => s.status === 'COMPLETE').length, failed_sets: 0, last_backup: sets[sets.length - 1], last_backup_age_hours: (Date.now() - Date.parse(sets[sets.length - 1].stop_time)) / 3.6e6, stored_bytes: 2.1e9, dedup_ratio: 5.6, recent_sets: sets.slice(-60) },
      system: { load_avg_1m: 0.4, cpu_count: 4, memory_used_percent: 38, memory_total_bytes: 16 * 1024 ** 3, disks: { pgdata: { path: '/var/lib/postgresql/16/main', total_bytes: 2e11, free_bytes: 4.3e10, dev: 2049 }, scratch: { path: '/var/tmp/pg_arca_scratch', total_bytes: 2e11, free_bytes: 4.3e10, dev: 2049 }, repo: { path: '/mnt/backup/repo/prodpg', total_bytes: 4e12, free_bytes: 2.6e12, dev: 77 }, wal_archive: { path: '/mnt/backup/wal/prodpg', total_bytes: 4e12, free_bytes: 2.6e12, dev: 77 } } }, patroni: { accessible: false },
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
      if (op.type === 'ephemeral_preflight') { await sleep(400); return report(op.id, { status: 'succeeded', result: { ok: false, level: 'bad', major: 15, host: { os: 'Ubuntu 24.04', cpus: 4, mem_available: 8e9, root: false, sudo_nopasswd: false }, settings: p.ephemeral || {},
        checks: [{ id: 'user', level: 'ok', text: 'runs as an unprivileged user (uid 1000)' }, { id: 'binaries', level: 'bad', text: 'no PostgreSQL 15 binaries on this host (found: 16)', fix: 'install PostgreSQL 15: see the installation plan below', missing_major: 15 }, { id: 'scratch', level: 'ok', text: 'scratch /var/tmp/pg_arca_scratch: 80.0 GiB free' }, { id: 'memory', level: 'ok', text: '8.0 GiB of memory available' }],
        installations: [{ bindir: '/usr/lib/postgresql/16/bin', major: 16, version: '16.4', missing_tools: [], complete: true, source: 'system' }],
        install_plan: { major: 15, recommended: 'private', host: { os: 'Ubuntu 24.04', family: 'debian' }, modes: {
          private: { possible: true, needs: ['network access to the package repository', 'about 150-300 MB of disk under /var/lib/pgarca/pg'], commands: ['apt-get download postgresql-15 postgresql-client-15', 'dpkg-deb -x <each .deb> /var/lib/pgarca/pg/15'], result_bindir: '/var/lib/pgarca/pg/15/usr/lib/postgresql/15/bin', blockers: [], warnings: ['the unpacked server is used ONLY for ephemeral recovery instances; it is not a database service'] },
          system: { possible: false, needs: ['root or passwordless sudo'], commands: ['apt-get install -y postgresql-15 postgresql-client-15'], result_bindir: '/usr/lib/postgresql/15/bin', blockers: ['needs root or passwordless sudo for the agent user'], warnings: ['installs a PostgreSQL server package system-wide'] } } } } }); }
      if (op.type === 'ephemeral_install') { await sleep(500); return report(op.id, { status: 'succeeded', result: { mode: p.mode, bindir: '/var/lib/pgarca/pg/15/usr/lib/postgresql/15/bin', version: '15.8' } }); }
      if (op.type === 'destination_migrate' && p.dry_run) { await sleep(300); return report(op.id, { status: 'succeeded', result: { source: { repo: p.source_repo, wal: p.source_wal }, destination: { repo: '/mnt/backup/repo/prodpg', wal: '/mnt/backup/wal/prodpg' },
        sets: [{ id: 'F1', type: 'full' }, { id: 'I1', type: 'incr' }], chunks: 18234, chunk_bytes: 3.1e9, set_bytes: 2e6, wal_files: 412, wal_bytes: 1.2e9, total_bytes: 4.302e9, files: 18654, source_usage_bytes: 3.2e9, source_wal_usage_bytes: 1.25e9,
        space: [{ path: '/mnt/backup/repo/prodpg', free_bytes: 2.6e12, total_bytes: 4e12 }], write_mb_s: 210.5, estimated_seconds: 21, ok: true, nothing_to_do: false,
        checks: [{ id: 'space', level: 'ok', text: 'repository + WAL archive: 4.0 GiB to copy, 2421.4 GiB free (2417.4 GiB after)' }] } }); }
      if (op.type === 'destination_migrate') { for (let i = 1; i <= 3; i++) { await sleep(400); await report(op.id, { status: 'running', progress: { phase: 'chunks', bytes: i * 1.4e9, bytes_total: 4.3e9, mb_s: 205 } }); }
        migrated = true; return report(op.id, { status: 'succeeded', result: { complete: true, copied: { sets: 2, chunks: 18234, wal: 412, bytes: 4.3e9 }, seconds: 21.4, left: { sets: [], wal_files: 0 } } }); }
      if (op.type === 'destination_check') { await sleep(400); return report(op.id, { status: 'succeeded', result: { type: p.type, ok: true, paths: [p.repo_path && { kind: 'repo', path: p.repo_path, ok: true, mount: { mountpoint: '/mnt/backup', fstype: 'nfs4', source: 'nas:/export' }, free_bytes: 5e11, checks: [{ id: 'fs', level: 'ok', text: `${p.repo_path} is on nfs4 (nas:/export)` }, { id: 'write', level: 'ok', text: 'writable: exclusive create, fsync and atomic rename work (3.1 ms)' }], bench: p.bench ? { mb: 32, write_mb_s: 212.4, read_mb_s: 480.1, note: 'read may be served from the page cache' } : undefined }, p.wal_path && { kind: 'wal', path: p.wal_path, ok: true, mount: { mountpoint: '/mnt/backup', fstype: 'nfs4', source: 'nas:/export' }, free_bytes: 5e11, checks: [{ id: 'fs', level: 'ok', text: `${p.wal_path} is on nfs4 (nas:/export)` }, { id: 'write', level: 'ok', text: 'writable' }] }].filter(Boolean) } }); }
      if (op.type === 'agent_config_set') { await sleep(300); return report(op.id, { status: 'succeeded', result: { changed: p.set } }); }
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
        if (!p.database) return report(op.id, { status: 'succeeded', result: { set: p.set || 'x', databases: [{ name: 'appdb', oid: 16384, size: 4e9, objects: 42, tables: 40, schemas: 3, connectable: true, in_latest: true, last_set: sets[sets.length - 1].id, last_stop: new Date(Date.now() - 3600e3).toISOString() }, { name: 'billing', oid: 16385, size: 1e9, objects: 8, tables: 8, schemas: 1, connectable: true, in_latest: true, last_set: sets[sets.length - 1].id, last_stop: new Date(Date.now() - 3600e3).toISOString() },
          ...(p.set === 'all' ? [{ name: 'reports', oid: 16390, size: 6e8, objects: 12, tables: 12, schemas: 2, connectable: true, in_latest: true, last_set: sets[sets.length - 1].id, last_stop: new Date(Date.now() - 3600e3).toISOString() }, { name: 'arca_rl_20261010', oid: 16399, size: 1e6, objects: 1, tables: 1, schemas: 1, connectable: true, in_latest: false, last_set: sets[sets.length - 1].id, last_stop: new Date(Date.now() - 3600e3).toISOString() }] : [])] } });
        return report(op.id, { status: 'succeeded', result: { set: 'x', database: p.database, schemas: [{ name: 'public', objects: [{ name: 'orders', kind: 'p', size: 3e9, partitions: 2, parts: [{ name: 'orders_2025', kind: 'r', depth: 0, parent: 'orders' }, { name: 'orders_2026', kind: 'r', depth: 0, parent: 'orders' }] }, { name: 'customers', kind: 'r', size: 4e8 }, { name: 'v_open_orders', kind: 'v', size: 0 }].filter(o => !p.search || o.name.includes(p.search)) }], total_objects: 2, truncated: false } });
      }
      if (op.type === 'restore_plan') {
        if (p.target_time && Date.parse(p.target_time) > Date.now() + 60_000) return report(op.id, { status: 'failed', error: 'PGA-PITR-002: target is in the future' });
        return report(op.id, { status: 'succeeded', result: { set: sets[sets.length - 1].id, chain: sets.slice(-3).map(s => s.id), target: p.target_time || 'end of archive', extract_bytes: 4.2e9, cluster_bytes: 5e9, saved_pct: 16, bytes: 5e9, files: 1200, missing_wal: [], ...(p.scope === 'database' ? { missing_roles: ['gone_owner'] } : {}), destination_database: p.new_name, destination: p.destination,
          space: [{ paths: ['/var/lib/postgresql/16/main', '/var/tmp/pg_arca_scratch'], roles: ['data', 'scratch'], need: 9.1e9, free: 4.3e10, total: 2.0e11, free_after: 3.39e10 }],
          preflight: { ok: p.new_name !== 'taken', level: p.new_name === 'taken' ? 'bad' : 'warn', checks: [{ id: 'chunks', level: 'ok', text: 'all 61234 backup chunks needed are present in the repository' }, { id: 'space', level: 'warn', text: "after the restore the live cluster's volume (/var/lib/postgresql/16/main, /var/tmp/pg_arca_scratch) would have 31.6 GiB free (17.0%)", fix: 'keep at least 10% free on the data volume' }, ...(p.new_name === 'taken' ? [{ id: 'name', level: 'bad', text: "destination database 'taken' already exists", fix: 'choose another name; existing databases are never overwritten' }] : [])] } } });
      }
      if (op.type === 'restore_database' || op.type === 'restore_object' || op.type === 'restore_instance') {
        for (let i = 1; i <= 3; i++) { await sleep(500); await report(op.id, { status: 'running', progress: { phase: 'extract', files: i * 40, files_total: 120, bytes: i * 1e8, bytes_total: 3e8 } }); }
        return report(op.id, { status: 'succeeded', result: { result_database: p.new_name || 'pgarca_stage_1', destination: p.destination, start_hint: 'pg_ctl -D ' + p.destination + ' start', inspect: 'SELECT 1',
          ...(p.create_missing_roles ? { roles_created: ['gone_owner'], warnings: ['roles created as NOLOGIN placeholders (no password, no login, no memberships) to keep owners and privileges: gone_owner'] } : {}) } });
      }
      if (op.type === 'wal_forensics' && p.mode === 'databases') { await sleep(1500); return report(op.id, { status: 'succeeded', result: { mode: 'databases', events: [], dropped: [{ oid: '16390', name: 'reports', time: new Date(Date.now() - 25 * 60e3).toISOString().replace('T', ' ').replace('Z', ' UTC'), time_exact: true, xid: '900', lsn: '0/4A000100' }], segments_scanned: 12, complete: true, elapsed_sec: 0.4 } }); }
      if (op.type === 'wal_forensics' && p.mode === 'dml') { await sleep(500); return report(op.id, { status: 'succeeded', result: { mode: 'dml', min_rows: p.min_rows || 1000, segments_scanned: 40, complete: true, elapsed_sec: 3.2, events: [{ kind: 'DELETE', xid: '4711', lsn: '0/4B000100', rows: 48210, deleted: 48210, updated: 0, names: ['appdb.public.orders'], committed: true, time: new Date(Date.now() - 50 * 60e3).toISOString().replace('T', ' ').replace('Z', ' UTC'), time_exact: true }] } }); }
      if (op.type === 'wal_forensics') { await sleep(600); return report(op.id, { status: 'succeeded', result: { segments_scanned: 64, elapsed_sec: 2.1, complete: true, window: { from: '2026-10-10 03:00:00 UTC' }, events: [{ lsn: '0/4A000028', kind: 'DROP', time: new Date(Date.now() - 3 * 3600e3).toISOString().replace('T', ' ').replace('Z', ' UTC'), time_exact: true, xid: '812', names: ['appdb.public.orders'], rels: [] }] } }); }
      if (op.type === 'backup_verify') { await sleep(800); return report(op.id, { status: 'succeeded', result: { ok: true, problems: [], chunks_checked: p.deep ? 90000 : 0, restore_test: p.restore_test ? { ok: true } : undefined } }); }
      if (op.type === 'backup_expire') return report(op.id, { status: 'succeeded', result: { delete_sets: [], keep_sets: sets.map(s => s.id), retention_full: p.retention_full || 2, dry_run: !!p.dry_run } });
      return report(op.id, { status: 'succeeded', result: {} });
    };
    const beat = async () => { try { const hb = await app.call('POST', '/api/agent/heartbeat', { body: { snapshot: snap(), max_ops: 3, agent_version: '2.0' }, headers: agent.h }); for (const op of hb.body.ops || []) handle(op).catch(e => console.error(e)); } catch (e) { console.error(e); } };
    await beat(); setInterval(beat, 1000);
    // an operational machine (backup server): no database, inventory only; answers its own operations
    const wt = await app.call('POST', '/api/enrollment-tokens', { body: { label: 'Backup server DC1', kind: 'worker' }, headers: { cookie } });
    const wen = await app.call('POST', '/api/agent/enroll', { body: { enrollment_token: wt.body.token, node_name: 'bk01', agent_version: '2.0', node_role: 'worker', discovery: { node_kind: 'worker', postgres_instances: [] } } });
    const wh = { authorization: 'Bearer ' + wen.body.agent_token, 'x-arca-node': wen.body.node_id };
    const winv = { node_kind: 'worker', worker: { role: 'worker', pg_installations: [{ major: 16, version: '16.4', bindir: '/usr/lib/postgresql/16/bin', source: 'system' }],
      host: { os: 'Debian GNU/Linux 12', cpus: 16, mem_total: 64e9, mem_available: 51e9, root: false, sudo_nopasswd: true },
      mounts: [{ mount: '/', fstype: 'ext4', remote: false, total_bytes: 2e11, free_bytes: 1.2e11 }, { mount: '/backup', fstype: 'nfs4', remote: true, total_bytes: 2e13, free_bytes: 1.4e13 }],
      dirs: { scratch: { path: '/var/tmp/pg_arca_scratch', exists: true, writable: true, free_bytes: 1.2e11 }, repo: { path: '/backup/pgarca/repo', exists: true, writable: true, free_bytes: 1.4e13 } } } };
    const wbeat = async () => { try { const hb = await app.call('POST', '/api/agent/heartbeat', { body: { snapshot: winv, max_ops: 2 }, headers: wh });
      for (const op of hb.body.ops || []) { await sleep(400); await app.call('POST', `/api/agent/ops/${op.id}/report`, { body: { status: 'succeeded', result: op.type === 'ephemeral_preflight' ? { ok: true, level: 'ok', major: op.params.major, checks: [{ id: 'binaries', level: 'ok', text: `PostgreSQL ${op.params.major} in /usr/lib/postgresql/${op.params.major}/bin` }, { id: 'scratch', level: 'ok', text: 'scratch /var/tmp/pg_arca_scratch: 111.8 GiB free' }] } : { ok: true } }, headers: wh }); } } catch (e) { console.error(e); } };
    await wbeat(); setInterval(wbeat, 1000);
    // geo-redundancy: two sites of the same database (sysid 7695): geo-dc1 primary, geo-dc2 Patroni standby cluster; they answer geo_demote / geo_promote
    const geo: any = { primary: 'dc1', lsn: 0x9000000 };
    const geoNode = async (name: string, site: string) => {
      const tk = await app.call('POST', '/api/enrollment-tokens', { body: { label: name, environment: 'prod' }, headers: { cookie } });
      const e = await app.call('POST', '/api/agent/enroll', { body: { enrollment_token: tk.body.token, node_name: name, agent_version: '2.0', discovery: { postgres_instances: [{ cluster_key: `patroni:geo-${site}`, patroni: { scope: `geo-${site}` } }] } } });
      return { site, name, h: { authorization: 'Bearer ' + e.body.agent_token, 'x-arca-node': e.body.node_id } };
    };
    const gn = [await geoNode('dc1-pg1', 'dc1'), await geoNode('dc2-pg1', 'dc2')];
    const lsn = (n: number) => `0/${n.toString(16).toUpperCase()}`;
    const gsnap = (site: string) => {
      const prim = geo.primary === site; const other = site === 'dc1' ? 'dc2' : 'dc1';
      return { postgres: { alive: true, version: '16.4', is_in_recovery: !prim, current_lsn: lsn(geo.lsn), system_identifier: '7695', timeline: 1, databases: [{ oid: 5, name: 'postgres', size: 8e6 }],
          slots: prim ? [{ name: `geo_${other}`, active: true, retained_bytes: 2048 }] : [], replay_ts: prim ? undefined : new Date().toISOString(),
          wal_receiver: prim ? undefined : { status: 'streaming', sender_host: `${other}-haproxy`, sender_port: 5000, silent_sec: 0.4 } },
        patroni: { accessible: true, scope: `geo-${site}`, local_node: { role: prim ? 'leader' : 'standby_leader', state: prim ? 'running' : 'streaming' }, members: [{ name: `${site}-pg1`, role: prim ? 'leader' : 'standby_leader', state: prim ? 'running' : 'streaming' }],
          standby_cluster: prim ? null : { host: `${other}-haproxy`, port: 5000, primary_slot_name: `geo_${site}`, ...(geo.rc?.[site] ? { restore_command: '/usr/local/bin/pg-arca-wal get %f %p' } : {}) },
          permanent_slots: prim ? [`geo_${other}`] : [], use_pg_rewind: !!geo.rewind?.[site] },
        system: { load_avg_1m: 0.2, cpu_count: 2, memory_used_percent: 30, memory_total_bytes: 4e9 } };
    };
    // pg_hba of a Patroni site lives in its DCS list: managed block + other entries; every change keeps the previous list (the console stores it)
    const dcs: Record<string, { base: string[]; managed: any[] }> = { dc1: { base: ['local all all trust', 'host replication replicator 172.30.0.0/16 scram-sha-256', 'host all all 172.30.0.0/16 scram-sha-256'], managed: [] }, dc2: { base: ['local all all trust', 'host replication replicator 172.30.0.0/16 scram-sha-256'], managed: [] } };
    const ruleLine = (r: any) => [r.type, r.database, r.user, ...(r.type === 'local' ? [] : [r.address]), r.method].join('  ');
    const listOf = (x: { base: string[]; managed: any[] }) => [...(x.managed.length ? ['# >>> pg_arca managed block >>>', ...x.managed.flatMap((r: any) => r.comment ? ['# ' + r.comment, ruleLine(r)] : [ruleLine(r)]), '# <<< pg_arca managed block <<<'] : []), ...x.base];
    const revOf = (l: string[]) => createHash('sha256').update(l.join('\n') + '\n').digest('hex').slice(0, 16);
    const parse = (l: string) => { const t = l.trim().split(/\s+/); return t[0] === 'local' ? { type: 'local', database: t[1], user: t[2], address: '', method: t[3] } : { type: t[0], database: t[1], user: t[2], address: t[3], method: t[4] }; };
    const hbaGeo = async (n: any, op: any) => {
      const x = dcs[n.site]; const p = op.params || {}; const cur = listOf(x); const ok = (result: any) => app.call('POST', `/api/agent/ops/${op.id}/report`, { body: { status: 'succeeded', result }, headers: n.h });
      if (op.type === 'hba_read') return ok({ hba_file: 'Patroni DCS: postgresql.pg_hba', mode: 'patroni', dcs_seed: false, seed_skipped: 0, rev: revOf(cur), raw: cur.join('\n') + '\n', truncated: false, dcs_rules: x.base.map(parse),
        managed: { present: x.managed.length > 0, rules: x.managed, rev: null }, effective: [], errors: [], ssl: false, has_includes: false, rule_count: cur.length, suggest: { replication_clients: [], roles: ['app', 'replicator'], databases: ['postgres'] }, backups: [],
        patroni_local: cur.some(l => /replication\s+replicator\s+127\.0\.0\.1/.test(l)) ? { ok: true, users: ['replicator'], denied: [] } : { ok: false, users: ['replicator'], denied: ['replicator'], suggest: ['host  replication  replicator  127.0.0.1/32  scram-sha-256'] } });
      if (op.type === 'hba_plan') return ok({ valid: true, errors: [], warnings: [], changed: true, mode: 'patroni', dcs_seed: false, base_rev: revOf(cur), diff: ['--- pg_hba (attuale)', '+++ pg_hba (nuovo)', ...(p.rules || []).map((r: any) => '+' + ruleLine(r))],
        simulation: [{ label: 'locale: utente postgres (peer)', before: true, after: true, critical: true }], would_lock_out: [] });
      if (op.type === 'hba_apply') { const prev = cur; x.managed = (p.rules || []).map((r: any) => ({ ...r })); return ok({ changed: true, mode: 'patroni', rev: revOf(listOf(x)), rules: x.managed.length, dcs_seed: false, previous: prev, previous_rev: revOf(prev), list: listOf(x), note: 'written to the DCS and loaded by PostgreSQL; every member follows' }); }
      if (op.type === 'hba_restore') { const prev = cur; const l: string[] = p.list || []; const b = l.findIndex(z => z.startsWith('# <<<')); x.managed = b < 0 ? [] : l.slice(1, b).filter(z => !z.startsWith('#')).map(parse); x.base = b < 0 ? l : l.slice(b + 1);
        return ok({ changed: true, mode: 'patroni', rev: revOf(listOf(x)), previous: prev, previous_rev: revOf(prev), list: listOf(x), restored: true }); }
      return ok({ changed: false });
    };
    const gbeat = async () => { geo.lsn += 0x100; for (const n of gn) { try {
      const hb = await app.call('POST', '/api/agent/heartbeat', { body: { snapshot: gsnap(n.site), max_ops: 2 }, headers: n.h });
      for (const op of hb.body.ops || []) { await sleep(500);
        if (op.type.startsWith('hba_')) { await hbaGeo(n, op); continue; }
        if (op.type === 'geo_demote') geo.primary = null;
        if (op.type === 'geo_promote') geo.primary = n.site;
        if (op.type === 'geo_archive_fallback') (geo.rc ||= {})[n.site] = !!op.params?.enable;
        if (op.type === 'patroni_config_patch' && op.params?.patch?.postgresql?.use_pg_rewind) (geo.rewind ||= {})[n.site] = true;
        await app.call('POST', `/api/agent/ops/${op.id}/report`, { body: { status: 'succeeded', result: { ok: true } }, headers: n.h }); }
    } catch (e) { console.error(e); } } };
    await gbeat(); setInterval(gbeat, 1000);
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
