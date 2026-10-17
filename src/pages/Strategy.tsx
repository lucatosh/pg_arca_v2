import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Modal, Skeleton, nof } from '../ui';
import { revalidate, toast, useQuery, clearDrafts, useDraft, revalidateMatching, useRole } from '../hooks';
import { go } from '../router';

interface Policy { enabled: boolean; fullEveryHours: number; incrEveryHours: number; retentionFull: number; verifyEveryHours: number; verifyDeep: boolean; retryAfterMinutes: number; retentionDays?: number; preferStandby?: boolean; readLimitMBs?: number; windowStart?: number; windowEnd?: number; rpoTargetMinutes?: number; rtoTargetMinutes?: number; drillEveryDays?: number }
interface Tpl { id: string; name: string; description: string; builtin: boolean; policy: Policy }
interface Source { scope: string; key: string; templateId?: string; templateName?: string; disabled?: boolean }
interface PView { templates: Tpl[]; suggested: Record<string, string>; assignments: Record<string, { templateId?: string; policy?: Policy; disabled?: boolean }>; folders: string[]; clusters: { id: string; name: string; environment: string; folder: string; source: string; effective: { policy: Policy | null; source: Source }; standbySite?: boolean }[] }
const ENVS = ['prod', 'prep', 'int', 'dev', 'test'];
const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test' };
const BLANK: Policy = { enabled: true, fullEveryHours: 168, incrEveryHours: 24, retentionFull: 2, verifyEveryHours: 168, verifyDeep: false, retryAfterMinutes: 30 };

const hrs = (h: number) => (h <= 0 ? 'never' : h % 168 === 0 ? `${h / 168 === 1 ? 'week' : `${h / 168} weeks`}` : h % 24 === 0 ? `${h / 24 === 1 ? 'day' : `${h / 24} days`}` : h === 1 ? 'hour' : `${h} hours`);
export function summarize(p: Policy | null): string {
  if (!p) return 'No automatic backups';
  return [`full every ${hrs(p.fullEveryHours)}`, p.incrEveryHours ? `incremental every ${hrs(p.incrEveryHours)}` : 'full only', `${p.retentionDays ? `${p.retentionDays} days of point-in-time recovery, ` : ''}${p.retentionFull} full ${p.retentionFull === 1 ? 'backup' : 'backups'} kept`, p.verifyEveryHours ? `verify every ${hrs(p.verifyEveryHours)}${p.verifyDeep ? ' (deep)' : ''}` : 'no verification', ...(p.drillEveryDays ? [`restore drill every ${p.drillEveryDays} days`] : []), ...(p.preferStandby ? ['from a replica when possible'] : []), ...(p.readLimitMBs ? [`read limit ${p.readLimitMBs} MB/s`] : []), ...((p.windowStart ?? 0) !== (p.windowEnd ?? 0) ? [`fulls and verifications ${String(p.windowStart).padStart(2, '0')}:00–${String(p.windowEnd).padStart(2, '0')}:00`] : []), ...(p.rpoTargetMinutes ? [`RPO objective ${mins(p.rpoTargetMinutes)}`] : []), ...(p.rtoTargetMinutes ? [`RTO objective ${mins(p.rtoTargetMinutes)}`] : [])].join(' · ');
}
/** Approximate worst-case data loss given the schedule (WAL archiving makes the real figure smaller). */
const rpoText = (p: Policy | null) => (!p ? '' : `A backup at least every ${hrs(p.incrEveryHours || p.fullEveryHours)}; with continuous WAL archiving, any point up to the last archived segment can be restored.`);
export function sourceText(s: Source | undefined): string {
  if (!s) return '';
  const t = s.templateName ? ` · template “${s.templateName}”` : s.disabled ? '' : ' · custom';
  switch (s.scope) {
    case 'cluster': return `Assigned to this cluster${t}`; case 'folder': return `Inherited from folder ${s.key.replace(/^folder:/, '')}${t}`;
    case 'env': return `Inherited from environment ${s.key.replace(/^env:/, '')}${t}`; case 'global': return `Global default${t}`;
    case 'legacy': return 'Set before templates existed (custom)'; default: return 'No policy assigned';
  }
}
/** A policy or template change moves the recovery objectives of the clusters it applies to: refresh them with the policies. */
const revalidatePolicies = () => { revalidate('/api/policies'); revalidateMatching(/^\/api\/clusters\/[^/]+\/objectives$/); };
const asgLabel = (a: PView['assignments'][string] | undefined, tpls: Tpl[]) => !a ? null : a.disabled ? 'No automatic backups' : a.templateId ? (tpls.find(t => t.id === a.templateId)?.name || a.templateId) : 'Custom';

