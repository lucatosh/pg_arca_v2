import React, { useState } from 'react';
import { api, get } from '../api';
import { Modal, Badge, Banner, Button, Card, Confirm, Dot, Empty, Field, Icon, Skeleton, Tabs, bytes, dt, ago, num, Preview, CopyBlock } from '../ui';
import { Op, revalidate, toast, useOpRunner, useQuery, isTerminal } from '../hooks';
import { go } from '../router';
import { statusKind } from '../App';
import { OP_LABEL, OpPanel, Result, statusBadge } from './shared';
import { BackupTab } from './Backup';
import { RestoreTab } from './Restore';
import { LogsTab } from './Logs';
import { HbaTab } from './Hba';
import { TuningTab } from './Tuning';
import { AgentSettings } from './AgentSettings';
import { ProtectionRibbon } from './Ribbon';

export const TAB_ITEMS: { id: string; label: string; icon?: string; preview?: boolean; agent?: boolean }[] = [
  { id: 'overview', label: 'Panoramica', icon: 'layers' }, { id: 'nodes', label: 'Nodi', icon: 'server' }, { id: 'ha', label: 'Alta affidabilità', icon: 'swap' },
  { id: 'params', label: 'Parametri', icon: 'settings' }, { id: 'backup', label: 'Backup', icon: 'shield' }, { id: 'restore', label: 'Ripristino', icon: 'restore' },
  { id: 'operations', label: 'Operazioni', icon: 'list' }, { id: 'logs', label: 'Log', icon: 'logs' },
  { id: 'hba', label: 'Accessi (HBA)', icon: 'lock' }, { id: 'ldap', label: 'LDAP / AD', preview: true }, { id: 'rbac', label: 'Ruoli (RBAC)', preview: true }, { id: 'tuning', label: 'Tuning', icon: 'zap' }, { id: 'templates', label: 'Modelli', preview: true },
];
const PREVIEW_TEXT: Record<string, string> = {
  ldap: 'Sincronizzazione di utenti e gruppi da LDAP / Active Directory verso i ruoli PostgreSQL. Non ancora disponibile.',
  rbac: 'Ruoli e permessi della console. Oggi esiste un solo amministratore.',
  templates: 'Politiche e modelli applicabili a più cluster. Non ancora disponibili.',
};

