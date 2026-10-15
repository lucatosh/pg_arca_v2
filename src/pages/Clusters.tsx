import { InstallCommand } from './shared';
import React, { useEffect, useRef, useState } from 'react';
import { api, get, uid } from '../api';
import { Badge, Banner, Button, Card, CopyBlock, Dot, Empty, Field, Icon, Modal, Skeleton, bytes, num } from '../ui';
import { revalidate, toast, useQuery, useRole, clearDrafts, useDraft } from '../hooks';
import { summarize } from './Strategy';
import { go } from '../router';
import { statusKind } from '../App';
import { buildFleet, toneOf, useFold, FolderNode, replicaText } from '../Fleet';
import { useHealth } from './Today';
import { GeoLinkField, LinkMode, linkModeOf, saveGeoLink } from '../GeoLink';
import { ProtectionLine } from '../Protection';

const ENVS = [['prod', 'Production'], ['prep', 'Pre-production'], ['int', 'Integration'], ['dev', 'Development'], ['test', 'Test']];
const stratOf = (c: any, pol: any) => {
  if (c.isSandbox || c.source === 'direct') return <span className="muted">—</span>;
  const e = pol?.clusters?.find((x: any) => x.id === c.id)?.effective; if (!pol) return <span className="muted">…</span>;
  return e?.policy ? <Badge kind="ok" title={summarize(e.policy)}>{e.source.templateName || 'Custom'}</Badge> : <a href="#/strategy" onClick={ev => ev.stopPropagation()} title="No backup schedule: backups only when started by hand"><Badge kind="warn">No schedule</Badge></a>;
};
// the agent is the normal case: only the exceptions are marked, next to the name (the Mode column made the table overflow)
const modeOf = (c: any) => c.isSandbox ? <Badge>Demo</Badge> : c.source === 'direct' ? <Badge title="Plain PostgreSQL connection: monitoring only, no backups">Connection only</Badge> : null;

export function Clusters({ clusters, loading, demoAvailable }: { clusters: any[]; loading: boolean; demoAvailable: boolean }) {
  const [wiz, setWiz] = useDraft('attach:open', false); const pol = useQuery<any>('/api/policies', { interval: 20000 }).data; const [org, setOrg] = useDraft<any>('organize:open', null);
  const real = clusters.filter(c => !c.isSandbox);
  // one source for every status in the console (the briefing): the KPI used to count c.status while the sidebar used the findings
  const hb = useHealth(30000).data; const prot = ((hb?.clusters || []) as any[]).filter((x: any) => x.protection && x.protection.state !== 'none');
  const protectedN = prot.filter((x: any) => x.protection.state === 'ok').length; const unprot = prot.filter((x: any) => x.protection.state === 'bad').length;
  const restoreDemo = async () => { try { await api('POST', '/api/clusters/demo'); revalidate('/api/clusters'); } catch (e: any) { toast(e.message, 'bad'); } };
  return <>
    <div className="pagehead"><div className="grow"><h1>Clusters</h1><p className="sub">All the PostgreSQL clusters managed by this console.</p></div>
      <Button kind="primary" icon="plus" onClick={() => setWiz(true)}>Connect cluster</Button></div>
    {clusters.length ? <div className="grid g4 kpis">
      <Card><div className="kpi"><span className="v">{clusters.length}</span><span className="l">Connected clusters</span></div></Card>
      <Card><div className="kpi"><span className="v" style={unprot ? { color: 'var(--bad)' } : undefined}>{protectedN}<span className="faint" style={{ fontSize: 14 }}> / {prot.length}</span></span><span className="l">{unprot ? `Protected · ${unprot} not protected` : 'Protected (restorable, no open problem)'}</span></div></Card>
      <Card><div className="kpi"><span className="v">{clusters.reduce((a, c) => a + (c.haState?.nodes?.length || 0), 0)}</span><span className="l">Nodes</span></div></Card>
      <Card><div className="kpi"><span className="v">{bytes(clusters.reduce((a, c) => a + (c.totalSizeBytes || 0), 0))}</span><span className="l">Managed data</span></div></Card>
    </div> : null}
    <Card pad={false}>
      {loading ? <div className="bd stack"><Skeleton h={18} /><Skeleton h={18} /><Skeleton h={18} /></div> :
        !clusters.length ? <Empty icon="db" title="No connected clusters" action={<div className="row" style={{ justifyContent: 'center' }}><Button kind="primary" icon="plus" onClick={() => setWiz(true)}>Connect cluster</Button>{demoAvailable ? <Button onClick={restoreDemo}>Restore the demo cluster</Button> : null}</div>}>
          Connect a cluster by installing the agent on a node (full backup, restore and high availability) or with a plain PostgreSQL connection (monitoring, no backups).</Empty> :
        <FleetTable clusters={clusters} pol={pol} onOrganize={setOrg} />}
    </Card>
    {real.length === 0 && clusters.length > 0 ? <Banner kind="info" title="You are looking at the demo cluster">It is an example: operations are not executed. Connect a real cluster, then delete the demo from its page.</Banner> : null}
    {wiz ? <AttachWizard onClose={() => { clearDrafts('attach'); setWiz(false); }} /> : null}
    {org ? <Organize c={org} all={clusters} onClose={() => { clearDrafts(`organize:${org.id}`); setOrg(null); }} /> : null}
  </>;
}

