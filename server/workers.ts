/**
 * Operational machines ("macchine operative"): nodes with the pg_arca agent and NO database of their own — a backup server holding repositories,
 * a host for the ephemeral recovery instances, a machine for restore drills. They belong to no cluster; what they can do is reported by the agent
 * (snapshot.worker: PostgreSQL binaries per major, filesystems with free space and type, pg_arca directories, CPU and memory) and what they are FOR is
 * decided here (label, roles) and in the recovery-instance configuration (placement = central, centralNode = this machine).
 *
 * Operations on them use the pseudo cluster id `worker:<nodeId>` (one lane per machine, like a cluster) and are limited to what makes sense without a
 * database: checking it as a recovery host, installing PostgreSQL binaries, checking a backup destination, reading / changing the agent's settings.
 */
import type { Request, Response } from 'express';
import { Store, NodeRecord, nowIso } from './store';
import * as ops from './ops';
import { validateOp } from './optypes';
import { refreshCluster } from './agents';

export const WORKER_OPS = ['ephemeral_preflight', 'ephemeral_install', 'destination_check', 'discovery_scan', 'agent_config_get', 'agent_config_set'];
const ADMIN_ONLY = ['ephemeral_install', 'agent_config_set'];
export const ROLES = ['recovery', 'repository', 'drill'];
export const workerCid = (id: string) => `worker:${id}`;
const online = (n: NodeRecord) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45_000;

/** Which configuration levels use this machine as their central recovery node. */
function usedBy(st: any, id: string) {
  const out: { scope: string; key: string }[] = [];
  for (const [k, v] of Object.entries(((st.settings.scoped || {}).ephemeral || {}) as Record<string, any>)) if (v?.centralNode === id) out.push({ scope: k.split(':')[0], key: k });
  return out;
}

export function workerView(st: any, n: NodeRecord, full = false) {
  const w = n.snapshot?.worker || n.discovery?.worker || {};
  const inst = ((w.pg_installations || []) as any[]).filter(i => i && i.major);
  const base = {
    id: n.id, name: n.name, label: n.label || '', roles: n.roles || [], online: online(n), lastSeen: n.lastSeen, agentVersion: n.agentVersion, remoteIp: n.remoteIp,
    os: w.host?.os, cpus: w.host?.cpus, memTotal: w.host?.mem_total, memAvailable: w.host?.mem_available, root: !!w.host?.root, sudo: !!w.host?.sudo_nopasswd,
    pgMajors: [...new Set(inst.map(i => Number(i.major)))].sort((a, b) => b - a),
    remoteMounts: ((w.mounts || []) as any[]).filter(m => m.remote).length,
    usedBy: usedBy(st, n.id),
    reported: !!n.snapshot?.worker,
  };
  if (!full) return base;
  const recent = (st.operations as any[]).filter(o => o.nodeId === n.id).slice(-15).reverse().map(o => ({ id: o.id, type: o.type, status: o.status, updatedAt: o.updatedAt, createdBy: o.createdBy, error: o.error }));
  return { ...base, installations: inst, mounts: w.mounts || [], dirs: w.dirs || {}, host: w.host || {}, system: n.snapshot?.system || null, recent };
}