export function ClusterView({ id, tab }: { id: string; tab?: string }) {
  const q = useQuery<{ cluster: any }>(`/api/clusters/${encodeURIComponent(id)}`, { interval: 5000 });
  const [detach, setDetach] = useState(false); const [busy, setBusy] = useState(false);
  const c = q.data?.cluster; const cur = TAB_ITEMS.some(t => t.id === tab) ? tab! : 'overview';
  if (q.error?.status === 404) return <Empty icon="db" title="Cluster non trovato" action={<Button onClick={() => go('')}>Torna all’elenco</Button>}>Potrebbe essere stato scollegato.</Empty>;
  if (!c) return <div className="stack"><Skeleton h={30} w={260} /><Skeleton h={120} /></div>;
  const doDetach = async () => {
    setBusy(true);
    try { await api('DELETE', `/api/clusters/${encodeURIComponent(id)}`); revalidate('/api/clusters'); toast(`Cluster ${c.name} scollegato`, 'ok'); go(''); }
    catch (e: any) { toast(e.message, 'bad'); setBusy(false); }
  };
  const agentic = c.source !== 'direct' && !c.isSandbox;
  return <>
    <div className="pagehead">
      <div className="grow"><div className="row wrap"><h1>{c.name}</h1><Badge kind={statusKind(c.status)}>{c.status === 'healthy' ? 'In salute' : c.status === 'degraded' ? 'Degradato' : c.status}</Badge>
        {c.isSandbox ? <Badge>Demo</Badge> : c.source === 'direct' ? <Badge>Solo connessione</Badge> : <Badge kind="accent">Agent</Badge>}</div>
        <p className="sub">{c.environment} · PostgreSQL {c.pgVersion || '—'} · timeline {c.activeTimeline || '—'}</p></div>
      <Button icon="trash" onClick={() => setDetach(true)}>Scollega</Button></div>
    {c.isSandbox ? <Banner kind="info" title="Cluster demo">Dati di esempio: le operazioni non vengono eseguite. Puoi eliminarlo quando hai collegato un cluster reale.</Banner> : null}
    {agentic ? <ProtectionRibbon c={c} /> : null}
    <Tabs value={cur} onChange={t => go(`c/${encodeURIComponent(id)}/${t}`)} items={TAB_ITEMS.map(t => ({ id: t.id, label: t.label, icon: t.icon, preview: t.preview }))} />
    {cur === 'overview' && <Overview c={c} agentic={agentic} />}
    {cur === 'nodes' && <Nodes c={c} />}
    {cur === 'ha' && <HA c={c} />}
    {cur === 'params' && <Params c={c} />}
    {cur === 'backup' && <BackupTab c={c} />}
    {cur === 'restore' && <RestoreTab c={c} />}
    {cur === 'operations' && <Operations c={c} />}
    {cur === 'logs' && <LogsTab c={c} />}
    {cur === 'tuning' && <TuningTab c={c} />}
    {cur === 'hba' && <HbaTab c={c} />}
    {PREVIEW_TEXT[cur] ? <Preview title={TAB_ITEMS.find(t => t.id === cur)!.label}>{PREVIEW_TEXT[cur]}</Preview> : null}
    {detach ? <Confirm danger title={`Scollegare ${c.name}?`} confirmLabel="Scollega" requireText={c.isSandbox ? undefined : c.name} busy={busy} onClose={() => setDetach(false)} onConfirm={doDetach}>
      <p>La console smette di gestire questo cluster, revoca gli agent e annulla le operazioni in coda. <strong>I dati e i backup sul server non vengono toccati.</strong></p></Confirm> : null}
  </>;
}

function Kpi({ v, l }: { v: React.ReactNode; l: string }) { return <Card><div className="kpi"><span className="v">{v}</span><span className="l">{l}</span></div></Card>; }

function Overview({ c, agentic }: { c: any; agentic: boolean }) {
  const b = useQuery<any>(agentic ? `/api/clusters/${encodeURIComponent(c.id)}/backups` : null, { interval: 15000 });
  const bk = b.data?.backup;
  return <div className="stack-l">
    <div className="grid g4"><Kpi v={c.haState?.nodes?.length ?? 0} l="Nodi" /><Kpi v={bytes(c.totalSizeBytes)} l="Dimensione dati" /><Kpi v={num(c.tps)} l="Transazioni al secondo" /><Kpi v={c.currentLSN || '—'} l="LSN corrente" /></div>
    {agentic ? <Card title="Protezione dei dati">
      {b.loading ? <Skeleton h={40} /> : !b.data?.agent ? <p className="muted">Nessun agent collegato.</p> : !bk?.configured ? <Banner kind="warn" title="Backup non ancora configurati">Apri la scheda Backup per attivare l’archiviazione WAL ed eseguire il primo backup.</Banner> :
        <div className="row wrap gap-l"><div><div className="kpi"><span className="v">{bk.last_backup ? ago(bk.last_backup.stop_time) : 'mai'}</span><span className="l">Ultimo backup</span></div></div>
          <div className="kpi"><span className="v">{bk.sets}</span><span className="l">Backup validi</span></div>
          <div className="kpi"><span className="v">{b.data.wal?.continuous === false ? 'Interrotti' : 'Continui'}</span><span className="l">WAL archiviati</span></div>
          <div className="grow" /><Button onClick={() => go(`c/${encodeURIComponent(c.id)}/backup`)}>Apri Backup</Button></div>}
    </Card> : c.source === 'direct' ? <Banner kind="info" title="Backup e ripristino non disponibili in modalità sola connessione">Girano sul server del database: installa l’agent su un nodo di questo cluster per attivarli.</Banner> : null}
    <Card title="Database" pad={false}>{c.databases?.length ? <div className="tablewrap"><table className="t"><thead><tr><th>Nome</th><th className="num">Dimensione</th></tr></thead>
      <tbody>{c.databases.map((d: any) => <tr key={d.name}><td>{d.name}</td><td className="num">{bytes(d.size)}</td></tr>)}</tbody></table></div> : <div className="bd muted">Nessun dato disponibile.</div>}</Card>
  </div>;
}