/** Cluster list grouped like the sidebar: environment (state, counts, size) > folders > clusters. */
function FleetTable({ clusters, pol, onOrganize }: { clusters: any[]; pol: any; onOrganize: (c: any) => void }) {
  const isAdmin = useRole() === 'admin';
  const h = useHealth(30000).data; const health = Object.fromEntries(((h?.clusters || []) as any[]).map((c: any) => [c.id, c.worst]));
  const prot = Object.fromEntries(((h?.clusters || []) as any[]).map((c: any) => [c.id, c.protection]));
  const groups = buildFleet(clusters, health); const fold = useFold('arca.fleet.table');
  // a standby site holds a copy of its primary: it counts for nodes, not again for data size
  const size = (n: FolderNode): number => n.clusters.reduce((a, c) => a + (c.totalSizeBytes || 0), 0) + n.children.reduce((a, x) => a + size(x), 0);
  const nn = (c: any) => c.haState?.nodes?.length ?? c.agentNodes?.length ?? 0;
  const nodes = (n: FolderNode): number => n.clusters.reduce((a, c) => a + nn(c) + (c.replicas || []).reduce((b: number, r: any) => b + nn(r), 0), 0) + n.children.reduce((a, x) => a + nodes(x), 0);
  const summary = (n: { count: number; bad: number; warn: number }) => <span className="small muted">{n.count} {n.count === 1 ? 'cluster' : 'clusters'}{n.bad ? <> · <span style={{ color: 'var(--bad)', fontWeight: 600 }}>{n.bad} critical</span></> : null}{n.warn ? <> · <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{n.warn} to check</span></> : null}{!n.bad && !n.warn ? ' · all healthy' : ''}</span>;
  const one = (c: any, depth: number, replica = false, parentEnv?: string) => <tr key={c.id} className={`click${replica ? ' replicarow' : ''}`} onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>
    <td style={{ paddingLeft: 14 + depth * 18 }}><span className="row gap-s">{replica ? <span className="branch" aria-hidden /> : null}<Dot kind={toneOf(c, health)} /><a href={`#/c/${encodeURIComponent(c.id)}`} onClick={e => e.stopPropagation()}><strong>{c.name}</strong></a>
      {replica && parentEnv && c.environment && c.environment !== parentEnv ? <span className="faint small">· {c.environment}</span> : null}
      {replica ? <span className="geotag" title="Standby site (standby cluster): receives data from the primary above">DR</span> : c.replicas?.length ? <span className="geotag p" title={`Primary site, replicated to ${c.replicas.map((r: any) => r.name).join(', ')}`}>GEO</span> : null}</span></td>
    <td className={replica ? 'stcell' : undefined} title={replica ? `Standby of ${c.geo.peers?.find((p: any) => p.role === 'primary')?.name}: ${replicaText(c)}` : undefined}><span className="small">{replica ? <>Standby{c.geo.link === 'manual' ? ' (set by hand)' : ''} · <span style={{ color: c.geo.health === 'ok' ? undefined : `var(--${c.geo.health})` }}>{replicaText(c)}</span></> : health[c.id] === 'critical' ? <span style={{ color: 'var(--bad)', fontWeight: 600 }}>Critical problems</span> : health[c.id] === 'warning' ? <span style={{ color: 'var(--warn)' }}>Needs attention</span> : c.status === 'healthy' ? 'Healthy' : c.status === 'degraded' ? 'Degraded' : c.status}{replica && (health[c.id] === 'critical' || health[c.id] === 'warning') ? <span className="faint"> · {health[c.id] === 'critical' ? 'critical problems' : 'needs attention'}</span> : null}</span></td>
    <td className="protcell">{c.isSandbox || c.source === 'direct' ? modeOf(c) : <ProtectionLine p={prot[c.id]} />}</td><td>{stratOf(c, pol)}</td><td className="wideonly" title={c.pgVersion || undefined}>{c.pgVersion ? String(c.pgVersion).split(' ')[0] : '—'}</td>
    <td className="num">{c.haState?.nodes?.length ?? c.agentNodes?.length ?? 0}</td><td className="num">{bytes(c.totalSizeBytes)}</td><td className="num wideonly">{num(c.tps)}</td>
    <td className="num">{c.isSandbox || !isAdmin ? null : <button className="btn ghost sm" onClick={e => { e.stopPropagation(); onOrganize(c); }} title="Environment, folder and replication relationship">Organize…</button>}</td></tr>;
  const row = (c: any, depth: number) => [one(c, depth), ...(c.replicas || []).map((r: any) => one(r, depth + 1, true, c.environment))];
  const folder = (n: FolderNode, env: string, depth: number): React.ReactNode[] => {
    const k = `${env}:${n.path}`; const open = fold.isOpen(k, true);
    return [<tr key={'f' + k} className="frow" onClick={() => fold.toggle(k, true)}><td colSpan={9} style={{ paddingLeft: 14 + depth * 18 }}>
      <span className="row gap-s"><Icon n={open ? 'down' : 'chev'} s={12} /><Icon n="folder" s={14} /><strong>{n.name}</strong><Dot kind={n.tone} />{summary(n)}<span className="small faint"> · {nodes(n)} {nodes(n) === 1 ? 'node' : 'nodes'} · {bytes(size(n))}</span></span></td></tr>,
      ...(open ? [...n.children.flatMap(ch => folder(ch, env, depth + 1)), ...n.clusters.flatMap(c => row(c, depth + 1))] : [])];
  };
  return <div className="tablewrap"><table className="t fleettable">
    <thead><tr><th>Cluster</th><th>Status</th><th>Protection</th><th title="Backup policy (schedule and retention)">Policy</th><th className="wideonly">PostgreSQL</th><th className="num">Nodes</th><th className="num">Size</th><th className="num wideonly">TPS</th><th /></tr></thead>
    <tbody>{groups.flatMap(g => {
      const k = `env:${g.env}`; const open = fold.isOpen(k, true);
      return [<tr key={k} className={`erow ${g.tone}`} onClick={() => fold.toggle(k, true)}><td colSpan={9}><span className="row gap-s"><Icon n={open ? 'down' : 'chev'} s={13} /><span className={`envmark ${g.env}`} /><strong>{g.label}</strong><Dot kind={g.tone} />{summary(g)}<span className="small faint"> · {nodes(g.root)} {nodes(g.root) === 1 ? 'node' : 'nodes'} · {bytes(size(g.root))}</span></span></td></tr>,
        ...(open ? [...g.root.children.flatMap(ch => folder(ch, g.env, 1)), ...g.root.clusters.flatMap(c => row(c, 1))] : [])];
    })}</tbody></table></div>;
}