export function mountWorkerRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  const workers = (st: any) => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.kind === 'worker');

  app.get('/api/workers', (_req: Request, res: Response) => {
    const st = store.peek();
    // database nodes whose agent never found a database: probably an operational machine enrolled the old way (it created an empty cluster)
    const candidates = (Object.values(st.nodes) as NodeRecord[]).filter(n => n.kind !== 'worker' && n.lastSeen && !n.snapshot?.postgres?.alive && !(n.discovery?.postgres_instances || []).length && !n.snapshot?.postgres?.data_directory)
      .map(n => ({ id: n.id, name: n.name, clusterId: n.clusterId, clusterName: (st.clusters as any[]).find(c => c.id === n.clusterId)?.name }));
    res.json({ workers: workers(st).map(n => workerView(st, n)).sort((a, b) => a.name.localeCompare(b.name)), candidates });
  });

  app.get('/api/workers/:id', (req: Request, res: Response) => {
    const st = store.peek(); const n = st.nodes[req.params.id];
    if (!n || n.kind !== 'worker' || !Object.prototype.hasOwnProperty.call(st.nodes, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json(workerView(st, n, true));
  });

  app.patch('/api/workers/:id', async (req: Request, res: Response) => {
    const { label, roles } = req.body || {};
    if (label !== undefined && (typeof label !== 'string' || label.length > 120)) return res.status(400).json({ error: 'invalid_label' });
    if (roles !== undefined && (!Array.isArray(roles) || roles.some((r: any) => !ROLES.includes(r)))) return res.status(400).json({ error: 'invalid_roles', message: `allowed roles: ${ROLES.join(', ')}` });
    const ok = await store.mutate(d => {
      const n = Object.prototype.hasOwnProperty.call(d.nodes, req.params.id) ? d.nodes[req.params.id] : undefined;
      if (!n || n.kind !== 'worker') return false;
      if (label !== undefined) n.label = label.trim();
      if (roles !== undefined) n.roles = [...new Set(roles as string[])];
      ops.audit(d, { actor: actor(req), action: 'worker.update', status: 'OK', details: { node: n.name, label, roles } });
      return true;
    });
    res.status(ok ? 200 : 404).json({ ok });
  });

  /** A node enrolled as a database server that turned out to have no database: make it an operational machine. Its empty cluster goes away (only if nothing else lives there). */
  app.post('/api/nodes/:id/make-worker', async (req: Request, res: Response) => {
    const out = await store.mutate(d => {
      const n = Object.prototype.hasOwnProperty.call(d.nodes, req.params.id) ? d.nodes[req.params.id] : undefined;
      if (!n) return { code: 404, body: { error: 'not_found' } };
      if (n.kind === 'worker') return { code: 200, body: { ok: true } };
      if (n.snapshot?.postgres?.alive) return { code: 409, body: { error: 'has_database', message: 'PostgreSQL runs on this server: it is not a worker host.' } };
      const old = n.clusterId;
      n.kind = 'worker'; n.clusterId = undefined; n.clusterKey = undefined;
      let removed = false;
      if (old) {
        const others = (Object.values(d.nodes) as NodeRecord[]).some(x => x.clusterId === old);
        const busy = d.operations.some(o => o.clusterId === old && !ops.isTerminal(o.status));
        if (!others && !busy) { d.clusters = d.clusters.filter((c: any) => c.id !== old || c.isSandbox); removed = true; }
        else refreshCluster(d, old);
      }
      ops.audit(d, { actor: actor(req), action: 'node.make_worker', status: 'OK', details: { node: n.name, clusterRemoved: removed ? old : null } });
      return { code: 200, body: { ok: true, clusterRemoved: removed } };
    });
    res.status(out.code).json(out.body);
  });

  app.post('/api/workers/:id/operations', async (req: Request, res: Response) => {
    const st = store.peek(); const n = Object.prototype.hasOwnProperty.call(st.nodes, req.params.id) ? st.nodes[req.params.id] : undefined;
    if (!n || n.kind !== 'worker') return res.status(404).json({ error: 'not_found' });
    const { type, params = {}, ttlSeconds } = req.body || {};
    if (!WORKER_OPS.includes(String(type))) return res.status(400).json({ error: 'not_for_workers', message: `On a worker host you can run: ${WORKER_OPS.join(', ')}.` });
    if (ADMIN_ONLY.includes(type) && (req as any).role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Only an administrator can install software or change the agent settings.' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const bad = validateOp(type, params);
    if (bad) return res.status(400).json({ error: 'invalid_operation', message: bad });
    if (!online(n)) return res.status(409).json({ error: 'node_offline', message: `${n.name} is not reachable.` });
    try {
      const { op, created } = await ops.submit(store, { type, clusterId: workerCid(n.id), nodeId: n.id, params, idempotencyKey: key, createdBy: actor(req), ttlSeconds: ttlSeconds ?? 600 });
      res.status(created ? 202 : 200).json({ operation: op, replayed: !created });
    } catch (e: any) {
      if (e.code === 'IDEMPOTENCY_CONFLICT') return res.status(422).json({ error: 'idempotency_conflict', message: e.message });
      throw e;
    }
  });

  app.get('/api/workers-summary', (_req: Request, res: Response) => {      // sidebar: cheap
    const st = store.peek();
    res.json({ workers: workers(st).map(n => ({ id: n.id, name: n.name, label: n.label || '', online: online(n), roles: n.roles || [] })).sort((a, b) => a.name.localeCompare(b.name)), at: nowIso() });
  });
}
