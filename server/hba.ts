/** pg_hba management API: rule templates (customisable, with variables) and propagation of one rule set to every node of a cluster. */
import type { Request, Response } from 'express';
import { Store } from './store';
import * as ops from './ops';
import { requiresApproval, requestApproval } from './approvals';

export interface HbaTemplate {
  id: string; name: string; description: string; envs: string[];
  vars: { key: string; label: string; def: string; hint?: string }[];
  rules: { type: string; database: string; user: string; address: string; method: string; options?: string; comment: string }[];
}
export const HBA_TEMPLATES: HbaTemplate[] = [
  { id: 'replication', name: 'Replica in streaming', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Consente ai nodi standby di replicare, solo via TLS e con password SCRAM, solo dalla rete dei nodi.',
    vars: [{ key: 'replUser', label: 'Utente di replica', def: 'replicator' }, { key: 'replNet', label: 'Rete dei nodi (CIDR)', def: '10.0.2.0/24', hint: 'Meglio stretta: un /32 per nodo o la sola subnet dei database.' }],
    rules: [{ type: 'hostssl', database: 'replication', user: '{{replUser}}', address: '{{replNet}}', method: 'scram-sha-256', comment: 'Replica streaming (Patroni / standby fisici)' }] },
  { id: 'app', name: 'Applicazioni (rete applicativa)', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Accesso degli utenti applicativi ai loro database, solo TLS + SCRAM, solo dalla rete applicativa.',
    vars: [{ key: 'appUser', label: 'Utente applicativo (o +ruolo)', def: 'app' }, { key: 'appDb', label: 'Database', def: 'all' }, { key: 'appNet', label: 'Rete applicativa (CIDR)', def: '10.0.20.0/24' }],
    rules: [{ type: 'hostssl', database: '{{appDb}}', user: '{{appUser}}', address: '{{appNet}}', method: 'scram-sha-256', comment: 'Applicazioni' }] },
  { id: 'dba', name: 'Amministratori (DBA)', envs: ['prod', 'prep', 'int'], description: 'I membri di un ruolo DBA entrano da una rete di gestione (VPN / bastion), mai da Internet.',
    vars: [{ key: 'dbaRole', label: 'Ruolo DBA', def: 'dba' }, { key: 'dbaNet', label: 'Rete di gestione (CIDR)', def: '10.0.10.0/24' }],
    rules: [{ type: 'hostssl', database: 'all', user: '+{{dbaRole}}', address: '{{dbaNet}}', method: 'scram-sha-256', comment: 'Amministratori dalla rete di gestione' }] },
  { id: 'monitoring', name: 'Monitoraggio', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Un utente di sola lettura (pg_monitor) per gli strumenti di monitoraggio.',
    vars: [{ key: 'monUser', label: 'Utente di monitoraggio', def: 'monitor' }, { key: 'monNet', label: 'Rete del monitoraggio (CIDR)', def: '10.0.30.0/24' }],
    rules: [{ type: 'hostssl', database: 'postgres', user: '{{monUser}}', address: '{{monNet}}', method: 'scram-sha-256', comment: 'Monitoraggio' }] },
  { id: 'tls-only', name: 'Solo connessioni cifrate', envs: ['prod', 'prep'], description: 'Rifiuta ogni connessione di rete non cifrata (le regole hostssl restano valide). Richiede ssl=on sul server.',
    vars: [],
    rules: [{ type: 'hostnossl', database: 'all', user: 'all', address: '0.0.0.0/0', method: 'reject', comment: 'Niente connessioni non cifrate' }, { type: 'hostnossl', database: 'all', user: 'all', address: '::/0', method: 'reject', comment: 'Niente connessioni non cifrate (IPv6)' }] },
  { id: 'block-external', name: 'Blocca una rete', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'Respinge esplicitamente una rete (es. una subnet non fidata) prima di ogni altra regola.',
    vars: [{ key: 'blockNet', label: 'Rete da bloccare (CIDR)', def: '192.168.99.0/24' }],
    rules: [{ type: 'host', database: 'all', user: 'all', address: '{{blockNet}}', method: 'reject', comment: 'Rete bloccata' }] },
  { id: 'local-admin', name: 'Amministrazione locale', envs: ['prod', 'prep', 'int', 'dev', 'test'], description: 'L’utente postgres entra dal socket locale con peer (nessuna password in chiaro) e da loopback con SCRAM.',
    vars: [],
    rules: [{ type: 'local', database: 'all', user: 'postgres', address: '', method: 'peer', comment: 'Amministrazione locale' }, { type: 'hostssl', database: 'all', user: 'postgres', address: '127.0.0.1/32', method: 'scram-sha-256', comment: 'Loopback' }] },
];
/** Suggested starter set per environment (template ids, in the order they should appear). */
export const HBA_SUGGESTED: Record<string, string[]> = {
  prod: ['local-admin', 'replication', 'dba', 'app', 'monitoring', 'tls-only'], prep: ['local-admin', 'replication', 'dba', 'app', 'tls-only'], int: ['local-admin', 'replication', 'dba', 'app'],
  dev: ['local-admin', 'replication', 'app'], test: ['local-admin', 'replication', 'app'],
};

