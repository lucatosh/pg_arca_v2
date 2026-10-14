/** pg_hba management API: rule templates (customisable, with variables) and propagation of one rule set to every node of a cluster. */
import { validateOp } from './optypes';
import type { Request, Response } from 'express';
import { Store } from './store';
import * as ops from './ops';
import { requiresApproval, requestApproval } from './approvals';
import { conflictFor } from './conflicts';

export interface HbaTemplate {
  id: string; name: string; description: string; envs: string[];
  vars: { key: string; label: string; def: string; hint?: string }[];
  rules: { type: string; database: string; user: string; address: string; method: string; options?: string; comment: string }[];
}
export const HBA_TEMPLATES: HbaTemplate[] = [
  { id: 'replication', name: 'Streaming replication', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Lets the standby nodes replicate, over TLS only, with a SCRAM password, only from the nodes’ network.',
    vars: [{ key: 'replUser', label: 'Replication user', def: 'replicator' }, { key: 'replNet', label: 'Nodes’ network (CIDR)', def: '10.0.2.0/24', hint: 'Narrow is better: a /32 per node or just the database subnet.' }],
    rules: [{ type: 'hostssl', database: 'replication', user: '{{replUser}}', address: '{{replNet}}', method: 'scram-sha-256', comment: 'Streaming replication (Patroni / physical standbys)' }] },
  { id: 'app', name: 'Applications (application network)', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Access for application users to their databases, TLS + SCRAM only, only from the application network.',
    vars: [{ key: 'appUser', label: 'Application user (or +role)', def: 'app' }, { key: 'appDb', label: 'Database', def: 'all' }, { key: 'appNet', label: 'Application network (CIDR)', def: '10.0.20.0/24' }],
    rules: [{ type: 'hostssl', database: '{{appDb}}', user: '{{appUser}}', address: '{{appNet}}', method: 'scram-sha-256', comment: 'Applications' }] },
  { id: 'dba', name: 'Administrators (DBA)', envs: ['prod', 'prep', 'int'], description: 'Members of a DBA role connect from a management network (VPN / bastion), never from the Internet.',
    vars: [{ key: 'dbaRole', label: 'DBA role', def: 'dba' }, { key: 'dbaNet', label: 'Management network (CIDR)', def: '10.0.10.0/24' }],
    rules: [{ type: 'hostssl', database: 'all', user: '+{{dbaRole}}', address: '{{dbaNet}}', method: 'scram-sha-256', comment: 'Administrators from the management network' }] },
  { id: 'monitoring', name: 'Monitoring', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'A read-only user (pg_monitor) for monitoring tools.',
    vars: [{ key: 'monUser', label: 'Monitoring user', def: 'monitor' }, { key: 'monNet', label: 'Monitoring network (CIDR)', def: '10.0.30.0/24' }],
    rules: [{ type: 'hostssl', database: 'postgres', user: '{{monUser}}', address: '{{monNet}}', method: 'scram-sha-256', comment: 'Monitoring' }] },
  { id: 'tls-only', name: 'Encrypted connections only', envs: ['prod', 'prep'], description: 'Rejects every unencrypted network connection (hostssl rules stay valid). Requires ssl=on on the server.',
    vars: [],
    rules: [{ type: 'hostnossl', database: 'all', user: 'all', address: '0.0.0.0/0', method: 'reject', comment: 'No unencrypted connections' }, { type: 'hostnossl', database: 'all', user: 'all', address: '::/0', method: 'reject', comment: 'No unencrypted connections (IPv6)' }] },
  { id: 'block-external', name: 'Block a network', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Explicitly rejects a network (e.g. an untrusted subnet) before any other rule.',
    vars: [{ key: 'blockNet', label: 'Network to block (CIDR)', def: '192.168.99.0/24' }],
    rules: [{ type: 'host', database: 'all', user: 'all', address: '{{blockNet}}', method: 'reject', comment: 'Blocked network' }] },
  { id: 'local-admin', name: 'Local administration', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'The postgres user connects from the local socket with peer (no cleartext password) and from loopback with SCRAM.',
    vars: [],
    rules: [{ type: 'local', database: 'all', user: 'postgres', address: '', method: 'peer', comment: 'Local administration' }, { type: 'hostssl', database: 'all', user: 'postgres', address: '127.0.0.1/32', method: 'scram-sha-256', comment: 'Loopback' }] },
];
/** Suggested starter set per environment (template ids, in the order they should appear). */
export const HBA_SUGGESTED: Record<string, string[]> = {
  prod: ['local-admin', 'replication', 'dba', 'app', 'monitoring', 'tls-only'], prep: ['local-admin', 'replication', 'dba', 'app', 'tls-only'], int: ['local-admin', 'replication', 'dba', 'app'],
  dev: ['local-admin', 'replication', 'app'], test: ['local-admin', 'replication', 'app'],
};

