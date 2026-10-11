/**
 * Configuration that applies to a scope and is inherited field by field:
 *   cluster  >  folder (longest path prefix)  >  environment  >  global
 * Used for the ephemeral recovery instance (where it runs, scratch, binaries, ports, memory) and for the backup destination (see destinations.ts).
 * Unlike backup policies (one template per scope) an assignment here carries only the fields it wants to change; every other field comes from the next scope up,
 * and the effective value of each field remembers where it came from. Nothing is copied into clusters: a change applies to the next operation.
 */
import type { Request, Response } from 'express';
import { Store } from './store';
import { audit } from './ops';
import { ENVS, normFolder, validFolder } from './policies';

export type Scope = 'global' | 'env' | 'folder' | 'cluster';
export type Kind = 'ephemeral' | 'destination';
export interface Resolved { value: Record<string, any>; sources: Record<string, { scope: Scope | 'default'; key: string }> }
export interface KindSpec {
  /** field defaults shown as "predefinito" (not stored) */
  defaults: Record<string, any>;
  /** validates ONE assignment (partial object). Returns the cleaned object or an error text. */
  validate: (v: any, st: any) => { ok: true; value: Record<string, any> } | { ok: false; error: string };
}

const key = (scope: Scope, k: string) => (scope === 'global' ? 'global' : `${scope}:${k}`);
const folderChain = (f: string) => { const p = normFolder(f).split('/').filter(Boolean); return p.map((_, i) => p.slice(0, p.length - i).join('/')); };   // deepest first

/** Effective configuration of one cluster: for each field the most specific scope that sets it. Pure. */
export function resolveScoped(st: any, kind: Kind, c: any, spec: KindSpec = SPECS[kind]): Resolved {
  const all: Record<string, Record<string, any>> = (st.settings.scoped || {})[kind] || {};
  const chain: [Scope, string][] = [['cluster', c.id], ...folderChain(c.folder).map(f => ['folder', f] as [Scope, string]), ['env', c.environment], ['global', '']];
  const value: Record<string, any> = { ...spec.defaults };
  const sources: Resolved['sources'] = {};
  for (const f of Object.keys(spec.defaults)) sources[f] = { scope: 'default', key: '' };
  for (const [scope, k] of [...chain].reverse()) {                          // least specific first, so the specific ones overwrite
    const a = all[key(scope, k)];
    if (!a) continue;
    for (const [f, v] of Object.entries(a)) { value[f] = v; sources[f] = { scope, key: key(scope, k) }; }
  }
  return { value, sources };
}

