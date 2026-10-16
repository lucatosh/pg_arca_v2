import React, { Suspense, lazy, useState } from 'react';
import { api, get } from '../api';
import { Modal, Badge, Banner, Button, Card, Confirm, Dot, Empty, Field, Icon, Skeleton, Tabs, bytes, dt, ago, num, Preview, CopyBlock } from '../ui';
import { Op, readDraft, revalidate, toast, useDraft, useOpRunner, useQuery, isTerminal, useRole, writeDraft } from '../hooks';
import { go } from '../router';
import { CLUSTER_TASKS } from '../tasks';
import { OP_SPECS } from '../../server/optypes';
import { statusKind } from '../App';
import { useHealth } from './Today';
import { InstallCommand, OP_LABEL, OpPanel, PHASE, Result, statusBadge } from './shared';
const BackupTab = lazy(() => import('./Backup').then(m => ({ default: m.BackupTab })));
const RestoreTab = lazy(() => import('./Restore').then(m => ({ default: m.RestoreTab })));
const LogsTab = lazy(() => import('./Logs').then(m => ({ default: m.LogsTab })));
const HbaTab = lazy(() => import('./Hba').then(m => ({ default: m.HbaTab })));
const TuningTab = lazy(() => import('./Tuning').then(m => ({ default: m.TuningTab })));
import { AgentSettings } from './AgentSettings';
import { PendingJoin } from './Join';
import { NodePanel } from './NodePanel';
import { ProtectionRibbon } from './Ribbon';
import { TAB_ITEMS, TAB_GROUPS, groupOf } from '../tabs';
import { GeoLinkModal } from '../GeoLink';
import { ProtectionLine } from '../Protection';

const PREVIEW_TEXT: Record<string, string> = {};