export function mountHbaRoutes(app: any, store: Store) {
  app.get('/api/clusters/:id/hba/history', (req: Request, res: Response) => {
    const h = ((store.peek().settings.hbaHistory || {})[req.params.id] || []) as any[];
    res.json({ history: h.map((x, i) => ({ index: i, at: x.at, by: x.by, seed: x.seed, kind: x.kind, rules: x.list.filter((l: string) => l.trim() && !l.trim().startsWith('#')).length, list: x.list })) });
  });

  // Patroni: put a previous DCS list back (same four-eyes rule as an apply). The agent re-checks the revision and simulates lock-outs first.
  app.post('/api/clusters/:id/hba/restore', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (!c.haState?.managedByPatroni) return res.status(409).json({ error: 'not_patroni', message: 'For nodes with a pg_hba.conf file, use “Restore the previous version” (backup copies on the node).' });
    const key = String(req.headers['idempotency-key'] || ''); if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const h = ((st.settings.hbaHistory || {})[c.id] || []) as any[]; const item = h[Number(req.body?.index)];
    if (!item) return res.status(404).json({ error: 'version_not_found' });
    const params = { list: item.list, base_rev: req.body?.baseRev || undefined, force: !!req.body?.force };
    const bad = validateOp('hba_restore', params); if (bad) return res.status(400).json({ error: 'invalid_operation', message: bad });
    if (requiresApproval(st, c, 'hba_cluster_apply', {})) {
      const rec = await requestApproval(store, ops.audit, { cluster: c, type: 'hba_restore', params, key, actor: (req as any).actor || 'admin' } as any);
      return res.status(202).json({ approval: rec, message: 'Risky operation in a protected environment: another administrator must approve it.' });
    }
    const t = hbaTarget(st, c.id); if (!t) return res.status(409).json({ error: 'no_suitable_node', message: 'No node with a reachable Patroni API.' });
    const cf = conflictFor(st.operations.filter(o => o.idempotencyKey !== key), c.id, 'hba_restore', params, (req as any).actor); if (cf) return res.status(409).json(cf);
    try {
      const r = await ops.submit(store, { type: 'hba_restore', clusterId: c.id, nodeId: t.id, params, idempotencyKey: key, createdBy: (req as any).actor || 'admin', ttlSeconds: 600 });
      res.status(202).json({ operation: r.op });
    } catch (e: any) { res.status(e.code === 'IDEMPOTENCY_CONFLICT' ? 422 : 500).json({ error: 'failed', message: e.message }); }
  });

  app.get('/api/hba/templates', (_req: Request, res: Response) => res.json({ templates: HBA_TEMPLATES, suggested: HBA_SUGGESTED }));

  // Apply one rule set to the cluster. Patroni clusters: the DCS list is edited once (every member follows). Others: every online node, each with
  // the pg_hba revision the operator saw (a node edited in the meantime is refused, not overwritten). One Idempotency-Key per operator intent.
  app.post('/api/clusters/:id/hba/apply', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (c.isSandbox) return res.status(409).json({ error: 'demo_cluster', message: 'Demo cluster: operations are not executed.' });
    if (c.source === 'direct') return res.status(409).json({ error: 'agent_required', message: 'Changing pg_hba requires the agent on the node.' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const { rules, baseRevs = {}, force = false, adopt = false } = req.body || {};
    if (!Array.isArray(rules) || rules.length > 200) return res.status(400).json({ error: 'invalid_rules' });
    const bodyOut = { rules, baseRevs, force: !!force, adopt: !!adopt };
    if (requiresApproval(st, c, 'hba_cluster_apply', {})) {
      const rec = await requestApproval(store, ops.audit, { cluster: c, type: 'hba_cluster_apply', params: bodyOut, key, actor: (req as any).actor || 'admin' });
      return res.status(202).json({ approval: rec, message: 'Risky operation in a protected environment: another administrator must approve it.' });
    }
    const r = await hbaFanout(store, c, bodyOut, key, (req as any).actor || 'admin');
    res.status(r.code).json(r.body);
  });
}

/** Patroni cluster: the one node that edits the DCS list. Patroni API reachable AND PostgreSQL running (the change is verified through pg_hba_file_rules),
 *  the leader / standby leader first (it is the member whose rules matter most for the replicas and the remote site). */
