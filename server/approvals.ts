import crypto from 'crypto';
/**
 * Four-eyes approval for risky operations, configurable per environment (settings.advanced.approvals = { prod: true, ... }).
 * A risky operation requested on a protected environment is NOT executed: it becomes a pending request that a DIFFERENT admin must approve
 * within 24 hours. The requester can cancel it. Everything is audited with both names. Off by default (no change in behaviour).
 */
export const APPROVAL_TTL_MS = 24 * 3600_000;
export const APPROVABLE_ENVS = ['prod', 'prep', 'int', 'dev', 'test'];

/** What counts as risky: it changes live access, live parameters, the HA topology or overwrites/deletes live data. */
export function isRisky(type: string, params: any = {}): boolean {
  if (['hba_cluster_apply', 'hba_apply', 'hba_rollback', 'pg_set_param', 'patroni_switchover', 'patroni_failover', 'patroni_restart', 'patroni_reinit', 'patroni_config_patch', 'patroni_pause'].includes(type)) return true;
  if (type === 'restore_promote') return params.mode === 'replace';
  if (type === 'restore_apply_rows') return (params.delete_keys || []).length > 0 || (params.restore_keys || []).length > 0;
  return false;
}
export const advanced = (st: any) => ({ approvals: {} as Record<string, boolean>, ...(st.settings.advanced || {}) });
export const requiresApproval = (st: any, cluster: any, type: string, params: any) => !!advanced(st).approvals[cluster.environment] && isRisky(type, params);

export function describeOp(type: string, params: any = {}): string {
  const m: Record<string, string> = { hba_cluster_apply: 'Modifica delle regole di accesso (pg_hba) su tutto il cluster', hba_apply: 'Modifica delle regole di accesso (pg_hba)', hba_rollback: 'Ripristino delle regole di accesso precedenti', pg_set_param: `Cambio del parametro ${params.name ?? ''} = ${params.value ?? ''}`,
    patroni_switchover: 'Switchover pianificato', patroni_failover: 'Failover forzato', patroni_restart: 'Riavvio via Patroni', patroni_reinit: 'Ricostruzione di una replica', patroni_config_patch: 'Modifica della configurazione Patroni', patroni_pause: 'Manutenzione Patroni',
    restore_promote: 'Sostituzione di una tabella con quella ripristinata', restore_apply_rows: `Recupero righe in ${params.object ?? ''}` };
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
    if (typeof a !== 'object') return res.status(400).json({ error: 'invalid', message: 'approvals non valido' });
    const join = req.body?.joinRequests === undefined ? ((store.peek().settings.advanced || {}).joinRequests !== false) : !!req.body.joinRequests;
    const next: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(a)) { if (!APPROVABLE_ENVS.includes(k)) return res.status(400).json({ error: 'invalid_env', message: 'Ambiente sconosciuto: ' + k }); if (v) next[k] = true; }
    if (Object.keys(next).length && activeAdmins(store.peek().settings) < 2)
      return res.status(409).json({ error: 'need_two_admins', message: 'Per attivare le approvazioni servono almeno due amministratori attivi: altrimenti nessuno potrebbe approvare.' });
    await store.mutate((d: any) => { d.settings.advanced = { ...(d.settings.advanced || {}), approvals: next, joinRequests: join }; audit(d, { actor: req.actor || 'admin', action: 'settings.advanced', status: 'OK', details: { approvals: Object.keys(next), joinRequests: join } }); });
    res.json(view(store.peek()));
  });
}

/** Create (or return the existing) pending request for the same user action (same Idempotency-Key). */
export async function requestApproval(store: any, audit: (d: any, e: any) => void, a: { cluster: any; type: string; params: any; nodeId?: string; ttlSeconds?: number; key: string; actor: string }) {
  const st = store.peek();
  const dup = (st.settings.approvalRequests || []).find((r: any) => r.status === 'pending' && r.idempotencyKey === a.key);
  if (dup) return dup;
  const rec = { id: 'apr_' + crypto.randomBytes(5).toString('hex'), status: 'pending', clusterId: a.cluster.id, clusterName: a.cluster.name, environment: a.cluster.environment, type: a.type, params: a.params,
    nodeId: a.nodeId, ttlSeconds: a.ttlSeconds, idempotencyKey: a.key, requestedBy: a.actor, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(), summary: describeOp(a.type, a.params) };
  await store.mutate((d: any) => { const l = (d.settings.approvalRequests ||= []); l.push(rec); if (l.length > 200) l.splice(0, l.length - 200);
    audit(d, { clusterId: a.cluster.id, actor: a.actor, action: 'approval.requested', status: 'OK', details: { id: rec.id, type: a.type, summary: rec.summary } }); });
  return rec;
}