export function ClusterView({ id, tab }: { id: string; tab?: string }) {
  const q = useQuery<{ cluster: any }>(`/api/clusters/${encodeURIComponent(id)}`, { interval: 5000 });
  const [detach, setDetach] = useState(false); const [busy, setBusy] = useState(false); const [spin, setSpin] = useState(false);
  const [gl, setGl] = useState(false); const allClusters: any[] = useQuery<any>('/api/clusters').data?.clusters || []; const useRoleIsAdmin = useRole() === 'admin';
  const c = q.data?.cluster; const cur = TAB_ITEMS.some(t => t.id === tab) ? tab! : 'overview'; const grp = groupOf(cur);
  // the header badge must agree with the health findings (the sidebar already does): a cluster whose WAL archiving is failing is not "Healthy"
  const hc = useHealth(30000).data?.clusters?.find((x: any) => x.id === id); const hw = hc?.worst as string | undefined;
  if (q.error?.status === 404) return <Empty icon="db" title="Cluster not found" action={<Button onClick={() => go('')}>Back to the list</Button>}>It may have been detached.</Empty>;
  if (!c) return <div className="stack"><Skeleton h={30} w={260} /><Skeleton h={120} /></div>;
  const doDetach = async () => {
    setBusy(true);
    try { await api('DELETE', `/api/clusters/${encodeURIComponent(id)}`); revalidate('/api/clusters'); toast(`Cluster ${c.name} detached`, 'ok'); go(''); }
    catch (e: any) { toast(e.message, 'bad'); setBusy(false); }
  };
  const agentic = c.source !== 'direct' && !c.isSandbox;
  const eff = hw === 'critical' ? 'critical' : hw === 'warning' && c.status === 'healthy' ? 'degraded' : c.status;
  return <>
    <div className="pagehead">
      <div className="grow"><div className="row wrap"><h1>{c.name}</h1><Badge kind={statusKind(eff)} title={hw === 'critical' || hw === 'warning' ? 'There are open findings for this cluster: see Today, or the banners below' : undefined}>{eff === 'healthy' ? 'Healthy' : eff === 'degraded' ? (hw === 'warning' ? 'Needs attention' : 'Degraded') : eff === 'critical' ? 'Critical problems' : eff}</Badge>
        {c.isSandbox ? <Badge>Demo</Badge> : c.source === 'direct' ? <Badge>Connection only</Badge> : null}</div>
        <p className="sub">{c.environment} · PostgreSQL {c.pgVersion || '—'}</p>
        {agentic && hc?.protection ? <div style={{ marginTop: 6 }}><ProtectionLine p={hc.protection} long /></div> : null}</div>
      {agentic && cur !== 'restore' ? <Button kind="primary" icon="restore" onClick={() => go(`c/${encodeURIComponent(id)}/restore`)} title="Restore a table, rows, a database or the whole server">Restore…</Button> : null}
      <Button icon="refresh" busy={spin} title="Reloads the status of the cluster, nodes, backups and operations right away" onClick={async () => { setSpin(true); const k = encodeURIComponent(id); await Promise.all([revalidate(`/api/clusters/${k}`), revalidate('/api/clusters'), revalidate('/api/nodes'), revalidate(`/api/clusters/${k}/backups`), revalidate(`/api/operations?clusterId=${k}`)]); setSpin(false); toast('Status refreshed', 'ok'); }}>Refresh</Button>
      <Button kind="ghost" icon="trash" onClick={() => setDetach(true)} title="Stop managing this cluster from the console (PostgreSQL and the backups are not touched)">Detach…</Button></div>
    {c.isSandbox ? <Banner kind="info" title="Demo cluster">Sample data: operations are not executed. You can delete it once you have connected a real cluster.</Banner> : null}
    {agentic ? <AgentUpdateBanner clusterId={c.id} /> : null}
    {/* the 30-day ribbon where it answers the question of the page (overview, backups); elsewhere the protection line above says it and the work starts higher */}
    {agentic && (cur === 'overview' || cur === 'backup') ? <ProtectionRibbon c={c} /> : null}
    {agentic ? <ActivityStrip id={c.id} /> : null}
    {c.geo ? <div className={`geostrip ${c.geo.health}`}><Icon n="swap" s={14} /><span className="small">{c.geo.role === 'standby'
      ? <><strong>Standby site (DR)</strong> of {c.geo.peers?.filter((p: any) => p.role === 'primary').map((p: any) => p.name).join(', ') || '?'} — {c.geo.lagBytes == null ? 'lag not measurable' : c.geo.lagBytes === 0 ? 'in sync' : `${bytes(c.geo.lagBytes)} behind`}{c.geo.problems?.length ? ` · ${c.geo.problems[0]}` : ''}</>
      : <><strong>Primary site</strong> replicated to {c.geo.peers?.map((p: any) => p.name).join(', ')}</>}</span>{useRoleIsAdmin ? <button className="btn ghost sm" onClick={() => setGl(true)}>Relationship…</button> : null}<button className="btn ghost sm" onClick={() => go('geo')}>Geo-redundancy</button></div> : null}
    {gl ? <GeoLinkModal c={c} all={allClusters} onClose={() => setGl(false)} /> : null}
    <RememberTab k={`nav:${id}:${grp.id}`} cur={cur} />
    <div className="clusternav">
      <div className="gnav" role="tablist" aria-label="Cluster areas">{TAB_GROUPS.map(g => <button key={g.id} role="tab" aria-selected={grp.id === g.id} onClick={() => go(`c/${encodeURIComponent(id)}/${grp.id === g.id ? cur : readDraft<string>(`nav:${id}:${g.id}`) || g.tabs[0]}`)}><Icon n={g.icon} />{g.label}</button>)}</div>
      <Tabs value={cur} onChange={t => go(`c/${encodeURIComponent(id)}/${t}`)} items={grp.tabs.map(tid => TAB_ITEMS.find(t => t.id === tid)!).map(t => ({ id: t.id, label: t.label, icon: t.icon, preview: t.preview }))} />
    </div>
    <Suspense fallback={<div className="stack"><Skeleton h={22} w={220} /><Skeleton h={160} /></div>}>
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
    </Suspense>
    {PREVIEW_TEXT[cur] ? <Preview title={TAB_ITEMS.find(t => t.id === cur)!.label}>{PREVIEW_TEXT[cur]}</Preview> : null}
    {detach ? <Confirm danger title={`Detach ${c.name}?`} confirmLabel="Detach" requireText={c.isSandbox ? undefined : c.name} busy={busy} onClose={() => setDetach(false)} onConfirm={doDetach}>
      <p>The console stops managing this cluster, revokes its agents and cancels queued operations. <strong>The data and backups on the server are not touched.</strong></p></Confirm> : null}
  </>;
}

/** "What do you need?": the common tasks as one click each, straight to the right page with the choice made (shared with Ctrl+K). */
function TaskStrip({ c, agentic }: { c: any; agentic: boolean }) {
  const role = useRole();
  const tasks = CLUSTER_TASKS.filter(t => (agentic || !t.agentOnly) && !(role === 'viewer' && ['table', 'rows', 'database', 'cluster', 'schedule', 'hba'].includes(t.id)));
  if (!tasks.length || c.isSandbox) return null;
  return <Card title="What do you need?"><div className="tasks">{tasks.map(t => <button key={t.id} className="task" onClick={() => t.run(c.id)}><Icon n={t.icon} s={16} /><span><strong>{t.label}</strong><span className="small muted">{t.hint}</span></span></button>)}</div></Card>;
}