export function hbaTarget(st: any, clusterId: string): any | null {
  const nodes = (Object.values(st.nodes) as any[]).filter(n => n.clusterId === clusterId && n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000 && n.snapshot?.patroni?.accessible);
  const rank = (n: any) => (n.snapshot?.postgres?.alive === false ? 10 : 0) + (['leader', 'master', 'primary', 'standby_leader'].includes(n.snapshot?.patroni?.local_node?.role) ? 0 : 1);
  return nodes.sort((a, b) => rank(a) - rank(b))[0] || null;
}

/** Previous pg_hba lists of a Patroni cluster (newest first): the DCS keeps only the current one, the console keeps the last 15 so a change can be undone. */
export async function recordHbaHistory(store: Store, op: any) {
  const r = op?.result; if (!r || r.mode !== 'patroni' || r.changed !== true) return;
  const prev: string[] | null = Array.isArray(r.previous) ? r.previous : Array.isArray(r.seed_list) ? r.seed_list : null;
  if (!prev) return;
  await store.mutate(d => {
    const h = ((d.settings.hbaHistory ||= {})[op.clusterId] ||= []);
    h.unshift({ at: new Date().toISOString(), by: op.createdBy || '?', opId: op.id, list: prev.slice(0, 600), rev: r.previous_rev || null, seed: !Array.isArray(r.previous), replacedBy: Array.isArray(r.list) ? r.list.length : null, kind: r.restored ? 'restore' : 'apply' });
    d.settings.hbaHistory[op.clusterId] = h.slice(0, 15);
  });
}

/** Submit one hba_apply per target node (or one for the whole Patroni cluster) and remember temporary-rule expiries for the scheduler. */
export async function hbaFanout(store: Store, c: any, body: any, key: string, actor: string): Promise<{ code: number; body: any }> {
  const c0 = c;
  const st = store.peek(); const { rules, force = false, adopt = false } = body;
  const baseRevs: Record<string, string> = body.baseRevs && typeof body.baseRevs === 'object' && !Array.isArray(body.baseRevs) ? body.baseRevs : {};
  const bad = validateOp('hba_apply', { rules, force: !!force, adopt: !!adopt });                 // the same checks every other operation gets
  if (bad) return { code: 400, body: { error: 'invalid_operation', message: bad } };
  for (const v of Object.values(baseRevs)) if (v !== undefined && v !== null && v !== '' && !/^[0-9a-f]{16}$/.test(String(v))) return { code: 400, body: { error: 'invalid_operation', message: 'invalid base_rev' } };
  const online = Object.values(st.nodes).filter(n => n.clusterId === c.id && n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000);
  if (!online.length) return { code: 409, body: { error: 'no_suitable_node', message: 'No node online.' } };
  const patroni = !!c.haState?.managedByPatroni;
  const t = patroni ? hbaTarget(st, c.id) : null;
  if (patroni && !t) return { code: 409, body: { error: 'no_suitable_node', message: 'No node with a reachable Patroni API: pg_hba is changed only through the DCS.' } };
  const targets = patroni ? [t!] : online;
  {                                                   // a colleague is already changing pg_hba here: refused with who and since when (replays of the same intent pass)
    const cf = conflictFor(st.operations.filter(o => !String(o.idempotencyKey || '').startsWith(`${key}:`)), c0.id, 'hba_apply', {}, actor);
    if (cf) return { code: 409, body: cf };
  }
  const out: any[] = [];
  try {
    for (const n of targets) {
      const r = await ops.submit(store, { type: 'hba_apply', clusterId: c.id, nodeId: n.id, params: { rules, force: !!force, adopt: !!adopt, base_rev: (Object.prototype.hasOwnProperty.call(baseRevs, n.id) && baseRevs[n.id]) || undefined }, idempotencyKey: `${key}:${n.id}`, createdBy: actor, ttlSeconds: 600 });
      out.push({ nodeId: n.id, nodeName: n.name, operation: r.op, replayed: !r.created });
    }
  } catch (e: any) {
    if (e.code === 'IDEMPOTENCY_CONFLICT') return { code: 422, body: { error: 'idempotency_conflict', message: e.message } };
    throw e;
  }
  const untils = (rules as any[]).map(r => /\[until=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z\]/.exec(String(r?.comment || ''))?.[1]).filter(Boolean).map(x => Date.parse(x + ':00Z')).filter(x => Number.isFinite(x));
  await store.mutate(d => { const m = (d.settings.hbaExpiry ||= {}); if (untils.length) m[c.id] = untils; else delete m[c.id]; });
  return { code: 202, body: { mode: patroni ? 'patroni' : 'per-node', operations: out } };
}
