import React, { useState } from 'react';
import { api } from '../api';
import { Badge, Button, Card, Empty, Skeleton, dt } from '../ui';
import { go } from '../router';
import { toast, useQuery, useRole, revalidate, useDraft } from '../hooks';
import { OP_LABEL, STATUS_LABEL } from './shared';

/** Fasce orarie offerte nel pannello attività e nello storico (le ore oltre la conservazione impostata non hanno dati). */
export const WINDOWS: { h: number; label: string }[] = [
  { h: 1, label: 'Last hour' }, { h: 2, label: 'Last 2 hours' }, { h: 6, label: 'Last 6 hours' }, { h: 12, label: 'Last 12 hours' }, { h: 24, label: 'Last 24 hours' },
];
const LONG: { h: number; label: string }[] = [{ h: 72, label: 'Last 3 days' }, { h: 168, label: 'Last 7 days' }, { h: 336, label: 'Last 14 days' }, { h: 720, label: 'Last 30 days' }];
const KIND: Record<string, 'ok' | 'bad' | 'warn'> = { succeeded: 'ok', failed: 'bad', expired: 'warn', cancelled: 'warn' };

export function RetentionSetting() {
  const role = useRole(); const q = useQuery<{ retentionDays: number; defaultDays: number; maxDays: number }>('/api/activity-settings');
  const [v, setV] = useState<string>(''); const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const cur = v === '' ? String(q.data.retentionDays) : v;
  const save = async () => {
    setBusy(true);
    try { await api('PUT', '/api/activity-settings', { retentionDays: Number(cur) }); setV(''); revalidate('/api/activity-settings'); revalidate('/api/operations/history'); toast('Retention updated', 'ok'); }
    catch (e: any) { toast(e.body?.message || e.message, 'bad'); } setBusy(false);
  };
  return <div className="row wrap">
    <span className="small muted">History retention: {q.data.retentionDays} {q.data.retentionDays === 1 ? 'day' : 'days'} (default {q.data.defaultDays}).</span>
    {role === 'admin' ? <><input className="input" style={{ width: 80 }} type="number" min={1} max={q.data.maxDays} value={cur} onChange={e => setV(e.target.value)} aria-label="Days of history retention" />
      <Button sm onClick={save} busy={busy} disabled={cur === String(q.data.retentionDays)}>Save</Button></> : null}
  </div>;
}

export function HistoryPage({ clusters }: { clusters: any[] }) {
  const meta = useQuery<{ retentionDays: number }>('/api/activity-settings');
  const days = meta.data?.retentionDays ?? 7;
  const [hours, setHours] = useDraft('history:hours', 24); const [st, setSt] = useDraft('history:st', 'all'); const [cl, setCl] = useDraft('history:cl', 'all'); const [s, setS] = useDraft('history:s', ''); const [open, setOpen] = useDraft<string | null>('history:open', null);
  const wins = [...WINDOWS, ...LONG.filter(w => w.h <= days * 24)];
  const q = useQuery<{ total: number; operations: any[] }>(`/api/operations/history?hours=${hours}&status=${st}&clusterId=${encodeURIComponent(cl)}&search=${encodeURIComponent(s)}&limit=200`, { interval: 15000 });
  return <>
    <div className="pagehead"><div className="grow"><h1>Operation history</h1><p className="sub">Finished backups, restores and other actions: outcome, duration and error cause.</p></div></div>
    <div className="row wrap">
      <select className="input" style={{ width: 170 }} value={hours} onChange={e => setHours(Number(e.target.value))} aria-label="Time window">{wins.map(w => <option key={w.h} value={w.h}>{w.label}</option>)}</select>
      <select className="input" style={{ width: 150 }} value={st} onChange={e => setSt(e.target.value)} aria-label="Outcome"><option value="all">Any outcome</option><option value="failed">Failed only</option><option value="succeeded">Succeeded only</option></select>
      <select className="input" style={{ width: 200 }} value={cl} onChange={e => setCl(e.target.value)} aria-label="Cluster"><option value="all">All clusters</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <input className="input" style={{ maxWidth: 260 }} placeholder="Search (type, user, error)" value={s} onChange={e => setS(e.target.value)} />
    </div>
    <Card pad={false}>{q.loading && !q.data ? <div className="bd"><Skeleton h={80} /></div> : !q.data?.operations.length ? <Empty icon="list" title="No operations in this window" /> :
      <div className="tablewrap"><table className="t"><thead><tr><th>Finished</th><th>Operation</th><th>Cluster</th><th>User</th><th>Outcome</th><th>Duration</th></tr></thead><tbody>
        {q.data.operations.map(o => {
          const secs = Math.max(0, Math.round((Date.parse(o.updatedAt) - Date.parse(o.createdAt)) / 1000)); const dur = secs < 60 ? `${secs} s` : secs < 3600 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`;
          return <React.Fragment key={o.id}><tr className={o.error ? 'click' : undefined} onClick={() => o.error && setOpen(open === o.id ? null : o.id)}>
            <td className="nowrap">{dt(o.updatedAt)}</td><td>{OP_LABEL[o.type] || o.type}{o.subtype ? <span className="faint small"> ({o.subtype})</span> : null}</td>
            <td>{o.clusterName ? <a href={`#/c/${encodeURIComponent(o.clusterId)}/operations`} onClick={e => e.stopPropagation()}>{o.clusterName}</a> : '—'}</td><td>{o.createdBy || '—'}</td>
            <td><Badge kind={KIND[o.status] || 'warn'}>{STATUS_LABEL[o.status] || o.status}</Badge></td><td className="num small muted">{dur}</td></tr>
            {open === o.id && o.error ? <tr><td colSpan={6}><div className="err" style={{ whiteSpace: 'pre-wrap' }}>{o.error}</div></td></tr> : null}</React.Fragment>;
        })}</tbody></table></div>}</Card>
    <div className="row wrap">{q.data ? <span className="faint small">{q.data.total} operations{q.data.total > 200 ? ' — showing the latest 200' : ''}. Click a row with an error to read it.</span> : null}<div className="grow" /><RetentionSetting /></div>
  </>;
}
