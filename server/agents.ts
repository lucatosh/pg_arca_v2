/**
 * Agent gateway + operator API for tokens, nodes and operations.
 *
 * Transport model (works through NAT/firewalls; no inbound port on DB hosts):
 *   agent --HTTPS POST--> /api/agent/heartbeat   (telemetry up, runnable operations down)
 *   agent --HTTPS POST--> /api/agent/ops/:id/report
 * Identity: one-time enrollment token -> per-node secret (only its sha256 is stored).
 */
import { validatePolicy, DEFAULT_POLICY, resolvePolicy } from './policies';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { Store, NodeRecord, sha256, newSecret, newId, nowIso } from './store';
import * as ops from './ops';
import { OP_SPECS, validateOp } from './optypes';
import { requiresApproval, requestApproval } from './approvals';
import { hbaFanout } from './hba';
import { deriveCluster, computeTps, sanitizeSnapshot } from './view';

export interface Deps {
  /** executes an operation server-side for clusters attached without an agent */
  directExec?: (cluster: any, type: string, params: any) => Promise<any>;
}

const safeEq = (a: any, b: any) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const REENROLL_WINDOW_MS = 10 * 60 * 1000;

export function authNode(store: Store, req: Request): NodeRecord | null {
  const id = String(req.headers['x-arca-node'] || '');
  const auth = String(req.headers['authorization'] || '');
  if (!id || !auth.startsWith('Bearer ')) return null;
  const nodes = store.peek().nodes; const node = Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : undefined;   // 'x-arca-node: __proto__' must not resolve
  if (!node) { sha256(auth); return null; }            // constant-ish work for unknown ids
  return safeEq(sha256(auth.slice(7).trim()), node.tokenHash) ? node : null;
}

/** 401 for agent calls. 'node_unknown' (the node id is not registered: deleted in the console) tells the agent to announce itself again right away;
 *  'unauthorized' (known node, wrong secret) is retried a few times before the agent gives up its credentials. */
function deny(store: Store, req: Request, res: Response) {
  const id = String(req.headers['x-arca-node'] || '');
  const known = Object.prototype.hasOwnProperty.call(store.peek().nodes, id);
  return res.status(401).json({ error: id && !known ? 'node_unknown' : 'unauthorized' });
}

/** Recompute the persisted cluster view from the nodes that belong to it (called inside a mutate). */
export function refreshCluster(draft: any, clusterId: string) {
  const idx = draft.clusters.findIndex((c: any) => c.id === clusterId);
  if (idx < 0) return;
  const prior = draft.clusters[idx];
  const nodes = Object.values(draft.nodes as Record<string, NodeRecord>).filter(n => n.clusterId === clusterId);
  const view = deriveCluster({ id: clusterId, name: prior.name, environment: prior.environment, nodes, prior });
  draft.clusters[idx] = { ...view, clusterKey: prior.clusterKey };
}

const KEY_RE = /^(patroni|sysid):[A-Za-z0-9_.:\/-]{1,120}$/;

/**
 * A node that was approved before PostgreSQL was visible has no cluster identity yet. Once its heartbeat carries one (patroni scope or system
 * identifier) the cluster adopts it, and clusters that turn out to be the same database are merged: nodes, operations, direct connection and policy
 * assignment move to the keeper (the one with more history, else the older). Runs inside a mutate. Never touches sandbox clusters.
 */
