/** Audit trail + fleet discovery API, backed by real data (store.audit, node.discovery). */
import type { Request, Response } from 'express';
import { Store } from './store';
import * as ops from './ops';

function categoryOf(action: string): string {
  if (/patroni|switchover|failover/.test(action)) return 'ha_patroni';
  if (/set_param|parameter|reload/.test(action)) return 'parameters';
  if (/^(auth|token|node\.revoke)/.test(action)) return 'security';
  if (/backup|restore|pitr|wal|verify/.test(action)) return /backup/.test(action) ? 'backup' : 'pitr';
  if (/discovery/.test(action)) return 'discovery';
  return 'agent';
}
const statusOf = (s: string) => /^(OK|SUCCEEDED|SUCCESS)$/i.test(s) ? 'SUCCESS' : /FAIL|ERROR/i.test(s) ? 'FAILED' : 'WARNING';

export function mountPlatformRoutes(app: any, store: Store) {
  app.get('/api/audit/history', (req: Request, res: Response) => {
    const { clusterId, category, status, search, limit = '100' } = req.query as Record<string, string>;
    const st = store.peek();
    const names = Object.fromEntries(st.clusters.map((c: any) => [c.id, c.name]));
    let list = [...st.audit].reverse().map((e: any) => ({
      id: e.id, timestamp: e.timestamp, clusterId: e.clusterId, clusterName: e.clusterId ? names[e.clusterId] : undefined,
      category: categoryOf(e.action), action: e.action, status: statusOf(e.status), user: e.actor,
      details: typeof e.details === 'string' ? e.details : JSON.stringify(e.details ?? {}), metadata: e.details,
    }));
    if (clusterId && clusterId !== 'all') list = list.filter(e => e.clusterId === clusterId);
    if (category && category !== 'all') list = list.filter(e => e.category === category);
    if (status && status !== 'all') list = list.filter(e => e.status === status);
    if (search) { const q = search.toLowerCase(); list = list.filter(e => e.action.toLowerCase().includes(q) || e.details.toLowerCase().includes(q) || (e.clusterName || '').toLowerCase().includes(q)); }
    res.json({ total: list.length, entries: list.slice(0, Math.min(parseInt(limit, 10) || 100, 1000)) });
  });

  app.get('/api/discovery/results', (_req: Request, res: Response) => {
    const st = store.peek();
    const cname = (id?: string) => st.clusters.find((c: any) => c.id === id)?.name;
    const nodes = Object.values(st.nodes).map(n => ({
      nodeId: n.id, nodeName: n.name, clusterId: n.clusterId, clusterName: cname(n.clusterId), lastSeen: n.lastSeen, discovery: n.discovery || null,
      findings: (n.discovery as any)?.findings || [],
    }));
    const sum = (k: string) => nodes.reduce((a, n) => a + Number(n.discovery?.summary?.[k] || 0), 0);
    // configuration drift between the members of one cluster (same setting, different value) — a classic source of failover surprises
    const IGNORE = new Set(['port', 'data_directory', 'hba_file', 'ident_file', 'config_file', 'cluster_name', 'unix_socket_directories', 'listen_addresses', 'external_pid_file']);
    const drift: any[] = [];
    const byCluster = new Map<string, typeof nodes>();
    for (const n of nodes) if (n.clusterId) (byCluster.get(n.clusterId) || byCluster.set(n.clusterId, []).get(n.clusterId)!).push(n);
    for (const [cid, list] of byCluster) {
      if (list.length < 2) continue;
      const keys = new Set<string>();
      for (const n of list) for (const k of Object.keys((n.discovery as any)?.postgres_instances?.[0]?.settings || {})) if (!IGNORE.has(k)) keys.add(k);
      for (const k of [...keys].sort()) {
        const vals: Record<string, string> = {};
        for (const n of list) { const v = (n.discovery as any)?.postgres_instances?.[0]?.settings?.[k]; if (v !== undefined) vals[n.nodeName] = String(v); }
        if (Object.keys(vals).length > 1 && new Set(Object.values(vals)).size > 1) drift.push({ clusterId: cid, clusterName: cname(cid), setting: k, values: vals });
      }
    }
    res.json({
      nodes, drift,
      summary: { nodes: nodes.length, postgres: sum('postgres_instances_found'), patroni: sum('patroni_clusters_found'), etcd: sum('etcd_clusters_found'), pgbouncer: sum('pgbouncer_instances_found'),
                 critical: sum('findings_critical'), warnings: sum('findings_warning'), drift: drift.length },
    });
  });

  // Ask agents to re-scan their host now. One idempotent operation per node.
  app.post('/api/discovery/scan', async (req: Request, res: Response) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const wanted: string[] | undefined = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds : undefined;
    const online = Object.values(store.peek().nodes).filter(n => (!wanted || wanted.includes(n.id)) && n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000);
    const out = [];
    for (const n of online) {
      const r = await ops.submit(store, { type: 'discovery_scan', clusterId: n.clusterId || 'unassigned', nodeId: n.id, idempotencyKey: `${key}:${n.id}`, createdBy: (req as any).actor || 'admin', ttlSeconds: 120 });
      out.push({ nodeId: n.id, operationId: r.op.id, replayed: !r.created });
    }
    res.status(202).json({ requested: out.length, operations: out });
  });
}
