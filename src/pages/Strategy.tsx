import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Empty, Field, Icon, Modal, Skeleton } from '../ui';
import { revalidate, toast, useQuery, clearDrafts, useDraft } from '../hooks';
import { go } from '../router';

interface Policy { enabled: boolean; fullEveryHours: number; incrEveryHours: number; retentionFull: number; verifyEveryHours: number; verifyDeep: boolean; retryAfterMinutes: number }
interface Tpl { id: string; name: string; description: string; builtin: boolean; policy: Policy }
interface Source { scope: string; key: string; templateId?: string; templateName?: string; disabled?: boolean }
interface PView { templates: Tpl[]; suggested: Record<string, string>; assignments: Record<string, { templateId?: string; policy?: Policy; disabled?: boolean }>; folders: string[]; clusters: { id: string; name: string; environment: string; folder: string; source: string; effective: { policy: Policy | null; source: Source } }[] }
const ENVS = ['prod', 'prep', 'int', 'dev', 'test'];
const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test' };
const BLANK: Policy = { enabled: true, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 168, verifyDeep: false, retryAfterMinutes: 30 };

const hrs = (h: number) => (h <= 0 ? 'never' : h % 168 === 0 ? `${h / 168 === 1 ? 'week' : `${h / 168} weeks`}` : h % 24 === 0 ? `${h / 24 === 1 ? 'day' : `${h / 24} days`}` : `${h} hours`);
export function summarize(p: Policy | null): string {
  if (!p) return 'No automatic backups';
  return [`full every ${hrs(p.fullEveryHours)}`, p.incrEveryHours ? `incremental every ${hrs(p.incrEveryHours)}` : 'full only', `${p.retentionFull} ${p.retentionFull === 1 ? 'chain' : 'chains'} kept`, p.verifyEveryHours ? `verify every ${hrs(p.verifyEveryHours)}${p.verifyDeep ? ' (deep)' : ''}` : 'no verification'].join(' · ');
}
/** Approximate worst-case data loss given the schedule (WAL archiving makes the real figure smaller). */
const rpoText = (p: Policy | null) => (!p ? '' : `At most ${hrs(p.incrEveryHours || p.fullEveryHours)} between two backups; with archived WAL, restores reach the last segment.`);
export function sourceText(s: Source | undefined): string {
  if (!s) return '';
  const t = s.templateName ? ` · template “${s.templateName}”` : s.disabled ? '' : ' · custom';
  switch (s.scope) {
    case 'cluster': return `Assigned to this cluster${t}`; case 'folder': return `Inherited from folder ${s.key.replace(/^folder:/, '')}${t}`;
    case 'env': return `Inherited from environment ${s.key.replace(/^env:/, '')}${t}`; case 'global': return `Global default${t}`;
    case 'legacy': return 'Set before templates existed (custom)'; default: return 'No policy assigned';
  }
}
const asgLabel = (a: PView['assignments'][string] | undefined, tpls: Tpl[]) => !a ? null : a.disabled ? 'No automatic backups' : a.templateId ? (tpls.find(t => t.id === a.templateId)?.name || a.templateId) : 'Custom';

function PolicyForm({ p, setP }: { p: Policy; setP: (p: Policy) => void }) {
  const n = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  return <div className="stack"><div className="grid g2">
    <Field label="Full backup every (hours)"><input className="input" type="number" min={24} max={720} value={p.fullEveryHours} onChange={n('fullEveryHours')} /></Field>
    <Field label="Incremental every (hours)" hint="0 = full only"><input className="input" type="number" min={0} max={168} value={p.incrEveryHours} onChange={n('incrEveryHours')} /></Field>
    <Field label="Chains to keep"><input className="input" type="number" min={1} max={365} value={p.retentionFull} onChange={n('retentionFull')} /></Field>
    <Field label="Verify every (hours)" hint="0 = never. Includes a test restore."><input className="input" type="number" min={0} max={720} value={p.verifyEveryHours} onChange={n('verifyEveryHours')} /></Field>
    <Field label="Retry after an error (minutes)"><input className="input" type="number" min={5} max={720} value={p.retryAfterMinutes} onChange={n('retryAfterMinutes')} /></Field></div>
    <label className="check"><input type="checkbox" checked={p.verifyDeep} onChange={e => setP({ ...p, verifyDeep: e.target.checked })} />Deep verification (reads back every chunk: slower)</label>
    <p className="small muted">{summarize(p)}</p></div>;
}

