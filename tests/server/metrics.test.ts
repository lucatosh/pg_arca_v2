import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { renderMetrics, mountMetricsRoutes } from '../../server/metrics';
(async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'met-')));
  const now = Date.now(); const iso = (ms: number) => new Date(ms).toISOString();
  await store.mutate(d => {
    d.clusters.push({ id: 'p', name: 'prod "db"', environment: 'prod', source: 'agent', status: 'healthy' } as any, { id: 'demo', name: 'demo', environment: 'dev', isSandbox: true } as any);
    d.nodes.n1 = { id: 'n1', name: 'pg1', clusterId: 'p', lastSeen: iso(now), snapshot: { postgres: { is_in_recovery: false, connections: { used: 3, max: 100 }, settings: { archive_mode: 'on' },
      archiver: { failed_count: 7, last_failed_time: iso(now - 60_000), last_failed_wal: '0000000100000000000000AA' }, replication: [{ application_name: 'pg2', replay_lag_bytes: 2048 }], databases: [{ name: 'a', size: 100 }, { name: 'b', size: 50 }] },
      wal: { gap_count: 1, conflicts: 3 }, backup: { configured: true, recent_sets: [{ status: 'COMPLETE', type: 'full', start_time: iso(now - 7200_000) }, { status: 'COMPLETE', type: 'incr', start_time: iso(now - 600_000) }, { status: 'FAILED', type: 'incr', start_time: iso(now - 100) }] } } } as any;
    d.nodes.n2 = { id: 'n2', name: 'pg2', clusterId: 'p', lastSeen: iso(now - 600_000), snapshot: { postgres: { is_in_recovery: true } } } as any;
    d.nodes.w1 = { id: 'w1', name: 'bk1', kind: 'worker', lastSeen: iso(now) } as any;
    d.settings.policyAssignments = { 'cluster:p': { templateId: 'prod-critical' } };                 // declares RPO 15 min / RTO 4 h
    d.operations.push({ id: 'o1', type: 'backup_run', status: 'succeeded', clusterId: 'p', nodeId: 'n1', createdAt: iso(now - 3000), updatedAt: iso(now - 1000), history: [], params: {}, idempotencyKey: 'k1', attempts: 1, createdBy: 'x' } as any,
      { id: 'o2', type: 'backup_run', status: 'failed', clusterId: 'p', nodeId: 'n1', createdAt: iso(now - 3000), updatedAt: iso(now - 1000), history: [], params: {}, idempotencyKey: 'k2', attempts: 1, createdBy: 'x' } as any,
      { id: 'o3', type: 'restore_drill', status: 'running', clusterId: 'p', nodeId: 'n1', createdAt: iso(now - 3000), updatedAt: iso(now - 1000), history: [], params: {}, idempotencyKey: 'k3', attempts: 1, createdBy: 'x' } as any);
  });
  const txt = renderMetrics(store.peek(), now);
  const get = (re: RegExp) => { const m = re.exec(txt); return m ? Number(m[1]) : null; };
  assert(/pg_arca_console_info\{version="[^"]+"\} 1/.test(txt));
  assert(txt.includes('cluster="prod \\"db\\""'), 'label escaping');
  assert(!txt.includes('cluster="demo"'), 'the demo cluster is not exported');
  assert.strictEqual(get(/pg_arca_cluster_backup_sets\{[^}]*\} (\d+)/), 2, 'COMPLETE sets only');
  assert.strictEqual(get(/pg_arca_cluster_last_full_backup_timestamp_seconds\{[^}]*\} (\d+)/), Math.floor((now - 7200_000) / 1000));
  assert.strictEqual(get(/pg_arca_cluster_archiver_failed_total\{[^}]*\} (\d+)/), 7);
  assert.strictEqual(get(/pg_arca_cluster_wal_conflicts\{[^}]*\} (\d+)/), 3);
  assert.strictEqual(get(/pg_arca_cluster_nodes\{[^}]*state="online"\} (\d+)/), 1); assert.strictEqual(get(/pg_arca_cluster_nodes\{[^}]*state="offline"\} (\d+)/), 1);
  assert.strictEqual(get(/pg_arca_cluster_replication_lag_bytes\{[^}]*replica="pg2"\} (\d+)/), 2048);
  assert.strictEqual(get(/pg_arca_cluster_size_bytes\{[^}]*\} (\d+)/), 150);
  assert.strictEqual(get(/pg_arca_cluster_rpo_seconds\{[^}]*\} (-?\d+)/), -1, 'archiver failing: unbounded');
  assert.strictEqual(get(/pg_arca_cluster_rpo_target_seconds\{[^}]*\} (\d+)/), 900); assert.strictEqual(get(/pg_arca_cluster_rto_target_seconds\{[^}]*\} (\d+)/), 14400);
  assert.strictEqual(get(/pg_arca_workers\{state="online"\} (\d+)/), 1);
  assert.strictEqual(get(/pg_arca_operations_24h\{type="backup_run",status="failed"\} (\d+)/), 1);
  assert.strictEqual(get(/pg_arca_operations_running (\d+)/), 1);
  assert(get(/pg_arca_cluster_status\{[^}]*\} (\d)/)! >= 1, 'archiver failing + offline node: not healthy');
  assert(get(/pg_arca_cluster_findings\{[^}]*severity="critical"\} (\d+)/)! >= 1);
  // the route: off without a token, 401 with a wrong one, text/plain with the right one (header or query)
  let token = ''; const app = new MiniApp(); mountMetricsRoutes(app, store, () => token);
  assert.strictEqual((await app.call('GET', '/metrics')).status, 404);
  token = 'scrape-me-9f3a';
  assert.strictEqual((await app.call('GET', '/metrics')).status, 401);
  assert.strictEqual((await app.call('GET', '/metrics', { headers: { authorization: 'Bearer nope' } })).status, 401);
  const ok = await app.call('GET', '/metrics', { headers: { authorization: 'Bearer scrape-me-9f3a' } });
  assert.strictEqual(ok.status, 200); assert(String(ok.body).includes('pg_arca_console_info'));
  assert.strictEqual((await app.call('GET', '/api/metrics?token=scrape-me-9f3a')).status, 200);
  console.log('metrics OK');
})();
