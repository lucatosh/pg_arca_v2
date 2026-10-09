import React, { useState } from 'react';
import { api, uid } from '../api';
import { Badge, Banner, Button, Card, Empty, Skeleton, dt, num } from '../ui';
import { toast, useQuery, revalidate } from '../hooks';

export function Audit({ clusters }: { clusters: any[] }) {
  const [cl, setCl] = useState('all'); const [st, setSt] = useState('all'); const [s, setS] = useState('');
  const q = useQuery<{ total: number; entries: any[] }>(`/api/audit/history?limit=200&clusterId=${cl}&status=${st}&search=${encodeURIComponent(s)}`, { interval: 10000 });
  return <>
    <div className="pagehead"><div className="grow"><h1>Registro attività</h1><p className="sub">Ogni azione eseguita dalla console, dagli agent e dallo scheduler.</p></div></div>
    <div className="row wrap"><select className="input" style={{ width: 200 }} value={cl} onChange={e => setCl(e.target.value)} aria-label="Cluster"><option value="all">Tutti i cluster</option>{clusters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select className="input" style={{ width: 160 }} value={st} onChange={e => setSt(e.target.value)} aria-label="Esito"><option value="all">Ogni esito</option><option value="SUCCESS">Riuscite</option><option value="FAILED">Fallite</option><option value="WARNING">Avvisi</option></select>
      <input className="input" style={{ maxWidth: 280 }} placeholder="Cerca" value={s} onChange={e => setS(e.target.value)} /></div>
    <Card pad={false}>{q.loading ? <div className="bd"><Skeleton h={80} /></div> : !q.data?.entries.length ? <Empty icon="list" title="Nessuna attività" /> :
      <div className="tablewrap"><table className="t"><thead><tr><th>Quando</th><th>Azione</th><th>Cluster</th><th>Utente</th><th>Esito</th><th>Dettagli</th></tr></thead><tbody>
        {q.data.entries.map(e => <tr key={e.id}><td className="nowrap">{dt(e.timestamp)}</td><td><code>{e.action}</code></td><td>{e.clusterName || '—'}</td><td>{e.user}</td>
          <td><Badge kind={e.status === 'SUCCESS' ? 'ok' : e.status === 'FAILED' ? 'bad' : 'warn'}>{e.status === 'SUCCESS' ? 'OK' : e.status === 'FAILED' ? 'Fallita' : 'Avviso'}</Badge></td>
          <td className="muted trunc" style={{ maxWidth: 360 }} title={e.details}>{e.details}</td></tr>)}</tbody></table></div>}</Card>
    {q.data ? <p className="faint small">{num(q.data.total)} voci{q.data.total > 200 ? ' — mostrate le ultime 200' : ''}.</p> : null}
  </>;
}

export function Discovery() {
  const q = useQuery<any>('/api/discovery/results', { interval: 10000 });
  const [busy, setBusy] = useState(false); const [key] = useState(() => uid('scan'));
  const scan = async () => { setBusy(true); try { const r = await api('POST', '/api/discovery/scan', {}, { key: uid('scan') }); toast(r.requested ? `Rilevamento richiesto a ${r.requested} nodi` : 'Nessun agent online', r.requested ? 'ok' : 'info'); setTimeout(() => revalidate('/api/discovery/results'), 4000); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const d = q.data;
  return <>
    <div className="pagehead"><div className="grow"><h1>Rilevamento</h1><p className="sub">Cosa gli agent trovano sui server: PostgreSQL, Patroni, etcd, PgBouncer.</p></div><Button icon="refresh" busy={busy} onClick={scan}>Esegui ora</Button></div>
    {d ? <div className="grid g4">{[['Nodi con agent', d.summary.nodes], ['Istanze PostgreSQL', d.summary.postgres], ['Cluster Patroni', d.summary.patroni], ['Cluster etcd', d.summary.etcd]].map(([l, v]) => <Card key={l as string}><div className="kpi"><span className="v">{v}</span><span className="l">{l}</span></div></Card>)}</div> : null}
    {!d ? <Skeleton h={100} /> : !d.nodes.length ? <Card><Empty icon="search" title="Nessun agent collegato">Il rilevamento reale parte dall’agent: installalo su un server (Cluster → Collega cluster) e i servizi trovati compariranno qui.</Empty></Card> :
      d.nodes.map((n: any) => <Card key={n.nodeId} title={n.nodeName} actions={<span className="faint small">ultimo contatto {dt(n.lastSeen)}</span>}>
        {n.discovery ? <pre className="out">{JSON.stringify(n.discovery.summary || n.discovery, null, 2)}</pre> : <p className="muted">Nessun rilevamento ancora eseguito su questo nodo.</p>}</Card>)}
  </>;
}