function Nodes({ c }: { c: any }) {
  const nodes: any[] = c.haState?.nodes || [];
  const reg = useQuery<{ nodes: any[] }>('/api/nodes', { interval: 8000 });
  const mine = (reg.data?.nodes || []).filter(n => n.clusterId === c.id);
  const [revoke, setRevoke] = useState<any>(null); const [tok, setTok] = useState<any>(null); const [busy, setBusy] = useState(false);
  const doRevoke = async () => { setBusy(true); try { await api('DELETE', `/api/nodes/${revoke.id}`); toast(`Agent di ${revoke.name} revocato`, 'ok'); revalidate('/api/nodes'); revalidate(`/api/clusters/${encodeURIComponent(c.id)}`); setRevoke(null); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const mint = async (nodeName?: string) => { setBusy(true); try { const t: any = await api('POST', '/api/enrollment-tokens', { label: `${c.name} +${nodeName || 'nodo'}`, clusterId: c.id, ttlMinutes: 60 }, { key: 'tok-' + Date.now() }); setTok(nodeName ? { ...t, node: nodeName, installCommand: t.installCommand.replace('sudo PG_ARCA_URL=', `sudo PG_ARCA_NODE_NAME=${nodeName} PG_ARCA_URL=`) } : t); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <div className="stack-l">
    {nodes.some(n => n.source === 'patroni') ? <Banner kind="info" title={`${nodes.filter(n => n.source === 'patroni').length} nodi del cluster non hanno ancora l’agent`}>Patroni li vede, ma per gestirli (backup, ripristino, accessi) serve l’agent. Se uno solo dei nodi con agent si ferma, backup e ripristini non partono. Usa “Installa agent” accanto a ogni nodo: il comando è già legato a questo cluster.</Banner> : null}
    <Card title="Membri del cluster" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Nodo</th><th>Ruolo</th><th>Stato</th><th className="num">Ritardo</th><th className="num">CPU</th><th className="num">Memoria</th><th className="num">Connessioni</th></tr></thead>
      <tbody>{nodes.map(n => <tr key={n.name}><td><span className="row gap-s"><Dot kind={n.online ? 'ok' : 'bad'} /><strong>{n.name}</strong>{n.source === 'patroni' ? <Badge kind="warn" title="Visto da Patroni: senza agent non si possono fare backup, ripristini o modifiche su questo nodo">senza agent</Badge> : null}{n.source === 'patroni' && !c.isSandbox ? <Button sm icon="plus" disabled={busy} onClick={() => mint(n.name)}>Installa agent</Button> : null}</span><div className="faint small">{n.host}:{n.port}</div></td>
        <td><Badge kind={n.role === 'primary' ? 'accent' : undefined}>{n.role === 'primary' ? 'Primario' : n.role === 'sync_standby' ? 'Standby sincrono' : n.role === 'standby_leader' ? 'Leader standby' : 'Replica'}</Badge></td>
        <td>{n.online ? n.state : 'offline'}</td><td className="num">{n.role === 'primary' ? '—' : bytes(n.replicationLagBytes)}</td>
        <td className="num">{n.source === 'agent' ? `${n.cpuPercent}%` : '—'}</td><td className="num">{n.source === 'agent' ? `${n.memoryPercent}%` : '—'}</td><td className="num">{n.connections}/{n.maxConnections || '—'}</td></tr>)}
        {!nodes.length ? <tr><td colSpan={7} className="muted">Nessun nodo rilevato.</td></tr> : null}</tbody></table></div></Card>
    {c.source !== 'direct' && !c.isSandbox ? <Card title="Agent installati" actions={<Button sm icon="plus" busy={busy && !revoke} onClick={() => mint()}>Aggiungi nodo</Button>} pad={false}>
      <div className="tablewrap"><table className="t"><thead><tr><th>Nodo</th><th>Versione agent</th><th>Ultimo contatto</th><th>Indirizzo</th><th /></tr></thead>
        <tbody>{mine.map(n => <tr key={n.id}><td><span className="row gap-s"><Dot kind={n.online ? 'ok' : 'bad'} />{n.name}</span></td><td>{n.agentVersion}</td><td>{ago(n.lastSeen)}</td><td className="mono">{n.remoteIp}</td>
          <td className="num"><Button sm icon="trash" onClick={() => setRevoke(n)}>Revoca</Button></td></tr>)}
          {!mine.length ? <tr><td colSpan={5} className="muted">Nessun agent.</td></tr> : null}</tbody></table></div></Card> : null}
    {!c.isSandbox && c.source !== 'direct' ? <AgentSettings clusterId={c.id} nodes={mine.map(n => ({ id: n.id, name: n.name, online: n.online }))} /> : null}
    {tok ? <Card title={tok.node ? `Installa l’agent su ${tok.node}` : 'Nuovo nodo'}><div className="stack"><p>Esegui come root sul nuovo server. Il token vale per un nodo e scade tra un’ora.</p><CopyBlock text={tok.installCommand} /><Button onClick={() => setTok(null)}>Chiudi</Button></div></Card> : null}
    {revoke ? <Confirm danger title={`Revocare l’agent di ${revoke.name}?`} confirmLabel="Revoca" busy={busy} onClose={() => setRevoke(null)} onConfirm={doRevoke}>
      <p>Il segreto dell’agent diventa subito non valido e le operazioni in coda per questo nodo vengono annullate. PostgreSQL sul nodo non viene toccato; per ricollegarlo serve un nuovo token.</p></Confirm> : null}
  </div>;
}

type HaAct = { kind: 'switchover' | 'failover' | 'restart' | 'pause' | 'reload'; member?: string };
function HA({ c }: { c: any }) {
  const nodes: any[] = c.haState?.nodes || [];
  const leader = nodes.find(n => n.role === 'primary');
  const [act, setAct] = useState<HaAct | null>(null); const [cand, setCand] = useState(''); const [typed, setTyped] = useState('');
  const r = useOpRunner(c.id, () => revalidate(`/api/clusters/${encodeURIComponent(c.id)}`));
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con Patroni per usare switchover e failover.</Banner>;
  if (!c.haState?.managedByPatroni) return <Card><Empty icon="swap" title="Patroni non rilevato">Le operazioni di alta affidabilità richiedono un cluster gestito da Patroni con l’agent installato (o la sua API collegata in modalità connessione).</Empty></Card>;
  const standbys = nodes.filter(n => n.role !== 'primary' && n.online);
  const start = (a: HaAct) => { setAct(a); setCand(standbys[0]?.name || ''); setTyped(''); r.reset(); };
  const exec = () => {
    if (!act) return;
    const m = act.kind;
    if (m === 'switchover') r.run('patroni_switchover', { leader: leader?.name, candidate: cand || undefined });
    else if (m === 'failover') r.run('patroni_failover', { candidate: cand, confirm: 'FAILOVER' });
    else if (m === 'restart') r.run('patroni_restart', { member: act.member });
    else if (m === 'reload') r.run('patroni_reload', {});
    else r.run('patroni_pause', { enable: !c.haState.maintenanceMode });
    setAct(null);
  };
  return <div className="stack-l">
    {c.haState.maintenanceMode ? <Banner kind="warn" title="Modalità manutenzione attiva">Patroni non eseguirà failover automatici finché non la disattivi.</Banner> : null}
    <Card title="Azioni">
      <div className="row wrap">
        <Button icon="swap" disabled={!standbys.length || r.busy} onClick={() => start({ kind: 'switchover' })}>Switchover pianificato</Button>
        <Button icon="pause" disabled={r.busy} onClick={() => start({ kind: 'pause' })}>{c.haState.maintenanceMode ? 'Esci dalla manutenzione' : 'Entra in manutenzione'}</Button>
        <Button icon="refresh" disabled={r.busy} onClick={() => start({ kind: 'reload' })}>Ricarica Patroni</Button>
        <Button kind="danger" icon="alert" disabled={!standbys.length || r.busy} onClick={() => start({ kind: 'failover' })}>Failover forzato…</Button></div>
      <p className="small muted" style={{ marginTop: 10 }}>Lo switchover è ordinato e senza perdita di dati. Il failover forzato si usa solo se il primario non risponde: può perdere transazioni.</p></Card>
    <Card title="Membri" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Membro</th><th>Ruolo</th><th>Stato</th><th /></tr></thead><tbody>
      {nodes.map(n => <tr key={n.name}><td>{n.name}</td><td>{n.role === 'primary' ? 'Leader' : 'Replica'}</td><td>{n.online ? n.state : 'offline'}</td><td className="num"><Button sm disabled={r.busy} onClick={() => start({ kind: 'restart', member: n.name })}>Riavvia</Button></td></tr>)}</tbody></table></div></Card>
    {(r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} cancel={undefined} /><Result op={r.op} /></Card> : null}
    {act ? <Modal2 act={act} leader={leader?.name} standbys={standbys} cand={cand} setCand={setCand} typed={typed} setTyped={setTyped} onClose={() => setAct(null)} onGo={exec} maint={!!c.haState.maintenanceMode} /> : null}
  </div>;
}

function Modal2({ act, leader, standbys, cand, setCand, typed, setTyped, onClose, onGo, maint }: any) {
  const k = act.kind; const danger = k === 'failover' || k === 'restart';
  const title = k === 'switchover' ? 'Switchover pianificato' : k === 'failover' ? 'Failover forzato' : k === 'restart' ? `Riavviare ${act.member}?` : k === 'reload' ? 'Ricaricare Patroni?' : maint ? 'Uscire dalla manutenzione?' : 'Entrare in manutenzione?';
  return <Confirm title={title} danger={danger} confirmLabel="Esegui" requireText={k === 'failover' ? 'FAILOVER' : undefined} onClose={onClose} onConfirm={() => (k === 'failover' && !cand ? null : onGo())}>
    {k === 'switchover' || k === 'failover' ? <Field label="Nuovo primario"><select className="input" value={cand} onChange={e => setCand(e.target.value)}>{standbys.map((s: any) => <option key={s.name} value={s.name}>{s.name}{s.replicationLagBytes ? ` (ritardo ${bytes(s.replicationLagBytes)})` : ''}</option>)}</select></Field> : null}
    {k === 'switchover' ? <p>Il primario attuale <strong>{leader}</strong> cede il ruolo in modo ordinato. Le connessioni attive vengono interrotte per qualche secondo.</p> : null}
    {k === 'failover' ? <Banner kind="bad" title="Rischio di perdita dati">Promuove la replica scelta senza aspettare il primario. Le transazioni non ancora replicate andranno perse.</Banner> : null}
    {k === 'restart' ? <p>Il membro sarà irraggiungibile durante il riavvio di PostgreSQL.</p> : null}
    {k === 'pause' ? <p>{maint ? 'Patroni riprende la gestione automatica del cluster.' : 'Patroni sospende i failover automatici: utile durante interventi manuali.'}</p> : null}
  </Confirm>;
}

const PARAMS = ['work_mem', 'maintenance_work_mem', 'shared_buffers', 'effective_cache_size', 'max_connections', 'checkpoint_timeout', 'max_wal_size', 'log_min_duration_statement', 'archive_timeout', 'wal_level', 'archive_mode', 'archive_command', 'full_page_writes', 'wal_log_hints'];
function Params({ c }: { c: any }) {
  const [name, setName] = useState(''); const [value, setValue] = useState(''); const [reset, setReset] = useState(false); const [node, setNode] = useState('');
  const [ask, setAsk] = useState(false);
  const r = useOpRunner(c.id);
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale per modificare i parametri.</Banner>;
  const valid = /^[a-z_][a-z0-9_.]*$/i.test(name) && (reset || value !== '');
  const nodes = c.agentNodes || [];
  return <div className="stack-l">
    <Card title="Modifica un parametro" actions={<Badge>ALTER SYSTEM</Badge>}>
      <div className="stack"><div className="grid g2">
        <Field label="Parametro"><input className="input" list="pgparams" value={name} onChange={e => setName(e.target.value)} placeholder="work_mem" /><datalist id="pgparams">{PARAMS.map(p => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Valore" hint={reset ? 'Il parametro tornerà al valore predefinito.' : undefined}><input className="input" disabled={reset} value={value} onChange={e => setValue(e.target.value)} placeholder="64MB" /></Field>
        {nodes.length > 1 ? <Field label="Nodo" hint="Il parametro vale per il nodo scelto."><select className="input" value={node} onChange={e => setNode(e.target.value)}><option value="">Primario (automatico)</option>{nodes.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field> : null}</div>
        <label className="check"><input type="checkbox" checked={reset} onChange={e => setReset(e.target.checked)} />Ripristina il valore predefinito</label>
        <div className="row"><Button kind="primary" disabled={!valid || r.busy} onClick={() => setAsk(true)}>Applica</Button>
          <Button disabled={r.busy} onClick={() => r.run('pg_reload', {}, { nodeId: node || undefined })}>Ricarica configurazione</Button></div></div></Card>
    {(r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} /><Result op={r.op} /></Card> : null}
    {ask ? <Confirm title="Applicare il parametro?" confirmLabel="Applica" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); r.run('pg_set_param', { name, value: reset ? null : value }, { nodeId: node || undefined }); }}>
      <p><code>{name}</code> → <code>{reset ? 'DEFAULT' : value}</code>. Verrà salvato con ALTER SYSTEM e la configurazione ricaricata. Se il parametro richiede un riavvio, l’esito lo indicherà e il riavvio resta una tua scelta.</p></Confirm> : null}
  </div>;
}

function Operations({ c }: { c: any }) {
  const q = useQuery<{ operations: Op[] }>(`/api/operations?clusterId=${encodeURIComponent(c.id)}`, { interval: 3000 });
  const [open, setOpen] = useState<string | null>(null);
  const ops = q.data?.operations || [];
  const cancel = async (id: string) => { try { await api('POST', `/api/operations/${id}/cancel`); q.refresh(); } catch (e: any) { toast(e.message, 'bad'); } };
  return <Card title="Registro operazioni" pad={false}>
    {!ops.length ? <Empty icon="list" title="Nessuna operazione">Backup, ripristini e interventi appaiono qui con esito e durata.</Empty> :
      <div className="tablewrap"><table className="t"><thead><tr><th>Quando</th><th>Operazione</th><th>Stato</th><th>Origine</th><th /></tr></thead><tbody>
        {ops.map(o => <React.Fragment key={o.id}><tr className="click" onClick={() => setOpen(open === o.id ? null : o.id)}>
          <td title={dt(o.createdAt)}>{ago(o.createdAt)}</td><td>{OP_LABEL[o.type] || o.type}{o.params?.type ? ` (${o.params.type})` : ''}</td><td>{statusBadge(o.status)}</td>
          <td className="muted">{(o as any).createdBy}</td><td className="num">{!isTerminal(o.status) ? <Button sm onClick={e => { e.stopPropagation(); cancel(o.id); }}>Annulla</Button> : null}</td></tr>
          {open === o.id ? <tr><td colSpan={5}><div className="stack"><OpPanel op={o} /><Result op={o} /><details><summary className="small muted" style={{ cursor: 'pointer' }}>Cronologia e parametri</summary><pre className="out">{JSON.stringify({ params: o.params, history: (o as any).history }, null, 2)}</pre></details></div></td></tr> : null}</React.Fragment>)}
      </tbody></table></div>}
  </Card>;
}