export function mountHbaRoutes(app: any, store: Store) {
  app.get('/api/hba/templates', (_req: Request, res: Response) => res.json({ templates: HBA_TEMPLATES, suggested: HBA_SUGGESTED }));

  // Apply one rule set to the cluster. Patroni clusters: the DCS list is edited once (every member follows). Others: every online node, each with
  // the pg_hba revision the operator saw (a node edited in the meantime is refused, not overwritten). One Idempotency-Key per operator intent.
  app.post('/api/clusters/:id/hba/apply', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (c.isSandbox) return res.status(409).json({ error: 'demo_cluster', message: 'Cluster demo: le operazioni non vengono eseguite.' });
    if (c.source === 'direct') return res.status(409).json({ error: 'agent_required', message: 'Modificare pg_hba richiede l’agent sul nodo.' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const { rules, baseRevs = {}, force = false, adopt = false } = req.body || {};
    if (!Array.isArray(rules) || rules.length > 200) return res.status(400).json({ error: 'invalid_rules' });
    const bodyOut = { rules, baseRevs, force: !!force, adopt: !!adopt };
    if (requiresApproval(st, c, 'hba_cluster_apply', {})) {
      const rec = await requestApproval(store, ops.audit, { cluster: c, type: 'hba_cluster_apply', params: bodyOut, key, actor: (req as any).actor || 'admin' });
      return res.status(202).json({ approval: rec, message: 'Operazione rischiosa su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    const r = await hbaFanout(store, c, bodyOut, key, (req as any).actor || 'admin');
    res.status(r.code).json(r.body);
  });
}

/** Submit one hba_apply per target node (or one for the whole Patroni cluster) and remember temporary-rule expiries for the scheduler. */
export async function hbaFanout(store: Store, c: any, body: any, key: string, actor: string): Promise<{ code: number; body: any }> {
  const st = store.peek(); const { rules, baseRevs = {}, force = false, adopt = false } = body;
  const online = Object.values(st.nodes).filter(n => n.clusterId === c.id && n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000);
  if (!online.length) return { code: 409, body: { error: 'no_suitable_node', message: 'Nessun nodo online.' } };
  const patroni = !!c.haState?.managedByPatroni;
  const targets = patroni ? [online.find(n => n.snapshot?.patroni?.accessible) || online[0]] : online;
  const out: any[] = [];
  try {
    for (const n of targets) {
      const r = await ops.submit(store, { type: 'hba_apply', clusterId: c.id, nodeId: n.id, params: { rules, force: !!force, adopt: !!adopt, base_rev: baseRevs[n.id] || undefined }, idempotencyKey: `${key}:${n.id}`, createdBy: actor, ttlSeconds: 600 });
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
