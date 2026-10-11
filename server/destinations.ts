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

export interface ResolvedDestination { type: string; repo_path?: string; wal_path?: string; require_mount: boolean; min_free_gb?: number; wal_shared_warning?: string }
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
  return { dest: d, resolved: r };
}

const stable = (v: any): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const CHECK_MAX_AGE_MS = 30 * 60 * 1000;
const checkParams = (d: ResolvedDestination) => ({ type: d.type, ...(d.repo_path ? { repo_path: d.repo_path } : {}), ...(d.wal_path ? { wal_path: d.wal_path } : {}), require_mount: d.require_mount, ...(d.min_free_gb ? { min_free_gb: d.min_free_gb } : {}) });

export function mountDestinationRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  const online = (n: NodeRecord) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000;
  const nodesOf = (st: any, id: string): NodeRecord[] => (Object.values(st.nodes) as NodeRecord[]).filter(n => n.clusterId === id);

  /** Latest check per node for the CURRENT resolved destination (same parameters), with its age. */
  const checksFor = (st: any, c: any, d: ResolvedDestination) => {
    const want = stable(checkParams(d));
    const out: Record<string, any> = {};
    for (const n of nodesOf(st, c.id)) {
      const op = [...st.operations].reverse().find((o: any) => o.type === 'destination_check' && o.clusterId === c.id && o.nodeId === n.id && stable({ ...o.params, bench: undefined }) === stable({ ...JSON.parse(want), bench: undefined }));
      out[n.id] = op ? { opId: op.id, status: op.status, ok: op.status === 'succeeded' ? !!op.result?.ok : null, at: op.updatedAt, fresh: Date.now() - Date.parse(op.updatedAt) < CHECK_MAX_AGE_MS } : null;
    }
    return out;
  };

  app.get('/api/clusters/:id/destination', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const { dest, resolved } = destinationFor(st, c);
    const nodes = nodesOf(st, c.id).map(n => ({ id: n.id, name: n.name, online: online(n), repo_path: n.snapshot?.config?.repo_path ?? n.snapshot?.backup?.repo_path ?? null }));
    res.json({ destination: dest, effective: resolved, nodes, checks: dest ? checksFor(st, c, dest) : {}, applied: (st.settings.destinationApplied || {})[c.id] || null, previewTypes: PREVIEW_TYPES });
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

  // apply: only when EVERY online node has a fresh, successful check of exactly this destination
  app.post('/api/clusters/:id/destination/apply', async (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    const { dest } = destinationFor(st, c);
    if (!dest) return res.status(409).json({ error: 'no_destination' });
    const key = String(req.headers['idempotency-key'] || '');
    if (!key) return res.status(400).json({ error: 'idempotency_key_required' });
    const nodes = nodesOf(st, c.id).filter(online);
    if (!nodes.length) return res.status(409).json({ error: 'no_online_node' });
    const chk = checksFor(st, c, dest);
    const bad = nodes.filter(n => !chk[n.id] || chk[n.id].ok !== true || !chk[n.id].fresh);
    if (bad.length) return res.status(409).json({ error: 'check_required', message: `Prima di applicare serve un controllo riuscito e recente su ogni nodo (mancano: ${bad.map(n => n.name).join(', ')}).`, nodes: bad.map(n => n.name) });
    const out = [];
    for (const n of nodes) {
      const set: Record<string, string> = {};
      if (dest.repo_path) set.repo_path = dest.repo_path;
      if (dest.wal_path) set.wal_archive_dir = dest.wal_path;
      const r = await ops.submit(store, { type: 'agent_config_set', clusterId: c.id, nodeId: n.id, params: { set }, idempotencyKey: `${key}:cfg:${n.id}`, createdBy: actor(req), ttlSeconds: 300 });
      out.push({ nodeId: n.id, nodeName: n.name, operation: r.op });
    }
    await store.mutate(d => {
      (d.settings.destinationApplied ||= {})[c.id] = { at: new Date().toISOString(), by: actor(req), repo_path: dest.repo_path, wal_path: dest.wal_path, type: dest.type };
      audit(d, { clusterId: c.id, actor: actor(req), action: 'destination.apply', status: 'OK', details: { ...dest } });
    });
    res.status(202).json({ destination: dest, operations: out, note: dest.repo_path ? 'I backup esistenti restano nel percorso precedente: la nuova catena parte con un nuovo backup completo.' : undefined });
  });
}
