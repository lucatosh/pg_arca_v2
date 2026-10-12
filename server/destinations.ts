/**
 * Where backups and WAL archives are written, decided per scope (global > environment > folder > cluster, field by field) instead of per machine.
 *
 * What is real today: a local directory, or a network share (NFS / SMB-CIFS) that is MOUNTED on the nodes. The agents never mount anything: before a destination is applied,
 * each node checks it (destination_check): the path must really sit on the expected kind of filesystem, be writable the way the engine writes (exclusive create, fsync,
 * atomic rename) and have room. Object storage (S3, Azure, GCS) and SFTP need a native engine backend that does not exist yet: they are listed in the UI as "Anteprima"
 * and are refused here.
 *
 * Paths may contain {cluster} {env} {id}: one global value such as /mnt/backup/pgarca/{env}/{cluster}/wal gives every cluster its own directory. (A WAL archive MUST be
 * per cluster: two clusters writing the same segment names into one directory would overwrite each other.)
 */
import type { Request, Response } from 'express';
import { Store, NodeRecord } from './store';
import * as ops from './ops';
import { audit } from './ops';
import { registerKind, resolveScoped, KindSpec } from './scoped';
import { requiresApproval, requestApproval } from './approvals';

export const DEST_TYPES = ['local', 'nfs', 'smb'] as const;
export const PREVIEW_TYPES = [
  { id: 's3', label: 'Amazon S3 / compatibile (MinIO, Ceph RGW)' }, { id: 'azure', label: 'Azure Blob Storage' }, { id: 'gcs', label: 'Google Cloud Storage' }, { id: 'sftp', label: 'SFTP' },
];
export const DEST_DEFAULTS = { type: 'local', requireMount: false };
const slug = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cluster';

const destPath = (v: any, name: string): string => {
  const s = String(v ?? '');
  if (!s.startsWith('/') || /[\u0000-\u001f]/.test(s) || s.length > 300 || s.split('/').includes('..')) throw new Error(`${name}: serve un percorso assoluto, senza «..»`);
  const bad = s.replace(/\{(cluster|env|id)\}/g, '').match(/[{}]/);
  if (bad) throw new Error(`${name}: i segnaposto ammessi sono {cluster}, {env} e {id}`);
  return s.replace(/\/+$/, '') || '/';
};

const destination: KindSpec = {
  defaults: DEST_DEFAULTS,
  validate(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'oggetto atteso' };
    const out: Record<string, any> = {};
    try {
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null || x === '') continue;
        switch (k) {
          case 'type':
            if (PREVIEW_TYPES.some(t => t.id === String(x))) throw new Error('Questo tipo di destinazione è in anteprima: il motore di backup oggi scrive su una cartella locale o su una condivisione di rete (NFS/SMB) montata sui nodi.');
            if (!(DEST_TYPES as readonly string[]).includes(String(x))) throw new Error('tipo non valido');
            out[k] = x; break;
          case 'repoPath': out[k] = destPath(x, 'repoPath'); break;
          case 'walPath': out[k] = destPath(x, 'walPath'); break;
          case 'requireMount': out[k] = !!x; break;
          case 'minFreeGb': { const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new Error('minFreeGb: numero tra 0 e 1000000'); out[k] = n; break; }
          default: throw new Error(`campo sconosciuto: ${k}`);
        }
      }
    } catch (e: any) { return { ok: false, error: e.message }; }
    if (out.repoPath && out.walPath && out.repoPath === out.walPath) return { ok: false, error: 'repository e archivio WAL devono essere cartelle diverse' };
    return { ok: true, value: out };
  },
};
registerKind('destination', destination);

export interface ResolvedDestination { type: string; repo_path?: string; wal_path?: string; require_mount: boolean; min_free_gb?: number; wal_shared_warning?: string; wal_collision?: string }
const expand = (p: string, c: any) => p.replace(/\{cluster\}/g, slug(c.name)).replace(/\{env\}/g, slug(c.environment)).replace(/\{id\}/g, slug(c.id));