function Kpi({ v, l }: { v: React.ReactNode; l: string }) { return <Card><div className="kpi"><span className="v">{v}</span><span className="l">{l}</span></div></Card>; }

function Overview({ c, agentic }: { c: any; agentic: boolean }) {
  const b = useQuery<any>(agentic ? `/api/clusters/${encodeURIComponent(c.id)}/backups` : null, { interval: 15000 });
  const bk = b.data?.backup;
  return <div className="stack-l">
    <div className="grid g3 kpis"><Kpi v={c.haState?.nodes?.length ?? 0} l="Nodes" /><Kpi v={bytes(c.totalSizeBytes)} l="Data size" /><Kpi v={num(c.tps)} l="Transactions per second" /></div>
    <TaskStrip c={c} agentic={agentic} />
    {agentic ? <Card title="Data protection">
      {b.loading ? <Skeleton h={40} /> : !b.data?.agent ? <p className="muted">No agent connected.</p> : !bk?.configured ? <Banner kind="warn" title="Backups not configured yet">Open the Backup tab to enable WAL archiving and take the first backup.</Banner> :
        <div className="row wrap gap-l"><div><div className="kpi"><span className="v">{bk.last_backup ? ago(bk.last_backup.stop_time) : 'never'}</span><span className="l">Last backup</span></div></div>
          <div className="kpi"><span className="v">{bk.sets}</span><span className="l">Valid backups</span></div>
          <div className="kpi"><span className="v">{b.data.wal?.continuous === false ? 'Broken' : 'Continuous'}</span><span className="l">Archived WAL</span></div>
          <div className="grow" /><Button onClick={() => go(`c/${encodeURIComponent(c.id)}/backup`)}>Open Backup</Button></div>}
    </Card> : c.source === 'direct' ? <Banner kind="info" title="Backup and restore are not available in connection-only mode">They run on the database server: install the agent on a node of this cluster to enable them.</Banner> : null}
    <Card title="Database" pad={false}>{c.databases?.length ? <div className="tablewrap"><table className="t"><thead><tr><th>Name</th><th className="num">Size</th></tr></thead>
      <tbody>{c.databases.map((d: any) => <tr key={d.name}><td>{d.name}</td><td className="num">{bytes(d.size)}</td></tr>)}</tbody></table></div> : <div className="bd muted">No data available.</div>}</Card>
  </div>;
}

