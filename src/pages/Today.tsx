import React from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Skeleton, ago, dday } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';
import { OP_LABEL } from './shared';
import { itCheck } from '../i18n';
import { untilLabel } from '../hbaLogic';

const SEV: Record<string, { label: string; kind: 'bad' | 'warn' | 'info' }> = { critical: { label: 'Urgent', kind: 'bad' }, warning: { label: 'Needs attention', kind: 'warn' }, info: { label: 'Information', kind: 'info' } };
const TYPE: Record<string, string> = { backup_run: 'Backup', backup_verify: 'Verification', backup_expire: 'Cleanup', restore_instance: 'Restore', restore_database: 'Restore', restore_object: 'Restore', restore_promote: 'Put back the table', hba_apply: 'Access rules', pg_set_param: 'Parameter' };

export function useHealth(interval = 20000) { return useQuery<any>('/api/briefing', { interval }); }

function PendingApprovals({ me, role }: { me: string; role: string }) {
  const q = useQuery<{ approvals: any[] }>('/api/approvals', { interval: 10000 });
  const list = (q.data?.approvals || []).filter(a => a.status === 'pending');
  const act = async (id: string, how: string) => { try { await api('POST', `/api/approvals/${id}/${how}`, {}); toast(how === 'approve' ? 'Approved: the operation has started' : how === 'reject' ? 'Request rejected' : 'Request cancelled', 'ok'); revalidate('/api/approvals'); revalidate('/api/operations'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  if (!list.length) return null;
  return <Card title="Awaiting approval"><div className="stack">{list.map(a => <div key={a.id} className="issue"><div className="row"><strong>{a.summary}</strong><div className="grow" /><span className="small muted">{a.clusterName} · {a.environment}</span></div>
    <p className="small muted" style={{ margin: '4px 0 6px' }}>Requested by {a.requestedBy} {ago(a.createdAt)}; {untilLabel(Date.parse(a.expiresAt))}.</p>
    <div className="row gap-s">{role === 'admin' && a.requestedBy !== me ? <><Button sm kind="primary" onClick={() => act(a.id, 'approve')}>Approve</Button><Button sm onClick={() => act(a.id, 'reject')}>Reject</Button></> : null}
      {a.requestedBy === me ? <Button sm onClick={() => act(a.id, 'cancel')}>Cancel the request</Button> : (role !== 'admin' ? <span className="small muted">An administrator is needed.</span> : null)}</div></div>)}</div></Card>;
}

export function TodayPage({ me, role }: { me: string; role: string }) {
  const q = useHealth(15000); const d = q.data;
  const open = (i: any) => go(i.action?.page === 'geo' ? 'geo' : String(i.clusterId).startsWith('worker:') ? `w/${encodeURIComponent(String(i.clusterId).slice(7))}` : i.action?.page === 'cluster' || !i.action?.page ? `c/${encodeURIComponent(i.clusterId)}` : i.action.page === 'strategy' ? 'strategy' : `c/${encodeURIComponent(i.clusterId)}/${i.action.page}`);
  return <>
    <div className="pagehead"><div className="grow"><h1>Today</h1><p className="sub">What needs attention now, with the likely cause and the next step.{d ? ` Updated ${ago(d.generatedAt)}.` : ''}</p></div></div>
    <PendingApprovals me={me} role={role} />
    {!d ? <Card><Skeleton h={80} /></Card> : <>
      <Banner kind={d.status === 'ok' ? 'ok' : d.status === 'critical' ? 'bad' : 'warn'} title={d.status === 'ok' ? 'All good' : d.status === 'critical' ? `${d.counts.critical} ${d.counts.critical === 1 ? 'urgent problem' : 'urgent problems'}` : 'Something needs attention'}>
        {d.status === 'ok' ? 'Recent backups, continuous WAL archive, replicas in sync, disks with free space.' : `${d.counts.critical} urgent, ${d.counts.warning} needing attention, ${d.counts.info} informational.`}
        {' '}Last 24 hours: {d.last24h.backups} {d.last24h.backups === 1 ? 'successful backup' : 'successful backups'}{d.last24h.failed ? <>, <strong>{d.last24h.failed} failed operations</strong></> : ', no failed operations'}{d.last24h.refused ? <>, {d.last24h.refused} refused by the checks before changing anything</> : ''}.</Banner>
      {d.issues.length ? <Card title="To do">
        <div className="stack">{d.issues.map((i: any) => <div key={i.key} className="issue">
          <div className="row"><Badge kind={SEV[i.severity].kind}>{SEV[i.severity].label}</Badge><strong>{i.title}</strong><div className="grow" /><span className="small muted">{i.clusterName} · {i.environment}</span></div>
          <p className="small muted" style={{ margin: '4px 0 6px' }}>{i.cause}</p>
          {i.action ? <Button sm onClick={() => open(i)}>{i.action.label}</Button> : null}</div>)}</div></Card> : null}
      {d.last24h.failures.length ? <Card title="Failed operations in the last 24 hours"><div className="tablewrap"><table className="t"><tbody>
        {d.last24h.failures.map((f: any) => <tr key={f.id}><td>{TYPE[f.type] || OP_LABEL[f.type] || f.type}</td><td className="muted">{f.error ? itCheck(f.error) : '—'}</td><td className="num small muted">{ago(f.at)}</td><td className="num"><Button sm onClick={() => go(`c/${encodeURIComponent(f.clusterId)}/operations`)}>Open</Button></td></tr>)}</tbody></table></div></Card> : null}
      {(d.last24h.refusals || []).length ? <details className="card" style={{ padding: '10px 16px' }}><summary className="small" style={{ cursor: 'pointer' }}>{d.last24h.refused} {d.last24h.refused === 1 ? 'operation refused' : 'operations refused'} by the checks (nothing was changed)</summary>
        <div className="tablewrap"><table className="t"><tbody>{d.last24h.refusals.map((f: any) => <tr key={f.id}><td>{TYPE[f.type] || OP_LABEL[f.type] || f.type}</td><td className="muted small">{f.error ? itCheck(f.error) : '—'}</td><td className="num small muted">{ago(f.at)}</td></tr>)}</tbody></table></div></details> : null}
      <Card title="Cluster"><div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Environment</th><th>Measured restore time</th><th>Status</th></tr></thead><tbody>
        {d.clusters.map((c: any) => <tr key={c.id} className="click" onClick={() => go(`c/${encodeURIComponent(c.id)}`)}><td><strong>{c.name}</strong>{c.folder ? <span className="faint small"> · {c.folder}</span> : null}</td><td>{c.environment}</td><td className="small">{c.rto ? <span title={`Drill of ${dday(c.rto.at)}`}>{c.rto.seconds >= 120 ? `${Math.round(c.rto.seconds / 60)} min` : `${Math.round(c.rto.seconds)} s`}</span> : <span className="muted">never tested</span>}</td>
          <td>{c.worst === 'ok' ? <Badge kind="ok">OK</Badge> : <Badge kind={SEV[c.worst].kind}>{c.issues} {c.issues === 1 ? 'issue' : 'issues'}</Badge>}</td></tr>)}
        {!d.clusters.length ? <tr><td colSpan={4} className="muted">No cluster with a connected agent.</td></tr> : null}</tbody></table></div></Card></>}
  </>;
}
