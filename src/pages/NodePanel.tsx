import React, { useState } from 'react';
import { Modal, Badge, Banner, Button, Dot, bytes, ago } from '../ui';
import { useOpRunner } from '../hooks';
import { OpPanel, Result } from './shared';

type Act = { id: string; label: string; hint: string; danger?: boolean; typed?: boolean; run: () => void; disabled?: string };

/** Everything you can do on ONE node: facts first, then commands grouped by what they touch. Commands act on this node, not on "some node of the cluster". */
export function NodePanel({ c, node, agent, leader, isAdmin, onClose, onInstall, onRevoke }: { c: any; node: any; agent?: any; leader?: string; isAdmin: boolean; onClose: () => void; onInstall: () => void; onRevoke: () => void }) {
  const r = useOpRunner(c.id);
  const [pending, setPending] = useState<Act | null>(null); const [typed, setTyped] = useState('');
  const patroni = !!c.haState?.managedByPatroni;
  const isPrimary = node.role === 'primary';
  const healthy = node.online && ['running', 'streaming'].includes(String(node.state));
  const hasAgent = !!agent && agent.online;
  const nid = agent?.id as string | undefined;
  const noAgent = 'Serve un agent online su questo nodo';
  const noPatroni = 'Serve Patroni su questo cluster';

  const acts: { group: string; items: Act[] }[] = [
    { group: 'PostgreSQL', items: [
      { id: 'restart', label: 'Riavvia PostgreSQL', hint: 'Riavvio ordinato tramite Patroni. Il nodo non risponde per qualche secondo' + (isPrimary ? ' e, essendo il primario, le applicazioni perdono la connessione.' : '.'), danger: true, disabled: patroni ? undefined : noPatroni, run: () => r.run('patroni_restart', { member: node.name }) },
      { id: 'reload', label: 'Ricarica la configurazione', hint: 'Rilegge postgresql.conf e pg_hba.conf senza riavviare. Sicuro da eseguire in qualsiasi momento.', disabled: hasAgent ? undefined : noAgent, run: () => r.run('pg_reload', {}, { nodeId: nid }) },
      { id: 'checkpoint', label: 'Esegui un checkpoint', hint: 'Forza la scrittura su disco dei dati in memoria. Utile prima di un backup o di un riavvio.', disabled: !isPrimary ? 'Solo sul primario' : hasAgent ? undefined : noAgent, run: () => r.run('checkpoint', {}, { nodeId: nid }) },
      { id: 'walsw', label: 'Chiudi il file WAL corrente', hint: 'Fa archiviare subito il WAL in corso: accorcia la perdita massima in caso di disastro.', disabled: !isPrimary ? 'Solo sul primario' : hasAgent ? undefined : noAgent, run: () => r.run('wal_switch', {}, { nodeId: nid }) },
    ] },
    { group: 'Alta affidabilità', items: [
      { id: 'promote', label: 'Promuovi a primario', hint: `Switchover ordinato: ${leader || 'il primario'} cede il ruolo a ${node.name} senza perdere dati.`, danger: true, disabled: !patroni ? noPatroni : isPrimary ? 'È già il primario' : !healthy ? 'La replica non è in salute (non sta replicando)' : undefined, run: () => r.run('patroni_switchover', { leader, candidate: node.name }) },
      { id: 'reinit', label: 'Ricostruisci la replica', hint: 'Cancella i dati di questo nodo e li riclona dal primario. Si usa quando una replica non riparte o è corrotta. Può richiedere molto tempo su database grandi.', danger: true, typed: true, disabled: !patroni ? noPatroni : isPrimary ? 'Mai sul primario: distruggerebbe i dati' : undefined, run: () => r.run('patroni_reinit', { member: node.name }) },
    ] },
    { group: 'Agent', items: [
      { id: 'scan', label: 'Rileva di nuovo', hint: 'L’agent rifà la scansione di PostgreSQL, Patroni e percorsi su questo server.', disabled: hasAgent ? undefined : noAgent, run: () => r.run('discovery_scan', {}, { nodeId: nid }) },
    ] },
  ];
  const go = (a: Act) => { if (a.disabled) return; if (a.danger) { setPending(a); setTyped(''); } else a.run(); };

  return <Modal title={<span className="row gap-s"><Dot kind={node.online ? 'ok' : 'bad'} />{node.name}<Badge kind={isPrimary ? 'accent' : undefined}>{isPrimary ? 'Primario' : 'Replica'}</Badge></span>} onClose={onClose} wide footer={<Button onClick={onClose}>Chiudi</Button>}>
    <div className="stack-l">
      <dl className="kv">
        <dt>Stato</dt><dd>{node.online ? node.state : 'offline'}</dd>
        {!isPrimary ? <><dt>Ritardo di replica</dt><dd>{bytes(node.replicationLagBytes)}</dd></> : null}
        <dt>Indirizzo</dt><dd className="mono">{node.host}:{node.port}</dd>
        <dt>Timeline</dt><dd>{node.timeline ?? '—'}</dd>
        <dt>Agent</dt><dd>{agent ? <>{agent.agentVersion} · ultimo contatto {ago(agent.lastSeen)} · {agent.remoteIp}</> : <span className="muted">non installato</span>}</dd>
      </dl>
      {!agent ? <Banner kind="warn" title="Questo nodo non ha l’agent">Patroni lo vede, ma per backup, ripristini, accessi e log serve l’agent.{isAdmin ? <> <Button sm icon="plus" onClick={onInstall}>Installa agent</Button></> : null}</Banner> : null}
      {acts.map(g => <div key={g.group}><h4 style={{ margin: '0 0 8px' }}>{g.group}</h4>
        <div className="stack">{g.items.map(a => <div key={a.id} className="row gap-s" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ flex: 1 }}><strong>{a.label}</strong><div className="small muted">{a.disabled ? a.disabled + '.' : a.hint}</div></div>
          <Button sm kind={a.danger ? 'danger' : undefined} disabled={!!a.disabled || r.busy || !isAdmin && a.danger} onClick={() => go(a)}>Esegui</Button></div>)}</div></div>)}
      {pending ? <Banner kind={pending.danger ? 'bad' : 'info'} title={`${pending.label} su ${node.name}?`}>
        <p>{pending.hint}</p>
        {pending.typed ? <p>Per confermare scrivi il nome del nodo: <input className="input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={node.name} /></p> : null}
        <div className="row gap-s"><Button sm kind="danger" disabled={pending.typed && typed !== node.name} onClick={() => { const a = pending; setPending(null); a.run(); }}>Conferma</Button><Button sm onClick={() => setPending(null)}>Annulla</Button></div></Banner> : null}
      {(r.op || r.error) ? <div><OpPanel op={r.op} error={r.error} cancel={undefined} /><Result op={r.op} /></div> : null}
      {agent && isAdmin ? <div className="row"><Button sm icon="trash" onClick={onRevoke}>Revoca l’agent di questo nodo</Button></div> : null}
    </div>
  </Modal>;
}
