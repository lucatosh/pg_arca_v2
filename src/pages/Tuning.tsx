import React, { useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Empty } from '../ui';
import { useOpRunner, revalidate, useDraft } from '../hooks';
import { OpPanel, Result } from './shared';
import { Advice, Workload, advise } from '../tuning';
import { RestartPg } from './RestartPg';

const W: [Workload, string, string][] = [['oltp', 'Transactional (OLTP)', 'Many connections, short queries'], ['mixed', 'Mixed', 'Applications and reports together'], ['olap', 'Analytical', 'Few heavy queries, large sorts']];

export function TuningTab({ c }: { c: any }) {
  const nodes: any[] = (c.agentNodes || []).filter((n: any) => n.sys?.mem && n.settings);
  const [w, setW] = useDraft<Workload>(`tuning:${c.id}:w`, 'oltp'); const [nodeId, setNodeId] = useDraft(`tuning:${c.id}:node`, '');
  const [ask, setAsk] = useState<Advice[] | null>(null); const [queue, setQueue] = useState<string[]>([]);
  const r = useOpRunner(c.id, () => revalidate(`/api/clusters/${encodeURIComponent(c.id)}`), `tuning:${c.id}:op`);
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real cluster with the agent to get sizing advice.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="settings" title="The agent is required">The advice uses the server’s RAM and cores, which only the agent knows.</Empty></Card>;
  const node = nodes.find(n => n.id === nodeId) || nodes.find(n => n.role === 'primary') || nodes[0];
  if (!node) return <Card><Empty icon="settings" title="Server data not available yet">Wait for the agent’s first heartbeat.</Empty></Card>;
  const rows = advise(node.sys, node.settings, w); const todo = rows.filter(x => x.differs);
  const pending: string[] = node.pendingRestart || [];
  const gb = (node.sys.mem / 1024 ** 3).toFixed(1);
  const run = async (items: Advice[]) => {
    setAsk(null); const q = items.map(i => i.name); setQueue(q);
    for (const i of items) { const op = await r.run('pg_set_param', { name: i.name, value: i.recommended }, { nodeId: node.id }); if (!op || op.status === 'failed') break; await new Promise(res => setTimeout(res, 1200)); }
    setQueue([]);
  };
  return <div className="stack-l">
    <Card title="Machine and workload" actions={nodes.length > 1 ? <select className="input" style={{ width: 'auto' }} value={node.id} onChange={e => setNodeId(e.target.value)} aria-label="Node">{nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select> : null}>
      <div className="stack"><p style={{ margin: 0 }}><strong>{node.name}</strong>: {gb} GiB RAM, {node.sys.cpu} cores.</p>
        <div className="grid g3">{W.map(([k, l, s]) => <label key={k} className={`opt ${w === k ? 'on' : ''}`}><input type="radio" name="wl" checked={w === k} onChange={() => setW(k)} /><div><div>{l}</div><div className="small muted">{s}</div></div></label>)}</div>
        {c.haState?.managedByPatroni ? <Banner kind="info" title="Patroni cluster">The parameters are written to Patroni’s dynamic configuration (DCS) and apply to every member. The recommendations are computed from the chosen node’s memory and cores: choose the smallest member.</Banner> : null}
        {pending.length ? <Banner kind="info" title="Restart pending">These parameters change only after a restart: {pending.join(', ')}.{!c.haState?.managedByPatroni ? <div style={{ marginTop: 8 }}><RestartPg c={c} onDone={() => revalidate(`/api/clusters/${encodeURIComponent(c.id)}`)} /></div> : null}</Banner> : null}</div></Card>
    <Card title="Recommendations" actions={<Button disabled={!todo.length || r.busy} onClick={() => setAsk(todo)}>Apply all ({todo.length})…</Button>} pad={false}>
      <div className="tablewrap"><table className="t"><thead><tr><th>Parameter</th><th>Current</th><th>Recommended</th><th /></tr></thead><tbody>
        {rows.map(x => <tr key={x.name}><td><code>{x.name}</code><div className="small muted" style={{ maxWidth: 520 }}>{x.why}</div></td><td className="mono">{x.current}</td>
          <td className="mono">{x.recommended} {x.restart && x.differs ? <Badge kind="warn" title="Needs a PostgreSQL restart">restart</Badge> : null}</td>
          <td className="num">{x.differs ? <Button sm disabled={r.busy} busy={queue.includes(x.name) && r.busy} onClick={() => setAsk([x])}>Apply</Button> : <Badge kind="ok">Already set</Badge>}</td></tr>)}</tbody></table></div>
      <div className="bd small muted">General sizing rules, not a measurement of your workload: check with your monitoring after each change. The <code>max_connections</code> parameter is not touched.</div></Card>
    {(r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} /><Result op={r.op} /></Card> : null}
    {ask ? <Confirm title={ask.length > 1 ? `Apply ${ask.length} parameters?` : `Apply ${ask[0].name}?`} confirmLabel="Apply" onClose={() => setAsk(null)} onConfirm={() => run(ask)}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{ask.map(i => <li key={i.name}><code>{i.name}</code>: {i.current} → <strong>{i.recommended}</strong>{i.restart ? ' (restart required)' : ''}</li>)}</ul>
      <p className="small muted">{c.haState?.managedByPatroni ? 'Written to Patroni’s dynamic configuration (DCS) and applied by every member.' : 'Saved with ALTER SYSTEM and the configuration reloaded.'} Parameters that need a restart stay pending: the restart is your decision.</p></Confirm> : null}
  </div>;
}