/** Choose what applies at one level: inherit / a template / custom / off. Saved straight to the policy tree. */
export function AssignDialog({ scope, k, label, env, view, onClose, onSaved }: { scope: 'global' | 'env' | 'folder' | 'cluster'; k: string; label: string; env?: string; view: PView; onClose: () => void; onSaved?: () => void }) {
  const cur = view.assignments[scope === 'global' ? 'global' : `${scope}:${k}`];
  const suggestedId = env ? view.suggested[env] : scope === 'env' ? view.suggested[k] : undefined;
  const DK = `assign:${scope}:${k}`; const close = () => { clearDrafts(DK); onClose(); };
  const [mode, setMode] = useDraft<string>(DK + ':mode', !cur ? 'inherit' : cur.disabled ? 'off' : cur.templateId ? `t:${cur.templateId}` : 'custom');
  const [pol, setPol] = useDraft<Policy>(DK + ':pol', cur?.policy || (view.templates.find(t => t.id === suggestedId)?.policy ?? BLANK));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body: any = { scope, key: k };
      if (mode === 'inherit') body.inherit = true; else if (mode === 'off') body.disabled = true; else if (mode === 'custom') body.policy = pol; else body.templateId = mode.slice(2);
      await api('PUT', '/api/policies/assignments', body);
      revalidate('/api/policies'); onSaved?.(); toast('Policy updated', 'ok'); close();
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  const opt = (v: string, title: React.ReactNode, sub?: string) => <label key={v} className={`opt ${mode === v ? 'on' : ''}`}><input type="radio" name="asg" checked={mode === v} onChange={() => setMode(v)} /><div><div>{title}</div>{sub ? <div className="small muted">{sub}</div> : null}</div></label>;
  return <Modal wide title={`Backup policy — ${label}`} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
    <div className="stack">
      {scope !== 'global' ? opt('inherit', 'Inherit from the level above', 'Follows the folder, the environment or the global value: changes by itself when those change.') : null}
      {view.templates.map(t => opt(`t:${t.id}`, <span className="row gap-s"><strong>{t.name}</strong>{t.id === suggestedId ? <Badge kind="accent">Recommended</Badge> : null}{!t.builtin ? <Badge>Yours</Badge> : null}</span>, summarize(t.policy)))}
      {opt('custom', <strong>Custom</strong>, 'Values for this level only.')}
      {mode === 'custom' ? <div className="opt-body"><PolicyForm p={pol} setP={setPol} /></div> : null}
      {opt('off', <strong>No automatic backups</strong>, 'Stops scheduling here (and below, unless redefined). Manual backups are still possible.')}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Compact card for the Backup tab: what applies to this cluster and where it comes from. */
export function StrategyCard({ c, policy, source, onSaved }: { c: any; policy: Policy | null; source?: Source; onSaved: () => void }) {
  const q = useQuery<PView>('/api/policies'); const [open, setOpen] = useDraft(`strategycard:${c.id}`, false);
  const sug = q.data?.templates.find(t => t.id === q.data?.suggested[c.environment]);
  return <Card title="Backup policy" actions={<Button sm icon="settings" onClick={() => setOpen(true)} disabled={!q.data}>Change</Button>}>
    <div className="stack">
      {policy ? <><div className="row wrap gap-s"><Badge kind="ok">Active</Badge>{source?.templateName ? <Badge kind="accent">{source.templateName}</Badge> : null}</div><p style={{ margin: 0 }}>{summarize(policy)}</p><p className="small muted" style={{ margin: 0 }}>{rpoText(policy)}</p></>
        : <Banner kind="warn" title="No automatic backups">{source?.disabled ? 'Scheduling is disabled at this level.' : 'No policy is assigned to this cluster, its folder or its environment.'}{sug ? ` For ${c.environment}, “${sug.name}” is recommended.` : ''}</Banner>}
      <div className="small muted">{sourceText(source)}</div>
      <div className="row"><Button sm kind="ghost" onClick={() => go('strategy')}>All policies</Button></div></div>
    {open && q.data ? <AssignDialog scope="cluster" k={c.id} label={c.name} env={c.environment} view={q.data} onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
  </Card>;
}

export function StrategyPage() {
  const q = useQuery<PView>('/api/policies', { interval: 10000 });
  const [dlg, setDlg] = useDraft<{ scope: 'global' | 'env' | 'folder' | 'cluster'; k: string; label: string; env?: string } | null>('strategy:dlg', null);
  const [edit, setEdit] = useDraft<Tpl | 'new' | null>('strategy:edit', null); const [folderEdit, setFolderEdit] = useDraft<string | null>('strategy:folder', null);
  const v = q.data;
  const uncovered = useMemo(() => (v?.clusters || []).filter(c => !c.effective.policy && c.source !== 'direct'), [v]);
  if (!v) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const envCount = (e: string) => v.clusters.filter(c => c.environment === e).length;
  const applySuggested = async () => {
    const envs = [...new Set(uncovered.map(c => c.environment))].filter(e => ENVS.includes(e));
    try { for (const e of envs) await api('PUT', '/api/policies/assignments', { scope: 'env', key: e, templateId: v.suggested[e] }); revalidate('/api/policies'); toast(`Recommended policies applied to ${envs.length} environment(s)`, 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); }
  };
  const del = async (t: Tpl) => { try { await api('DELETE', `/api/policies/templates/${t.id}`); revalidate('/api/policies'); toast('Modello eliminato', 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  const lineOf = (scope: 'global' | 'env' | 'folder', k: string) => asgLabel(v.assignments[scope === 'global' ? 'global' : `${scope}:${k}`], v.templates);
  const Line = ({ scope, k, title, sub, env }: { scope: 'global' | 'env' | 'folder'; k: string; title: string; sub?: string; env?: string }) => { const a = lineOf(scope, k); return <tr>
    <td><strong>{title}</strong>{sub ? <div className="small muted">{sub}</div> : null}</td>
    <td>{a ? <Badge kind={a === 'No automatic backups' ? 'warn' : 'accent'}>{a}</Badge> : <span className="muted">Inherits</span>}</td>
    <td className="num"><Button sm onClick={() => setDlg({ scope, k, label: title, env })}>Assign</Button></td></tr>; };
  return <>
    <div className="pagehead"><div className="grow"><h1>Backup policies</h1><p className="sub">Decide once per environment or folder; every cluster follows the closest level. An assignment on a single cluster overrides everything.</p></div></div>
    {uncovered.length ? <Banner kind="warn" title={`${uncovered.length} cluster(s) without automatic backups`} actions={<Button sm kind="primary" onClick={applySuggested}>Apply the recommended ones per environment</Button>}>{uncovered.map(c => c.name).join(', ')}. The recommended template depends on the environment (production → “{v.templates.find(t => t.id === v.suggested.prod)?.name}”).</Banner> : v.clusters.length ? <Banner kind="ok" title="Every cluster has an active policy" /> : null}
    <div className="stack-l" style={{ marginTop: 16 }}>
      <Card title="Levels" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Level</th><th>Assignment</th><th /></tr></thead><tbody>
        <Line scope="global" k="" title="All clusters" sub="Fallback value when no level below is set" />
        {ENVS.map(e => <Line key={e} scope="env" k={e} env={e} title={`Environment: ${ENV_LABEL[e]}`} sub={`${envCount(e)} cluster(s) · recommended: ${v.templates.find(t => t.id === v.suggested[e])?.name}`} />)}
        {v.folders.map(f => <Line key={f} scope="folder" k={f} title={`Folder: ${f}`} sub={`${v.clusters.filter(c => c.folder === f || c.folder.startsWith(f + '/')).length} cluster(s)`} />)}</tbody></table></div></Card>

      <Card title="Cluster" pad={false}>{!v.clusters.length ? <Empty icon="shield" title="No connected clusters" /> : <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Folder</th><th>Effective policy</th><th /></tr></thead><tbody>
        {v.clusters.map(c => <tr key={c.id}><td><a href={`#/c/${encodeURIComponent(c.id)}/backup`}><strong>{c.name}</strong></a><div className="small muted">{c.environment}</div></td>
          <td>{folderEdit === c.id ? <FolderEdit c={c} folders={v.folders} onDone={() => setFolderEdit(null)} /> : <button className="linkbtn" onClick={() => setFolderEdit(c.id)}>{c.folder || <span className="muted">— set</span>}</button>}</td>
          <td>{c.effective.policy ? <><div>{summarize(c.effective.policy)}</div><div className="small muted">{sourceText(c.effective.source)}</div></> : <><Badge kind="warn">None</Badge><div className="small muted">{sourceText(c.effective.source)}</div></>}</td>
          <td className="num"><Button sm onClick={() => setDlg({ scope: 'cluster', k: c.id, label: c.name, env: c.environment })}>Assign</Button></td></tr>)}</tbody></table></div>}</Card>

      <Card title="Templates" actions={<Button sm icon="plus" onClick={() => setEdit('new')}>New template</Button>}>
        <div className="grid g3">{v.templates.map(t => <div key={t.id} className="tpl"><div className="row"><strong className="grow">{t.name}</strong>{!t.builtin ? <Badge>Yours</Badge> : null}</div>
          <p className="small muted" style={{ margin: '6px 0' }}>{t.description || summarize(t.policy)}</p>
          <div className="small" style={{ marginBottom: 8 }}>{summarize(t.policy)}</div>
          <div className="row wrap gap-s">{ENVS.filter(e => v.suggested[e] === t.id).map(e => <Badge key={e} kind="accent">recommended {e}</Badge>)}<div className="grow" />
            <Button sm onClick={() => setEdit({ ...t, id: t.builtin ? '' : t.id, name: t.builtin ? `${t.name} (copy)` : t.name, builtin: false })}>{t.builtin ? 'Duplicate' : 'Edit'}</Button>
            {!t.builtin ? <Button sm kind="ghost" aria-label="Delete template" onClick={() => del(t)}><Icon n="trash" /></Button> : null}</div></div>)}</div></Card>
    </div>
    {dlg ? <AssignDialog scope={dlg.scope} k={dlg.k} label={dlg.label} env={dlg.env} view={v} onClose={() => setDlg(null)} /> : null}
    {edit ? <TemplateDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
  </>;
}

function FolderEdit({ c, folders, onDone }: { c: any; folders: string[]; onDone: () => void }) {
  const [f, setF] = useDraft(`folderedit:${c.id}`, c.folder || '');
  const save = async () => { try { await api('PATCH', `/api/clusters/${encodeURIComponent(c.id)}`, { folder: f }); revalidate('/api/policies'); revalidate('/api/clusters'); onDone(); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  return <span className="row gap-s"><input className="input" style={{ width: 160 }} autoFocus list="folders" value={f} onChange={e => setF(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onDone(); }} placeholder="e.g. bank/core" /><datalist id="folders">{folders.map(x => <option key={x} value={x} />)}</datalist>
    <Button sm kind="primary" onClick={save}>Save</Button></span>;
}

function TemplateDialog({ t, onClose }: { t: Tpl | null; onClose: () => void }) {
  const DK = `tpl:${t?.id || 'new'}`; const close = () => { clearDrafts(DK); onClose(); };
  const [name, setName] = useDraft(DK + ':name', t?.name || ''); const [desc, setDesc] = useDraft(DK + ':desc', t?.description || ''); const [pol, setPol] = useDraft<Policy>(DK + ':pol', t?.policy || BLANK);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const id = t?.id || name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/policies/templates/${id}`, { name, description: desc, policy: pol }); revalidate('/api/policies'); toast('Template saved', 'ok'); close(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={t?.id ? 'Edit template' : 'New template'} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button kind="primary" busy={busy} disabled={!name.trim() || id.length < 2} onClick={save}>Save</Button></>}>
    <div className="stack"><Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus /></Field>
      <Field label="Description"><input className="input" value={desc} onChange={e => setDesc(e.target.value)} maxLength={300} /></Field>
      <PolicyForm p={pol} setP={setPol} />{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
