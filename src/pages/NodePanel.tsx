import React, { useState } from 'react';
import { Modal, Badge, Banner, Button, Dot, bytes, ago } from '../ui';
import { useOpRunner } from '../hooks';
import { OpPanel, Result } from './shared';

type Act = { id: string; label: string; hint: string; danger?: boolean; typed?: boolean; run: () => void; disabled?: string };

/** Everything you can do on ONE node: facts first, then commands grouped by what they touch. Commands act on this node, not on "some node of the cluster". */
export function NodePanel({ c, node, agent, leader, isAdmin, onClose, onInstall, onRevoke }: { c: any; node: any; agent?: any; leader?: string; isAdmin: boolean; onClose: () => void; onInstall: () => void; onRevoke: () => void }) {
  const member = node.memberName || node.name;           // Patroni knows this node by its MEMBER name, which may differ from the hostname/agent name
  const r = useOpRunner(c.id);
  const [pending, setPending] = useState<Act | null>(null); const [typed, setTyped] = useState('');
  const patroni = !!c.haState?.managedByPatroni;
  const isPrimary = node.role === 'primary';
  const healthy = node.online && ['running', 'streaming'].includes(String(node.state));
  const hasAgent = !!agent && agent.online;
  const nid = agent?.id as string | undefined;
  const noAgent = 'Needs an online agent on this node';
  const noPatroni = 'Needs Patroni on this cluster';

  const acts: { group: string; items: Act[] }[] = [
    { group: 'PostgreSQL', items: [
      patroni || !hasAgent
        ? { id: 'restart', label: 'Restart PostgreSQL', hint: 'Orderly restart through Patroni. The node does not respond for a few seconds' + (isPrimary ? ' and, since it is the primary, applications lose their connection.' : '.'), danger: true, disabled: patroni ? undefined : noAgent, run: () => r.run('patroni_restart', { member }) }
        : { id: 'restart', label: 'Restart PostgreSQL', hint: 'Restart the way the server is managed (its systemd service, or pg_ctl where there is no systemd). All connections are closed; if the configuration has errors that would prevent startup, the restart is refused beforehand.', danger: true, typed: true, run: () => r.run('pg_restart', { confirm: 'RESTART' }, { nodeId: nid }) },

      { id: 'reload', label: 'Reload the configuration', hint: 'Re-reads postgresql.conf and pg_hba.conf without restarting. Safe to run at any time.', disabled: hasAgent ? undefined : noAgent, run: () => r.run('pg_reload', {}, { nodeId: nid }) },
      { id: 'checkpoint', label: 'Run a checkpoint', hint: 'Forces in-memory data to be written to disk. Useful before a backup or a restart.', disabled: !isPrimary ? 'Primary only' : hasAgent ? undefined : noAgent, run: () => r.run('checkpoint', {}, { nodeId: nid }) },
      { id: 'walsw', label: 'Switch the current WAL file', hint: 'Gets the current WAL archived right away: reduces the maximum loss in case of disaster.', disabled: !isPrimary ? 'Primary only' : hasAgent ? undefined : noAgent, run: () => r.run('wal_switch', {}, { nodeId: nid }) },
    ] },
    { group: 'High availability', items: [
      { id: 'promote', label: 'Promote to primary', hint: `Orderly switchover: ${leader || 'the primary'} hands its role to ${node.name} without data loss.`, danger: true, disabled: !patroni ? noPatroni : isPrimary ? 'It is already the primary' : !healthy ? 'The replica is not healthy (it is not replicating)' : undefined, run: () => r.run('patroni_switchover', { leader, candidate: member }) },
      { id: 'reinit', label: 'Reinitialize the replica', hint: 'Deletes this node’s data and re-clones it from the primary. Used when a replica does not start or is corrupted. It can take a long time on large databases.', danger: true, typed: true, disabled: !patroni ? noPatroni : isPrimary ? 'Never on the primary: it would destroy the data' : undefined, run: () => r.run('patroni_reinit', { member }) },
    ] },
    { group: 'Agent', items: [
      { id: 'compat', label: 'Check PostgreSQL compatibility', hint: 'Checks this node’s PostgreSQL version, whether it is supported or end-of-life, and that the binaries the agent uses (psql, pg_waldump…) match the server.', disabled: hasAgent ? undefined : noAgent, run: () => r.run('compat_check', {}, { nodeId: nid }) },
      { id: 'scan', label: 'Run discovery again', hint: 'The agent rescans PostgreSQL, Patroni and paths on this server.', disabled: hasAgent ? undefined : noAgent, run: () => r.run('discovery_scan', {}, { nodeId: nid }) },
    ] },
  ];
  const go = (a: Act) => { if (a.disabled) return; if (a.danger) { setPending(a); setTyped(''); } else a.run(); };

  return <Modal title={<span className="row gap-s"><Dot kind={node.online ? 'ok' : 'bad'} />{node.name}<Badge kind={isPrimary ? 'accent' : undefined}>{isPrimary ? 'Primary' : 'Replica'}</Badge></span>} onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
    <div className="stack-l">
      <dl className="kv">
        <dt>State</dt><dd>{node.online ? node.state : 'offline'}</dd>
        {!isPrimary ? <><dt>Replication lag</dt><dd>{bytes(node.replicationLagBytes)}</dd></> : null}
        <dt>Address</dt><dd className="mono">{node.host}:{node.port}</dd>
        <dt>Timeline</dt><dd>{node.timeline ?? '—'}</dd>
        {node.pgVersion ? <><dt>PostgreSQL</dt><dd>{String(node.pgVersion).split(' ')[0]} {node.compat && node.compat.problems.length ? <Badge kind={node.compat.problems.some((p: any) => p.severity === 'critical') ? 'bad' : 'warn'}>{node.compat.tier === 'unsupported' ? 'unsupported' : node.compat.tier === 'legacy' ? 'legacy' : node.compat.eol ? 'end of life' : 'to verify'}</Badge> : node.compat ? <Badge kind="ok">supported</Badge> : null}</dd></> : null}
        <dt>Agent</dt><dd>{agent ? <>{agent.agentVersion} · last seen {ago(agent.lastSeen)} · {agent.remoteIp}</> : <span className="muted">not installed</span>}</dd>
      </dl>
      {!agent ? <Banner kind="warn" title="This node has no agent">Patroni sees it, but backups, restores, access and logs need the agent.{isAdmin ? <> <Button sm icon="plus" onClick={onInstall}>Install agent</Button></> : null}</Banner> : null}
      {acts.map(g => <div key={g.group}><h4 style={{ margin: '0 0 8px' }}>{g.group}</h4>
        <div className="stack">{g.items.map(a => <div key={a.id} className="row gap-s" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ flex: 1 }}><strong>{a.label}</strong><div className="small muted">{a.disabled ? a.disabled + '.' : a.hint}</div></div>
          <Button sm kind={a.danger ? 'danger' : undefined} disabled={!!a.disabled || r.busy || !isAdmin && a.danger} onClick={() => go(a)}>Run</Button></div>)}</div></div>)}
      {pending ? <Banner kind={pending.danger ? 'bad' : 'info'} title={`${pending.label} on ${node.name}?`}>
        <p>{pending.hint}</p>
        {pending.typed ? <p>Type the node name to confirm: <input className="input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={node.name} /></p> : null}
        <div className="row gap-s"><Button sm kind="danger" disabled={pending.typed && typed !== node.name} onClick={() => { const a = pending; setPending(null); a.run(); }}>Confirm</Button><Button sm onClick={() => setPending(null)}>Cancel</Button></div></Banner> : null}
      {(r.op || r.error) ? <div><OpPanel op={r.op} error={r.error} cancel={undefined} /><Result op={r.op} /></div> : null}
      {agent && isAdmin ? <div className="row"><Button sm icon="trash" onClick={onRevoke}>Revoke this node’s agent</Button></div> : null}
    </div>
  </Modal>;
}
