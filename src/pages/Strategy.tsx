import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Empty, Field, Icon, Modal, Skeleton } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

interface Policy { enabled: boolean; fullEveryHours: number; incrEveryHours: number; retentionFull: number; verifyEveryHours: number; verifyDeep: boolean; retryAfterMinutes: number }
interface Tpl { id: string; name: string; description: string; builtin: boolean; policy: Policy }
interface Source { scope: string; key: string; templateId?: string; templateName?: string; disabled?: boolean }
interface PView { templates: Tpl[]; suggested: Record<string, string>; assignments: Record<string, { templateId?: string; policy?: Policy; disabled?: boolean }>; folders: string[]; clusters: { id: string; name: string; environment: string; folder: string; source: string; effective: { policy: Policy | null; source: Source } }[] }
const ENVS = ['prod', 'prep', 'int', 'dev', 'test'];
const ENV_LABEL: Record<string, string> = { prod: 'Produzione', prep: 'Pre-produzione', int: 'Integrazione', dev: 'Sviluppo', test: 'Test' };
const BLANK: Policy = { enabled: true, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 168, verifyDeep: false, retryAfterMinutes: 30 };

const hrs = (h: number) => (h <= 0 ? 'mai' : h % 168 === 0 ? `${h / 168 === 1 ? 'settimana' : `${h / 168} settimane`}` : h % 24 === 0 ? `${h / 24 === 1 ? 'giorno' : `${h / 24} giorni`}` : `${h} ore`);
export function summarize(p: Policy | null): string {
  if (!p) return 'Nessun backup automatico';
  return [`completo ogni ${hrs(p.fullEveryHours)}`, p.incrEveryHours ? `incrementale ogni ${hrs(p.incrEveryHours)}` : 'solo completi', `${p.retentionFull} ${p.retentionFull === 1 ? 'catena' : 'catene'}`, p.verifyEveryHours ? `verifica ogni ${hrs(p.verifyEveryHours)}${p.verifyDeep ? ' (approfondita)' : ''}` : 'nessuna verifica'].join(' · ');
}
/** Approximate worst-case data loss given the schedule (WAL archiving makes the real figure smaller). */
const rpoText = (p: Policy | null) => (!p ? '' : `Tra un backup e l’altro passano al massimo ${hrs(p.incrEveryHours || p.fullEveryHours)}; con i WAL archiviati il ripristino arriva fino all’ultimo segmento.`);
export function sourceText(s: Source | undefined): string {
  if (!s) return '';
  const t = s.templateName ? ` · modello “${s.templateName}”` : s.disabled ? '' : ' · personalizzata';
  switch (s.scope) {
    case 'cluster': return `Assegnata a questo cluster${t}`; case 'folder': return `Ereditata dalla cartella ${s.key.replace(/^folder:/, '')}${t}`;
    case 'env': return `Ereditata dall’ambiente ${s.key.replace(/^env:/, '')}${t}`; case 'global': return `Predefinita globale${t}`;
    case 'legacy': return 'Impostata prima dei modelli (personalizzata)'; default: return 'Nessuna strategia assegnata';
  }
}
const asgLabel = (a: PView['assignments'][string] | undefined, tpls: Tpl[]) => !a ? null : a.disabled ? 'Nessun backup automatico' : a.templateId ? (tpls.find(t => t.id === a.templateId)?.name || a.templateId) : 'Personalizzata';

function PolicyForm({ p, setP }: { p: Policy; setP: (p: Policy) => void }) {
  const n = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  return <div className="stack"><div className="grid g2">
    <Field label="Backup completo ogni (ore)"><input className="input" type="number" min={24} max={720} value={p.fullEveryHours} onChange={n('fullEveryHours')} /></Field>
    <Field label="Incrementale ogni (ore)" hint="0 = solo completi"><input className="input" type="number" min={0} max={168} value={p.incrEveryHours} onChange={n('incrEveryHours')} /></Field>
    <Field label="Catene da conservare"><input className="input" type="number" min={1} max={365} value={p.retentionFull} onChange={n('retentionFull')} /></Field>
    <Field label="Verifica ogni (ore)" hint="0 = mai. Include una prova di ripristino."><input className="input" type="number" min={0} max={720} value={p.verifyEveryHours} onChange={n('verifyEveryHours')} /></Field>
    <Field label="Riprova dopo un errore (minuti)"><input className="input" type="number" min={5} max={720} value={p.retryAfterMinutes} onChange={n('retryAfterMinutes')} /></Field></div>
    <label className="check"><input type="checkbox" checked={p.verifyDeep} onChange={e => setP({ ...p, verifyDeep: e.target.checked })} />Verifica approfondita (rilegge ogni blocco: più lenta)</label>
    <p className="small muted">{summarize(p)}</p></div>;
}