/** The concrete destination of one cluster (placeholders expanded). `null` when nothing is configured for it. */
export function destinationFor(st: any, c: any): { dest: ResolvedDestination | null; resolved: ReturnType<typeof resolveScoped> } {
  const r = resolveScoped(st, 'destination', c);
  const v = r.value;
  if (!v.repoPath && !v.walPath) return { dest: null, resolved: r };
  const d: ResolvedDestination = { type: v.type || 'local', require_mount: !!v.requireMount };
  if (v.repoPath) d.repo_path = expand(v.repoPath, c);
  if (v.walPath) d.wal_path = expand(v.walPath, c);
  if (v.minFreeGb) d.min_free_gb = Number(v.minFreeGb);
  if (v.walPath && !/\{(cluster|id)\}/.test(v.walPath) && st.clusters.filter((x: any) => !x.isSandbox).length > 1) {
    d.wal_shared_warning = 'Il percorso WAL non contiene {cluster}: se lo stesso valore vale per più cluster, i loro segmenti WAL finiscono nella stessa cartella e si sovrascrivono.';
  }
  if (d.wal_path) {                                         // two clusters that RESOLVE to the same (or a nested) archive directory, even with placeholders (same name and environment, two clusters assigned the same path by hand)
    const mine = d.wal_path.replace(/\/+$/, '') + '/';
    for (const o of st.clusters) {
      if (o.id === c.id || o.isSandbox) continue;
      const ow = (resolveScoped(st, 'destination', o).value.walPath as string | undefined);
      if (!ow) continue;
      const theirs = expand(ow, o).replace(/\/+$/, '') + '/';
      if (mine === theirs || mine.startsWith(theirs) || theirs.startsWith(mine)) { d.wal_collision = `L’archivio WAL ${d.wal_path} coincide (o contiene / è contenuto) con quello del cluster «${o.name}»: i segmenti con lo stesso nome si sovrascriverebbero. Cambia il percorso (per esempio aggiungendo {id}).`; break; }
    }
  }
  return { dest: d, resolved: r };
}

const stable = (v: any): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const CHECK_MAX_AGE_MS = 30 * 60 * 1000;
const checkParams = (d: ResolvedDestination) => ({ type: d.type, ...(d.repo_path ? { repo_path: d.repo_path } : {}), ...(d.wal_path ? { wal_path: d.wal_path } : {}), require_mount: d.require_mount, ...(d.min_free_gb ? { min_free_gb: d.min_free_gb } : {}) });

const online = (n: NodeRecord) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000;
const nodesOf = (st: any, id: string): NodeRecord[] => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === id);

/** Latest check per node for the CURRENT resolved destination (same parameters), with its age. */
export function checksFor(st: any, c: any, d: ResolvedDestination) {
  const want = stable(checkParams(d));
  const out: Record<string, any> = {};
  for (const n of nodesOf(st, c.id)) {
    const op = [...st.operations].reverse().find((o: any) => o.type === 'destination_check' && o.clusterId === c.id && o.nodeId === n.id && stable({ ...o.params, bench: undefined }) === stable({ ...JSON.parse(want), bench: undefined }));
    out[n.id] = op ? { opId: op.id, status: op.status, ok: op.status === 'succeeded' ? !!op.result?.ok : null, at: op.updatedAt, fresh: Date.now() - Date.parse(op.updatedAt) < CHECK_MAX_AGE_MS } : null;
  }
  return out;
}

/** Why the destination cannot be applied now (null = it can). */
export function precheckApply(st: any, c: any): { code: number; body: any } | null {
  if (c.isSandbox) return { code: 409, body: { error: 'demo_cluster' } };
  const { dest } = destinationFor(st, c);
  if (!dest) return { code: 409, body: { error: 'no_destination' } };
  if (dest.wal_collision) return { code: 409, body: { error: 'wal_collision', message: dest.wal_collision } };
  const nodes = nodesOf(st, c.id).filter(online);
  if (!nodes.length) return { code: 409, body: { error: 'no_online_node' } };
  const chk = checksFor(st, c, dest);
  const bad = nodes.filter(n => !chk[n.id] || chk[n.id].ok !== true || !chk[n.id].fresh);
  if (bad.length) return { code: 409, body: { error: 'check_required', message: `Prima di applicare serve un controllo riuscito e recente su ogni nodo (mancano: ${bad.map(n => n.name).join(', ')}).`, nodes: bad.map(n => n.name) } };
  return null;
}

/**
 * Apply the resolved destination to every online node of the cluster (also called when a four-eyes request is approved). Each agent keeps its OLD
 * repository / WAL archive as a read-only previous location (restores and PITR keep working across the change) and, on the primary, proves that the
 * next WAL segment lands in the new archive - or goes back to the old one by itself. Existing backups are not moved (destination_migrate does that).
 */
