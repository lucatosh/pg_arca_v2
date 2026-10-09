/**
 * Backup strategy: reusable templates + assignment with inheritance.
 *   precedence (most specific wins):  cluster  >  folder (longest path prefix)  >  environment  >  global
 * An assignment points at a template (built-in or custom) or carries its own custom policy, or switches backups off for that scope
 * ("disabled": stops inheritance). The scheduler asks resolvePolicy() for every cluster on every tick, so a change applies at the next tick
 * with no per-cluster copying (and nothing to get out of sync).
 */
import type { Request, Response } from 'express';
import { Store } from './store';
import { audit } from './ops';

export interface BackupPolicy {
  enabled: boolean;
  fullEveryHours: number;      // 24..720
  incrEveryHours: number;      // 1..168 (0 = only fulls)
  retentionFull: number;       // 1..365
  verifyEveryHours: number;    // 0 = off
  verifyDeep: boolean;
  retryAfterMinutes: number;
}
export const DEFAULT_POLICY: BackupPolicy = { enabled: false, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 168, verifyDeep: false, retryAfterMinutes: 30 };

export function validatePolicy(p: any): { ok: true; policy: BackupPolicy } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'policy object required' };
  const n = (v: any, lo: number, hi: number, name: string) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${name} must be ${lo}..${hi}`); return Math.floor(x); };
  try {
    const out: BackupPolicy = {
      enabled: !!p.enabled,
      fullEveryHours: n(p.fullEveryHours ?? DEFAULT_POLICY.fullEveryHours, 6, 720, 'fullEveryHours'),
      incrEveryHours: n(p.incrEveryHours ?? DEFAULT_POLICY.incrEveryHours, 0, 168, 'incrEveryHours'),
      retentionFull: n(p.retentionFull ?? DEFAULT_POLICY.retentionFull, 1, 365, 'retentionFull'),
      verifyEveryHours: n(p.verifyEveryHours ?? DEFAULT_POLICY.verifyEveryHours, 0, 720, 'verifyEveryHours'),
      verifyDeep: !!p.verifyDeep,
      retryAfterMinutes: n(p.retryAfterMinutes ?? DEFAULT_POLICY.retryAfterMinutes, 5, 1440, 'retryAfterMinutes'),
    };
    if (out.incrEveryHours && out.incrEveryHours >= out.fullEveryHours) return { ok: false, error: 'incrEveryHours must be smaller than fullEveryHours' };
    return { ok: true, policy: out };
  } catch (e: any) { return { ok: false, error: e.message }; }
}


export const ENVS = ['prod', 'prep', 'int', 'dev', 'test'] as const;
export interface Template { id: string; name: string; description: string; builtin: boolean; policy: BackupPolicy }

const P = (o: Partial<BackupPolicy>): BackupPolicy => ({ ...DEFAULT_POLICY, enabled: true, ...o });
export const BUILTIN_TEMPLATES: Template[] = [
  { id: 'prod-critical', name: 'Produzione critica', builtin: true, description: 'Completo ogni settimana, incrementale ogni 4 ore, 4 catene conservate, verifica con prova di ripristino ogni giorno.',
    policy: P({ fullEveryHours: 168, incrEveryHours: 4, retentionFull: 4, verifyEveryHours: 24, verifyDeep: false, retryAfterMinutes: 15 }) },
  { id: 'prod-standard', name: 'Produzione standard', builtin: true, description: 'Completo settimanale, incrementale giornaliero, 2 catene, verifica settimanale.',
    policy: P({ fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 168 }) },
  { id: 'preprod', name: 'Pre-produzione / integrazione', builtin: true, description: 'Completo settimanale, incrementale ogni 24 ore, 2 catene, verifica ogni due settimane.',
    policy: P({ fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 336 }) },
  { id: 'dev-light', name: 'Sviluppo e test (leggero)', builtin: true, description: 'Un completo ogni settimana, nessun incrementale, 1 catena, nessuna verifica automatica.',
    policy: P({ fullEveryHours: 168, incrEveryHours: 0, retentionFull: 1, verifyEveryHours: 0 }) },
  { id: 'compliance', name: 'Conservazione lunga (compliance)', builtin: true, description: 'Completo ogni giorno, incrementale ogni ora, 30 catene conservate, verifica approfondita settimanale.',
    policy: P({ fullEveryHours: 24, incrEveryHours: 1, retentionFull: 30, verifyEveryHours: 168, verifyDeep: true, retryAfterMinutes: 10 }) },
];
/** Suggested starting point per environment (shown in the UI as "consigliato"). */
export const SUGGESTED: Record<string, string> = { prod: 'prod-critical', prep: 'preprod', int: 'preprod', dev: 'dev-light', test: 'dev-light' };

export type Scope = 'global' | 'env' | 'folder' | 'cluster';
export interface Assignment { templateId?: string; policy?: BackupPolicy; disabled?: boolean }
const key = (scope: Scope, k: string) => (scope === 'global' ? 'global' : `${scope}:${k}`);

export const normFolder = (f: any): string => String(f ?? '').split('/').map(x => x.trim()).filter(Boolean).join('/');
export const validFolder = (f: string) => f.length <= 120 && f.split('/').every(p => /^[^\u0000-\u001f<>"\\]{1,40}$/.test(p));

function allTemplates(st: any): Template[] {
  const custom: Template[] = Object.values(st.settings.policyTemplates || {}) as any;
  return [...BUILTIN_TEMPLATES, ...custom.map(t => ({ ...t, builtin: false }))];
}
const folderChain = (f: string) => { const p = normFolder(f).split('/').filter(Boolean); return p.map((_, i) => p.slice(0, p.length - i).join('/')); };   // deepest first

export interface Resolved { policy: BackupPolicy | null; source: { scope: Scope | 'legacy' | 'none'; key: string; templateId?: string; templateName?: string; disabled?: boolean } }
/** Effective policy of one cluster. Pure: depends only on persisted state. */
export function resolvePolicy(st: any, c: any): Resolved {
  const as: Record<string, Assignment> = st.settings.policyAssignments || {};
  const tpls = allTemplates(st);
  const candidates: [Scope, string][] = [['cluster', c.id], ...folderChain(c.folder).map(f => ['folder', f] as [Scope, string]), ['env', c.environment], ['global', '']];
  for (const [scope, k] of candidates) {
    const a = as[key(scope, k)];
    if (!a) continue;
    if (a.disabled) return { policy: null, source: { scope, key: key(scope, k), disabled: true } };
    const t = a.templateId ? tpls.find(x => x.id === a.templateId) : undefined;
    const pol = t?.policy || a.policy;
    if (pol) return { policy: { ...pol, enabled: t ? true : pol.enabled }, source: { scope, key: key(scope, k), templateId: t?.id, templateName: t?.name } };
  }
  if (c.backupPolicy) return { policy: c.backupPolicy, source: { scope: 'legacy', key: 'cluster:' + c.id } };   // set by the per-cluster editor before templates existed
  return { policy: null, source: { scope: 'none', key: '' } };
}

export function mountPolicyRoutes(app: any, store: Store) {
  const actor = (req: Request) => (req as any).actor || 'admin';
  const view = () => {
    const st = store.peek();
    return {
      templates: allTemplates(st), suggested: SUGGESTED, assignments: st.settings.policyAssignments || {},
      folders: [...new Set(st.clusters.map((c: any) => normFolder(c.folder)).filter(Boolean))].sort(),
      clusters: st.clusters.filter((c: any) => !c.isSandbox).map((c: any) => ({ id: c.id, name: c.name, environment: c.environment, folder: normFolder(c.folder), source: c.source, effective: resolvePolicy(st, c) })),
    };
  };
  app.get('/api/policies', (_req: Request, res: Response) => res.json(view()));

  app.put('/api/policies/templates/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || BUILTIN_TEMPLATES.some(t => t.id === id)) return res.status(400).json({ error: 'invalid_template_id', message: 'Id minuscolo (a-z, 0-9, -), diverso dai modelli predefiniti.' });
    const { name, description = '' } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 60) return res.status(400).json({ error: 'name_required' });
    const v = validatePolicy({ ...req.body?.policy, enabled: true });
    if (!v.ok) return res.status(400).json({ error: 'invalid_policy', message: v.error });
    await store.mutate(d => {
      (d.settings.policyTemplates ||= {})[id] = { id, name: name.trim(), description: String(description).slice(0, 300), policy: v.policy };
      audit(d, { actor: actor(req), action: 'policy.template.save', status: 'OK', details: { id, name } });
    });
    res.json({ ok: true, ...view() });
  });

  app.delete('/api/policies/templates/:id', async (req: Request, res: Response) => {
    const id = req.params.id;
    const r = await store.mutate(d => {
      if (!(d.settings.policyTemplates || {})[id]) return 'missing' as const;
      if (Object.values(d.settings.policyAssignments || {}).some((a: any) => a.templateId === id)) return 'in_use' as const;
      delete d.settings.policyTemplates[id];
      audit(d, { actor: actor(req), action: 'policy.template.delete', status: 'OK', details: { id } });
      return 'ok' as const;
    });
    if (r === 'missing') return res.status(404).json({ error: 'not_found' });
    if (r === 'in_use') return res.status(409).json({ error: 'template_in_use', message: 'Il modello è assegnato: assegna prima un altro modello.' });
    res.json({ ok: true, ...view() });
  });

  // body: { scope, key, templateId | policy | disabled | inherit:true }.  inherit removes the assignment (back to the parent scope).
  app.put('/api/policies/assignments', async (req: Request, res: Response) => {
    const { scope, key: k = '', templateId, policy, disabled, inherit } = req.body || {};
    if (!['global', 'env', 'folder', 'cluster'].includes(scope)) return res.status(400).json({ error: 'invalid_scope' });
    const st0 = store.peek();
    let kk = String(k);
    if (scope === 'env' && !(ENVS as readonly string[]).includes(kk)) return res.status(400).json({ error: 'invalid_environment' });
    if (scope === 'folder') { kk = normFolder(kk); if (!kk || !validFolder(kk)) return res.status(400).json({ error: 'invalid_folder' }); }
    if (scope === 'cluster' && !st0.clusters.some((c: any) => c.id === kk && !c.isSandbox)) return res.status(404).json({ error: 'cluster_not_found' });
    let a: Assignment | null = null;
    if (!inherit) {
      if (disabled) a = { disabled: true };
      else if (templateId) { if (!allTemplates(st0).some(t => t.id === templateId)) return res.status(400).json({ error: 'unknown_template' }); a = { templateId }; }
      else if (policy) { const v = validatePolicy({ ...policy, enabled: true }); if (!v.ok) return res.status(400).json({ error: 'invalid_policy', message: v.error }); a = { policy: v.policy }; }
      else return res.status(400).json({ error: 'nothing_to_assign' });
    }
    await store.mutate(d => {
      const m = (d.settings.policyAssignments ||= {});
      if (a) m[key(scope, kk)] = a; else delete m[key(scope, kk)];
      if (scope === 'cluster') { const c = d.clusters.find((x: any) => x.id === kk); if (c) delete c.backupPolicy; }   // the new assignment supersedes the legacy per-cluster copy
      audit(d, { clusterId: scope === 'cluster' ? kk : undefined, actor: actor(req), action: 'policy.assign', status: 'OK', details: { scope, key: kk, ...(a || { inherit: true }) } });
    });
    res.json({ ok: true, ...view() });
  });

  app.get('/api/clusters/:id/effective-policy', (req: Request, res: Response) => {
    const st = store.peek(); const c = st.clusters.find((x: any) => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'cluster_not_found' });
    res.json(resolvePolicy(st, c));
  });
}
