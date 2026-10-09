import React from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Skeleton, ago } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

const SEV: Record<string, { label: string; kind: 'bad' | 'warn' | 'info' }> = { critical: { label: 'Urgente', kind: 'bad' }, warning: { label: 'Da controllare', kind: 'warn' }, info: { label: 'Informazione', kind: 'info' } };
const TYPE: Record<string, string> = { backup_run: 'Backup', backup_verify: 'Verifica', backup_expire: 'Pulizia', restore_instance: 'Ripristino', restore_database: 'Ripristino', restore_object: 'Ripristino', restore_promote: 'Riporta tabella', hba_apply: 'Regole di accesso', pg_set_param: 'Parametro' };

export function useHealth(interval = 20000) { return useQuery<any>('/api/health', { interval }); }

function PendingApprovals({ me, role }: { me: string; role: string }) {
  const q = useQuery<{ approvals: any[] }>('/api/approvals', { interval: 10000 });
  const list = (q.data?.approvals || []).filter(a => a.status === 'pending');
  const act = async (id: string, how: string) => { try { await api('POST', `/api/approvals/${id}/${how}`, {}); toast(how === 'approve' ? 'Approvata: l’operazione è stata avviata' : how === 'reject' ? 'Richiesta rifiutata' : 'Richiesta annullata', 'ok'); revalidate('/api/approvals'); revalidate('/api/operations'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  if (!list.length) return null;
  return <Card title="In attesa di approvazione"><div className="stack">{list.map(a => <div key={a.id} className="issue"><div className="row"><strong>{a.summary}</strong><div className="grow" /><span className="small muted">{a.clusterName} · {a.environment}</span></div>
    <p className="small muted" style={{ margin: '4px 0 6px' }}>Richiesta da {a.requestedBy} {ago(a.createdAt)}; scade {ago(a.expiresAt).replace(' fa', '')}.</p>
    <div className="row gap-s">{role === 'admin' && a.requestedBy !== me ? <><Button sm kind="primary" onClick={() => act(a.id, 'approve')}>Approva</Button><Button sm onClick={() => act(a.id, 'reject')}>Rifiuta</Button></> : null}
      {a.requestedBy === me ? <Button sm onClick={() => act(a.id, 'cancel')}>Annulla la richiesta</Button> : (role !== 'admin' ? <span className="small muted">Serve un amministratore.</span> : null)}</div></div>)}</div></Card>;
}

export function TodayPage({ me, role }: { me: string; role: string }) {
  const q = useHealth(15000); const d = q.data;
  const open = (i: any) => go(i.action?.page === 'cluster' || !i.action?.page ? `c/${encodeURIComponent(i.clusterId)}` : i.action.page === 'strategy' ? 'strategy' : `c/${encodeURIComponent(i.clusterId)}/${i.action.page}`);
  return <>
    <div className="pagehead"><div className="grow"><h1>Oggi</h1><p className="sub">Cosa richiede attenzione adesso, con la causa probabile e il passo successivo.{d ? ` Aggiornato ${ago(d.generatedAt)}.` : ''}</p></div></div>
    <PendingApprovals me={me} role={role} />
    {!d ? <Card><Skeleton h={80} /></Card> : <>
      <Banner kind={d.status === 'ok' ? 'ok' : d.status === 'critical' ? 'bad' : 'warn'} title={d.status === 'ok' ? 'Tutto in ordine' : d.status === 'critical' ? `${d.counts.critical} ${d.counts.critical === 1 ? 'problema urgente' : 'problemi urgenti'}` : 'Qualcosa da controllare'}>
        {d.status === 'ok' ? 'Backup recenti, archivio WAL continuo, repliche allineate, dischi con spazio.' : `${d.counts.critical} urgenti, ${d.counts.warning} da controllare, ${d.counts.info} informazioni.`}
        {' '}Ultime 24 ore: {d.last24h.backups} {d.last24h.backups === 1 ? 'backup riuscito' : 'backup riusciti'}{d.last24h.failed ? <>, <strong>{d.last24h.failed} operazioni fallite</strong></> : ', nessuna operazione fallita'}.</Banner>
      {d.issues.length ? <Card title="Da fare">
        <div className="stack">{d.issues.map((i: any) => <div key={i.key} className="issue">
          <div className="row"><Badge kind={SEV[i.severity].kind}>{SEV[i.severity].label}</Badge><strong>{i.title}</strong><div className="grow" /><span className="small muted">{i.clusterName} · {i.environment}</span></div>
          <p className="small muted" style={{ margin: '4px 0 6px' }}>{i.cause}</p>
          {i.action ? <Button sm onClick={() => open(i)}>{i.action.label}</Button> : null}</div>)}</div></Card> : null}
      {d.last24h.failures.length ? <Card title="Operazioni fallite nelle ultime 24 ore"><div className="tablewrap"><table className="t"><tbody>
        {d.last24h.failures.map((f: any) => <tr key={f.id}><td>{TYPE[f.type] || f.type}</td><td className="muted">{f.error || '—'}</td><td className="num small muted">{ago(f.at)}</td><td className="num"><Button sm onClick={() => go(`c/${encodeURIComponent(f.clusterId)}/operations`)}>Apri</Button></td></tr>)}</tbody></table></div></Card> : null}
      <Card title="Cluster"><div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>Ambiente</th><th>Stato</th></tr></thead><tbody>
        {d.clusters.map((c: any) => <tr key={c.id} className="click" onClick={() => go(`c/${encodeURIComponent(c.id)}`)}><td><strong>{c.name}</strong>{c.folder ? <span className="faint small"> · {c.folder}</span> : null}</td><td>{c.environment}</td>
          <td>{c.worst === 'ok' ? <Badge kind="ok">In ordine</Badge> : <Badge kind={SEV[c.worst].kind}>{c.issues} {c.issues === 1 ? 'segnalazione' : 'segnalazioni'}</Badge>}</td></tr>)}
        {!d.clusters.length ? <tr><td colSpan={3} className="muted">Nessun cluster con agente collegato.</td></tr> : null}</tbody></table></div></Card></>}
  </>;
}
