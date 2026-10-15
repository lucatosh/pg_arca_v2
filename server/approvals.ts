import crypto from 'crypto';
import { sealParams } from './ops';
import { hbaOpenRule } from './optypes';
/**
 * Four-eyes approval for risky operations, configurable per environment (settings.advanced.approvals = { prod: true, ... }).
 * A risky operation requested on a protected environment is NOT executed: it becomes a pending request that a DIFFERENT admin must approve
 * within 24 hours. The requester can cancel it. Everything is audited with both names. Off by default (no change in behaviour).
 */
export const APPROVAL_TTL_MS = 24 * 3600_000;
export const APPROVABLE_ENVS = ['prod', 'prep', 'int', 'dev', 'test'];

/** What counts as risky: it changes live access, live parameters, the HA topology or overwrites/deletes live data. */
export function isRisky(type: string, params: any = {}): boolean {
  if ((type === 'hba_apply' || type === 'hba_cluster_apply' || type === 'hba_restore') && hbaOpenRule(params.rules)) return true;   // trust / clear-text password towards the network: four-eyes
  if (type === 'pg_restart' && params.dry_run) return false;                 // only says HOW it would restart
  if (type === 'restore_db_swap' && params.dry_run) return false;
  if (type === 'restore_database' && params.replace_original) return true;
  if (type === 'restore_instance' && params.replace_production && !params.dry_run) return true;   // production is stopped and its data directory replaced
  if (type === 'restore_kept_drop') return true;      // the restored database takes the original's place
  if (type === 'restore_object' && params.finish === 'promote' && params.promote_mode === 'replace') return true;
  if (type === 'restore_object' && params.finish === 'rows_all') return true;
  if (['hba_cluster_apply', 'hba_apply', 'hba_rollback', 'hba_restore', 'pg_set_param', 'patroni_switchover', 'patroni_failover', 'patroni_restart', 'pg_restart', 'patroni_reinit', 'archive_enable', 'patroni_config_patch', 'patroni_pause', 'ephemeral_install', 'geo_promote', 'geo_demote', 'geo_switchover', 'restore_db_swap', 'destination_apply', 'destination_drop_old'].includes(type)) return true;
  if (type === 'wal_retire_branch') return !params.dry_run;                 // stored WAL of a timeline is set aside in the archive
  if (type === 'restore_promote') return params.mode === 'replace';
  if (type === 'restore_instance') return !!params.keep_archiving;               // a copy that will write into production's WAL archive
  if (type === 'restore_apply_rows') return (params.delete_keys || []).length > 0 || (params.restore_keys || []).length > 0 || (params.restore_all || []).length > 0 || !!params.delete_all_added;
  return false;
}
export const advanced = (st: any) => ({ approvals: {} as Record<string, boolean>, ...(st.settings.advanced || {}) });
export const requiresApproval = (st: any, cluster: any, type: string, params: any) => !!advanced(st).approvals[cluster.environment] && isRisky(type, params);

export function describeOp(type: string, params: any = {}): string {
  const m: Record<string, string> = { destination_apply: `Backup destination change${params.repo_path ? ' → ' + params.repo_path : ''}`, destination_drop_old: `Deletion of the previous backup location ${params.path ?? ''}`, hba_cluster_apply: 'Access rule (pg_hba) change on the whole cluster', wal_retire_branch: `Retirement of the dead WAL branch of timeline ${params.timeline ?? ''}`, hba_apply: 'Access rule (pg_hba) change', hba_rollback: 'Rollback to the previous access rules', hba_restore: 'Restore of a previous version of the access rules (Patroni DCS)', pg_set_param: `Parameter change ${params.name ?? ''} = ${params.value ?? ''}`,
    patroni_switchover: 'Planned switchover', patroni_failover: 'Forced failover', patroni_restart: 'Restart through Patroni', pg_restart: 'PostgreSQL restart', patroni_reinit: 'Replica reinitialization', archive_enable: 'Enable WAL archiving', patroni_config_patch: 'Patroni configuration change', patroni_pause: 'Patroni maintenance mode',
    restore_promote: 'Replacement of tables with the restored ones', ephemeral_install: `Installation of the PostgreSQL ${params.major ?? ''} binaries for restores`, restore_apply_rows: `Row recovery in ${params.object ?? ''}`,
    restore_kept_drop: `Deletion of kept data ${params.path ?? ''}`, restore_db_swap: `Replacement of database ${params.original ?? ''} with ${params.restored ?? ''}` };
  if (type === 'restore_instance' && params.replace_production) return 'In-place restore of the production server (PostgreSQL stopped and restarted on the restored data)';
  return m[type] || type;
}

