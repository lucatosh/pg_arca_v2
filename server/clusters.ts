/**
 * Cluster inventory API (real, persisted). Replaces the former in-memory mock CRUD.
 *  - Fresh install: exactly ONE demo cluster (isSandbox) which can be deleted and (once) restored.
 *  - Attach with agent:    create an enrollment token (agents.ts) -> install agent -> cluster appears by itself.
 *  - Attach without agent: POST /api/clusters/attach-direct (direct.ts).
 */
import type { Request, Response } from 'express';
import { Store, nowIso } from './store';
import { audit } from './ops';
import { DirectDriver, validateConnInput } from './direct';

export const DEMO_ID = 'cluster-demo';

export function seedDemoOnFirstRun(store: Store, buildDemo: () => any) {
  return store.mutate(d => {
    if (d.settings.initialized) return;
    d.settings.initialized = true;
    d.clusters.push(buildDemo());
  });
}

/** Strip secrets / internals before sending a cluster to the browser. */
export function publicCluster(c: any, st: { nodes: Record<string, any>; directConnections: Record<string, any> }) {
  const { __prevXact, ...rest } = c;
  const dc = st.directConnections[c.id];
  return {
    ...rest,
    connection: dc ? { host: dc.host, port: dc.port, database: dc.database, user: dc.user, sslmode: dc.sslmode, patroniUrl: dc.patroniUrl, lastOk: dc.lastOk, lastError: dc.lastError } : undefined,
    agentNodes: Object.values(st.nodes).filter((n: any) => n.clusterId === c.id).map((n: any) => ({ id: n.id, name: n.name, lastSeen: n.lastSeen, agentVersion: n.agentVersion })),
    capabilities: c.isSandbox ? { demo: true } : capabilitiesOf(c, st),
  };
}

function capabilitiesOf(c: any, st: any) {
  const hasAgent = Object.values(st.nodes).some((n: any) => n.clusterId === c.id);
  return {
    live_state: true,
    host_metrics: hasAgent,
    backup_restore_pitr: hasAgent,
    patroni_ops: !!c.haState?.managedByPatroni,
    set_parameters: hasAgent || !!c.privileges?.superuser,
    mode: c.source,
  };
}

export function mountClusterRoutes(app: any, store: Store, direct: DirectDriver, buildDemo: () => any) {
  const actor = (req: Request) => (req as any).actor || 'admin';

  app.get('/api/clusters', (req: Request, res: Response) => {
    const st = store.peek();
    const env = typeof req.query.env === 'string' ? req.query.env : undefined;
    const list = st.clusters.filter((c: any) => !env || c.environment === env).map((c: any) => publicCluster(c, st));
    res.json({ clusters: list, demoAvailable: st.demoDeleted && !st.clusters.some((c: any) => c.isSandbox) });
  });

  app.get('/api/clusters/:id', (req: Request, res: Response) => {
    const st = store.peek();
    const c = st.clusters.find((x: any) => x.id === req.params.id);
    c ? res.json({ cluster: publicCluster(c, st) }) : res.status(404).json({ error: 'cluster_not_found' });
  });

  app.post('/api/clusters/test-connection', async (req: Request, res: Response) => {
    const bad = validateConnInput(req.body);
    if (bad) return res.status(400).json({ error: 'invalid_input', message: bad });
    try { res.json({ ok: true, ...(await direct.test(req.body)) }); }
    catch (e: any) { res.status(200).json({ ok: false, error: e.code === 'INVALID' ? 'invalid_input' : 'connection_failed', message: String(e.message).slice(0, 400) }); }
  });

  app.post('/api/clusters/attach-direct', async (req: Request, res: Response) => {
    const { name, environment = 'prod' } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 80) return res.status(400).json({ error: 'name_required' });
    if (!['prod', 'prep', 'int', 'dev', 'test'].includes(environment)) return res.status(400).json({ error: 'invalid_environment' });
    const bad = validateConnInput(req.body);
    if (bad) return res.status(400).json({ error: 'invalid_input', message: bad });
    try {
      const r = await direct.attach({ ...req.body, name: name.trim(), environment }, actor(req));
      direct.poll(r.cluster.id).catch(() => undefined);
      res.status(r.created ? 201 : 200).json({ created: r.created, cluster: publicCluster(r.cluster, store.peek()), capabilities: r.test.capabilities });
    } catch (e: any) {
      res.status(422).json({ error: 'connection_failed', message: String(e.message).slice(0, 400) });
    }
  });

  app.patch('/api/clusters/:id', async (req: Request, res: Response) => {
    const { name, environment } = req.body || {};
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80)) return res.status(400).json({ error: 'invalid_name' });
    if (environment !== undefined && !['prod', 'prep', 'int', 'dev', 'test'].includes(environment)) return res.status(400).json({ error: 'invalid_environment' });
    const ok = await store.mutate(d => {
      const c = d.clusters.find((x: any) => x.id === req.params.id);
      if (!c) return false;
      if (name) c.name = name.trim();
      if (environment) c.environment = environment;
      audit(d, { clusterId: c.id, actor: actor(req), action: 'cluster.update', status: 'OK', details: { name, environment } });
      return true;
    });
    ok ? res.json({ ok: true }) : res.status(404).json({ error: 'cluster_not_found' });
  });

  // Detach: idempotent (second call => 200 with already:true), atomic across cluster + nodes + secrets + queued ops.
  app.delete('/api/clusters/:id', async (req: Request, res: Response) => {
    const out = await store.mutate(d => {
      const c = d.clusters.find((x: any) => x.id === req.params.id);
      if (!c) return null;
      d.clusters = d.clusters.filter((x: any) => x.id !== c.id);
      delete d.directConnections[c.id];
      const revoked: string[] = [];
      for (const [id, n] of Object.entries(d.nodes)) if ((n as any).clusterId === c.id) { revoked.push((n as any).name); delete d.nodes[id]; }
      for (const o of d.operations) if (o.clusterId === c.id && !['succeeded', 'failed', 'expired', 'cancelled'].includes(o.status)) {
        o.status = 'cancelled'; o.updatedAt = nowIso(); o.history.push({ at: o.updatedAt, status: 'cancelled', note: 'cluster detached' });
      }
      if (c.isSandbox) d.demoDeleted = true;
      audit(d, { clusterId: c.id, actor: actor(req), action: 'cluster.detach', status: 'OK', details: { name: c.name, revokedNodes: revoked } });
      return { name: c.name, revoked };
    });
    if (!out) return res.status(200).json({ ok: true, already: true });
    res.json({ ok: true, removed: out.name, revokedNodes: out.revoked });
  });

  app.post('/api/clusters/demo', async (_req: Request, res: Response) => {
    const r = await store.mutate(d => {
      if (d.clusters.some((c: any) => c.isSandbox)) return 'exists' as const;
      d.clusters.push(buildDemo()); d.demoDeleted = false; return 'created' as const;
    });
    res.status(r === 'created' ? 201 : 200).json({ ok: true, result: r });
  });
}