/** Environment and folder of a cluster ("prod" > "fatturazione/api"): what groups it in the console AND what its folder-level strategies and settings inherit. */
function Organize({ c, all, onClose }: { c: any; all: any[]; onClose: () => void }) {
  const OK = `organize:${c.id}`;
  const [env, setEnv] = useDraft(OK + ':env', c.environment || 'prod'); const [folder, setFolder] = useDraft(OK + ':folder', c.folder || ''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [lm, setLm] = useDraft<LinkMode>(OK + ':lm', linkModeOf(c)); const [lp, setLp] = useDraft<string>(OK + ':lp', c.geoLink?.primary || '');
  const known = [...new Set(all.filter(x => !x.isSandbox && x.folder).map(x => x.folder as string))].sort();
  const save = async () => { if (lm === 'manual' && !lp) { setErr('Choose the primary cluster.'); return; } setBusy(true); setErr(null); try { await api('PATCH', `/api/clusters/${encodeURIComponent(c.id)}`, { environment: env, folder }); await saveGeoLink(c, lm, lp); revalidate('/api/clusters'); toast('Saved', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || (e.body?.error === 'invalid_folder' ? 'Invalid folder name.' : e.message)); } finally { setBusy(false); } };
  return <Modal title={`Organize ${c.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
    <div className="stack">
      <Field label="Environment"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
      <Field label="Folder" hint="Per application or service, also on several levels: “billing” or “billing/api”. Empty = directly under the environment.">
        <input className="input" list="folders-known" value={folder} onChange={e => setFolder(e.target.value)} placeholder="app_name" /><datalist id="folders-known">{known.map(f => <option key={f} value={f} />)}</datalist></Field>
      <GeoLinkField c={c} all={all} mode={lm} setMode={setLm} primary={lp} setPrimary={setLp} />
      {c.geo?.role === 'standby' ? <Banner kind="info">{c.name} is a standby site: in the list and in the sidebar it always appears under its primary ({c.geo.peers?.find((p: any) => p.role === 'primary')?.name || '—'}), wherever it is filed. The environment and folder set here decide the policies and settings it inherits, and its position if it becomes primary.</Banner> : null}
      <p className="small muted">The folder groups clusters in the sidebar and in the list, and the backup policies and recovery settings assigned to a folder apply to every cluster it contains.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function AttachWizard({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useDraft<'agent' | 'direct' | null>('attach:mode', null);
  return <Modal title="Connect a cluster" onClose={onClose} wide locked={false}>
    {!mode ? <div className="stack">
      <button className="choice" onClick={() => setMode('agent')}><Icon n="shield" s={22} /><div><strong>With agent (recommended)</strong><p className="sub">You install a small agent on a node: backups, point-in-time recovery, high availability and live logs. The agent connects to the console, not the other way round.</p></div></button>
      <button className="choice" onClick={() => setMode('direct')}><Icon n="link" s={22} /><div><strong>PostgreSQL connection only</strong><p className="sub">Nothing to install: the console connects with a read-only user. Status and metrics yes; backup and restore no, because they run on the database server.</p></div></button>
    </div> : mode === 'agent' ? <AgentFlow onClose={onClose} back={() => setMode(null)} /> : <DirectFlow onClose={onClose} back={() => setMode(null)} />}
  </Modal>;
}

function AgentFlow({ onClose, back }: { onClose: () => void; back: () => void }) {
  const [env, setEnv] = useDraft('attach:agent:env', 'prod'); const [label, setLabel] = useDraft('attach:agent:label', ''); const [tok, setTok] = useDraft<any>('attach:agent:tok', null, { secret: true }); const [count, setCount] = useDraft('attach:agent:count', 1);
  const addr = useQuery<{ effective: string; warning?: string }>('/api/console-address');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [joinedAll, setJoinedAll] = useDraft<any[]>('attach:agent:joined', []);
  const joined = joinedAll.length >= count ? joinedAll[0] : null;
  const [beforeIds, setBeforeIds] = useDraft<string[] | null>('attach:agent:before', null); const before = { current: beforeIds ? new Set(beforeIds) : null }; const keyRef = useRef(uid('tok'));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const n = await get<{ nodes: any[] }>('/api/nodes'); setBeforeIds(n.nodes.map(x => x.id));
      setTok(await api('POST', '/api/enrollment-tokens', { label: label || 'node', environment: env, ttlMinutes: 60, maxUses: count }, { key: keyRef.current }));
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!tok || joined) return;
    const t = setInterval(async () => {
      try { const n = await get<{ nodes: any[] }>('/api/nodes'); const fresh = n.nodes.filter(x => before.current && !before.current.has(x.id)); if (fresh.length !== joinedAll.length) { setJoinedAll(fresh); revalidate('/api/clusters'); } } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [tok, joined, joinedAll.length]);
  if (joined) return <div className="stack"><Banner kind="ok" title={joinedAll.length > 1 ? `${joinedAll.length} servers connected` : `Node ${joined.name} connected`}>{joinedAll.length > 1 ? <>{joinedAll.map(j => <div key={j.id}><strong>{j.name}</strong>{j.pgVersion ? ` — PostgreSQL ${String(j.pgVersion).split(' ')[0]}, ${j.role || 'detecting role'}` : ''}</div>)}<div className="small" style={{ marginTop: 6 }}>Nodes of the same cluster (same system identifier) are grouped automatically.</div></> : <>The agent completed enrollment{joined.pgVersion ? ` (PostgreSQL ${joined.pgVersion}, role ${joined.role || 'being detected'})` : ''}. The other nodes of the same cluster are added the same way: the console groups them by itself.</>}</Banner>
    <div className="row"><Button kind="primary" onClick={() => { onClose(); if (joined.clusterId) go(`c/${encodeURIComponent(joined.clusterId)}`); }}>Open the cluster</Button><Button onClick={onClose}>Close</Button></div></div>;
  if (!tok) return <div className="stack">
    <Field label="Environment"><select className="input" value={env} onChange={e => setEnv(e.target.value)}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
    <Field label="Node label" hint="Only to recognize the token in the log."><input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. pg-prod-01" /></Field>
    <Field label="Servers to connect with this command" hint="For a Patroni cluster, enter how many nodes it has: run the same command on each, the console groups them by itself."><input className="input" type="number" min={1} max={20} value={count} onChange={e => setCount(Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))))} style={{ maxWidth: 120 }} /></Field>
    {err ? <Banner kind="bad">{err}</Banner> : null}
    <div className="row"><Button onClick={back}>Back</Button><Button kind="primary" busy={busy} onClick={create}>Generate the install command</Button></div>
    <div className="hr" /><details><summary className="small" style={{ cursor: 'pointer' }}>Prefer no token? The server announces itself</summary>
      <div className="stack" style={{ marginTop: 8 }}><p className="small muted">Run this command as root on the server: the agent announces itself to the console and “New server detected” appears here. You approve it, choosing the environment.</p>
        <CopyBlock text={`curl -fsSL ${addr.data?.effective || location.origin}/agent/install.sh | sudo PG_ARCA_URL=${addr.data?.effective || location.origin} bash`} />
        {addr.data?.warning ? <p className="small" style={{ color: 'var(--warn)' }}>{addr.data.warning}</p> : null}</div></details></div>;
  return <div className="stack">
    <p>Run this command <strong>as root</strong> {count > 1 ? <>on each of the {count} servers</> : <>on the database server</>}. {count > 1 ? `The token is valid for ${count} servers` : 'The token is valid for a single server'} and expires in one hour.</p>
    {tok.addressWarning ? <Banner kind="warn" title="The servers will not reach this address">{tok.addressWarning}</Banner> : null}
    <InstallCommand r={tok} />
    <p className="small muted">Requirements: Linux with systemd, Python 3.6 or later, network access from this server to the console ({tok.consoleUrl || location.origin}{tok.consoleUrlConfigured ? ', address set in Settings' : ''}). Installation takes a few seconds and reports at the end whether the server was registered.</p>
    <Banner kind="info"><span className="row gap-s"><Icon n="refresh" spin />{joinedAll.length ? `${joinedAll.length} of ${count} connected: ${joinedAll.map(j => j.name).join(', ')}. Waiting for the others…` : 'Waiting for the agent to connect…'}</span></Banner>
    <div className="row"><Button onClick={onClose}>Close</Button><span className="faint small">You can close this: the node will appear in the list anyway.</span></div></div>;
}

function DirectFlow({ onClose, back }: { onClose: () => void; back: () => void }) {
  const [f, setF] = useDraft('attach:direct:form', { name: '', environment: 'prod', host: '', port: '5432', database: 'postgres', user: '', password: '', sslmode: 'require', caCertPem: '', patroniUrl: '' }, { secret: true });   // holds a password: memory only
  const [test, setTest] = useState<any>(null); const [busy, setBusy] = useState<'t' | 'a' | null>(null); const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<any>) => { setF({ ...f, [k]: e.target.value }); setTest(null); };
  const body = () => ({ ...f, port: Number(f.port) || 5432, patroniUrl: f.patroniUrl || undefined, caCertPem: f.caCertPem || undefined });
  const doTest = async () => {
    setBusy('t'); setErr(null); setTest(null);
    try { const r = await api('POST', '/api/clusters/test-connection', body()); r.ok ? setTest(r) : setErr(r.message); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(null); }
  };
  const attach = async () => {
    setBusy('a'); setErr(null);
    try { const r = await api('POST', '/api/clusters/attach-direct', body(), { key: uid('att') }); revalidate('/api/clusters'); toast(r.created ? 'Cluster connected' : 'Cluster already connected: updated', 'ok'); onClose(); go(`c/${encodeURIComponent(r.cluster.id)}`); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(null); }
  };
  const caps = test?.capabilities;
  return <div className="stack">
    <div className="grid g2"><Field label="Cluster name"><input className="input" value={f.name} onChange={set('name')} /></Field>
      <Field label="Environment"><select className="input" value={f.environment} onChange={set('environment')}>{ENVS.map(e => <option key={e[0]} value={e[0]}>{e[1]}</option>)}</select></Field>
      <Field label="Host"><input className="input" value={f.host} onChange={set('host')} placeholder="db1.example.com" /></Field>
      <Field label="Port"><input className="input" value={f.port} onChange={set('port')} inputMode="numeric" /></Field>
      <Field label="Database"><input className="input" value={f.database} onChange={set('database')} /></Field>
      <Field label="User" hint="pg_monitor + pg_read_all_settings is enough."><input className="input" value={f.user} onChange={set('user')} autoComplete="off" /></Field>
      <Field label="Password"><input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
      <Field label="Encryption"><select className="input" value={f.sslmode} onChange={set('sslmode')}><option value="require">TLS (no certificate verification)</option><option value="verify-full">TLS with certificate verification</option><option value="disable">None (not recommended)</option></select></Field></div>
    {f.sslmode === 'verify-full' ? <Field label="CA certificate (PEM)"><textarea className="input mono" rows={4} value={f.caCertPem} onChange={set('caCertPem')} /></Field> : null}
    <Field label="Patroni API URL (optional)" hint="E.g. http://db1:8008 — to see roles and members."><input className="input" value={f.patroniUrl} onChange={set('patroniUrl')} /></Field>
    {err ? <Banner kind="bad" title="Connection failed">{err}</Banner> : null}
    {test ? <Banner kind="ok" title="Connection succeeded">{caps ? `Permissions: ${caps.set_parameters ? 'parameter changes, ' : ''}${caps.patroni_ops ? 'Patroni operations, ' : ''}read-only for the rest. Backup and restore need the agent.` : ''}</Banner> : null}
    <div className="row"><Button onClick={back}>Back</Button><div className="grow" /><Button busy={busy === 't'} disabled={!f.host || !f.user} onClick={doTest}>Test connection</Button>
      <Button kind="primary" busy={busy === 'a'} disabled={!test || !f.name.trim()} onClick={attach}>Connect</Button></div></div>;
}