export async function applyDestination(store: Store, c: any, key: string, by: string): Promise<{ code: number; body: any }> {
  const st = store.peek();
  const pre = precheckApply(st, c);
  if (pre) return pre;
  const { dest } = destinationFor(st, c);
  const out = [];
  for (const n of nodesOf(st, c.id).filter(online)) {
    const set: Record<string, string> = {};
    if (dest!.repo_path) set.repo_path = dest!.repo_path;
    if (dest!.wal_path) set.wal_archive_dir = dest!.wal_path;
    const r = await ops.submit(store, { type: 'agent_config_set', clusterId: c.id, nodeId: n.id, params: { set, verify_wal: true }, idempotencyKey: `${key}:cfg:${n.id}`, createdBy: by, ttlSeconds: 300 });
    out.push({ nodeId: n.id, nodeName: n.name, operation: r.op });
  }
  const prevOf = (n: any) => ({ repo: n.snapshot?.storage?.repo_path || null, wal: n.snapshot?.storage?.wal_path || null });
  const prim = nodesOf(st, c.id).find(n => online(n) && n.snapshot?.postgres?.is_in_recovery === false);
  await store.mutate(d => {
    (d.settings.destinationApplied ||= {})[c.id] = { at: new Date().toISOString(), by, repo_path: dest!.repo_path, wal_path: dest!.wal_path, type: dest!.type, previous: prim ? prevOf(prim) : null };
    audit(d, { clusterId: c.id, actor: by, action: 'destination.apply', status: 'OK', details: { ...dest } });
  });
  return { code: 202, body: { destination: dest, operations: out,
    note: dest!.repo_path ? 'I backup già fatti restano nella posizione precedente, leggibili per i ripristini; la nuova destinazione parte con un backup completo (il prossimo backup lo diventa da sé). Puoi migrare il contenuto vecchio in background.' : undefined } };
}

