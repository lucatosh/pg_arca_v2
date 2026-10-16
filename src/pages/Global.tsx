import React, { useMemo, useState } from 'react';
import { api, uid } from '../api';
import { Badge, Banner, Button, Card, Empty, Icon, Skeleton, dt, num } from '../ui';
import { go } from '../router';
import { toast, useQuery, revalidate, useDraft } from '../hooks';
import { ActivitySwitch, OP_LABEL } from './shared';

/** The audit trail in words (independent review, round 2: raw 'op.submit:hba_plan', JSON details, every request an amber 'Warning'). The raw
 *  action stays as a tooltip: an auditor can still search and quote it. */
const actionText = (a: string) => { const m = /^op\.(submit:)?(.+)$/.exec(a || ''); if (m) return `${m[1] ? 'Requested: ' : ''}${OP_LABEL[m[2]] || m[2].replace(/_/g, ' ')}`;
  const t = String(a || '').replace(/[._:]+/g, ' ').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—'; };
const outcome = (st: string): [string, string] => { const u = String(st || '').toUpperCase();
  return u === 'SUCCESS' || u === 'SUCCEEDED' ? ['OK', 'ok'] : u === 'FAILED' || u === 'FAILURE' ? ['Failed', 'bad'] : u === 'QUEUED' ? ['Requested', ''] : u === 'RUNNING' ? ['Running', 'info']
    : u === 'CANCELLED' ? ['Cancelled', ''] : u === 'EXPIRED' ? ['Expired', 'warn'] : ['Warning', 'warn']; };
const detailsText = (d: any) => { if (d == null || d === '') return ''; let v = d; if (typeof d === 'string') { try { v = JSON.parse(d); } catch { return d; } }
  if (!v || typeof v !== 'object') return String(v); return Object.entries(v).filter(([k, x]) => x != null && x !== '' && k !== 'opId').map(([k, x]) => `${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${typeof x === 'object' ? JSON.stringify(x) : String(x)}`).join(' · '); };
export function Audit({ clusters }: { clusters: any[] }) {
  const [cl, setCl] = useDraft('audit:cl', 'all'); const [st, setSt] = useDraft('audit:st', 'all'); const [s, setS] = useDraft('audit:s', '');
  const q = useQuery<{ total: number; entries: any[] }>(`/api/audit/history?limit=200&clusterId=${cl}&status=${st}&search=${encodeURIComponent(s)}`, { interval: 10000 });
  return <>
    <div className="pagehead"><div className="grow"><h1>Activity log</h1><p className="sub">Who changed what: every action of people, agents and the scheduler, kept for audit.</p></div><ActivitySwitch at="audit" /></div>
    <div className="row wrap"><select className="input" style={{ width: 200 }} value={cl} onChange={e => setCl(e.target.value)} aria-label="Cluster"><option value="all">All clusters</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select className="input" style={{ width: 160 }} value={st} onChange={e => setSt(e.target.value)} aria-label="Outcome"><option value="all">Any outcome</option><option value="SUCCESS">Succeeded</option><option value="FAILED">Failed</option><option value="WARNING">Warnings</option></select>
      <input className="input" style={{ maxWidth: 280 }} placeholder="Search" value={s} onChange={e => setS(e.target.value)} /></div>
    <Card pad={false}>{q.loading ? <div className="bd"><Skeleton h={80} /></div> : !q.data?.entries.length ? <Empty icon="list" title="No activity" /> :
      <div className="tablewrap"><table className="t"><thead><tr><th>When</th><th>Action</th><th>Cluster</th><th>User</th><th>Outcome</th><th>Details</th></tr></thead><tbody>
        {q.data.entries.map(e => { const o = outcome(e.status); return <tr key={e.id}><td className="nowrap">{dt(e.timestamp)}</td><td title={e.action}>{actionText(e.action)}</td><td>{e.clusterName || '—'}</td><td>{e.user}</td>
          <td><Badge kind={o[1] as any}>{o[0]}</Badge></td>
          <td className="muted trunc small" style={{ maxWidth: 360 }} title={e.details}>{detailsText(e.details)}</td></tr>; })}</tbody></table></div>}</Card>
    {q.data ? <p className="faint small">{num(q.data.total)} entries{q.data.total > 200 ? ' — showing the latest 200' : ''}.</p> : null}
  </>;
}

const FIX_TAB: Record<string, [string, string]> = { ARCHIVE_OFF: ['backup', 'Open Backup'], ARCHIVE_FOREIGN: ['backup', 'Open Backup'], NO_CHECKSUMS: ['backup', 'Open Backup'], SSL_OFF: ['hba', 'Open Access (HBA)'], WAL_MINIMAL: ['params', 'Open Parameters'] };
const SEV: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const SEV_LABEL: Record<string, string> = { critical: 'Critical', warning: 'To fix', info: 'Suggestion' };

export function Discovery() {
  const q = useQuery<any>('/api/discovery/results', { interval: 10000 });
  const [busy, setBusy] = useState(false); const [sev, setSev] = useDraft<string>('discovery:sev', 'all');
  const scan = async () => { setBusy(true); try { const r = await api('POST', '/api/discovery/scan', {}, { key: uid('scan') }); toast(r.requested ? `Discovery requested from ${r.requested} nodes` : 'No agent online', r.requested ? 'ok' : 'info'); setTimeout(() => revalidate('/api/discovery/results'), 4000); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const d = q.data;
  const findings: any[] = !d ? [] : d.nodes.flatMap((n: any) => (n.findings || []).map((f: any) => ({ ...f, node: n.nodeName, clusterId: n.clusterId, clusterName: n.clusterName }))).sort((a: any, b: any) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3));
  const shown = findings.filter(f => sev === 'all' || f.severity === sev);
  // identical finding on several nodes of the same cluster → one row listing the nodes
  const grouped = useMemo(() => { const m = new Map<string, any>(); for (const f of shown) { const k = `${f.clusterId}|${f.code}|${f.target}`; const g = m.get(k); if (g) g.nodes.push(f.node); else m.set(k, { ...f, nodes: [f.node] }); } return [...m.values()]; }, [shown]);
  return <>
    <div className="pagehead"><div className="grow"><h1>Discovery</h1><p className="sub">How each server is configured: what the agents find on the servers, what to fix in their configuration and where nodes of the same cluster disagree. Problems of the clusters themselves (backups, replication, archiving) are on <a href="#/today">Today</a>.</p></div><Button icon="refresh" busy={busy} onClick={scan}>Run now</Button></div>
    {d ? <div className="grid g4">{[['Nodes with agent', d.summary.nodes, ''], ...(d.summary.postgres ? [['PostgreSQL instances', d.summary.postgres, '']] : []), ['Critical configuration findings', d.summary.critical, d.summary.critical ? 'bad' : 'ok'], ['Differences between nodes', d.summary.drift, d.summary.drift ? 'warn' : 'ok']].map(([l, v, k]) => <Card key={l as string}><div className="kpi"><span className="v" style={k === 'bad' ? { color: 'var(--bad)' } : k === 'warn' ? { color: 'var(--warn)' } : undefined}>{v}</span><span className="l">{l}</span></div></Card>)}</div> : null}
    {!d ? <Skeleton h={100} /> : !d.nodes.length ? <Card><Empty icon="search" title="No agent connected">Real discovery starts from the agent: install it on a server (Clusters → Connect cluster) and the services found will appear here.</Empty></Card> : <div className="stack-l" style={{ marginTop: 16 }}>
      <Card title="To fix" actions={<select className="input" style={{ width: 'auto' }} value={sev} onChange={e => setSev(e.target.value)} aria-label="Severity"><option value="all">All</option><option value="critical">Critical</option><option value="warning">To fix</option><option value="info">Suggestions</option></select>} pad={false}>
        {!grouped.length ? <div className="bd"><Banner kind="ok" title="No configuration findings">The agents found nothing to report in the servers' configuration{sev !== 'all' ? ' with this filter' : ''}. Cluster problems, if any, are on Today.</Banner></div> :
          <div className="tablewrap"><table className="t"><tbody>{grouped.map((f, i) => <tr key={i}><td style={{ width: 120 }}><Badge kind={f.severity === 'critical' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'}>{SEV_LABEL[f.severity] || f.severity}</Badge></td>
            <td><strong>{f.title}</strong><div className="small muted">{f.detail}</div>{f.fix ? <div className="small" style={{ marginTop: 4 }}><Icon n="zap" s={13} /> {f.fix}</div> : null}</td>
            <td className="small muted">{f.clusterName ? <a href={`#/c/${encodeURIComponent(f.clusterId)}`}>{f.clusterName}</a> : 'Server'}<div>{f.nodes.join(', ')}</div></td>
            <td className="num">{f.clusterId && FIX_TAB[f.code] ? <Button sm onClick={() => go(`c/${encodeURIComponent(f.clusterId)}/${FIX_TAB[f.code][0]}`)}>{FIX_TAB[f.code][1]}</Button> : null}</td></tr>)}</tbody></table></div>}</Card>

      <Card title="Configuration differences between nodes" pad={false}>{!d.drift.length ? <div className="bd muted">The nodes of every cluster have the same values for the compared parameters.</div> :
        <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Parameter</th><th>Values</th></tr></thead><tbody>{d.drift.map((x: any, i: number) => <tr key={i}><td><a href={`#/c/${encodeURIComponent(x.clusterId)}/params`}>{x.clusterName}</a></td><td><code>{x.setting}</code></td>
          <td>{Object.entries(x.values).map(([n, v]) => <span key={n} className="chip" style={{ marginRight: 6 }} title={n}>{n}: {String(v)}</span>)}</td></tr>)}</tbody></table></div>}
        <div className="bd small muted">Parameters that differ between members of the same cluster are a frequent source of surprises after a failover.</div></Card>

      <div className="grid g2">{d.nodes.map((n: any) => <Card key={n.nodeId} title={n.nodeName} actions={<span className="faint small">last seen {dt(n.lastSeen)}</span>}>
        {n.discovery ? <div className="stack"><dl className="kv small">{n.clusterName ? <><dt>Cluster</dt><dd><a href={`#/c/${encodeURIComponent(n.clusterId)}`}>{n.clusterName}</a></dd></> : null}
          {Object.entries(n.discovery.summary || {}).filter(([k, v]) => !k.startsWith('findings') && Number(v) > 0).map(([k, v]) => <React.Fragment key={k}><dt>{k.replace(/_found$/, '').replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></React.Fragment>)}</dl>
          <details><summary className="small muted" style={{ cursor: 'pointer' }}>Technical details</summary><pre className="out">{JSON.stringify(n.discovery, null, 2)}</pre></details></div> : <p className="muted">No discovery has run on this node yet.</p>}</Card>)}</div>
    </div>}
  </>;
}