export function activeAdmins(settings: any): number {
  return (settings.admin ? 1 : 0) + Object.values(settings.users || {}).filter((u: any) => u.role === 'admin' && !u.disabled).length;
}

/** Advanced settings: for now the per-environment four-eyes switch. Returns the saved view. */
export function mountAdvancedRoutes(app: any, store: any, audit: (d: any, e: any) => void) {
  const view = (st: any) => ({ joinRequests: (advanced(st) as any).joinRequests !== false, approvals: advanced(st).approvals, environments: APPROVABLE_ENVS, activeAdmins: activeAdmins(st.settings) });
  app.get('/api/advanced', (_req: any, res: any) => { const st = store.peek(); res.json({ ...view({ settings: st.settings }), }); });
  app.put('/api/advanced', async (req: any, res: any) => {
    const a = req.body?.approvals ?? store.peek().settings.advanced?.approvals ?? {};
    if (typeof a !== 'object') return res.status(400).json({ error: 'invalid', message: 'invalid approvals' });
    const join = req.body?.joinRequests === undefined ? ((store.peek().settings.advanced || {}).joinRequests !== false) : !!req.body.joinRequests;
    const next: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(a)) { if (!APPROVABLE_ENVS.includes(k)) return res.status(400).json({ error: 'invalid_env', message: 'Unknown environment: ' + k }); if (v) next[k] = true; }
    if (Object.keys(next).length && activeAdmins(store.peek().settings) < 2)
      return res.status(409).json({ error: 'need_two_admins', message: 'Enabling approvals needs at least two active administrators: otherwise nobody could approve.' });
    await store.mutate((d: any) => { d.settings.advanced = { ...(d.settings.advanced || {}), approvals: next, joinRequests: join }; audit(d, { actor: req.actor || 'admin', action: 'settings.advanced', status: 'OK', details: { approvals: Object.keys(next), joinRequests: join } }); });
    res.json(view(store.peek()));
  });
}

/** Create (or return the existing) pending request for the same user action (same Idempotency-Key). */
export async function requestApproval(store: any, audit: (d: any, e: any) => void, a: { cluster: any; type: string; params: any; nodeId?: string; ttlSeconds?: number; key: string; actor: string; owner?: string }) {
  const st = store.peek();
  const dup = (st.settings.approvalRequests || []).find((r: any) => r.status === 'pending' && r.idempotencyKey === a.key);
  if (dup) return dup;
  const rec = { id: 'apr_' + crypto.randomBytes(5).toString('hex'), status: 'pending', clusterId: a.cluster.id, clusterName: a.cluster.name, environment: a.cluster.environment, type: a.type, params: sealParams(store.dir, a.params),
    nodeId: a.nodeId, ttlSeconds: a.ttlSeconds, idempotencyKey: a.key, requestedBy: a.actor, requestedByOwner: a.owner || undefined, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), summary: describeOp(a.type, a.params) };
  await store.mutate((d: any) => { const l = (d.settings.approvalRequests ||= []); l.push(rec); if (l.length > 200) l.splice(0, l.length - 200);
    audit(d, { clusterId: a.cluster.id, actor: a.actor, action: 'approval.requested', status: 'OK', details: { id: rec.id, type: a.type, summary: rec.summary } }); });
  return rec;
}
