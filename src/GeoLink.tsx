import React, { useState } from 'react';
import { api } from './api';
import { Banner, Button, Field, Modal } from './ui';
import { revalidate, toast } from './hooks';

/* =====================================================================================================================================================
 * Primary / standby relationship of a cluster ("parentela"). Detected automatically when the agents see the same database (system identifier) and a
 * standby cluster replicating from the other one; the operator can confirm it, set it by hand (cluster without agent, telemetry not there yet, intent
 * documented before the replica is built) or detach a cluster that must never be paired (a restored copy, a clone).
 * ===================================================================================================================================================== */
export type LinkMode = 'auto' | 'manual' | 'none';
export const linkModeOf = (c: any): LinkMode => (c.geoLink?.primary ? 'manual' : c.geoLink?.none ? 'none' : 'auto');

/** The relationship as the console sees it now, in one sentence. */
export function linkSummary(c: any): string {
  const g = c.geo; const prim = g?.peers?.find((p: any) => p.role === 'primary');
  if (!g) return c.geoLink?.none ? 'No relationship (automatic pairing turned off).' : 'No replication relationship detected with the other clusters.';
  if (g.role === 'standby') return `Standby site of ${prim?.name || '?'} — ${g.link === 'manual' ? 'set by hand' : 'detected automatically (same database, replication running)'}.`;
  return `Primary site, replicated to ${(g.peers || []).filter((p: any) => p.role === 'standby').map((p: any) => `${p.name}${p.link === 'manual' ? ' (set by hand)' : ''}`).join(', ') || '—'}.`;
}

/** Form section (used inside other dialogs). */
export function GeoLinkField({ c, all, mode, setMode, primary, setPrimary }: { c: any; all: any[]; mode: LinkMode; setMode: (m: LinkMode) => void; primary: string; setPrimary: (v: string) => void }) {
  const cands = all.filter(x => x.id !== c.id && !x.isSandbox).sort((a, b) => a.name.localeCompare(b.name));
  const sameDb = (x: any) => x.geo && c.geo && (x.geo.peers || []).some((p: any) => p.clusterId === c.id);
  return <fieldset className="geolinkf">
    <legend>Replication relationship (geo-redundancy)</legend>
    <p className="small muted" style={{ margin: '0 0 8px' }}>{linkSummary(c)}</p>
    <label className="check"><input type="radio" name="glm" checked={mode === 'auto'} onChange={() => setMode('auto')} /><span><strong>Automatic</strong> <span className="muted small">(recommended) — the console pairs clusters of the same database when one replicates from the other</span></span></label>
    <label className="check"><input type="radio" name="glm" checked={mode === 'manual'} onChange={() => setMode('manual')} /><span><strong>Is a standby site of…</strong> <span className="muted small">— for a cluster without an agent, or to declare it before replication is running</span></span></label>
    {mode === 'manual' ? <Field label="Primary cluster"><select className="input" value={primary} onChange={e => setPrimary(e.target.value)}>
      <option value="">Choose…</option>{cands.map(x => <option key={x.id} value={x.id}>{x.name}{x.environment ? ` · ${x.environment}` : ''}{sameDb(x) ? ' · same database' : ''}</option>)}</select></Field> : null}
    <label className="check"><input type="radio" name="glm" checked={mode === 'none'} onChange={() => setMode('none')} /><span><strong>No relationship</strong> <span className="muted small">— never pair it (restored copy, test clone with the same system identifier)</span></span></label>
  </fieldset>;
}

export async function saveGeoLink(c: any, mode: LinkMode, primary: string) {
  if (mode === linkModeOf(c) && (mode !== 'manual' || primary === c.geoLink?.primary)) return false;
  await api('PUT', `/api/clusters/${encodeURIComponent(c.id)}/geo-link`, mode === 'manual' ? { primary } : mode === 'none' ? { none: true } : { primary: null });
  revalidate('/api/clusters'); revalidate('/api/geo');
  return true;
}

/** Stand-alone dialog (cluster page, georedundancy page). */
export function GeoLinkModal({ c, all, onClose }: { c: any; all: any[]; onClose: () => void }) {
  const [mode, setMode] = useState<LinkMode>(linkModeOf(c)); const [primary, setPrimary] = useState<string>(c.geoLink?.primary || '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (mode === 'manual' && !primary) { setErr('Choose the primary cluster.'); return; }
    setBusy(true); setErr(null);
    try { if (await saveGeoLink(c, mode, primary)) toast('Relationship saved', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={`Replication relationship of ${c.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
    <div className="stack"><GeoLinkField c={c} all={all} mode={mode} setMode={setMode} primary={primary} setPrimary={setPrimary} />
      <p className="small muted">The relationship decides where the cluster appears (under its primary in the sidebar and in the list), the health status of the standby site and the actions on the Geo-redundancy page. It changes nothing in PostgreSQL or Patroni.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