export function mountDestinationRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';

  app.get('/api/clusters/:id/destination', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const { dest, resolved } = destinationFor(st, c);
    const nodes = nodesOf(st, c.id).map(n => ({ id: n.id, name: n.name, online: online(n), primary: n.snapshot?.postgres?.is_in_recovery === false,
      repo_path: n.snapshot?.storage?.repo_path ?? n.snapshot?.config?.repo_path ?? n.snapshot?.backup?.repo_path ?? null, wal_path: n.snapshot?.storage?.wal_path ?? null,
      repo_previous: n.snapshot?.storage?.repo_previous || [], wal_previous: n.snapshot?.storage?.wal_previous || [] }));
    // the locations still read by restores after a change (as the primary reports them): what can be migrated or, once safe, deleted
    const prim = nodes.find(n => n.primary && n.online) || nodes.find(n => n.online) || nodes[0];
    const previous = prim ? { repo: prim.repo_previous, wal: prim.wal_previous, nodeId: prim.id, nodeName: prim.name } : null;
    const running = st.operations.filter((o: any) => o.clusterId === c.id && ['destination_migrate', 'destination_drop_old'].includes(o.type) && ['queued', 'leased', 'running'].includes(o.status)).map((o: any) => ({ id: o.id, type: o.type, status: o.status }));
    res.json({ destination: dest, effective: resolved, nodes, checks: dest ? checksFor(st, c, dest) : {}, applied: (st.settings.destinationApplied || {})[c.id] || null, previewTypes: PREVIEW_TYPES,
      current: prim ? { repo: prim.repo_path, wal: prim.wal_path } : null, previous, running });
  });

  /**
   * WHERE things happen for this cluster, in one answer for the screens that need it (restore plan, backup page): the node and scratch directory of the
   * recovery instance, the repository and WAL archive in use, the free space of each as last reported by the agents, and which level of the configuration
   * each value comes from (so the screen can say "set for environment prod" and link to the right place to change it).
   */
  app.get('/api/clusters/:id/placement', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const nodes = nodesOf(st, c.id);
    const prim = nodes.find(n => online(n) && n.snapshot?.postgres?.is_in_recovery === false) || nodes.find(n => online(n) && n.snapshot?.postgres?.alive) || nodes.find(online) || nodes[0];
    const eph = resolveScoped(st, 'ephemeral', c);
    const central = eph.value.placement === 'central' ? (st.nodes as any)[eph.value.centralNode] as NodeRecord | undefined : undefined;
    const runNode = eph.value.placement === 'central' ? central : prim;
    const disks = (n?: NodeRecord) => (n?.snapshot?.system?.disks || {}) as Record<string, { path: string; free_bytes: number; total_bytes: number; dev?: number }>;
    const rd = disks(runNode); const pd = disks(prim);
    const scratchPath = eph.value.scratchDir || rd.scratch?.path || '/var/tmp/pg_arca_scratch';
    const scratchDisk = rd.scratch && rd.scratch.path === scratchPath ? rd.scratch : null;
    const { dest, resolved } = destinationFor(st, c);
    const applied = (st.settings.destinationApplied || {})[c.id] || null;
    const node = (n?: NodeRecord) => (n ? { id: n.id, name: n.name, online: online(n), role: n.snapshot?.postgres?.is_in_recovery === false ? 'primary' : n.snapshot?.postgres?.is_in_recovery === true ? 'replica' : null } : null);
    res.json({
      ephemeral: {
        placement: eph.value.placement || 'node', node: node(runNode), centralMissing: eph.value.placement === 'central' && !central,
        scratchDir: scratchPath, scratchDisk, scratchSharesData: !!(scratchDisk && rd.pgdata && scratchDisk.dev !== undefined && scratchDisk.dev === rd.pgdata.dev),
        binDir: eph.value.binDir || null, sharedBuffersMb: eph.value.sharedBuffersMb, keepOnFailure: !!eph.value.keepOnFailure, sources: eph.sources,
      },
      backup: {
        repoPath: pd.repo?.path || applied?.repo_path || null, walPath: pd.wal_archive?.path || applied?.wal_path || null,
        repoDisk: pd.repo || null, walDisk: pd.wal_archive || null, dataDisk: pd.pgdata || null,
        configured: dest, pending: !!(dest && ((dest.repo_path && dest.repo_path !== pd.repo?.path) || (dest.wal_path && dest.wal_path !== pd.wal_archive?.path))),
        type: dest?.type || applied?.type || 'local', sources: resolved.sources, node: node(prim),
        previous: { repo: (prim?.snapshot?.storage?.repo_previous || []).map((x: any) => x.path), wal: (prim?.snapshot?.storage?.wal_previous || []).map((x: any) => x.path) },
        migrating: st.operations.some((o: any) => o.clusterId === c.id && o.type === 'destination_migrate' && !o.params?.dry_run && ['queued', 'leased', 'running'].includes(o.status)),
      },
    });
  });

  // check on every online node: the destination must work from each of them (a standby may take over)
  app.post('/api/clusters/:id/destination/check', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    if (c.isSandbox) return res.status(409).json({ error: 'demo_cluster' });
    const { dest } = destinationFor(st, c);
    if (!dest) return res.status(409).json({ error: 'no_destination', message: 'Nessuna destinazione configurata per questo cluster, la sua cartella o l’ambiente.' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const nodes = nodesOf(st, c.id).filter(online);
    if (!nodes.length) return res.status(409).json({ error: 'no_online_node', message: 'Nessun nodo del cluster è raggiungibile: il controllo gira sui nodi.' });
    const bench = !!req.body?.bench;
    const out = [];
    for (const n of nodes) {
      const r = await ops.submit(store, { type: 'destination_check', clusterId: c.id, nodeId: n.id, params: { ...checkParams(dest), ...(bench ? { bench: true } : {}) }, idempotencyKey: `${key}:${n.id}`, createdBy: actor(req), ttlSeconds: 300 });
      out.push({ nodeId: n.id, nodeName: n.name, operation: r.op });
    }
    res.status(202).json({ destination: dest, operations: out });
  });

  // apply: only when EVERY online node has a fresh, successful check of exactly this destination. On a protected environment it is a four-eyes request.
  app.post('/api/clusters/:id/destination/apply', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const pre = precheckApply(st, c);
    if (pre) return res.status(pre.code).json(pre.body);
    if (requiresApproval(st, c, 'destination_apply', {})) {
      const { dest } = destinationFor(st, c);
      const rec = await requestApproval(store, audit, { cluster: c, type: 'destination_apply', params: { repo_path: dest!.repo_path, wal_path: dest!.wal_path }, key, actor: actor(req) });
      return res.status(202).json({ approval: rec, message: 'Cambio di destinazione su un ambiente protetto: serve l’approvazione di un altro amministratore.' });
    }
    const r = await applyDestination(store, c, key, actor(req));
    res.status(r.code).json(r.body);
  });
}
