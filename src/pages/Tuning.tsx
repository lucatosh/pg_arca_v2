import React, { useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Empty } from '../ui';
import { useOpRunner, revalidate } from '../hooks';
import { OpPanel, Result } from './shared';
import { Advice, Workload, advise } from '../tuning';

const W: [Workload, string, string][] = [['oltp', 'Transazionale (OLTP)', 'Molte connessioni, query brevi'], ['mixed', 'Misto', 'Applicazioni e report insieme'], ['olap', 'Analitico', 'Poche query pesanti, grandi ordinamenti']];

export function TuningTab({ c }: { c: any }) {
  const nodes: any[] = (c.agentNodes || []).filter((n: any) => n.sys?.mem && n.settings);
  const [w, setW] = useState<Workload>('oltp'); const [nodeId, setNodeId] = useState('');
  const [ask, setAsk] = useState<Advice[] | null>(null); const [queue, setQueue] = useState<string[]>([]);
  const r = useOpRunner(c.id, () => revalidate(`/api/clusters/${encodeURIComponent(c.id)}`));
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con l’agent per ricevere consigli di dimensionamento.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="settings" title="Serve l’agent">I consigli usano RAM e core del server, che solo l’agent conosce.</Empty></Card>;
  const node = nodes.find(n => n.id === nodeId) || nodes.find(n => n.role === 'primary') || nodes[0];
  if (!node) return <Card><Empty icon="settings" title="Dati del server non ancora disponibili">Attendi il primo battito dell’agent.</Empty></Card>;
  const rows = advise(node.sys, node.settings, w); const todo = rows.filter(x => x.differs);
  const pending: string[] = node.pendingRestart || [];
  const gb = (node.sys.mem / 1024 ** 3).toFixed(1);
  const run = async (items: Advice[]) => {
    setAsk(null); const q = items.map(i => i.name); setQueue(q);
    for (const i of items) { const op = await r.run('pg_set_param', { name: i.name, value: i.recommended }, { nodeId: node.id }); if (!op || op.status === 'failed') break; await new Promise(res => setTimeout(res, 1200)); }
    setQueue([]);
  };
  return <div className="stack-l">
    <Card title="Macchina e carico" actions={nodes.length > 1 ? <select className="input" style={{ width: 'auto' }} value={node.id} onChange={e => setNodeId(e.target.value)} aria-label="Nodo">{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select> : null}>
      <div className="stack"><p style={{ margin: 0 }}><strong>{node.name}</strong>: {gb} GB di RAM, {node.sys.cpu} core.</p>
        <div className="grid g3">{W.map(([k, l, s]) => <label key={k} className={`opt ${w === k ? 'on' : ''}`}><input type="radio" name="wl" checked={w === k} onChange={() => setW(k)} /><div><div>{l}</div><div className="small muted">{s}</div></div></label>)}</div>
        {c.haState?.managedByPatroni ? <Banner kind="warn" title="Cluster Patroni">I parametri sono applicati al nodo scelto con ALTER SYSTEM. Per averli uguali su tutti i membri ripeti l’operazione su ciascuno (o usa la configurazione dinamica di Patroni): la pagina Rilevamento segnala le differenze.</Banner> : null}
        {pending.length ? <Banner kind="info" title="Riavvio in attesa">Questi parametri cambieranno solo dopo un riavvio: {pending.join(', ')}.</Banner> : null}</div></Card>
    <Card title="Consigli" actions={<Button kind="primary" disabled={!todo.length || r.busy} onClick={() => setAsk(todo)}>Applica tutti ({todo.length})</Button>} pad={false}>
      <div className="tablewrap"><table className="t"><thead><tr><th>Parametro</th><th>Attuale</th><th>Consigliato</th><th /></tr></thead><tbody>
        {rows.map(x => <tr key={x.name}><td><code>{x.name}</code><div className="small muted" style={{ maxWidth: 520 }}>{x.why}</div></td><td className="mono">{x.current}</td>
          <td className="mono">{x.recommended} {x.restart && x.differs ? <Badge kind="warn" title="Serve un riavvio di PostgreSQL">riavvio</Badge> : null}</td>
          <td className="num">{x.differs ? <Button sm disabled={r.busy} busy={queue.includes(x.name) && r.busy} onClick={() => setAsk([x])}>Applica</Button> : <Badge kind="ok">Già così</Badge>}</td></tr>)}</tbody></table></div>
      <div className="bd small muted">Regole generali di dimensionamento, non una misura del tuo carico: verifica con il monitoraggio dopo ogni modifica. Il parametro <code>max_connections</code> non viene toccato.</div></Card>
    {(r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} /><Result op={r.op} /></Card> : null}
    {ask ? <Confirm title={ask.length > 1 ? `Applicare ${ask.length} parametri?` : `Applicare ${ask[0].name}?`} confirmLabel="Applica" onClose={() => setAsk(null)} onConfirm={() => run(ask)}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{ask.map(i => <li key={i.name}><code>{i.name}</code>: {i.current} → <strong>{i.recommended}</strong>{i.restart ? ' (riavvio necessario)' : ''}</li>)}</ul>
      <p className="small muted">Salvato con ALTER SYSTEM e configurazione ricaricata. I parametri che richiedono un riavvio restano in attesa: il riavvio è una tua scelta.</p></Confirm> : null}
  </div>;
}
