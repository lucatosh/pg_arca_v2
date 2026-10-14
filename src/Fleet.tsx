import React, { useMemo, useState } from 'react';
import { Dot, Icon } from './ui';
import { go } from './router';

/* ====================================================================================================================================================
 * Fleet organisation shared by the sidebar and the cluster list: environment > folder (nested, "app/component") > cluster, each level with the worst
 * state of what it contains, so a problem is visible without opening anything. Folders are the same `folder` paths used by backup strategies and by the
 * recovery / destination settings (one place to organise, one meaning everywhere).
 * ==================================================================================================================================================== */
export const ENV_ORDER = ['prod', 'prep', 'int', 'dev', 'test'];
export const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test', demo: 'Demo' };
export type Tone = 'ok' | 'warn' | 'bad';
const RANK: Record<Tone, number> = { ok: 0, warn: 1, bad: 2 };
export const worst = (a: Tone, b: Tone): Tone => (RANK[b] > RANK[a] ? b : a);

/** State of one cluster: its own status, made worse by the health findings of the briefing (backups missing, disks full...). */
export function toneOf(c: any, health?: Record<string, string>): Tone {
  let s: Tone = c.status === 'healthy' ? 'ok' : c.status === 'degraded' ? 'warn' : c.status === 'critical' || c.status === 'down' ? 'bad' : 'warn';
  if (c.geo?.role === 'standby') s = worst(s, c.geo.health === 'bad' ? 'bad' : c.geo.health === 'warn' ? 'warn' : 'ok');
  const h = health?.[c.id];
  return worst(s, h === 'critical' ? 'bad' : h === 'warning' ? 'warn' : 'ok');
}

export interface FolderNode { name: string; path: string; clusters: any[]; children: FolderNode[]; tone: Tone; count: number; bad: number; warn: number }
export interface EnvGroup { env: string; label: string; root: FolderNode; tone: Tone; count: number; bad: number; warn: number }

/** Primary cluster a standby site hangs under in the tree (only when that primary is in the same list), else null. Works for any site pair the console
 *  recognises (same system identifier), whoever added it and wherever it is filed: after a switchover the tree turns around by itself. */
export function primaryOf(c: any, clusters: any[]): any | null {
  if (c?.geo?.role !== 'standby') return null;
  const pid = c.geo.peers?.find((p: any) => p.role === 'primary')?.clusterId;
  return (pid && pid !== c.id && clusters.find(x => x.id === pid && x.geo?.role === 'primary')) || null;
}

/** The fleet as a tree: standby sites are not listed on their own but as `replicas` of their primary (a shallow copy of the primary carries them). */
export function nestReplicas(clusters: any[]): any[] {
  const under = new Map<string, any[]>();
  for (const c of clusters) { const p = primaryOf(c, clusters); if (p) under.set(p.id, [...(under.get(p.id) || []), c]); }
  return clusters.filter(c => !primaryOf(c, clusters)).map(c => under.has(c.id) ? { ...c, replicas: under.get(c.id)!.sort((a, b) => a.name.localeCompare(b.name)) } : c);
}