/** Choose what applies at one level: inherit / a template / custom / off. Saved straight to the policy tree. */
export function AssignDialog({ scope, k, label, env, view, onClose, onSaved }: { scope: 'global' | 'env' | 'folder' | 'cluster'; k: string; label: string; env?: string; view: PView; onClose: () => void; onSaved?: () => void }) {
  const cur = view.assignments[scope === 'global' ? 'global' : `${scope}:${k}`];
  const suggestedId = env ? view.suggested[env] : scope === 'env' ? view.suggested[k] : undefined;
  const [mode, setMode] = useState<string>(!cur ? 'inherit' : cur.disabled ? 'off' : cur.templateId ? `t:${cur.templateId}` : 'custom');
  const [pol, setPol] = useState<Policy>(cur?.policy || (view.templates.find(t => t.id === suggestedId)?.policy ?? BLANK));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body: any = { scope, key: k };
      if (mode === 'inherit') body.inherit = true; else if (mode === 'off') body.disabled = true; else if (mode === 'custom') body.policy = pol; else body.templateId = mode.slice(2);
      await api('PUT', '/api/policies/assignments', body);
      revalidate('/api/policies'); onSaved?.(); toast('Strategia aggiornata', 'ok'); onClose();
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  const opt = (v: string, title: React.ReactNode, sub?: string) => <label key={v} className={`opt ${mode === v ? 'on' : ''}`}><input type="radio" name="asg" checked={mode === v} onChange={() => setMode(v)} /><div><div>{title}</div>{sub ? <div className="small muted">{sub}</div> : null}</div></label>;
  return <Modal wide title={`Strategia di backup — ${label}`} onClose={onClose} footer={<><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} onClick={save}>Salva</Button></>}>
    <div className="stack">
      {scope !== 'global' ? opt('inherit', 'Eredita dal livello superiore', 'Segue la cartella, l’ambiente o il valore globale: cambia da sola se cambiano quelli.') : null}
      {view.templates.map(t => opt(`t:${t.id}`, <span className="row gap-s"><strong>{t.name}</strong>{t.id === suggestedId ? <Badge kind="accent">Consigliato</Badge> : null}{!t.builtin ? <Badge>Tuo</Badge> : null}</span>, summarize(t.policy)))}
      {opt('custom', <strong>Personalizzata</strong>, 'Valori solo per questo livello.')}
      {mode === 'custom' ? <div className="opt-body"><PolicyForm p={pol} setP={setPol} /></div> : null}
      {opt('off', <strong>Nessun backup automatico</strong>, 'Blocca la pianificazione qui (e sotto, se non ridefinita). I backup manuali restano possibili.')}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Compact card for the Backup tab: what applies to this cluster and where it comes from. */