// ====================================================================================================== ephemeral instance
const absPath = (v: any): string | null => {
  const s = String(v ?? '');
  if (!s) return null;
  if (!s.startsWith('/') || /[\u0000-\u001f]/.test(s) || s.length > 300 || s.split('/').includes('..')) throw new Error('serve un percorso assoluto, senza «..»');
  return s.replace(/\/+$/, '') || '/';
};
const int = (v: any, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}: valore tra ${lo} e ${hi}`); return n; };

export const EPHEMERAL_DEFAULTS = { placement: 'node', sharedBuffersMb: 256, keepOnFailure: false, installMode: 'private' };
const ephemeral: KindSpec = {
  defaults: EPHEMERAL_DEFAULTS,
  validate(v, st) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'oggetto atteso' };
    const out: Record<string, any> = {};
    try {
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === null || x === '') continue;
        switch (k) {
          case 'placement': if (!['node', 'central'].includes(String(x))) throw new Error('placement: node oppure central'); out[k] = x; break;
          case 'centralNode': { const id = String(x); if (!Object.prototype.hasOwnProperty.call(st.nodes || {}, id)) throw new Error('il nodo centrale non esiste (deve avere un agent registrato)'); out[k] = id; break; }
          case 'centralInto': {
            const o: any = x; if (typeof o !== 'object' || Array.isArray(o)) throw new Error('centralInto: oggetto {host, port, user}');
            const r: Record<string, any> = {};
            if (o.host) { if (!/^[A-Za-z0-9]([A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?$/.test(String(o.host))) throw new Error('centralInto.host non valido'); r.host = String(o.host); }
            if (o.port) r.port = int(o.port, 1, 65535, 'centralInto.port');
            if (o.user) { if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(String(o.user))) throw new Error('centralInto.user non valido'); r.user = String(o.user); }
            out[k] = r; break;
          }
          case 'scratchDir': case 'binDir': case 'installDir': out[k] = absPath(x); break;
          case 'portMin': case 'portMax': out[k] = int(x, 1024, 65535, k); break;
          case 'sharedBuffersMb': out[k] = int(x, 16, 262144, k); break;
          case 'keepOnFailure': out[k] = !!x; break;
          case 'installMode': if (!['private', 'system'].includes(String(x))) throw new Error('installMode: private oppure system'); out[k] = x; break;
          default: throw new Error(`campo sconosciuto: ${k}`);
        }
      }
    } catch (e: any) { return { ok: false, error: e.message }; }
    if (('portMin' in out) !== ('portMax' in out)) return { ok: false, error: 'indica sia portMin sia portMax (oppure nessuno dei due)' };
    if (out.portMin && out.portMax && out.portMin > out.portMax) return { ok: false, error: 'portMin non può superare portMax' };
    return { ok: true, value: out };
  },
};

export const SPECS: Record<Kind, KindSpec> = { ephemeral, destination: { defaults: {}, validate: () => ({ ok: false, error: 'non ancora configurato' }) } };
export function registerKind(kind: Kind, spec: KindSpec) { SPECS[kind] = spec; }

/** The settings the AGENT receives (snake_case, only what it understands; it validates again against its own filesystem). */
export function ephemeralForAgent(r: Resolved): Record<string, any> {
  const v = r.value, o: Record<string, any> = {};
  const map: [string, string][] = [['placement', 'placement'], ['centralNode', 'central_node'], ['scratchDir', 'scratch_dir'], ['binDir', 'bin_dir'], ['installDir', 'install_dir'], ['portMin', 'port_min'],
    ['portMax', 'port_max'], ['sharedBuffersMb', 'shared_buffers_mb'], ['keepOnFailure', 'keep_on_failure'], ['installMode', 'install_mode']];
  for (const [a, b] of map) if (v[a] !== undefined && v[a] !== '') o[b] = v[a];
  return o;
}

/** Operations whose ephemeral instance this configuration shapes. `central` moves the data-lane ones to the chosen node. */
export const EPHEMERAL_OPS = ['restore_plan', 'restore_object', 'restore_database', 'restore_drill', 'backup_verify', 'restore_diff', 'restore_apply_rows', 'restore_promote', 'ephemeral_preflight', 'ephemeral_install', 'wal_forensics'];
export const CENTRAL_OPS = ['restore_object', 'restore_database', 'restore_drill', 'restore_promote', 'restore_diff', 'restore_apply_rows', 'ephemeral_preflight'];

export function mountScopedRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  const online = (n: any) => !!n.lastSeen && Date.now() - Date.parse(n.lastSeen) < 45000;
  const view = (kind: Kind) => {
    const st = store.peek();
    return {
      kind, defaults: SPECS[kind].defaults, assignments: (st.settings.scoped || {})[kind] || {},
      folders: [...new Set(st.clusters.map((c: any) => normFolder(c.folder)).filter(Boolean))].sort(),
      clusters: st.clusters.filter((c: any) => !c.isSandbox).map((c: any) => ({ id: c.id, name: c.name, environment: c.environment, folder: normFolder(c.folder), source: c.source, effective: resolveScoped(st, kind, c) })),
      nodes: Object.values(st.nodes).map((n: any) => ({ id: n.id, name: n.name, clusterId: n.clusterId || null, online: online(n), pg: !!n.snapshot?.postgres?.alive })),
    };
  };
  const kindOf = (req: Request): Kind | null => (Object.prototype.hasOwnProperty.call(SPECS, req.params.kind) ? (req.params.kind as Kind) : null);
  app.get('/api/scoped/:kind', (req: Request, res: Response) => { const k = kindOf(req); if (!k) return res.status(404).json({ error: 'unknown_kind' }); res.json(view(k)); });
  app.get('/api/clusters/:id/scoped/:kind', (req: Request, res: Response) => {
    const k = kindOf(req); const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: 'unknown_kind' });
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    res.json(resolveScoped(st, k, c));
  });

  // body: { scope, key, value } sets (replaces) the fields of that scope; { scope, key, inherit: true } removes the assignment.
  app.put('/api/scoped/:kind/assignments', async (req: Request, res: Response) => {
    const kind = kindOf(req); if (!kind) return res.status(404).json({ error: 'unknown_kind' });
    const { scope, key: k = '', value, inherit } = req.body || {};
    if (!['global', 'env', 'folder', 'cluster'].includes(scope)) return res.status(400).json({ error: 'invalid_scope' });
    const st0 = store.peek();
    let kk = String(k);
    if (scope === 'env' && !(ENVS as readonly string[]).includes(kk)) return res.status(400).json({ error: 'invalid_environment' });
    if (scope === 'folder') { kk = normFolder(kk); if (!kk || !validFolder(kk)) return res.status(400).json({ error: 'invalid_folder' }); }
    if (scope === 'cluster' && !st0.clusters.some((c: any) => c.id === kk && !c.isSandbox)) return res.status(404).json({ error: 'cluster_not_found' });
    let clean: Record<string, any> | null = null;
    if (!inherit) {
      const v = SPECS[kind].validate(value, st0);
      if (!v.ok) return res.status(400).json({ error: 'invalid_value', message: v.error });
      clean = v.value;
      if (!Object.keys(clean).length) return res.status(400).json({ error: 'nothing_to_assign', message: 'Nessun campo da impostare: per tornare all’ereditarietà usa «eredita».' });
    }
    await store.mutate(d => {
      const m = (((d.settings.scoped ||= {})[kind]) ||= {});
      if (clean) m[key(scope, kk)] = clean; else delete m[key(scope, kk)];
      audit(d, { clusterId: scope === 'cluster' ? kk : undefined, actor: actor(req), action: `scoped.${kind}`, status: 'OK', details: { scope, key: kk, ...(clean || { inherit: true }) } });
    });
    res.json({ ok: true, ...view(kind) });
  });
}