export function reconcileCluster(d: any, nodeId: string) {
  const n = d.nodes[nodeId]; const key = n?.snapshot?.cluster_key;
  if (!n?.clusterId || typeof key !== 'string' || !KEY_RE.test(key)) return;
  const mine = d.clusters.find((c: any) => c.id === n.clusterId);
  if (!mine || mine.isSandbox) return;
  n.clusterKey = key;
  if (!mine.clusterKey) mine.clusterKey = key;
  if (mine.clusterKey !== key) return;                // an unrelated database now answers on this node: leave it to the operator
  const dups = d.clusters.filter((c: any) => c.id !== mine.id && !c.isSandbox && c.clusterKey === key);
  if (!dups.length) return;
  const hist = (c: any) => d.operations.filter((o: any) => o.clusterId === c.id).length;
  const all = [mine, ...dups].sort((a: any, b: any) => hist(b) - hist(a) || Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
  const keep = all[0];
  for (const lose of all.slice(1)) {
    for (const x of Object.values(d.nodes as Record<string, NodeRecord>)) if (x.clusterId === lose.id) { x.clusterId = keep.id; x.clusterKey = key; }
    for (const o of d.operations) if (o.clusterId === lose.id) o.clusterId = keep.id;
    for (const a of d.audit) if (a.clusterId === lose.id) a.clusterId = keep.id;
    if (d.directConnections?.[lose.id]) { if (!d.directConnections[keep.id]) d.directConnections[keep.id] = { ...d.directConnections[lose.id], clusterId: keep.id }; delete d.directConnections[lose.id]; }
    const pa = d.settings.policyAssignments; if (pa && pa['cluster:' + lose.id]) { if (!pa['cluster:' + keep.id]) pa['cluster:' + keep.id] = pa['cluster:' + lose.id]; delete pa['cluster:' + lose.id]; }
    d.clusters = d.clusters.filter((c: any) => c.id !== lose.id);
    ops.audit(d, { clusterId: keep.id, actor: 'system', action: 'cluster.merge', status: 'OK', details: { merged: lose.id, key } });
  }
  refreshCluster(d, keep.id);
}

export interface AgentHooks {
  onLogs?: (node: NodeRecord, clusterName: string, logs: any[]) => void;
}

export function mountAgentRoutes(app: any, store: Store, hooks: AgentHooks = {}) {
  // ---- enrollment ---------------------------------------------------------
  app.post('/api/agent/enroll', async (req: Request, res: Response) => {
    const b = req.body || {};
    const tokenRaw = String(b.enrollment_token || '');
    const nodeName = String(b.node_name || '').trim();
    if (!tokenRaw || !/^[A-Za-z0-9_.-]{1,63}$/.test(nodeName)) return res.status(400).json({ error: 'invalid_request' });
    const secret = newSecret();
    const result = await store.mutate(d => {
      const t = d.enrollmentTokens.find(x => safeEq(x.hash, sha256(tokenRaw)));
      if (!t) return { err: 'invalid_token' as const };
      if (Date.parse(t.expiresAt) < Date.now()) return { err: 'token_expired' as const };
      const reuse = t.usedAt && t.usedByNode === nodeName && Date.now() - Date.parse(t.usedAt) < REENROLL_WINDOW_MS;
      if (t.usedAt && !reuse) return { err: 'token_already_used' as const };

      const disc = b.discovery || {};
      const inst = (disc.postgres_instances || [])[0] || {};
      const clusterKey: string | undefined = inst.cluster_key;
      let cluster = t.clusterId ? d.clusters.find((c: any) => c.id === t.clusterId) : undefined;
      if (t.clusterId && !cluster) return { err: 'cluster_not_found' as const };
      if (!cluster && clusterKey) cluster = d.clusters.find((c: any) => c.clusterKey === clusterKey);
      if (!cluster) {
        cluster = {
          id: newId('cl'), name: inst.patroni?.scope || (disc.patroni_clusters || [])[0]?.scope || `pg-${nodeName}`,
          environment: t.environment || 'prod', clusterKey, source: 'agent', isSandbox: false,
          status: 'degraded', databases: [], hbaRules: [], features: {}, createdAt: nowIso(),
        };
        d.clusters.push(cluster);
      }
      const existing = Object.values(d.nodes).find(n => n.name === nodeName && n.clusterId === cluster!.id);
      const id = existing?.id || newId('node');
      d.nodes[id] = {
        ...(existing || {}), id, name: nodeName, tokenHash: sha256(secret), enrolledAt: existing?.enrolledAt || nowIso(),
        clusterId: cluster.id, clusterKey, agentVersion: String(b.agent_version || ''), remoteIp: req.socket.remoteAddress || '',
        discovery: disc, lastSeen: nowIso(),
      };
      t.usedAt = t.usedAt || nowIso(); t.usedByNode = nodeName;
      ops.audit(d, { clusterId: cluster.id, actor: `agent:${nodeName}`, action: 'agent.enroll', status: 'OK', details: { nodeId: id } });
      refreshCluster(d, cluster.id);
      return { ok: true as const, nodeId: id, clusterId: cluster.id };
    });
    if ('err' in result) return res.status(result.err === 'invalid_token' ? 401 : 403).json({ error: result.err });
    res.status(201).json({ node_id: result.nodeId, cluster_id: result.clusterId, agent_token: secret, heartbeat_interval: 10 });
  });

  // ---- heartbeat: telemetry up, operations down -----------------------------
  app.post('/api/agent/heartbeat', async (req: Request, res: Response) => {
    const node = authNode(store, req);
    if (!node) return deny(store, req, res);
    const b = req.body || {};
    const snap = sanitizeSnapshot(b.snapshot);
    if (snap && JSON.stringify(snap).length > 1_500_000) return res.status(413).json({ error: 'snapshot_too_large' });
    await store.mutate(d => {
      const n = d.nodes[node.id];
      if (!n) return;
      const nowMs = Date.now();
      n.lastSeen = new Date(nowMs).toISOString();
      n.remoteIp = req.socket.remoteAddress || n.remoteIp;
      if (b.agent_version) n.agentVersion = String(b.agent_version);
      if (snap) {
        n.snapshot = snap;
        const total = Number(snap.postgres?.xact_total);
        if (Number.isFinite(total)) {
          const tps = computeTps(n.prevXact, total, nowMs);
          if (tps !== undefined) n.tps = tps;
          n.prevXact = { total, at: nowMs };
        }
      }
      if (b.discovery) n.discovery = b.discovery;
      reconcileCluster(d, node.id);
      if (n.clusterId) refreshCluster(d, n.clusterId);
    });
    const max = Math.max(0, Math.min(Number(b.max_ops ?? 1) || 1, 5));
    // Long-poll: hold the request (<= wait_seconds) until an operation is runnable for this node, so operator
    // actions reach NAT'ed agents in ~a second without any inbound port.
    const waitMs = Math.max(0, Math.min(Number(b.wait_seconds ?? 0) || 0, 20)) * 1000;
    const deadline = Date.now() + waitMs;
    let todo = max ? await ops.lease(store, node.id, max) : [];
    while (max && todo.length === 0 && Date.now() < deadline && store.peek().nodes[node.id]) {
      await new Promise(r => setTimeout(r, 250));
      if (store.peek().operations.some(o => o.nodeId === node.id && o.status === 'queued')) todo = await ops.lease(store, node.id, max);
    }
    res.json({ ok: true, server_time: nowIso(), heartbeat_interval: 10, ops: todo.map(o => ({ id: o.id, type: o.type, params: o.params, attempt: o.attempts, cluster_id: o.clusterId })) });
  });

  // ---- log ingest (authenticated, size-bounded) -----------------------------
  app.post('/api/agent/logs', (req: Request, res: Response) => {
    const node = authNode(store, req);
    if (!node) return deny(store, req, res);
    const logs = Array.isArray(req.body?.logs) ? req.body.logs.slice(0, 500) : null;
    if (!logs) return res.status(400).json({ error: 'logs_array_required' });
    const cl = store.peek().clusters.find((c: any) => c.id === node.clusterId);
    hooks.onLogs?.(node, cl?.name || '', logs);
    res.json({ ok: true, ingested: logs.length });
  });

  app.post('/api/agent/ops/:id/report', async (req: Request, res: Response) => {
    const node = authNode(store, req);
    if (!node) return deny(store, req, res);
    const { status, result, error, progress } = req.body || {};
    if (!['running', 'succeeded', 'failed'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const r = await ops.report(store, node.id, req.params.id, status, result, error ? String(error).slice(0, 4000) : undefined, 120,
      status === 'running' && progress && typeof progress === 'object' ? JSON.parse(JSON.stringify(progress).slice(0, 4000)) : undefined);
    if (r.ok && status === 'succeeded' && r.op?.type === 'discovery_scan' && result && typeof result === 'object') {
      await store.mutate(d => { if (d.nodes[node.id]) { d.nodes[node.id].discovery = result; refreshCluster(d, d.nodes[node.id].clusterId || ''); } });
    }
    res.status(r.ok ? 200 : 409).json({ ok: r.ok, reason: r.reason, status: r.op?.status, cancel: !!r.cancel });
  });
}

// =============================================================================
// Operator API: enrollment tokens, nodes, operations
// =============================================================================
export function mountOperatorRoutes(app: any, store: Store, deps: Deps = {}) {
  const actorOf = (req: Request) => (req as any).actor || 'admin';

  app.post('/api/enrollment-tokens', async (req: Request, res: Response) => {
    const { label = '', ttlMinutes = 60, clusterId, environment } = req.body || {};
    const ttl = Math.min(Math.max(Number(ttlMinutes) || 60, 1), 7 * 24 * 60);
    if (environment && !['prod', 'prep', 'int', 'dev', 'test'].includes(environment)) return res.status(400).json({ error: 'invalid_environment' });
    if (clusterId && !store.peek().clusters.some((c: any) => c.id === clusterId)) return res.status(404).json({ error: 'cluster_not_found' });
    const token = 'arca_enr_' + newSecret(24);
    const rec = { id: newId('tok'), hash: sha256(token), label: String(label).slice(0, 80), createdAt: nowIso(),
                  expiresAt: new Date(Date.now() + ttl * 60000).toISOString(), clusterId, environment };
    await store.mutate(d => { d.enrollmentTokens.push(rec); ops.audit(d, { actor: actorOf(req), action: 'token.create', status: 'OK', details: { id: rec.id, label: rec.label } }); });
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    res.status(201).json({
      id: rec.id, token, expiresAt: rec.expiresAt,
      installCommand: `curl -fsSL ${base}/agent/install.sh | sudo PG_ARCA_URL=${base} PG_ARCA_ENROLL_TOKEN=${token} bash`,
      note: 'The token is shown once and can enroll exactly one node.',
    });
  });

  app.get('/api/enrollment-tokens', (_req: Request, res: Response) => {
    res.json({ tokens: store.peek().enrollmentTokens.map(({ hash, ...t }) => ({ ...t, active: !t.usedAt && Date.parse(t.expiresAt) > Date.now() })) });
  });

  app.delete('/api/enrollment-tokens/:id', async (req: Request, res: Response) => {
    const n = await store.mutate(d => { const b = d.enrollmentTokens.length; d.enrollmentTokens = d.enrollmentTokens.filter(t => t.id !== req.params.id); return b - d.enrollmentTokens.length; });
    res.status(n ? 200 : 404).json({ ok: !!n });
  });

  app.get('/api/nodes', (_req: Request, res: Response) => {
    const now = Date.now();
    res.json({ nodes: Object.values(store.peek().nodes).map(n => ({
      id: n.id, name: n.name, clusterId: n.clusterId, agentVersion: n.agentVersion, lastSeen: n.lastSeen, remoteIp: n.remoteIp,
      online: !!n.lastSeen && now - Date.parse(n.lastSeen) < 45000, tps: n.tps,
      role: n.snapshot?.postgres?.role, pgVersion: n.snapshot?.postgres?.version,
    })) });
  });

  app.delete('/api/nodes/:id', async (req: Request, res: Response) => {      // revoke: secret becomes invalid immediately
    const out = await store.mutate(d => {
      const n = d.nodes[req.params.id];
      if (!n) return null;
      delete d.nodes[req.params.id];
      ops.audit(d, { clusterId: n.clusterId, actor: actorOf(req), action: 'node.revoke', status: 'OK', details: { name: n.name } });
      for (const o of d.operations) if (o.nodeId === n.id && (o.status === 'queued')) { o.status = 'cancelled'; o.history.push({ at: nowIso(), status: 'cancelled', note: 'node revoked' }); }
      if (n.clusterId) refreshCluster(d, n.clusterId);
      return n.name;
    });
    res.status(out ? 200 : 404).json({ ok: !!out });
  });

  // ---- operations -----------------------------------------------------------
  app.post('/api/clusters/:id/operations', async (req: Request, res: Response) => {
    const st = store.peek();
    const cluster = st.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) return res.status(404).json({ error: 'cluster_not_found' });
    if (cluster.isSandbox) return res.status(409).json({ error: 'demo_cluster', message: 'This is the demo cluster: operations are not executed. Attach a real cluster.' });
    const { type, params = {}, nodeId, ttlSeconds } = req.body || {};
    const key = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required', message: 'Send an Idempotency-Key header (any unique string per user action).' });
    const bad = validateOp(String(type), params);
    if (bad) return res.status(400).json({ error: 'invalid_operation', message: bad });
    if (type === 'agent_config_set' && (req as any).role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Solo un amministratore può cambiare percorsi e impostazioni dell’agent.' });
    const spec = OP_SPECS[type];
    if (requiresApproval(st, cluster, type, params)) {
      const reqRec = await requestApproval(store, ops.audit, { cluster, type, params, nodeId, ttlSeconds, key, actor: actorOf(req) });
      return res.status(202).json({ approval: reqRec, message: 'Operazione rischiosa su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    const r = await execute(cluster, type, params, nodeId, ttlSeconds, key, actorOf(req));
    res.status(r.code).json(r.body);
  });

  async function execute(cluster: any, type: string, params: any, nodeId: string | undefined, ttlSeconds: number | undefined, key: string, actor: string): Promise<{ code: number; body: any }> {
    ttlSeconds = ttlSeconds === undefined || ttlSeconds === null ? undefined : (Number.isFinite(Number(ttlSeconds)) ? Math.min(86400, Math.max(30, Math.floor(Number(ttlSeconds)))) : 600);   // NaN would mean 'never expires'
    const spec = OP_SPECS[type];
    const st = store.peek();
    try {
      if (cluster.source === 'direct') {
        if (spec.lane === 'data') return { code: 409, body: { error: 'agent_required', message: 'Backup, restore and PITR run on the database host: install the agent on a node of this cluster (agentless attach cannot read the data directory).' } };
        if (!deps.directExec) return { code: 501, body: { error: 'direct_not_available' } };
        const { op, created } = await ops.runLocal(store, { type, clusterId: cluster.id, params, idempotencyKey: key, createdBy: actor }, () => deps.directExec!(cluster, type, params));
        return { code: created ? 202 : 200, body: { operation: op, replayed: !created } };
      }
      // agent-backed: choose the executing node
      const nodes = Object.values(st.nodes).filter(n => n.clusterId === cluster.id);
      const online = (n: NodeRecord) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000;
      let target: NodeRecord | undefined = nodeId ? nodes.find(n => n.id === nodeId) : undefined;
      if (nodeId && !target) return { code: 404, body: { error: 'node_not_found' } };
      if (!target) {
        const pick = (pred: (n: NodeRecord) => boolean) => nodes.find(n => online(n) && pred(n));
        if (spec.target === 'primary') target = pick(n => n.snapshot?.postgres?.is_in_recovery === false);
        else if (spec.target === 'patroni_node') target = pick(n => !!n.snapshot?.patroni?.accessible);
        else {
          // any_node: prefer a node whose PostgreSQL is really up (a replica still being cloned or a stopped instance cannot back up or plan a restore),
          // the primary first so that a backup chain keeps coming from one place
          const alive = (n: NodeRecord) => n.snapshot?.postgres?.alive === true;
          target = pick(n => alive(n) && n.snapshot?.postgres?.is_in_recovery === false) || pick(alive) || (spec.lane === 'data' ? undefined : pick(() => true));
          if (!target && spec.lane === 'data') return { code: 409, body: { error: 'no_suitable_node', message: 'Nessun nodo con agent ha PostgreSQL attivo in questo momento: backup e ripristini non possono partire. Controlla lo stato dei nodi (Nodi → Percorsi e rilevamento).' } };
        }
      }
      if (!target) return { code: 409, body: { error: 'no_suitable_node', message: 'No online node can execute this operation right now.' } };
      if (!online(target)) return { code: 409, body: { error: 'node_offline', message: `Node ${target.name} is offline.` } };
      if (spec.needsPatroni && !target.snapshot?.patroni?.accessible) return { code: 409, body: { error: 'patroni_unavailable', message: 'Patroni REST API is not reachable from this node.' } };
      const { op, created } = await ops.submit(store, { type, clusterId: cluster.id, nodeId: target.id, params, idempotencyKey: key, createdBy: actor, ttlSeconds });
      return { code: created ? 202 : 200, body: { operation: op, replayed: !created } };
    } catch (e: any) {
      if (e.code === 'IDEMPOTENCY_CONFLICT') return { code: 422, body: { error: 'idempotency_conflict', message: e.message } };
      throw e;
    }
  }

  // ---- four-eyes approvals --------------------------------------------------
  const pendingView = () => {
    const now = Date.now(); const list = (store.peek().settings.approvalRequests || []) as any[];
    return list.map(r => (r.status === 'pending' && Date.parse(r.expiresAt) < now ? { ...r, status: 'expired' } : r)).slice(-50).reverse();
  };
  app.get('/api/approvals', (_req: Request, res: Response) => res.json({ approvals: pendingView() }));
  const decide = async (req: Request, res: Response, how: 'approve' | 'reject' | 'cancel') => {
    const actor = actorOf(req); const id = req.params.id;
    const rec = (store.peek().settings.approvalRequests || []).find((r: any) => r.id === id);
    if (!rec) return res.status(404).json({ error: 'not_found' });
    if (rec.status !== 'pending') return res.status(409).json({ error: 'not_pending', message: 'La richiesta è già stata gestita.' });
    if (Date.parse(rec.expiresAt) < Date.now()) { await store.mutate(d => { const r = d.settings.approvalRequests.find((x: any) => x.id === id); if (r) r.status = 'expired'; }); return res.status(409).json({ error: 'expired', message: 'La richiesta è scaduta: va rifatta.' }); }
    if (how === 'cancel' && rec.requestedBy !== actor && (req as any).role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Solo chi ha chiesto l’operazione (o un amministratore) può annullarla.' });
    if (how === 'approve' && rec.requestedBy === actor) return res.status(403).json({ error: 'self_approval', message: 'Non puoi approvare una tua richiesta: serve un altro amministratore.' });
    const done = (status: string) => store.mutate(d => { const r = d.settings.approvalRequests.find((x: any) => x.id === id); r.status = status; r.decidedBy = actor; r.decidedAt = nowIso();
      ops.audit(d, { clusterId: rec.clusterId, actor, action: 'approval.' + how, status: 'OK', details: { id, type: rec.type, requestedBy: rec.requestedBy } }); });
    if (how !== 'approve') { await done(how === 'reject' ? 'rejected' : 'cancelled'); return res.json({ ok: true }); }
    const cluster = store.peek().clusters.find((c: any) => c.id === rec.clusterId);
    if (!cluster) return res.status(404).json({ error: 'cluster_not_found' });
    const r = rec.type === 'hba_cluster_apply' ? await hbaFanout(store, cluster, rec.params, 'appr:' + id, rec.requestedBy) : await execute(cluster, rec.type, rec.params, rec.nodeId, rec.ttlSeconds, 'appr:' + id, rec.requestedBy);
    if (r.code >= 400) return res.status(r.code).json(r.body);                    // not consumed: the approver can retry when the node is back
    await done('approved');
    res.json({ ok: true, operation: r.body.operation, operations: r.body.operations });
  };
  app.post('/api/approvals/:id/approve', (req: Request, res: Response) => decide(req, res, 'approve'));
  app.post('/api/approvals/:id/reject', (req: Request, res: Response) => decide(req, res, 'reject'));
  app.post('/api/approvals/:id/cancel', (req: Request, res: Response) => decide(req, res, 'cancel'));

  // ---- backups (read model from agent telemetry; no round-trip needed) and policy ----------------------------
  app.get('/api/clusters/:id/backups', (req: Request, res: Response) => {
    const st = store.peek();
    const cluster = st.clusters.find((c: any) => c.id === req.params.id);
    if (!cluster) return res.status(404).json({ error: 'cluster_not_found' });
    const nodes = Object.values(st.nodes).filter(n => n.clusterId === cluster.id);
    const withBackup = nodes.filter(n => n.snapshot?.backup?.configured).sort((a, b) => (b.snapshot.backup.sets || 0) - (a.snapshot.backup.sets || 0));
    const primary = nodes.find(n => n.snapshot?.postgres?.is_in_recovery === false);
    const src = withBackup[0] || primary || nodes[0];
    const running = st.operations.filter(o => o.clusterId === cluster.id && ['backup_run', 'backup_verify', 'backup_expire', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote', 'restore_drill'].includes(o.type) && !isTerminalStatus(o.status));
    res.json({
      agent: nodes.length > 0, node: src ? { id: src.id, name: src.name, lastSeen: src.lastSeen } : null,
      backup: src?.snapshot?.backup || null, wal: src?.snapshot?.wal || null,
      archiver: src?.snapshot?.postgres?.archiver || null, archiveMode: src?.snapshot?.postgres?.settings?.archive_mode || null,
      policy: resolvePolicy(st, cluster).policy || { ...DEFAULT_POLICY }, policySource: resolvePolicy(st, cluster).source, running,
    });
  });

  app.put('/api/clusters/:id/backup-policy', async (req: Request, res: Response) => {
    const v = validatePolicy(req.body);
    if (!v.ok) return res.status(400).json({ error: 'invalid_policy', message: v.error });
    const ok = await store.mutate(d => {
      const c = d.clusters.find((x: any) => x.id === req.params.id);
      if (!c) return false;
      if (c.isSandbox || c.source === 'direct') throw Object.assign(new Error('agent_required'), { code: 'AGENT_REQUIRED' });
      (d.settings.policyAssignments ||= {})['cluster:' + c.id] = { policy: v.policy }; delete c.backupPolicy;
      ops.audit(d, { clusterId: c.id, actor: actorOf(req), action: 'backup.policy', status: 'OK', details: v.policy });
      return true;
    }).catch((e: any) => (e.code === 'AGENT_REQUIRED' ? 'agent' : Promise.reject(e)));
    if (ok === 'agent') return res.status(409).json({ error: 'agent_required', message: 'Scheduled backups need an agent on the cluster.' });
    ok ? res.json({ ok: true, policy: v.policy }) : res.status(404).json({ error: 'cluster_not_found' });
  });

  app.get('/api/operations', (req: Request, res: Response) => {
    const { clusterId, status } = req.query as any;
    let list = store.peek().operations;
    if (clusterId) list = list.filter(o => o.clusterId === clusterId);
    if (status) list = list.filter(o => o.status === status);
    res.json({ operations: list.slice(-200).reverse() });
  });

  app.get('/api/operations/:id', (req: Request, res: Response) => {
    const op = store.peek().operations.find(o => o.id === req.params.id);
    op ? res.json({ operation: op }) : res.status(404).json({ error: 'not_found' });
  });

  app.post('/api/operations/:id/cancel', async (req: Request, res: Response) => {
    const r = await ops.cancel(store, req.params.id, actorOf(req));
    res.status(r.ok ? 200 : (r.reason === 'unknown operation' ? 404 : 409)).json(r);
  });
}

function isTerminalStatus(s: string) { return ['succeeded', 'failed', 'expired', 'cancelled'].includes(s); }
