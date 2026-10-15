/**
 * Prometheus exposition of what the console knows: clusters and their state, health findings by severity, backup age and WAL archiving per
 * cluster, agents online, operations of the last 24 h. Text format 0.0.4, no dependency.
 *
 * Security: /metrics is OFF unless PG_ARCA_METRICS_TOKEN is set; then every scrape must send `Authorization: Bearer <token>` (or ?token=
 * for scrapers that cannot set headers). No session, no role: the token is the credential, keep it as such.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { Store } from './store';
import { evaluate, objectives } from './health';
import { APP_VERSION } from './version';

const ONLINE_MS = 45_000;
const esc = (s: any) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const lbl = (o: Record<string, any>) => '{' + Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(',') + '}';

export function renderMetrics(st: any, now = Date.now()): string {
  const out: string[] = [];
  const line = (name: string, labels: Record<string, any> | null, v: number | null | undefined) => { if (v == null || !Number.isFinite(Number(v))) return; out.push(`${name}${labels ? lbl(labels) : ''} ${Number(v)}`); };
  const head = (name: string, type: string, help: string) => { out.push(`# HELP ${name} ${help}`); out.push(`# TYPE ${name} ${type}`); };

  head('pg_arca_console_info', 'gauge', 'Console version.'); line('pg_arca_console_info', { version: APP_VERSION }, 1);
  head('pg_arca_console_time_seconds', 'gauge', 'Unix time of this scrape as seen by the console.'); line('pg_arca_console_time_seconds', null, Math.floor(now / 1000));

  const clusters = (st.clusters as any[]).filter(c => !c.isSandbox);
  const nodes = Object.values(st.nodes || {}) as any[];
  const issues = evaluate(st, now);
  const L = (c: any) => ({ cluster: c.name, environment: c.environment, cluster_id: c.id });

  head('pg_arca_cluster_status', 'gauge', 'Cluster status as the console derives it: 0 healthy, 1 degraded, 2 critical, 3 down/unknown.');
  head('pg_arca_cluster_findings', 'gauge', 'Open health findings of the cluster, by severity.');
  head('pg_arca_cluster_last_backup_timestamp_seconds', 'gauge', 'Start time of the newest COMPLETE backup set reported by the agents (0 = none).');
  head('pg_arca_cluster_last_full_backup_timestamp_seconds', 'gauge', 'Start time of the newest COMPLETE full backup (0 = none).');
  head('pg_arca_cluster_backup_sets', 'gauge', 'COMPLETE backup sets the agents report for the cluster.');
  head('pg_arca_cluster_archiver_failed_total', 'gauge', 'pg_stat_archiver.failed_count on the primary.');
  head('pg_arca_cluster_archiver_last_failed_timestamp_seconds', 'gauge', 'pg_stat_archiver.last_failed_time on the primary (0 = never).');
  head('pg_arca_cluster_wal_gaps', 'gauge', 'Gaps in the archived WAL sequence the agents found.');
  head('pg_arca_cluster_wal_conflicts', 'gauge', 'Divergent WAL copies in quarantine (two servers wrote the same name).');
  head('pg_arca_cluster_nodes', 'gauge', 'Nodes with an agent, by online state.');
  head('pg_arca_cluster_replication_lag_bytes', 'gauge', 'Replay lag of each replica as the primary sees it.');
  head('pg_arca_cluster_size_bytes', 'gauge', 'Sum of the database sizes reported by the primary.');
  head('pg_arca_cluster_rpo_seconds', 'gauge', 'Recovery point: upper bound of the transactions not in the WAL archive yet (-1 = unbounded: archiving failing or off; absent = unknown).');
  head('pg_arca_cluster_rto_estimate_seconds', 'gauge', 'Recovery time estimated from the last disaster-recovery drill, scaled to the current size (absent = never measured).');
  head('pg_arca_cluster_rpo_target_seconds', 'gauge', 'Recovery point objective declared in the backup policy (absent = none).');
  head('pg_arca_cluster_rto_target_seconds', 'gauge', 'Recovery time objective declared in the backup policy (absent = none).');
  const sevRank: Record<string, number> = { critical: 2, warning: 1, info: 0 };
  for (const c of clusters) {
    const mine = nodes.filter(n => n.clusterId === c.id && n.kind !== 'worker');
    const online = mine.filter(n => n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS);
    const prim = online.find(n => n.snapshot?.postgres?.is_in_recovery === false) || online[0];
    const pg = prim?.snapshot?.postgres || {};
    const my = issues.filter(i => i.clusterId === c.id);
    const worst = my.reduce((m, i) => Math.max(m, sevRank[i.severity] ?? 0), -1);
    const status = c.status === 'down' ? 3 : worst === 2 ? 2 : c.status === 'degraded' || worst === 1 ? 1 : c.status === 'healthy' ? 0 : 3;
    line('pg_arca_cluster_status', L(c), status);
    for (const s of ['critical', 'warning', 'info']) line('pg_arca_cluster_findings', { ...L(c), severity: s }, my.filter(i => i.severity === s).length);
    const sets: any[] = (prim?.snapshot?.backup?.recent_sets || []).filter((x: any) => x.status === 'COMPLETE');
    const ts = (x: any) => { const t = Date.parse(x?.start_time || ''); return Number.isFinite(t) ? Math.floor(t / 1000) : 0; };
    line('pg_arca_cluster_last_backup_timestamp_seconds', L(c), sets.length ? Math.max(...sets.map(ts)) : 0);
    const fulls = sets.filter(x => x.type === 'full');
    line('pg_arca_cluster_last_full_backup_timestamp_seconds', L(c), fulls.length ? Math.max(...fulls.map(ts)) : 0);
    line('pg_arca_cluster_backup_sets', L(c), sets.length);
    if (pg.archiver) {
      line('pg_arca_cluster_archiver_failed_total', L(c), Number(pg.archiver.failed_count || 0));
      const lf = Date.parse(pg.archiver.last_failed_time || ''); line('pg_arca_cluster_archiver_last_failed_timestamp_seconds', L(c), Number.isFinite(lf) ? Math.floor(lf / 1000) : 0);
    }
    const wal = prim?.snapshot?.wal; if (wal) { line('pg_arca_cluster_wal_gaps', L(c), Number(wal.gap_count || 0)); line('pg_arca_cluster_wal_conflicts', L(c), Number(wal.conflicts || 0)); }
    line('pg_arca_cluster_nodes', { ...L(c), state: 'online' }, online.length); line('pg_arca_cluster_nodes', { ...L(c), state: 'offline' }, mine.length - online.length);
    for (const r of (pg.replication || []) as any[]) if (r?.application_name) line('pg_arca_cluster_replication_lag_bytes', { ...L(c), replica: r.application_name }, Number(r.replay_lag_bytes || 0));
    const size = ((pg.databases || []) as any[]).reduce((a, d) => a + Number(d?.size || 0), 0); if (size) line('pg_arca_cluster_size_bytes', L(c), size);
    const ob = objectives(st, c.id, now);
    if (ob) { if (ob.rpo.seconds != null) line('pg_arca_cluster_rpo_seconds', L(c), ob.rpo.seconds); else if (ob.rpo.state === 'bad') line('pg_arca_cluster_rpo_seconds', L(c), -1);
      if (ob.rto.estimateSeconds != null) line('pg_arca_cluster_rto_estimate_seconds', L(c), ob.rto.estimateSeconds);
      if (ob.targets.rpoSeconds) line('pg_arca_cluster_rpo_target_seconds', L(c), ob.targets.rpoSeconds); if (ob.targets.rtoSeconds) line('pg_arca_cluster_rto_target_seconds', L(c), ob.targets.rtoSeconds); }
  }

  head('pg_arca_workers', 'gauge', 'Worker hosts (backup servers, recovery hosts), by online state.');
  const workers = nodes.filter(n => n.kind === 'worker');
  const wOn = workers.filter(n => n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS).length;
  line('pg_arca_workers', { state: 'online' }, wOn); line('pg_arca_workers', { state: 'offline' }, workers.length - wOn);

  head('pg_arca_operations_24h', 'gauge', 'Operations finished in the last 24 hours, by type and status.');
  const since = now - 24 * 3600_000; const agg: Record<string, number> = {};
  for (const o of (st.operations as any[])) { const t = Date.parse(o.updatedAt || ''); if (!Number.isFinite(t) || t < since) continue; const k = `${o.type}|${o.status}`; agg[k] = (agg[k] || 0) + 1; }
  for (const [k, v] of Object.entries(agg).sort()) { const [type, status] = k.split('|'); line('pg_arca_operations_24h', { type, status }, v); }
  head('pg_arca_operations_running', 'gauge', 'Operations queued, leased or running right now.');
  line('pg_arca_operations_running', null, (st.operations as any[]).filter(o => ['queued', 'leased', 'running'].includes(o.status)).length);

  head('pg_arca_findings', 'gauge', 'Open health findings across all clusters, by severity.');
  for (const s of ['critical', 'warning', 'info']) line('pg_arca_findings', { severity: s }, issues.filter(i => i.severity === s).length);
  return out.join('\n') + '\n';
}

/** GET /metrics (and /api/metrics): bearer token from PG_ARCA_METRICS_TOKEN; disabled (404) when the variable is not set. */
export function mountMetricsRoutes(app: any, store: Store, tokenEnv = () => process.env.PG_ARCA_METRICS_TOKEN) {
  const handler = (req: Request, res: Response) => {
    const want = String(tokenEnv() || '');
    if (!want) return res.status(404).json({ error: 'metrics_disabled', message: 'Set PG_ARCA_METRICS_TOKEN in the console settings to enable /metrics.' });
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String((req.query as any)?.token || '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (!got || a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.setHeader('WWW-Authenticate', 'Bearer'); return res.status(401).json({ error: 'unauthorized' }); }
    res.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(store.peek()));
  };
  app.get('/metrics', handler); app.get('/api/metrics', handler);
}
