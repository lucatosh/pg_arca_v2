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
  if (!g) return c.geoLink?.none ? 'Nessuna relazione (abbinamento automatico disattivato).' : 'Nessuna relazione di replica rilevata con gli altri cluster.';
  if (g.role === 'standby') return `Sito di replica di ${prim?.name || '?'} — ${g.link === 'manual' ? 'impostato a mano' : 'rilevato automaticamente (stesso database, replica in corso)'}.`;
  return `Sito primario, replicato su ${(g.peers || []).filter((p: any) => p.role === 'standby').map((p: any) => `${p.name}${p.link === 'manual' ? ' (impostato a mano)' : ''}`).join(', ') || '—'}.`;
}

/** Form section (used inside other dialogs). */
export function GeoLinkField({ c, all, mode, setMode, primary, setPrimary }: { c: any; all: any[]; mode: LinkMode; setMode: (m: LinkMode) => void; primary: string; setPrimary: (v: string) => void }) {
  const cands = all.filter(x => x.id !== c.id && !x.isSandbox).sort((a, b) => a.name.localeCompare(b.name));
  const sameDb = (x: any) => x.geo && c.geo && (x.geo.peers || []).some((p: any) => p.clusterId === c.id);
  return <fieldset className="geolinkf">
    <legend>Relazione di replica (georidondanza)</legend>
    <p className="small muted" style={{ margin: '0 0 8px' }}>{linkSummary(c)}</p>
    <label className="check"><input type="radio" name="glm" checked={mode === 'auto'} onChange={() => setMode('auto')} /><span><strong>Automatica</strong> <span className="muted small">(consigliata) — la console abbina i cluster dello stesso database quando uno replica dall’altro</span></span></label>
    <label className="check"><input type="radio" name="glm" checked={mode === 'manual'} onChange={() => setMode('manual')} /><span><strong>È una replica di…</strong> <span className="muted small">— per un cluster senza agent, o per dichiararlo prima che la replica sia attiva</span></span></label>
    {mode === 'manual' ? <Field label="Cluster primario"><select className="input" value={primary} onChange={e => setPrimary(e.target.value)}>
      <option value="">Scegli…</option>{cands.map(x => <option key={x.id} value={x.id}>{x.name}{x.environment ? ` · ${x.environment}` : ''}{sameDb(x) ? ' · stesso database' : ''}</option>)}</select></Field> : null}
    <label className="check"><input type="radio" name="glm" checked={mode === 'none'} onChange={() => setMode('none')} /><span><strong>Nessuna relazione</strong> <span className="muted small">— non abbinarlo mai (copia ripristinata, clone di test con lo stesso identificativo)</span></span></label>
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
    if (mode === 'manual' && !primary) { setErr('Scegli il cluster primario.'); return; }
    setBusy(true); setErr(null);
    try { if (await saveGeoLink(c, mode, primary)) toast('Relazione salvata', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={`Relazione di replica di ${c.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Salva</Button></>}>
    <div className="stack"><GeoLinkField c={c} all={all} mode={mode} setMode={setMode} primary={primary} setPrimary={setPrimary} />
      <p className="small muted">La relazione decide dove il cluster compare (sotto il suo primario nella barra laterale e nell’elenco), lo stato di salute del sito di replica e le azioni della pagina Georidondanza. Non modifica nulla su PostgreSQL o Patroni.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