export function StrategyCard({ c, policy, source, onSaved }: { c: any; policy: Policy | null; source?: Source; onSaved: () => void }) {
  const q = useQuery<PView>('/api/policies'); const [open, setOpen] = useState(false);
  const sug = q.data?.templates.find(t => t.id === q.data?.suggested[c.environment]);
  return <Card title="Strategia di backup" actions={<Button sm icon="settings" onClick={() => setOpen(true)} disabled={!q.data}>Cambia</Button>}>
    <div className="stack">
      {policy ? <><div className="row wrap gap-s"><Badge kind="ok">Attiva</Badge>{source?.templateName ? <Badge kind="accent">{source.templateName}</Badge> : null}</div><p style={{ margin: 0 }}>{summarize(policy)}</p><p className="small muted" style={{ margin: 0 }}>{rpoText(policy)}</p></>
        : <Banner kind="warn" title="Nessun backup automatico">{source?.disabled ? 'La pianificazione è disattivata a questo livello.' : 'Nessuna strategia assegnata a questo cluster, alla sua cartella o all’ambiente.'}{sug ? ` Per ${c.environment} è consigliato “${sug.name}”.` : ''}</Banner>}
      <div className="small muted">{sourceText(source)}</div>
      <div className="row"><Button sm kind="ghost" onClick={() => go('strategy')}>Tutte le strategie</Button></div></div>
    {open && q.data ? <AssignDialog scope="cluster" k={c.id} label={c.name} env={c.environment} view={q.data} onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
  </Card>;
}

export function StrategyPage() {
  const q = useQuery<PView>('/api/policies', { interval: 10000 });
  const [dlg, setDlg] = useState<{ scope: 'global' | 'env' | 'folder' | 'cluster'; k: string; label: string; env?: string } | null>(null);
  const [edit, setEdit] = useState<Tpl | 'new' | null>(null); const [folderEdit, setFolderEdit] = useState<string | null>(null);
  const v = q.data;
  const uncovered = useMemo(() => (v?.clusters || []).filter(c => !c.effective.policy && c.source !== 'direct'), [v]);
  if (!v) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const envCount = (e: string) => v.clusters.filter(c => c.environment === e).length;
  const applySuggested = async () => {
    const envs = [...new Set(uncovered.map(c => c.environment))].filter(e => ENVS.includes(e));
    try { for (const e of envs) await api('PUT', '/api/policies/assignments', { scope: 'env', key: e, templateId: v.suggested[e] }); revalidate('/api/policies'); toast(`Strategie consigliate applicate a ${envs.length} ambiente/i`, 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); }
  };
  const del = async (t: Tpl) => { try { await api('DELETE', `/api/policies/templates/${t.id}`); revalidate('/api/policies'); toast('Modello eliminato', 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  const lineOf = (scope: 'global' | 'env' | 'folder', k: string) => asgLabel(v.assignments[scope === 'global' ? 'global' : `${scope}:${k}`], v.templates);
  const Line = ({ scope, k, title, sub, env }: { scope: 'global' | 'env' | 'folder'; k: string; title: string; sub?: string; env?: string }) => { const a = lineOf(scope, k); return <tr>
    <td><strong>{title}</strong>{sub ? <div className="small muted">{sub}</div> : null}</td>
    <td>{a ? <Badge kind={a === 'Nessun backup automatico' ? 'warn' : 'accent'}>{a}</Badge> : <span className="muted">Eredita</span>}</td>
    <td className="num"><Button sm onClick={() => setDlg({ scope, k, label: title, env })}>Assegna</Button></td></tr>; };
  return <>
    <div className="pagehead"><div className="grow"><h1>Strategie di backup</h1><p className="sub">Decidi una volta per ambiente o cartella; ogni cluster segue il livello più vicino. Un’assegnazione sul singolo cluster vince su tutto.</p></div></div>
    {uncovered.length ? <Banner kind="warn" title={`${uncovered.length} cluster senza backup automatico`} actions={<Button sm kind="primary" onClick={applySuggested}>Applica i consigliati per ambiente</Button>}>{uncovered.map(c => c.name).join(', ')}. Il modello consigliato dipende dall’ambiente (produzione → “{v.templates.find(t => t.id === v.suggested.prod)?.name}”).</Banner> : v.clusters.length ? <Banner kind="ok" title="Tutti i cluster hanno una strategia attiva" /> : null}
    <div className="stack-l" style={{ marginTop: 16 }}>
      <Card title="Livelli" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Livello</th><th>Assegnazione</th><th /></tr></thead><tbody>
        <Line scope="global" k="" title="Tutti i cluster" sub="Valore di riserva se nessun livello sotto è definito" />
        {ENVS.map(e => <Line key={e} scope="env" k={e} env={e} title={`Ambiente: ${ENV_LABEL[e]}`} sub={`${envCount(e)} cluster · consigliato: ${v.templates.find(t => t.id === v.suggested[e])?.name}`} />)}
        {v.folders.map(f => <Line key={f} scope="folder" k={f} title={`Cartella: ${f}`} sub={`${v.clusters.filter(c => c.folder === f || c.folder.startsWith(f + '/')).length} cluster`} />)}</tbody></table></div></Card>

      <Card title="Cluster" pad={false}>{!v.clusters.length ? <Empty icon="shield" title="Nessun cluster collegato" /> : <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Cartella</th><th>Strategia effettiva</th><th /></tr></thead><tbody>
        {v.clusters.map(c => <tr key={c.id}><td><a href={`#/c/${encodeURIComponent(c.id)}/backup`}><strong>{c.name}</strong></a><div className="small muted">{c.environment}</div></td>
          <td>{folderEdit === c.id ? <FolderEdit c={c} folders={v.folders} onDone={() => setFolderEdit(null)} /> : <button className="linkbtn" onClick={() => setFolderEdit(c.id)}>{c.folder || <span className="muted">— imposta</span>}</button>}</td>
          <td>{c.effective.policy ? <><div>{summarize(c.effective.policy)}</div><div className="small muted">{sourceText(c.effective.source)}</div></> : <><Badge kind="warn">Nessuna</Badge><div className="small muted">{sourceText(c.effective.source)}</div></>}</td>
          <td className="num"><Button sm onClick={() => setDlg({ scope: 'cluster', k: c.id, label: c.name, env: c.environment })}>Assegna</Button></td></tr>)}</tbody></table></div>}</Card>

      <Card title="Modelli" actions={<Button sm icon="plus" onClick={() => setEdit('new')}>Nuovo modello</Button>}>
        <div className="grid g3">{v.templates.map(t => <div key={t.id} className="tpl"><div className="row"><strong className="grow">{t.name}</strong>{!t.builtin ? <Badge>Tuo</Badge> : null}</div>
          <p className="small muted" style={{ margin: '6px 0' }}>{t.description || summarize(t.policy)}</p>
          <div className="small" style={{ marginBottom: 8 }}>{summarize(t.policy)}</div>
          <div className="row">{ENVS.filter(e => v.suggested[e] === t.id).map(e => <Badge key={e} kind="accent">consigliato {e}</Badge>)}<div className="grow" />
            <Button sm onClick={() => setEdit({ ...t, id: t.builtin ? '' : t.id, name: t.builtin ? `${t.name} (copia)` : t.name, builtin: false })}>{t.builtin ? 'Duplica' : 'Modifica'}</Button>
            {!t.builtin ? <Button sm kind="ghost" aria-label="Elimina modello" onClick={() => del(t)}><Icon n="trash" /></Button> : null}</div></div>)}</div></Card>
    </div>
    {dlg ? <AssignDialog scope={dlg.scope} k={dlg.k} label={dlg.label} env={dlg.env} view={v} onClose={() => setDlg(null)} /> : null}
    {edit ? <TemplateDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
  </>;
}

function FolderEdit({ c, folders, onDone }: { c: any; folders: string[]; onDone: () => void }) {
  const [f, setF] = useState(c.folder || '');
  const save = async () => { try { await api('PATCH', `/api/clusters/${encodeURIComponent(c.id)}`, { folder: f }); revalidate('/api/policies'); revalidate('/api/clusters'); onDone(); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  return <span className="row gap-s"><input className="input" style={{ width: 160 }} autoFocus list="folders" value={f} onChange={e => setF(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }} placeholder="es. banca/core" /><datalist id="folders">{folders.map(x => <option key={x} value={x} />)}</datalist>
    <Button sm kind="primary" onClick={save}>Salva</Button></span>;
}

function TemplateDialog({ t, onClose }: { t: Tpl | null; onClose: () => void }) {
  const [name, setName] = useState(t?.name || ''); const [desc, setDesc] = useState(t?.description || ''); const [pol, setPol] = useState<Policy>(t?.policy || BLANK);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const id = t?.id || name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/policies/templates/${id}`, { name, description: desc, policy: pol }); revalidate('/api/policies'); toast('Modello salvato', 'ok'); onClose(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={t?.id ? 'Modifica modello' : 'Nuovo modello'} onClose={onClose} footer={<><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} disabled={!name.trim() || id.length < 2} onClick={save}>Salva</Button></>}>
    <div className="stack"><Field label="Nome"><input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus /></Field>
      <Field label="Descrizione"><input className="input" value={desc} onChange={e => setDesc(e.target.value)} maxLength={300} /></Field>
      <PolicyForm p={pol} setP={setPol} />{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