const mins = (m: number) => m >= 120 ? `${(m / 60).toFixed(1).replace(/\.0$/, '')} h` : `${m} min`;
/** Choices a person reads in days and frequencies (an independent review: "the policy editor speaks in hours and chains"). What a business
 *  decides first - how far back it can go - comes first; the mechanics (chains, retries, windows, limits) are under "Advanced". */
const FULL_EVERY: [number, string][] = [[24, 'Every day'], [48, 'Every 2 days'], [168, 'Every week'], [336, 'Every 2 weeks'], [720, 'Every 30 days']];
const INCR_EVERY: [number, string][] = [[0, 'None (full backups only)'], [1, 'Every hour'], [4, 'Every 4 hours'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Every day']];
const VERIFY_EVERY: [number, string][] = [[0, 'Never'], [24, 'Every day'], [168, 'Every week'], [720, 'Every 30 days']];
const DRILL_EVERY: [number, string][] = [[0, 'Never'], [7, 'Every week'], [30, 'Every 30 days'], [90, 'Every 90 days']];
function Every({ label, hint, value, choices, unit, min, max, onChange }: { label: string; hint?: string; value: number; choices: [number, string][]; unit: string; min: number; max: number; onChange: (v: number) => void }) {
  const known = choices.some(([v]) => v === value);
  return <Field label={label} hint={hint}><div className="row gap-s">
    <select className="input" value={known ? String(value) : 'custom'} onChange={e => onChange(e.target.value === 'custom' ? (known ? Math.max(min, value || min) : value) : Number(e.target.value))} style={{ maxWidth: 230 }}>
      {choices.map(([v, t]) => <option key={v} value={v}>{t}</option>)}<option value="custom">Other…</option></select>
    {!known ? <><input className="input" type="number" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} style={{ width: 90 }} aria-label={`${label} (${unit})`} /><span className="small muted">{unit}</span></> : null}</div></Field>;
}
function PolicyForm({ p, setP }: { p: Policy; setP: (p: Policy) => void }) {
  const n = (k: keyof Policy) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  const [adv, setAdv] = useState(false);
  return <div className="stack">
    <Field label="Keep point-in-time recovery for at least (days)" hint="Backups and WAL needed to restore any point of the last N days are kept, as long as the WAL archive is continuous (0 = keep only the number of full backups set under Advanced)."><input className="input" type="number" min={0} max={3650} value={p.retentionDays ?? 0} onChange={n('retentionDays')} style={{ maxWidth: 140 }} /></Field>
    <div className="grid g2">
      <Every label="Full backup" value={p.fullEveryHours} choices={FULL_EVERY} unit="hours" min={24} max={720} onChange={v => setP({ ...p, fullEveryHours: v })} />
      <Every label="Incremental backup" hint="Only what changed since the previous backup: fast and small." value={p.incrEveryHours} choices={INCR_EVERY} unit="hours" min={0} max={168} onChange={v => setP({ ...p, incrEveryHours: v })} />
    </div>
    <div className="grid g2"><Field label="Recovery point objective (minutes, 0 = none)" hint="Maximum acceptable data loss: compared with the measured recovery point (age of the oldest WAL not yet archived)."><input className="input" type="number" min={0} max={10080} value={p.rpoTargetMinutes ?? 0} onChange={n('rpoTargetMinutes')} /></Field>
    <Field label="Recovery time objective (minutes, 0 = none)" hint="How long the business accepts to wait for the whole cluster back: compared with the last disaster recovery drill, scaled to today's size."><input className="input" type="number" min={0} max={100000} value={p.rtoTargetMinutes ?? 0} onChange={n('rtoTargetMinutes')} /></Field></div>
    <Every label="Verify the backups" hint="Checks that every chunk of every backup is present (deep verification under Advanced also reads and checksums them) and test-restores the latest backup." value={p.verifyEveryHours} choices={VERIFY_EVERY} unit="hours" min={0} max={720} onChange={v => setP({ ...p, verifyEveryHours: v })} />
    <Every label="Disaster recovery drill" hint="Restores the whole cluster into a scratch directory, starts it, checks every database and measures the restore time. Proves restorability and keeps the restore time current." value={p.drillEveryDays || 0} choices={DRILL_EVERY} unit="days" min={0} max={365} onChange={v => setP({ ...p, drillEveryDays: v })} />
    <button type="button" className="linkbtn small" aria-expanded={adv} onClick={() => setAdv(!adv)}>{adv ? 'Hide the advanced settings' : 'Advanced: full backups kept, hours for heavy work, read limit, replica, retries'}</button>
    {adv ? <div className="stack" style={{ paddingLeft: 12, borderLeft: '2px solid var(--line)' }}>
      <div className="grid g2"><Field label="Full backups kept (with their incrementals)" hint="The oldest beyond this number are removed, unless still needed for the days above."><input className="input" type="number" min={1} max={365} value={p.retentionFull} onChange={n('retentionFull')} /></Field>
      <Field label="Retry after an error (minutes)"><input className="input" type="number" min={5} max={720} value={p.retryAfterMinutes} onChange={n('retryAfterMinutes')} /></Field></div>
      <label className="check"><input type="checkbox" checked={p.verifyDeep} onChange={e => setP({ ...p, verifyDeep: e.target.checked })} />Deep verification (reads back every chunk: slower)</label>
    <Field label="Hours for full backups and verifications (console server time zone)" hint="Heavy work only between these hours, e.g. 22 → 06 for the night; the same hour twice = any time. Incrementals run whenever they are due. A cluster with no full backup yet gets one right away."><div className="row gap-s"><input className="input" type="number" min={0} max={23} style={{ width: 80 }} value={p.windowStart ?? 0} onChange={e => setP({ ...p, windowStart: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /><span className="muted">→</span><input className="input" type="number" min={0} max={23} style={{ width: 80 }} value={p.windowEnd ?? 0} onChange={e => setP({ ...p, windowEnd: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></div></Field>
    <Field label="Read rate limit (MB/s, 0 = none)" hint="How fast a scheduled backup may read the data directory: a ceiling that keeps backups from saturating production storage (the copy takes proportionally longer). Manual backups are not limited."><input className="input" type="number" min={0} max={100000} value={p.readLimitMBs ?? 0} onChange={e => setP({ ...p, readLimitMBs: Math.max(0, Number(e.target.value) || 0) })} /></Field>
    <label className="check"><input type="checkbox" checked={!!p.preferStandby} onChange={e => setP({ ...p, preferStandby: e.target.checked })} /><span>Take scheduled backups on a streaming replica when possible <span className="small muted">— the primary does not read its data files; used only when the backup storage is a shared NFS/SMB share (a replica cannot see a per-node local WAL archive), otherwise the primary is used</span></span></label>
    </div> : null}
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
      revalidatePolicies(); onSaved?.(); toast('Policy updated', 'ok'); close();
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

/** The policy recommended for a cluster's environment, assignable in one click (to the cluster only: nothing else changes). */
export function useRecommended(c: any, onSaved: () => void) {
  const q = useQuery<PView>('/api/policies'); const [busy, setBusy] = useState(false);
  const sug = q.data?.templates.find(t => t.id === q.data?.suggested[c.environment]) || null;
  const assign = async () => {
    if (!sug) return; setBusy(true);
    try { await api('PUT', '/api/policies/assignments', { scope: 'cluster', key: c.id, templateId: sug.id }); revalidatePolicies(); onSaved(); toast(`Backups of ${c.name} scheduled with “${sug.name}”`, 'ok'); }
    catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); }
  };
  return { sug, assign, busy };
}

/** Compact card for the Backup tab: what applies to this cluster and where it comes from. */
export function StrategyCard({ c, policy, source, onSaved }: { c: any; policy: Policy | null; source?: Source; onSaved: () => void }) {
  const q = useQuery<PView>('/api/policies'); const [open, setOpen] = useDraft(`strategycard:${c.id}`, false);
  const sug = q.data?.templates.find(t => t.id === q.data?.suggested[c.environment]);
  const admin = useRole() === 'admin';                     // assigning a policy is for administrators (the server refuses the others)
  return <Card title="Backup policy" actions={admin ? <Button sm icon="settings" onClick={() => setOpen(true)} disabled={!q.data}>Change</Button> : undefined}>
    <div className="stack">
      {policy ? <><div className="row wrap gap-s"><Badge kind="ok">Active</Badge>{source?.templateName ? <Badge kind="accent">{source.templateName}</Badge> : null}</div><p style={{ margin: 0 }}>{summarize(policy)}</p><p className="small muted" style={{ margin: 0 }}>{rpoText(policy)}</p></>
        : <div><strong>No automatic backups</strong><p className="small muted" style={{ margin: '4px 0 0' }}>{source?.disabled ? 'Scheduling is disabled at this level.' : 'No policy is assigned to this cluster, its folder or its environment.'}{sug ? ` For ${ENV_LABEL[c.environment] || c.environment}, “${sug.name}” is recommended.` : ''}</p></div>}
      {policy ? <div className="small muted">{sourceText(source)}</div> : null}
      <div className="row">{!policy && admin ? <Button sm onClick={() => setOpen(true)} disabled={!q.data}>Choose a policy…</Button> : null}<Button sm kind="ghost" onClick={() => go('strategy')}>All policies</Button></div></div>
    {open && q.data ? <AssignDialog scope="cluster" k={c.id} label={c.name} env={c.environment} view={q.data} onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
  </Card>;
}

export function StrategyPage() {
  const q = useQuery<PView>('/api/policies', { interval: 10000 });
  const [dlg, setDlg] = useDraft<{ scope: 'global' | 'env' | 'folder' | 'cluster'; k: string; label: string; env?: string } | null>('strategy:dlg', null);
  const [edit, setEdit] = useDraft<Tpl | 'new' | null>('strategy:edit', null); const [folderEdit, setFolderEdit] = useDraft<string | null>('strategy:folder', null);
  const v = q.data;
  const uncovered = useMemo(() => (v?.clusters || []).filter(c => !c.effective.policy && c.source !== 'direct' && !c.standbySite), [v]);
  const [askApply, setAskApply] = useState(false);
  if (!v) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const envCount = (e: string) => v.clusters.filter(c => c.environment === e).length;
  const applySuggested = async () => {
    const envs = [...new Set(uncovered.map(c => c.environment))].filter(e => ENVS.includes(e));
    try { for (const e of envs) await api('PUT', '/api/policies/assignments', { scope: 'env', key: e, templateId: v.suggested[e] }); revalidatePolicies(); toast(`Recommended policies applied to ${nof(envs.length, 'environment')}`, 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); }
  };
  const del = async (t: Tpl) => { try { await api('DELETE', `/api/policies/templates/${t.id}`); revalidatePolicies(); toast('Template deleted', 'ok'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  const lineOf = (scope: 'global' | 'env' | 'folder', k: string) => asgLabel(v.assignments[scope === 'global' ? 'global' : `${scope}:${k}`], v.templates);
  const Line = ({ scope, k, title, sub, env }: { scope: 'global' | 'env' | 'folder'; k: string; title: string; sub?: string; env?: string }) => { const a = lineOf(scope, k); return <tr>
    <td><strong>{title}</strong>{sub ? <div className="small muted">{sub}</div> : null}</td>
    <td>{a ? <Badge kind={a === 'No automatic backups' ? 'warn' : 'accent'}>{a}</Badge> : <span className="muted">{scope === 'global' ? 'No policy (manual backups only)' : 'Inherits'}</span>}</td>
    <td className="num"><Button sm onClick={() => setDlg({ scope, k, label: title, env })}>Assign</Button></td></tr>; };
  return <>
    <div className="pagehead"><div className="grow"><h1>Backup policies</h1><p className="sub">Decide once per environment or folder; every cluster follows the closest level. An assignment on a single cluster overrides everything.</p></div></div>
    {uncovered.length ? <Banner kind="warn" title={`${nof(uncovered.length, 'cluster')} without automatic backups`} actions={<Button sm kind="primary" onClick={() => setAskApply(true)}>Apply the recommended ones per environment…</Button>}>{uncovered.map(c => c.name).join(', ')}. The recommended template depends on the environment (production → “{v.templates.find(t => t.id === v.suggested.prod)?.name}”).</Banner> : v.clusters.length ? <Banner kind="ok" title="Every cluster has an active policy" /> : null}
    {askApply ? <Confirm title="Apply the recommended policies?" confirmLabel="Apply" onClose={() => setAskApply(false)} onConfirm={() => { setAskApply(false); applySuggested(); }}>
      {/* whole environments change in one click: say exactly which, with what, and which clusters they reach */}
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{[...new Set(uncovered.map(c => c.environment))].filter(e => ENVS.includes(e)).map(e => <li key={e}>
        <strong>{ENV_LABEL[e] || e}</strong> → “{v.templates.find(t => t.id === v.suggested[e])?.name || v.suggested[e]}”: {nof(envCount(e), 'cluster')} of this environment ({v.clusters.filter(c => c.environment === e).map(c => c.name).join(', ')})</li>)}</ul>
      <p className="small muted">Backups start at the next scheduled time of each policy. A cluster or folder with its own assignment keeps it.</p></Confirm> : null}
    <div className="stack-l" style={{ marginTop: 16 }}>
      <Card title="Levels" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Level</th><th>Assignment</th><th /></tr></thead><tbody>
        <Line scope="global" k="" title="All clusters" sub="Applies wherever no environment, folder or cluster sets its own" />
        {ENVS.map(e => <Line key={e} scope="env" k={e} env={e} title={`Environment: ${ENV_LABEL[e]}`} sub={`${nof(envCount(e), 'cluster')} · recommended: ${v.templates.find(t => t.id === v.suggested[e])?.name}`} />)}
        {v.folders.map(f => <Line key={f} scope="folder" k={f} title={`Folder: ${f}`} sub={nof(v.clusters.filter(c => c.folder === f || c.folder.startsWith(f + '/')).length, 'cluster')} />)}</tbody></table></div></Card>

      <Card title="Clusters" pad={false}>{!v.clusters.length ? <Empty icon="shield" title="No connected clusters" /> : <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Folder</th><th>Effective policy</th><th /></tr></thead><tbody>
        {v.clusters.map(c => <tr key={c.id}><td><a href={`#/c/${encodeURIComponent(c.id)}/backup`}><strong>{c.name}</strong></a><div className="small muted">{c.environment}</div></td>
          <td>{folderEdit === c.id ? <FolderEdit c={c} folders={v.folders} onDone={() => setFolderEdit(null)} /> : <button className="linkbtn" onClick={() => setFolderEdit(c.id)}>{c.folder || <span className="muted">— set</span>}</button>}</td>
          <td>{c.effective.policy ? <><div>{summarize(c.effective.policy)}</div><div className="small muted">{sourceText(c.effective.source)}</div></> : <><Badge kind="warn">None</Badge><div className="small muted">{sourceText(c.effective.source)}</div></>}</td>
          <td className="num"><Button sm onClick={() => setDlg({ scope: 'cluster', k: c.id, label: c.name, env: c.environment })}>Assign</Button></td></tr>)}</tbody></table></div>}</Card>

      <Card title="Templates" actions={<Button sm icon="plus" onClick={() => setEdit('new')}>New template</Button>}>
        <div className="grid g3">{v.templates.map(t => <div key={t.id} className="tpl"><div className="row"><strong className="grow">{t.name}</strong>{!t.builtin ? <Badge>Yours</Badge> : null}</div>
          {t.description ? <p className="small muted" style={{ margin: '6px 0' }}>{t.description}</p> : null}
          <div className="small" style={{ margin: t.description ? '0 0 8px' : '6px 0 8px' }}>{summarize(t.policy)}</div>
          <div className="row wrap gap-s">{ENVS.filter(e => v.suggested[e] === t.id).map(e => <Badge key={e} kind="accent">Recommended for {ENV_LABEL[e] || e}</Badge>)}<div className="grow" />
            <Button sm onClick={() => setEdit({ ...t, id: t.builtin ? '' : t.id, name: t.builtin ? `${t.name} (copy)` : t.name, builtin: false })}>{t.builtin ? 'Duplicate' : 'Edit'}</Button>
            {!t.builtin ? <Button sm kind="ghost" aria-label="Delete template" onClick={() => del(t)}><Icon n="trash" /></Button> : null}</div></div>)}</div></Card>
    </div>
    {dlg ? <AssignDialog scope={dlg.scope} k={dlg.k} label={dlg.label} env={dlg.env} view={v} onClose={() => setDlg(null)} /> : null}
    {edit ? <TemplateDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} /> : null}
  </>;
}

function FolderEdit({ c, folders, onDone }: { c: any; folders: string[]; onDone: () => void }) {
  const [f, setF] = useDraft(`folderedit:${c.id}`, c.folder || '');
  const save = async () => { try { await api('PATCH', `/api/clusters/${encodeURIComponent(c.id)}`, { folder: f }); revalidatePolicies(); revalidate('/api/clusters'); onDone(); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
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
    try { await api('PUT', `/api/policies/templates/${id}`, { name, description: desc, policy: pol, ...(t?.id ? {} : { create: true }) }); revalidatePolicies(); toast('Template saved', 'ok'); close(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={t?.id ? 'Edit template' : 'New template'} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button kind="primary" busy={busy} disabled={!name.trim() || id.length < 2} onClick={save}>Save</Button></>}>
    <div className="stack"><Field label="Name"><input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus /></Field>
      <Field label="Description"><input className="input" value={desc} onChange={e => setDesc(e.target.value)} maxLength={300} /></Field>
      <PolicyForm p={pol} setP={setPol} />{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
