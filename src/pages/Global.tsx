import React, { useMemo, useState } from 'react';
import { api, uid } from '../api';
import { Badge, Banner, Button, Card, Empty, Icon, Skeleton, dt, num } from '../ui';
import { go } from '../router';
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

const FIX_TAB: Record<string, [string, string]> = { ARCHIVE_OFF: ['backup', 'Apri Backup'], ARCHIVE_FOREIGN: ['backup', 'Apri Backup'], NO_CHECKSUMS: ['backup', 'Apri Backup'], SSL_OFF: ['hba', 'Apri Accessi (HBA)'], WAL_MINIMAL: ['params', 'Apri Parametri'] };
const SEV: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const SEV_LABEL: Record<string, string> = { critical: 'Critico', warning: 'Da sistemare', info: 'Suggerimento' };

export function Discovery() {
  const q = useQuery<any>('/api/discovery/results', { interval: 10000 });
  const [busy, setBusy] = useState(false); const [sev, setSev] = useState<string>('all');
  const scan = async () => { setBusy(true); try { const r = await api('POST', '/api/discovery/scan', {}, { key: uid('scan') }); toast(r.requested ? `Rilevamento richiesto a ${r.requested} nodi` : 'Nessun agent online', r.requested ? 'ok' : 'info'); setTimeout(() => revalidate('/api/discovery/results'), 4000); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const d = q.data;
  const findings: any[] = !d ? [] : d.nodes.flatMap((n: any) => (n.findings || []).map((f: any) => ({ ...f, node: n.nodeName, clusterId: n.clusterId, clusterName: n.clusterName }))).sort((a: any, b: any) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3));
  const shown = findings.filter(f => sev === 'all' || f.severity === sev);
  // identical finding on several nodes of the same cluster → one row listing the nodes
  const grouped = useMemo(() => { const m = new Map<string, any>(); for (const f of shown) { const k = `${f.clusterId}|${f.code}|${f.target}`; const g = m.get(k); if (g) g.nodes.push(f.node); else m.set(k, { ...f, nodes: [f.node] }); } return [...m.values()]; }, [shown]);
  return <>
    <div className="pagehead"><div className="grow"><h1>Rilevamento</h1><p className="sub">Cosa gli agent trovano sui server, cosa va sistemato e dove i nodi dello stesso cluster non coincidono.</p></div><Button icon="refresh" busy={busy} onClick={scan}>Esegui ora</Button></div>
    {d ? <div className="grid g4">{[['Nodi con agent', d.summary.nodes, ''], ['Istanze PostgreSQL', d.summary.postgres, ''], ['Problemi critici', d.summary.critical, d.summary.critical ? 'bad' : 'ok'], ['Differenze tra nodi', d.summary.drift, d.summary.drift ? 'warn' : 'ok']].map(([l, v, k]) => <Card key={l as string}><div className="kpi"><span className="v" style={k === 'bad' ? { color: 'var(--bad)' } : k === 'warn' ? { color: 'var(--warn)' } : undefined}>{v}</span><span className="l">{l}</span></div></Card>)}</div> : null}
    {!d ? <Skeleton h={100} /> : !d.nodes.length ? <Card><Empty icon="search" title="Nessun agent collegato">Il rilevamento reale parte dall’agent: installalo su un server (Cluster → Collega cluster) e i servizi trovati compariranno qui.</Empty></Card> : <div className="stack-l" style={{ marginTop: 16 }}>
      <Card title="Da sistemare" actions={<select className="input" style={{ width: 'auto' }} value={sev} onChange={e => setSev(e.target.value)} aria-label="Gravità"><option value="all">Tutte</option><option value="critical">Critiche</option><option value="warning">Da sistemare</option><option value="info">Suggerimenti</option></select>} pad={false}>
        {!grouped.length ? <div className="bd"><Banner kind="ok" title="Nessun problema rilevato">Gli agent non hanno trovato nulla da segnalare{sev !== 'all' ? ' con questo filtro' : ''}.</Banner></div> :
          <div className="tablewrap"><table className="t"><tbody>{grouped.map((f, i) => <tr key={i}><td style={{ width: 120 }}><Badge kind={f.severity === 'critical' ? 'bad' : f.severity === 'warning' ? 'warn' : 'info'}>{SEV_LABEL[f.severity] || f.severity}</Badge></td>
            <td><strong>{f.title}</strong><div className="small muted">{f.detail}</div>{f.fix ? <div className="small" style={{ marginTop: 4 }}><Icon n="zap" s={13} /> {f.fix}</div> : null}</td>
            <td className="small muted">{f.clusterName ? <a href={`#/c/${encodeURIComponent(f.clusterId)}`}>{f.clusterName}</a> : 'Server'}<div>{f.nodes.join(', ')}</div></td>
            <td className="num">{f.clusterId && FIX_TAB[f.code] ? <Button sm onClick={() => go(`c/${encodeURIComponent(f.clusterId)}/${FIX_TAB[f.code][0]}`)}>{FIX_TAB[f.code][1]}</Button> : null}</td></tr>)}</tbody></table></div>}</Card>

      <Card title="Differenze di configurazione tra i nodi" pad={false}>{!d.drift.length ? <div className="bd muted">I nodi di ogni cluster hanno gli stessi valori nei parametri confrontati.</div> :
        <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Parametro</th><th>Valori</th></tr></thead><tbody>{d.drift.map((x: any, i: number) => <tr key={i}><td><a href={`#/c/${encodeURIComponent(x.clusterId)}/params`}>{x.clusterName}</a></td><td><code>{x.setting}</code></td>
          <td>{Object.entries(x.values).map(([n, v]) => <span key={n} className="chip" style={{ marginRight: 6 }} title={n}>{n}: {String(v)}</span>)}</td></tr>)}</tbody></table></div>}
        <div className="bd small muted">Parametri diversi tra membri dello stesso cluster sono una causa frequente di sorprese dopo un failover.</div></Card>

      <div className="grid g2">{d.nodes.map((n: any) => <Card key={n.nodeId} title={n.nodeName} actions={<span className="faint small">ultimo contatto {dt(n.lastSeen)}</span>}>
        {n.discovery ? <div className="stack"><dl className="kv small">{n.clusterName ? <><dt>Cluster</dt><dd><a href={`#/c/${encodeURIComponent(n.clusterId)}`}>{n.clusterName}</a></dd></> : null}
          {Object.entries(n.discovery.summary || {}).filter(([k, v]) => !k.startsWith('findings') && Number(v) > 0).map(([k, v]) => <React.Fragment key={k}><dt>{k.replace(/_found$/, '').replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></React.Fragment>)}</dl>
          <details><summary className="small muted" style={{ cursor: 'pointer' }}>Dettagli tecnici</summary><pre className="out">{JSON.stringify(n.discovery, null, 2)}</pre></details></div> : <p className="muted">Nessun rilevamento ancora eseguito su questo nodo.</p>}</Card>)}</div>
    </div>}
  </>;
}