/** One line on how a standby site is doing, for tooltips and the list. */
export function replicaText(c: any): string {
  const g = c.geo || {};
  const lag = g.lagBytes == null ? 'lag not measurable' : g.lagBytes === 0 ? 'in sync' : `${fmtBytes(g.lagBytes)} behind`;
  return g.problems?.length ? `${lag} · ${g.problems[0]}` : lag;
}
const fmtBytes = (b: number) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`; };

export function buildFleet(clusters: any[], health?: Record<string, string>): EnvGroup[] {
  const envs = new Map<string, EnvGroup>();
  const mk = (name: string, path: string): FolderNode => ({ name, path, clusters: [], children: [], tone: 'ok', count: 0, bad: 0, warn: 0 });
  for (const c of nestReplicas(clusters)) {
    const env = c.isSandbox ? 'demo' : c.environment || 'prod';
    let g = envs.get(env);
    if (!g) { g = { env, label: ENV_LABEL[env] || env, root: mk('', ''), tone: 'ok', count: 0, bad: 0, warn: 0 }; envs.set(env, g); }
    let node = g.root;
    const parts = String(c.folder || '').split('/').map((x: string) => x.trim()).filter(Boolean);
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let ch = node.children.find(x => x.path === path);
      if (!ch) { ch = mk(p, path); node.children.push(ch); }
      node = ch;
    });
    node.clusters.push(c);
  }
  const roll = (n: FolderNode): FolderNode => {
    n.children.forEach(roll);
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    n.clusters.sort((a, b) => a.name.localeCompare(b.name));
    const all = n.clusters.flatMap(c => [c, ...(c.replicas || [])]);
    const tones = all.map(c => toneOf(c, health));
    n.count = all.length + n.children.reduce((a, x) => a + x.count, 0);
    n.bad = tones.filter(t => t === 'bad').length + n.children.reduce((a, x) => a + x.bad, 0);
    n.warn = tones.filter(t => t === 'warn').length + n.children.reduce((a, x) => a + x.warn, 0);
    n.tone = n.bad ? 'bad' : n.warn ? 'warn' : 'ok';
    return n;
  };
  const out = [...envs.values()].map(g => { roll(g.root); return { ...g, tone: g.root.tone, count: g.root.count, bad: g.root.bad, warn: g.root.warn }; });
  const order = (e: string) => (e === 'demo' ? 99 : ENV_ORDER.indexOf(e) < 0 ? 50 : ENV_ORDER.indexOf(e));
  return out.sort((a, b) => order(a.env) - order(b.env));
}

const rd = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const wr = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** Open/closed state of groups, remembered per browser. Closed by default only for groups that are all healthy and not the one in view. */
export function useFold(prefix: string) {
  const [st, setSt] = useState<Record<string, boolean>>(() => { try { return JSON.parse(rd(prefix) || '{}'); } catch { return {}; } });
  const isOpen = (k: string, def: boolean) => (k in st ? st[k] : def);
  const toggle = (k: string, def: boolean) => setSt(s => { const n = { ...s, [k]: !(k in s ? s[k] : def) }; wr(prefix, JSON.stringify(n)); return n; });
  return { isOpen, toggle };
}

/** "3 · 1 critico" style counter, short enough for the sidebar. */
export function Counter({ g }: { g: { count: number; bad: number; warn: number } }) {
  return <span className="fcount">{g.bad ? <span className="b" title={`${g.bad} with critical issues`}>{g.bad}</span> : null}{g.warn ? <span className="w" title={`${g.warn} to check`}>{g.warn}</span> : null}<span className="n">{g.count}</span></span>;
}

/** Sidebar tree. `current` = id of the cluster on screen (its groups open automatically). */
export function FleetTree({ clusters, health, current, query }: { clusters: any[]; health?: Record<string, string>; current?: string; query: string }) {
  const fold = useFold('arca.fleet.fold');
  const groups = useMemo(() => buildFleet(clusters, health), [clusters, health]);
  const q = query.trim().toLowerCase();
  const hasCur = (n: FolderNode): boolean => n.clusters.some(c => c.id === current || c.replicas?.some((r: any) => r.id === current)) || n.children.some(hasCur);
  const one = (c: any, depth: number, replica = false) => <button key={c.id} className={`citem${replica ? ' replica' : ''}`} style={{ paddingLeft: 10 + depth * 12 }}
    title={replica ? `${c.name} — standby site of ${c.geo.peers?.find((p: any) => p.role === 'primary')?.name || '?'}: ${replicaText(c)}` : `${c.name}${c.folder ? ` — ${c.folder}` : ''}`} aria-current={current === c.id ? 'page' : undefined}
    onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>{replica ? <span className="branch" aria-hidden /> : null}<Dot kind={toneOf(c, health)} /><span className="n lbl">{c.name}</span>{c.geo?.role === 'standby' ? <span className="geotag lbl" title={`Standby site of ${c.geo.peers?.find((p: any) => p.role === 'primary')?.name || '?'}`}>DR</span> : c.geo?.role === 'primary' && c.geo?.peers?.length ? <span className="geotag p lbl" title="Primary site with standby sites">GEO</span> : null}{c.isSandbox ? <span className="faint small lbl">demo</span> : null}</button>;
  const item = (c: any, depth: number) => c.replicas?.length
    ? <div key={c.id} className="geotree" role="group" aria-label={`${c.name} and its standby sites`}>{one(c, depth)}{c.replicas.map((r: any) => one(r, depth + 1, true))}</div>
    : one(c, depth);
  const folder = (n: FolderNode, env: string, depth: number): React.ReactNode => {
    const k = `${env}:${n.path}`; const open = q ? true : fold.isOpen(k, n.tone !== 'ok' || hasCur(n));
    return <div key={k} className="fgroup">
      <button className="fhead folder" style={{ paddingLeft: 8 + depth * 12 }} aria-expanded={open} onClick={() => fold.toggle(k, n.tone !== 'ok' || hasCur(n))} title={n.path}>
        <Icon n={open ? 'down' : 'chev'} s={12} /><Icon n="folder" s={13} /><span className="n lbl">{n.name}</span><Dot kind={n.tone} /><Counter g={n} /></button>
      {open ? <>{n.children.map(ch => folder(ch, env, depth + 1))}{n.clusters.map(c => item(c, depth + 1))}</> : null}</div>;
  };
  const filter = (n: FolderNode): FolderNode | null => {
    if (!q) return n;
    const hit = (c: any) => c.name.toLowerCase().includes(q) || String(c.folder || '').toLowerCase().includes(q);
    const cl = n.clusters.filter(c => hit(c) || c.replicas?.some(hit));
    const ch = n.children.map(filter).filter(Boolean) as FolderNode[];
    return cl.length || ch.length ? { ...n, clusters: cl, children: ch } : null;
  };
  return <div className="fleet">{groups.map(g => {
    const root = filter(g.root); if (!root) return null;
    const k = `env:${g.env}`; const open = q ? true : fold.isOpen(k, true);
    return <div key={g.env} className={`fenv ${g.tone}`}>
      <button className="fhead env" aria-expanded={open} onClick={() => fold.toggle(k, true)}><Icon n={open ? 'down' : 'chev'} s={12} /><span className={`envmark ${g.env}`} /><span className="n lbl">{g.label}</span><Dot kind={g.tone} /><Counter g={g} /></button>
      {open ? <>{root.children.map(ch => folder(ch, g.env, 1))}{root.clusters.map(c => item(c, 1))}</> : null}</div>;
  })}</div>;
}