function Nodes({ c }: { c: any }) {
  const nodes: any[] = c.haState?.nodes || [];
  const reg = useQuery<{ nodes: any[] }>('/api/nodes', { interval: 8000 });
  const mine = (reg.data?.nodes || []).filter(n => n.clusterId === c.id);
  const isAdmin = useRole() === 'admin';
  const [revoke, setRevoke] = useState<any>(null); const [tok, setTok] = useState<any>(null); const [busy, setBusy] = useState(false); const [sel, setSel] = useState<string | null>(null);
  const leaderName = (l => l?.memberName || l?.name)(nodes.find(n => n.role === 'primary'));
  const selNode = nodes.find(n => n.name === sel); const selAgent = mine.find(n => n.name === sel);
  const doRevoke = async () => { setBusy(true); try { await api('DELETE', `/api/nodes/${revoke.id}`); toast(`Agent on ${revoke.name} revoked`, 'ok'); revalidate('/api/nodes'); revalidate(`/api/clusters/${encodeURIComponent(c.id)}`); setRevoke(null); } catch (e: any) { toast(e.message, 'bad'); } finally { setBusy(false); } };
  const mint = async (nodeName?: string) => { setBusy(true); try { const t: any = await api('POST', '/api/enrollment-tokens', { label: `${c.name} +${nodeName || 'node'}`, clusterId: c.id, ttlMinutes: 60 }, { key: 'tok-' + Date.now() }); setTok(nodeName ? { ...t, node: nodeName } : t); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <div className="stack-l">
    {nodes.some(n => n.source === 'patroni') ? <Banner kind="info" title={`${nodes.filter(n => n.source === 'patroni').length} cluster nodes do not have the agent yet`}>Patroni sees them, but managing them (backup, restore, access) needs the agent. If the only node with an agent goes down, backups and restores do not start. Use “Install agent” next to each node: the command is already bound to this cluster.</Banner> : null}
    <Card title="Cluster members" actions={<span className="row gap-s">{c.activeTimeline || c.currentLSN ? <span className="small faint xp" title="Where the cluster's WAL is now: timeline (increases at each promotion) and current WAL position">timeline {c.activeTimeline || '—'} · LSN {c.currentLSN || '—'}</span> : null}<Badge>{c.haState?.managedByPatroni ? `Patroni cluster · ${nodes.length} nodes` : nodes.length > 1 ? `${nodes.length} independent servers` : "Single instance"}</Badge></span>} pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Node</th><th>Role</th><th>State</th><th className="num">Lag</th><th className="num">CPU</th><th className="num">Memory</th><th className="num">Connections</th><th /></tr></thead>
      <tbody>{nodes.map(n => <tr key={n.name}><td><span className="row gap-s"><Dot kind={n.online ? 'ok' : 'bad'} /><strong>{n.name}</strong>{n.source === 'patroni' ? (isAdmin && !c.isSandbox ? <PendingJoin name={n.name}><Badge kind="warn" title="Seen by Patroni: without an agent, no backups, restores or changes can be done on this node">no agent</Badge><Button sm icon="plus" disabled={busy} onClick={() => mint(n.name)}>Install agent</Button></PendingJoin> : <Badge kind="warn" title="Seen by Patroni: without an agent, no backups, restores or changes can be done on this node">no agent</Badge>) : null}</span><div className="faint small">{n.host}:{n.port}{n.memberName && n.memberName !== n.name ? <span title="The name Patroni knows this node by (its member name differs from the hostname)"> · Patroni: {n.memberName}</span> : null}</div></td>
        <td><Badge kind={n.role === 'primary' ? 'accent' : undefined}>{n.role === 'primary' ? 'Primary' : n.role === 'sync_standby' ? 'Sync standby' : n.role === 'standby_leader' ? 'Standby leader' : 'Replica'}</Badge></td>
        <td>{n.online ? n.state : 'offline'}</td><td className="num">{n.role === 'primary' ? '—' : bytes(n.replicationLagBytes)}</td>
        <td className="num">{n.source === 'agent' ? `${n.cpuPercent}%` : '—'}</td><td className="num">{n.source === 'agent' ? `${n.memoryPercent}%` : '—'}</td><td className="num">{n.connections}/{n.maxConnections || '—'}</td><td className="num">{!c.isSandbox && c.source !== 'direct' ? <Button sm onClick={() => setSel(n.name)}>Manage</Button> : null}</td></tr>)}
        {!nodes.length ? <tr><td colSpan={8} className="muted">No nodes detected.</td></tr> : null}</tbody></table></div></Card>
    {c.source !== 'direct' && !c.isSandbox ? <Card title="Installed agents" actions={isAdmin ? <Button sm icon="plus" busy={busy && !revoke} onClick={() => mint()}>Add node</Button> : undefined} pad={false}>
      <div className="tablewrap"><table className="t"><thead><tr><th>Node</th><th>Agent version</th><th>Last seen</th><th>Address</th><th /></tr></thead>
        <tbody>{mine.map(n => <tr key={n.id}><td><span className="row gap-s"><Dot kind={n.online ? 'ok' : 'bad'} />{n.name}</span></td><td>{n.agentVersion}</td><td>{ago(n.lastSeen)}</td><td className="mono">{n.remoteIp}</td>
          <td className="num">{isAdmin ? <Button sm icon="trash" onClick={() => setRevoke(n)}>Revoke</Button> : null}</td></tr>)}
          {!mine.length ? <tr><td colSpan={5} className="muted">No agents.</td></tr> : null}</tbody></table></div></Card> : null}
    {!c.isSandbox && c.source !== 'direct' ? <AgentSettings clusterId={c.id} nodes={mine.map(n => ({ id: n.id, name: n.name, online: n.online }))} /> : null}
    {/* storage is set in ONE place, with the backups (a review found it in three, and the offsite copy only here) */}
    {!c.isSandbox && c.source !== 'direct' ? <div className="activitystrip"><Icon n="shield" s={14} /><span className="small">Offsite copy: in Protection → Backup, next to where the backups go.</span><div className="grow" /><button className="linkbtn small" onClick={() => go(`c/${encodeURIComponent(c.id)}/backup`)}>Open</button></div> : null}
    {selNode ? <NodePanel c={c} node={selNode} agent={selAgent} leader={leaderName} isAdmin={isAdmin} onClose={() => setSel(null)} onInstall={() => { setSel(null); mint(selNode.name); }} onRevoke={() => { setRevoke(selAgent); setSel(null); }} /> : null}
    {tok ? <Modal title={tok.node ? `Install the agent on ${tok.node}` : 'Add a node'} onClose={() => setTok(null)} footer={<Button onClick={() => setTok(null)}>Close</Button>}><div className="stack"><p>Run this command as root on the server{tok.node ? ` ${tok.node}` : ''}. The token is valid for a single node and expires in one hour.</p><InstallCommand r={tok} nodeName={tok.node} /><p className="faint small">Alternative without a token: install the agent giving only the console address. The server announces itself and you approve it from the “New server detected” banner.</p></div></Modal> : null}
    {revoke ? <Confirm danger title={`Revoke the agent on ${revoke.name}?`} confirmLabel="Revoke" busy={busy} onClose={() => setRevoke(null)} onConfirm={doRevoke}>
      <p>The agent’s secret becomes invalid immediately and queued operations for this node are cancelled. PostgreSQL on the node is not touched; reconnecting it needs a new token.</p></Confirm> : null}
  </div>;
}

type HaAct = { kind: 'switchover' | 'failover' | 'restart' | 'pause' | 'reload'; member?: string };
function HA({ c }: { c: any }) {
  const nodes: any[] = c.haState?.nodes || [];
  const leader = nodes.find(n => n.role === 'primary');
  const [act, setAct] = useState<HaAct | null>(null); const [cand, setCand] = useState(''); const [typed, setTyped] = useState('');
  const r = useOpRunner(c.id, () => revalidate(`/api/clusters/${encodeURIComponent(c.id)}`));
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real Patroni cluster to use switchover and failover.</Banner>;
  if (!c.haState?.managedByPatroni) return <Card><Empty icon="swap" title="Patroni not detected">High-availability operations require a Patroni-managed cluster with the agent installed (or its API connected in connection mode).</Empty></Card>;
  const standbys = nodes.filter(n => n.role !== 'primary' && n.online && ['running', 'streaming'].includes(String(n.state)));   // only replicas Patroni could really promote
  const sickCount = nodes.filter(n => n.role !== 'primary').length - standbys.length;
  const mname = (n: any) => n?.memberName || n?.name;
  const start = (a: HaAct) => { setAct(a); setCand(mname(standbys[0]) || ''); setTyped(''); r.reset(); };
  const exec = () => {
    if (!act) return;
    const m = act.kind;
    if (m === 'switchover') r.run('patroni_switchover', { leader: mname(leader), candidate: cand || undefined });
    else if (m === 'failover') r.run('patroni_failover', { candidate: cand, confirm: 'FAILOVER' });
    else if (m === 'restart') r.run('patroni_restart', { member: act.member });
    else if (m === 'reload') r.run('patroni_reload', {});
    else r.run('patroni_pause', { enable: !c.haState.maintenanceMode });
    setAct(null);
  };
  return <div className="stack-l">
    {c.haState.maintenanceMode ? <Banner kind="warn" title="Maintenance mode on">Patroni will not perform automatic failovers until you turn it off.</Banner> : null}
    <Card title="Actions">
      <div className="row wrap">
        <Button icon="swap" disabled={!standbys.length || r.busy} onClick={() => start({ kind: 'switchover' })}>Planned switchover</Button>
        <Button icon="pause" disabled={r.busy} onClick={() => start({ kind: 'pause' })}>{c.haState.maintenanceMode ? 'Leave maintenance mode' : 'Enter maintenance mode'}</Button>
        <Button icon="refresh" disabled={r.busy} onClick={() => start({ kind: 'reload' })}>Reload Patroni</Button>
        <Button kind="danger" icon="alert" disabled={!standbys.length || r.busy} onClick={() => start({ kind: 'failover' })}>Forced failover…</Button></div>
<dl className="kv" style={{ marginTop: 12 }}>
        <dt>Planned switchover</dt><dd className="small muted">Hands the primary role to a healthy replica, in an orderly way and without data loss. Connections drop for a few seconds. Used for maintenance.</dd>
        <dt>Enter maintenance mode</dt><dd className="small muted">Suspends Patroni’s automatic failovers: the cluster does not change primary by itself while you work. Remember to leave it.</dd>
        <dt>Reload Patroni</dt><dd className="small muted">Makes Patroni re-read its configuration file (patroni.yml) on the node, without restarting PostgreSQL. Needed after editing it by hand. Does not change the primary.</dd>
        <dt>Forced failover</dt><dd className="small muted">Promotes a replica immediately, without waiting for the primary. Only when the primary is not responding: transactions not yet replicated are lost.</dd></dl>
      {sickCount > 0 ? <p className="small" style={{ marginTop: 8, color: 'var(--warn, #d9a441)' }}>{sickCount} {sickCount === 1 ? 'replica is' : 'replicas are'} not healthy (state other than running): {sickCount === 1 ? 'it' : 'they'} cannot be chosen{standbys.length ? '' : ', so switchover and failover are disabled'}.</p> : null}</Card>
    <Card title="Members" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Member</th><th>Role</th><th>State</th><th /></tr></thead><tbody>
      {nodes.map(n => <tr key={n.name}><td>{n.name}</td><td>{n.role === 'primary' ? 'Leader' : 'Replica'}</td><td>{n.online ? n.state : 'offline'}</td><td className="num"><Button sm disabled={r.busy} onClick={() => start({ kind: 'restart', member: mname(n) })}>Restart</Button></td></tr>)}</tbody></table></div></Card>
    {r.conflict?.overridable ? <Banner kind="warn" title="Conflict with another operation">{r.conflict.message} <Button sm kind="danger" onClick={() => r.runForced()}>Proceed anyway</Button></Banner>
      : (r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} cancel={undefined} /><Result op={r.op} /></Card> : null}
    {act ? <Modal2 act={act} leader={mname(leader)} standbys={standbys} cand={cand} setCand={setCand} typed={typed} setTyped={setTyped} onClose={() => setAct(null)} onGo={exec} maint={!!c.haState.maintenanceMode} /> : null}
  </div>;
}

function Modal2({ act, leader, standbys, cand, setCand, typed, setTyped, onClose, onGo, maint }: any) {
  const k = act.kind; const danger = k === 'failover' || k === 'restart';
  const title = k === 'switchover' ? 'Planned switchover' : k === 'failover' ? 'Forced failover' : k === 'restart' ? `Restart ${act.member}?` : k === 'reload' ? 'Reload Patroni?' : maint ? 'Leave maintenance mode?' : 'Enter maintenance mode?';
  return <Confirm title={title} danger={danger} confirmLabel="Run" requireText={k === 'failover' ? 'FAILOVER' : undefined} onClose={onClose} onConfirm={() => (k === 'failover' && !cand ? null : onGo())}>
    {k === 'switchover' || k === 'failover' ? <Field label="New primary"><select className="input" value={cand} onChange={e => setCand(e.target.value)}>{standbys.map((s: any) => <option key={s.name} value={s.memberName || s.name}>{s.name}{s.replicationLagBytes ? ` (lag ${bytes(s.replicationLagBytes)})` : ''}</option>)}</select></Field> : null}
    {k === 'switchover' ? <p>The current primary <strong>{leader}</strong> hands over its role in an orderly way. Active connections are interrupted for a few seconds.</p> : null}
    {k === 'failover' ? <Banner kind="bad" title="Risk of data loss">Promotes the chosen replica without waiting for the primary. Transactions not yet replicated will be lost.</Banner> : null}
    {k === 'restart' ? <p>The member will be unreachable while PostgreSQL restarts.</p> : null}
    {k === 'pause' ? <p>{maint ? 'Patroni resumes automatic management of the cluster.' : 'Patroni suspends automatic failovers: useful during manual work.'}</p> : null}
  </Confirm>;
}

const PARAMS = ['work_mem', 'maintenance_work_mem', 'shared_buffers', 'effective_cache_size', 'max_connections', 'checkpoint_timeout', 'max_wal_size', 'log_min_duration_statement', 'archive_timeout', 'wal_level', 'archive_mode', 'full_page_writes', 'wal_log_hints'];
/** The sub-tab last opened in each area of a cluster: switching area and coming back lands where you were. */
function RememberTab({ k, cur }: { k: string; cur: string }) { React.useEffect(() => { writeDraft(k, cur); }, [k, cur]); return null; }

function Params({ c }: { c: any }) {
  const PK = `params:${c.id}`;
  const [name, setName] = useDraft(PK + ':name', ''); const [value, setValue] = useDraft(PK + ':value', ''); const [reset, setReset] = useDraft(PK + ':reset', false); const [node, setNode] = useDraft(PK + ':node', '');
  const [ask, setAsk] = useState(false);
  const r = useOpRunner(c.id, undefined, PK + ':op');
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real cluster to change parameters.</Banner>;
  const valid = /^[a-z_][a-z0-9_.]*$/i.test(name) && (reset || value !== '');
  const nodes = c.agentNodes || [];
  return <div className="stack-l">
    <Card title="Change a parameter" actions={<Badge title={c.haState?.managedByPatroni ? 'Patroni cluster: the parameter goes into the dynamic configuration (like patronictl edit-config) and applies to all members; never ALTER SYSTEM or postgresql.conf.' : undefined}>{c.haState?.managedByPatroni ? 'Patroni DCS (edit-config)' : 'ALTER SYSTEM'}</Badge>}>
      <div className="stack"><div className="grid g2">
        <Field label="Parameter"><input className="input" list="pgparams" value={name} onChange={e => setName(e.target.value)} placeholder="work_mem" /><datalist id="pgparams">{PARAMS.map(p => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Value" hint={reset ? 'The parameter will go back to its default value.' : undefined}><input className="input" disabled={reset} value={value} onChange={e => setValue(e.target.value)} placeholder="64MB" /></Field>
        {nodes.length > 1 && !c.haState?.managedByPatroni ? <Field label="Node" hint="The parameter applies to the chosen node."><select className="input" value={node} onChange={e => setNode(e.target.value)}><option value="">Primary (automatic)</option>{nodes.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field> : null}</div>
        <label className="check"><input type="checkbox" checked={reset} onChange={e => setReset(e.target.checked)} />Reset to the default value</label>
        <div className="row"><Button kind="primary" disabled={!valid || r.busy} onClick={() => setAsk(true)}>Apply</Button>
          <Button disabled={r.busy} onClick={() => r.run('pg_reload', {}, { nodeId: node || undefined })}>Reload configuration</Button></div></div></Card>
    {r.conflict?.overridable ? <Banner kind="warn" title={r.conflict.error === 'geo_standby_lower' ? 'Standby sites first' : 'Conflict with another operation'} actions={<Button sm kind="danger" onClick={() => r.runForced()}>Apply anyway</Button>}>{r.conflict.message}</Banner>
      : (r.op || r.error) ? <Card><OpPanel op={r.op} error={r.error} /><Result op={r.op} /></Card> : null}
    {ask ? <Confirm title="Apply the parameter?" confirmLabel="Apply" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); r.run('pg_set_param', { name, value: reset ? null : value }, { nodeId: node || undefined }); }}>
      <p><code>{name}</code> → <code>{reset ? 'DEFAULT' : value}</code>. {c.haState?.managedByPatroni ? 'It will be written to Patroni’s dynamic configuration (DCS) and applied by all members.' : 'It will be saved with ALTER SYSTEM and the configuration reloaded.'} If the parameter needs a restart, the result says so and the restart stays your decision.</p></Confirm> : null}
  </div>;
}

function Operations({ c }: { c: any }) {
  const q = useQuery<{ operations: Op[] }>(`/api/operations?clusterId=${encodeURIComponent(c.id)}`, { interval: 3000 });
  const [open, setOpen] = useState<string | null>(null);
  // the checks and reads pages run by themselves (offsite settings, restore plans…) are hidden unless asked: the list is about what changed things
  const [checks, setChecks] = useDraft(`ops:${c.id}:checks`, false);
  const all = q.data?.operations || []; const isRead = (o: Op) => OP_SPECS[o.type] ? !OP_SPECS[o.type].mutating : false;
  const ops = checks ? all : all.filter(o => !isRead(o) || o.status === 'failed' || o.status === 'expired'); const hidden = all.length - ops.length;   // a failed check is never hidden
  const cancel = async (id: string) => { try { await api('POST', `/api/operations/${id}/cancel`); q.refresh(); } catch (e: any) { toast(e.message, 'bad'); } };
  return <Card title="Operations on this cluster" pad={false} actions={hidden || checks ? <label className="check small"><input type="checkbox" checked={checks} onChange={e => setChecks(e.target.checked)} />Show checks and reads{!checks && hidden ? ` (${hidden})` : ''}</label> : undefined}>
    {!ops.length ? <Empty icon="list" title="No operations">Backups, restores and other actions appear here with outcome and duration.</Empty> :
      <div className="tablewrap"><table className="t"><thead><tr><th>When</th><th>Operation</th><th>Status</th><th>Started by</th><th /></tr></thead><tbody>
        {ops.map(o => <React.Fragment key={o.id}><tr className="click" onClick={() => setOpen(open === o.id ? null : o.id)}>
          <td title={dt(o.createdAt)}>{ago(o.createdAt)}</td><td>{OP_LABEL[o.type] || o.type}{o.params?.type ? ` (${o.params.type})` : ''}</td><td>{statusBadge(o.status)}</td>
          <td className="muted">{(o as any).createdBy}</td><td className="num">{!isTerminal(o.status) ? <Button sm onClick={e => { e.stopPropagation(); cancel(o.id); }}>Cancel</Button> : null}</td></tr>
          {open === o.id ? <tr><td colSpan={5}><div className="stack"><OpPanel op={o} /><Result op={o} /><details><summary className="small muted" style={{ cursor: 'pointer' }}>History and parameters</summary><pre className="out">{JSON.stringify({ params: o.params, history: (o as any).history }, null, 2)}</pre></details></div></td></tr> : null}</React.Fragment>)}
      </tbody></table></div>}
  </Card>;
}

/** Who is doing what on this cluster right now (every DBA sees the others' work before starting something that would collide). */
function ActivityStrip({ id }: { id: string }) {
  const q = useQuery<{ activity: { id: string; what: string; status: string; createdBy: string; createdAt: string; progress: string | null }[] }>(`/api/clusters/${encodeURIComponent(id)}/activity`, { interval: 5000 });
  const a = q.data?.activity || [];
  if (!a.length) return null;
  return <div className="activitystrip" role="status"><Icon n="activity" s={14} /><span className="small"><strong>Running on this cluster:</strong> {a.map((x, i) => <span key={x.id}>{i ? ' · ' : ''}{OP_LABEL[(x as any).type] || x.what} <span className="faint">({x.status === 'queued' ? 'queued' : (x.progress && (PHASE[x.progress] || x.progress)) || 'running'}, {x.createdBy}, {ago(x.createdAt)})</span></span>)}</span>
    <button className="btn ghost sm" onClick={() => window.dispatchEvent(new Event('arca:dock'))}>Details</button></div>;
}

/** Agents of this cluster running other code than the console serves: console features may be missing there (an old agent ignores what it does not know). */
function AgentUpdateBanner({ clusterId }: { clusterId: string }) {
  const q = useQuery<{ nodes: any[] }>('/api/nodes', { interval: 30000 });
  const h = useQuery<{ version?: string }>('/api/health', { interval: 300000 });
  const [show, setShow] = useState(false);
  // only nodes that respond: an agent that does not report cannot be updated from here, and its real problem (not responding) is said elsewhere
  const old = (q.data?.nodes || []).filter(n => n.clusterId === clusterId && n.agentOutdated && n.online !== false);
  if (!old.length) return null;
  const cmds = Array.from(new Set(old.map(n => n.upgradeCommand).filter(Boolean))) as string[];
  const local = cmds.some(c => /https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(c));          // the servers cannot reach a console on localhost
  const cv = h.data?.version; const vs = Array.from(new Set(old.map(n => n.agentVersion || '?')));
  // same version number, different code (a release candidate rebuilt, a patched console): say so instead of "1.0.0-rc.1 → 1.0.0-rc.1"
  const vers = cv && vs.length === 1 && vs[0] === cv ? `an earlier build of ${cv}` : `${vs.join(', ')} → ${cv || 'this console'}`;
  // one line by default: it used to be a 150 px banner on every tab of the cluster, pushing the restore wizard below the fold
  return <div className="activitystrip" role="status"><Icon n="alert" s={14} />
    <span className="small"><strong>{old.length === 1 ? `The agent on ${old[0].name} is outdated` : `${old.length} agents are outdated (${old.map(n => n.name).join(', ')})`}</strong> <span className="faint">({vers}): some features may be missing until it is updated; updating does not touch PostgreSQL or the backups.</span></span>
    <button className="btn ghost sm" onClick={() => setShow(!show)} aria-expanded={show}>{show ? 'Hide' : 'Show the update command'}</button>
    {show ? <div style={{ flexBasis: '100%' }}>{local ? <p className="small">The console address is <code>localhost</code>, which the servers cannot reach: set the address the servers use in <a href="#/settings">Settings → Console address</a>, then the command appears here.</p>
      : <><p className="small" style={{ margin: '6px 0' }}>Run as root {old.length > 1 ? 'on each of these servers' : `on ${old[0].name}`}:</p>{cmds.map(c => <CopyBlock key={c} text={c} />)}</>}</div> : null}
  </div>;
}
