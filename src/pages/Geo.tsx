import React, { useState } from 'react';
import { api, uid } from '../api';
import { Badge, Banner, Button, Card, Confirm, Dot, Empty, Field, Icon, Modal, Skeleton, ago, bytes, dt, tm, nof } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';
import { go } from '../router';

/* ====================================================================================================================================================
 * Geo-redundancy: the same database on several sites (Patroni clusters with the same system identifier): one primary site, standby sites replicating
 * over the WAN. Shows the replication between sites and runs the two site-level actions: planned switchover and DR promotion — both through each site's DCS.
 * ==================================================================================================================================================== */
interface Site { clusterId: string; name: string; environment: string; role: 'primary' | 'standby' | 'unknown'; leader: string | null; online: boolean; lsn: string | null; timeline: number | null; endpointSource?: string | null; link?: 'auto' | 'manual';
  endpoint: { host: string; port: number } | null; upstream?: { host: string; port: number; slot?: string } | null; receiver?: { status: string; sender: string; silentSec: number | null } | null;
  lagBytes?: number | null; replayDelaySec?: number | null; slot?: { name: string; active: boolean; retainedBytes: number | null } | null; health: 'ok' | 'warn' | 'bad'; problems: string[] }
interface Ready { checks: { id: string; level: 'ok' | 'warn' | 'bad' | 'info'; text: string; fix?: string; site?: string; clusterId?: string; action?: 'archive_fallback' | 'enable_rewind' }[]; status: 'ready' | 'degraded' | 'not_ready'; rpoSec: number | null; rpoTargetSec: number; lastTest: { at: string; seconds: number | null; from: string; to: string } | null }
interface Policy { autoFailover: boolean; confirmSec: number; maxLossMB: number; autoRejoin: boolean }
interface Watch { primaryName?: string; downSince: number | null; witnesses: { console: boolean; standby: boolean; standbyName?: string }; lastSeenSec: number | null; candidate?: string | null; candidateName?: string; actInSec: number | null; snoozedUntil?: number | null; note?: string }
interface Failover { from: string; to: string; fromName: string; toName: string; at: string; lossBytes: number | null; auto: boolean; rejoinedAt?: string; rejoinError?: string }
interface Group { sysid: string; sites: Site[]; primary: string | null; readiness?: Ready; policy?: Policy; watch?: Watch | null; failover?: Failover | null }
interface Job { id: string; type?: string; fromName: string; toName: string; status: string; createdBy: string; createdAt: string; steps: { at: string; text: string }[]; error?: string }
const JOB_LABEL: Record<string, string> = { switchover: 'Planned switchover', failover: 'Disaster recovery (manual promotion)', failover_auto: 'Automatic disaster recovery', rejoin: 'Rejoin of the old primary' };
const JOB_ST: Record<string, [string, 'ok' | 'bad' | 'warn' | 'accent']> = { running: ['running', 'accent'], succeeded: ['completed', 'ok'], failed: ['stopped', 'bad'], held: ['waiting for a decision', 'warn'], interrupted: ['interrupted (console restarted)', 'warn'] };

const ROLE_LABEL = { primary: 'Primary site', standby: 'Standby site (DR)', unknown: 'Role not determined' };

export function GeoPage({ role }: { role: string }) {
  const q = useQuery<{ groups: Group[]; jobs: Job[] }>('/api/geo', { interval: 4000 });
  const d = q.data; const [pick, setPick] = useState(false);
  const all: any[] = useQuery<any>('/api/clusters').data?.clusters || [];
  return <>
    <div className="pagehead"><div className="grow"><h1>Geo-redundancy</h1>
      <p className="sub">The same database on several sites: a primary site and standby sites (Patroni clusters in standby mode, or physical standbys) that receive WAL over the wide-area network. Pairs are detected automatically; you can also declare them yourself.</p></div>
      {role === 'admin' ? <Button icon="plus" onClick={() => setPick(true)}>Declare a standby site</Button> : null}</div>
    {pick ? <LinkPicker all={all} onClose={() => setPick(false)} /> : null}
    {!d ? <Skeleton h={220} /> : !d.groups.length ? <Empty icon="swap" title="No site pairs">When a cluster in <code>standby_cluster</code> mode (or a physical standby registered as a cluster) replicates from another connected cluster, the pair appears here by itself. For a cluster without an agent, or to declare the relationship before replication is enabled, use “Declare a standby site”.</Empty> :
      d.groups.map(g => <GroupCard key={g.sysid} g={g} role={role} running={d.jobs.some(j => j.status === 'running')} />)}
    {d?.jobs?.length ? <Card title="Site role changes"><div className="stack">{d.jobs.map(j => <div key={j.id} className="geojob">
      <div className="row wrap gap-s"><strong>{JOB_LABEL[j.type || 'switchover'] || j.type}: {j.fromName} → {j.toName}</strong><Badge kind={(JOB_ST[j.status] || [j.status, 'accent'])[1]}>{(JOB_ST[j.status] || [j.status])[0]}</Badge><div className="grow" /><span className="small faint">{j.createdBy}, {ago(j.createdAt)}</span></div>
      <ol className="small">{j.steps.map((s, i) => <li key={i}>{s.text} <span className="faint">({tm(s.at)})</span></li>)}</ol></div>)}</div></Card> : null}
  </>;
}

function SiteCard({ s, onOpen }: { s: Site; onOpen: () => void }) {
  return <div className={`geosite ${s.role} ${s.health}`}>
    <div className="row"><Dot kind={s.online ? s.health : 'bad'} /><button className="linkbtn" onClick={onOpen}><strong>{s.name}</strong></button><div className="grow" />{s.link === 'manual' ? <Badge title="Relationship declared by an operator (Organize… in the cluster list)">set by hand</Badge> : null}<Badge kind={s.role === 'primary' ? 'accent' : undefined}>{ROLE_LABEL[s.role]}</Badge></div>
    <dl className="kv small">
      <dt>Leader</dt><dd>{s.leader || <span style={{ color: 'var(--bad)' }}>none reachable</span>}{s.timeline ? <span className="faint xp"> · timeline {s.timeline}</span> : null}</dd>
      <dt className="xp">WAL position</dt><dd className="mono xp">{s.lsn || '—'}</dd>
      {s.role === 'standby' ? <>
        <dt>Receives from</dt><dd>{s.upstream ? <span className="mono">{s.upstream.host}:{s.upstream.port}</span> : '—'}{s.upstream?.slot ? <span className="faint xp"> · slot {s.upstream.slot}</span> : null}</dd>
        <dt>WAL receiver</dt><dd>{s.receiver?.status === 'streaming' ? <Badge kind="ok">streaming</Badge> : <Badge kind="bad">{s.receiver?.status || 'absent'}</Badge>}{s.receiver?.silentSec != null ? <span className="faint"> · last message {Math.round(s.receiver.silentSec)} s ago</span> : null}</dd>
      </> : null}
      <dt>Reachable from the other sites as</dt><dd>{s.endpoint ? <><span className="mono">{s.endpoint.host}:{s.endpoint.port}</span>{s.endpointSource === 'detected' ? <span className="faint small" title="Detected from the address the standby site uses to reach it: the switchback will use it"> · detected</span> : null}</> : <span className="faint">not set</span>}</dd>
    </dl>
    {s.problems.length ? <div className="small" style={{ color: s.health === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>{s.problems.join(' · ')}</div> : null}
  </div>;
}

function GroupCard({ g, role, running }: { g: Group; role: string; running: boolean }) {
  const prim = g.sites.find(s => s.role === 'primary'); const stand = g.sites.filter(s => s.role === 'standby');
  const extra = g.sites.filter(s => s.role === 'primary' && s !== prim);            // split-brain: more than one writable site
  const [dlg, setDlg] = useState<{ kind: 'switch' | 'promote' | 'endpoint' | 'demote'; site: Site; next?: 'switch' } | null>(null);
  return <Card title={<span className="row gap-s"><Icon n="swap" s={16} />{prim?.name || '?'}{stand.map(s => <span key={s.clusterId} className="faint"> ⇄ {s.name}</span>)}<span className="small faint" title={`PostgreSQL system identifier ${g.sysid}${(g as any).stanza ? ` · backup catalog ${(g as any).stanza}` : ''}`}>· same database on every site{(g as any).stanza ? ' · backups shared by the sites' : ''}</span></span>}>
    {extra.length && prim ? <Banner kind="bad" title="Two sites accept writes (split-brain)">{[prim, ...extra].map(x => x.name).join(' and ')} are both primary: the data is diverging. Choose which one to keep and demote the other to standby site: writes made on the demoted one after the split are lost. If its data has already diverged it may be unable to follow the other site: in that case reinitialize its members (“Reinitialize” on the High availability tab).
      {role === 'admin' ? <div className="row wrap" style={{ marginTop: 8 }}>{[prim, ...extra].map(x => <Button key={x.clusterId} sm kind="danger" onClick={() => setDlg({ kind: 'demote', site: x })}>Demote {x.name}</Button>)}</div> : null}</Banner> : null}
    <div className="geogrid">
      {prim ? <SiteCard s={prim} onOpen={() => go(`c/${encodeURIComponent(prim.clusterId)}`)} /> : <div className="geosite bad"><strong>Primary site not visible</strong><p className="small muted">No connected cluster accepts writes for this database.</p></div>}
      <div className="geolinks">{stand.map(s => <div key={s.clusterId} className={`geolink ${s.health}`}>
        <div className="arrow"><span /></div>
        <div className="small"><strong>{s.lagBytes == null ? '—' : s.lagBytes === 0 ? 'in sync' : `${bytes(s.lagBytes)} behind`}</strong></div>
        <div className="small faint">{s.receiver?.status === 'streaming' ? 'WAN link up' : 'WAN link down'}{s.slot ? <span className={s.slot.active ? 'xp' : undefined}>{` · slot ${s.slot.active ? 'active' : 'INACTIVE'}${s.slot.retainedBytes != null ? `, retaining ${bytes(s.slot.retainedBytes)}` : ''}`}</span> : ''}</div>
      </div>)}</div>
      <div className="stack">{[...extra, ...stand].map(s => <SiteCard key={s.clusterId} s={s} onOpen={() => go(`c/${encodeURIComponent(s.clusterId)}`)} />)}</div>
    </div>
    <DrPanel g={g} role={role} prim={prim} onPromote={s => setDlg({ kind: 'promote', site: s })} />
    {g.readiness ? <Readiness r={g.readiness} role={role} /> : null}
    {role === 'admin' ? <div className="row wrap" style={{ marginTop: 14 }}>
      {prim && stand.map(s => <Button key={'sw' + s.clusterId} icon="swap" disabled={running || s.health === 'bad'} title={s.health === 'bad' ? 'The standby site is not healthy' : undefined} onClick={() => setDlg(s.endpoint ? { kind: 'switch', site: s } : { kind: 'endpoint', site: s, next: 'switch' })}>Planned switchover to {s.name}</Button>)}
      {stand.map(s => <Button key={'pr' + s.clusterId} kind="danger" icon="alert" disabled={running} onClick={() => setDlg({ kind: 'promote', site: s })}>Promote {s.name} (disaster recovery)…</Button>)}
      {g.sites.map(s => <Button key={'ep' + s.clusterId} sm kind="ghost" onClick={() => setDlg({ kind: 'endpoint', site: s })}>Set the address of {s.name}…</Button>)}
    </div> : null}
    {dlg?.kind === 'endpoint' ? <EndpointDialog s={dlg.site} onClose={() => setDlg(null)} onSaved={dlg.next === 'switch' ? ep => setDlg({ kind: 'switch', site: { ...dlg.site, endpoint: ep } }) : undefined} /> : null}
    {dlg?.kind === 'demote' ? (() => { const keepSite = [prim, ...extra].find(x => x && x.clusterId !== dlg.site.clusterId)!; return <Confirm title={`Demote ${dlg.site.name}?`} confirmLabel="Demote" requireText="DEMOTE" danger onClose={() => setDlg(null)}
      onConfirm={async () => { const s = dlg.site; setDlg(null); try { const r = await api<any>('POST', '/api/geo/demote', { clusterId: s.clusterId, to: keepSite.clusterId, confirm: 'DEMOTE' }, { key: uid('geod') }); toast(r.approval ? 'Request sent: another administrator must approve it' : `${s.name} demoted: it now follows ${keepSite.name}`, 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } }}>
      <p><strong>{dlg.site.name}</strong> stops accepting writes and becomes a standby site of <strong>{keepSite.name}</strong> (through its DCS, like <span className="mono">patronictl edit-config</span>). Writes made on {dlg.site.name} after the split will no longer be visible: if you need them, take a backup or a dump of {dlg.site.name} first.</p></Confirm>; })() : null}
    {dlg?.kind === 'switch' && prim ? <Confirm title={`Switchover: ${dlg.site.name} becomes the primary site`} confirmLabel="Start the switchover" requireText="SWITCHOVER" danger onClose={() => setDlg(null)}
      onConfirm={async () => { const s = dlg.site; setDlg(null); try { const r = await api<any>('POST', '/api/geo/switchover', { from: prim.clusterId, to: s.clusterId, confirm: 'SWITCHOVER' }, { key: uid('geo') }); toast(r.approval ? 'Request sent: another administrator must approve it' : 'Switchover started', 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } }}>
      <ol className="small">
        <li><strong>{prim.name}</strong> becomes a standby site of {dlg.site.name} (<span className="mono">{dlg.site.endpoint?.host}:{dlg.site.endpoint?.port}</span>): from then on, writes on {prim.name} stop.</li>
        <li>pg_arca waits until {dlg.site.name} has received and replayed everything (at most 2 minutes; if that does not happen it stops and {dlg.site.name} is not promoted: no data lost).</li>
        <li><strong>{dlg.site.name}</strong> is promoted through its DCS; a permanent <code>geo_…</code> slot is created for {prim.name} so it does not miss any WAL.</li>
      </ol>
      <p className="small muted">Applications must point to the new primary site (DNS, VIP or HAProxy): pg_arca does not change the network. Write downtime: from a few seconds to a couple of minutes.</p></Confirm> : null}
    {dlg?.kind === 'promote' ? <PromoteDialog s={dlg.site} primary={prim} onClose={() => setDlg(null)} /> : null}
  </Card>;
}

function EndpointDialog({ s, onClose, onSaved }: { s: Site; onClose: () => void; onSaved?: (ep: { host: string; port: number }) => void }) {
  const [host, setHost] = useState(s.endpoint?.host || ''); const [port, setPort] = useState(String(s.endpoint?.port || 5000)); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PUT', `/api/clusters/${encodeURIComponent(s.clusterId)}/geo-endpoint`, { host, port: Number(port) }); revalidate('/api/geo'); toast('Address saved', 'ok'); if (onSaved) onSaved({ host, port: Number(port) }); else onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } };
  return <Modal title={`How the other sites reach ${s.name}`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={!host}>Save</Button></>}>
    <div className="stack"><p className="small muted">The address that always leads to the leader of {s.name} (the site’s HAProxy, VIP or DNS), as seen from the nodes of the other site. It is needed to make it the replication source after a switchover.</p>
      <div className="grid g2"><Field label="Host"><input className="input mono" value={host} onChange={e => setHost(e.target.value)} placeholder="dc2-haproxy" /></Field><Field label="Port"><input className="input mono" value={port} onChange={e => setPort(e.target.value)} /></Field></div>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function PromoteDialog({ s, primary, onClose }: { s: Site; primary?: Site; onClose: () => void }) {
  const alive = !!primary?.online; const [lost, setLost] = useState(false); const [typed, setTyped] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const go2 = async () => { setBusy(true); setErr(null); try { const r = await api<any>('POST', '/api/geo/promote', { clusterId: s.clusterId, confirm: 'PROMOTE', primaryLost: lost }, { key: uid('geop') }); toast(r.approval ? 'Request sent: another administrator must approve it' : `Promotion of ${s.name} started`, 'ok'); revalidate('/api/geo'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title={`Promote ${s.name} (disaster recovery)`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="danger" busy={busy} disabled={typed !== 'PROMOTE' || (alive && !lost)} onClick={go2}>Promote</Button></>}>
    <div className="stack">
      {alive ? <Banner kind="bad" title={`${primary!.name} is still running`}>It accepts writes: if you promote {s.name} now you will have two primary sites with diverging data (split-brain). If both sites are healthy, use the <strong>planned switchover</strong>.</Banner>
        : <Banner kind="warn" title="The primary site is not responding">{s.lagBytes ? `At the last contact ${s.name} was ${bytes(s.lagBytes)} behind: that data will be lost.` : `Last known state: ${s.name} was in sync.`}</Banner>}
      {alive ? <label className="check"><input type="checkbox" checked={lost} onChange={e => setLost(e.target.checked)} /> I know {primary!.name} is lost or isolated and will not receive writes again (I will shut it down / isolate it myself).</label> : null}
      <p className="small">{s.name} stops replicating and becomes writable (Patroni promotes it: <code>standby_cluster</code> removed from its DCS). The old primary site, when it comes back, must NOT resume writing: it has to be rebuilt as a standby site.</p>
      <Field label="Type PROMOTE to confirm"><input className="input" value={typed} onChange={e => setTyped(e.target.value)} /></Field>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Declare a standby site by hand: which cluster replicates from which. */
function LinkPicker({ all, onClose }: { all: any[]; onClose: () => void }) {
  const real = all.filter(c => !c.isSandbox).sort((a, b) => a.name.localeCompare(b.name));
  const [stby, setStby] = useState(''); const [prim, setPrim] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/clusters/${encodeURIComponent(stby)}/geo-link`, { primary: prim }); revalidate('/api/geo'); revalidate('/api/clusters'); toast('Relationship saved', 'ok'); onClose(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title="Declare a standby site" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!stby || !prim || stby === prim} onClick={save}>Save</Button></>}>
    <div className="stack">
      <Field label="Standby site"><select className="input" value={stby} onChange={e => setStby(e.target.value)}><option value="">Choose…</option>{real.map(c => <option key={c.id} value={c.id}>{c.name}{c.geo?.role ? ` · ${c.geo.role === 'standby' ? 'already a standby' : 'primary'}` : ''}</option>)}</select></Field>
      <Field label="Replicates from (primary site)"><select className="input" value={prim} onChange={e => setPrim(e.target.value)}><option value="">Choose…</option>{real.filter(c => c.id !== stby).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <p className="small muted">Needed when the console cannot detect it by itself (cluster without an agent, replication not active yet). If the agents see different databases the relationship stays, but it is flagged as impossible. It changes nothing in PostgreSQL or Patroni.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** "If the primary site is lost now, does the DR site take over cleanly, and how much is lost?": the conditions a geo pair silently depends on. */
/** The state in words that say what to do: "Ready, 2 things to fix" / "Not ready: 1 problem" (never "ready with reservations" while the link is down). */
const readyLabel = (r: Ready) => { const bad = r.checks.filter(c => c.level === 'bad').length, warn = r.checks.filter(c => c.level === 'warn').length;
  return r.status === 'ready' ? 'Ready for disaster recovery' : r.status === 'degraded' ? `Disaster recovery works, with ${nof(warn, 'weakness', 'weaknesses')} to fix` : `Not ready for disaster recovery: ${nof(bad, 'problem')}`; };
function Readiness({ r, role }: { r: Ready; role: string }) {
  const [open, setOpen] = useState(r.status !== 'ready'); const [edit, setEdit] = useState(false); const [rpo, setRpo] = useState(String(r.rpoTargetSec)); const [busy, setBusy] = useState(false);
  const issues = r.checks.filter(c => c.level !== 'ok'); const tone = r.status === 'ready' ? 'ok' : r.status === 'degraded' ? 'warn' : 'bad';
  const [fixing, setFixing] = useState<string | null>(null);
  const [all, setAll] = useState(false); const byLevel = (a: { level: string }, b: { level: string }) => (a.level === 'bad' ? 0 : a.level === 'warn' ? 1 : 2) - (b.level === 'bad' ? 0 : b.level === 'warn' ? 1 : 2);
  // one-click fixes, through the site's own DCS (agent operations: the command / setting is built by the agent, never sent from here)
  const fix = async (c: Ready['checks'][number]) => {
    setFixing(c.id + c.clusterId);
    try {
      const body = c.action === 'archive_fallback' ? { type: 'geo_archive_fallback', params: { enable: true } } : { type: 'patroni_config_patch', params: { patch: { postgresql: { use_pg_rewind: true } } } };
      const r: any = await api('POST', `/api/clusters/${encodeURIComponent(c.clusterId!)}/operations`, body, { key: uid('geofix') });
      if (r.approval) toast('Request sent: another administrator must approve it.', 'info', 8000);
      else toast(c.action === 'archive_fallback' ? 'Enabling the archive fallback in the site’s DCS' : 'Enabling pg_rewind in the site’s DCS', 'ok');
      setTimeout(() => revalidate('/api/geo'), 8000);
    } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setFixing(null); }
  };
  const save = async () => { setBusy(true); try { await api('PUT', '/api/geo/settings', { rpoSec: Number(rpo) }); revalidate('/api/geo'); toast('RPO target saved', 'ok'); setEdit(false); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  return <div className={`geoready ${tone}`}>
    <div className="row wrap gap-s">
      <button className="linkbtn row gap-s" onClick={() => setOpen(!open)} aria-expanded={open}><Icon n={open ? 'down' : 'chev'} s={13} /><Dot kind={tone} /><strong>{readyLabel(r)}</strong></button>
      <span className="small muted">estimated loss <strong>{r.rpoSec == null ? 'not measurable' : r.rpoSec < 1 ? 'none' : `${r.rpoSec} s`}</strong> · target {r.rpoTargetSec} s
        {r.lastTest ? <> · last switchover {ago(r.lastTest.at)}{r.lastTest.seconds != null ? `, ${r.lastTest.seconds} s` : ''}</> : <> · switchover never tested</>}</span>
      <div className="grow" />{role === 'admin' ? <Button sm kind="ghost" onClick={() => setEdit(true)}>RPO target…</Button> : null}
    </div>
    {/* problems first (worst first), at most three until asked; the configuration syntax of a fix sits behind "How to fix by hand" */}
    {open ? <ul className="geochecks">{(all ? [...issues.sort(byLevel), ...r.checks.filter(c => c.level === 'ok')] : [...issues].sort(byLevel).slice(0, 3)).map((c, i) => <li key={i} className={c.level}>
      <Icon n={c.level === 'ok' ? 'check' : c.level === 'info' ? 'info' : 'alert'} s={13} /><span className="grow">{c.text}{c.fix && c.level !== 'ok' ? <details className="howfix"><summary className="small faint">How to fix by hand</summary><span className="small">{c.fix}</span></details> : null}</span>
      {role === 'admin' && c.action && c.clusterId ? <Button sm busy={fixing === c.id + c.clusterId} onClick={() => fix(c)}>{c.action === 'archive_fallback' ? 'Enable the archive fallback' : 'Enable pg_rewind'}</Button> : null}</li>)}
      <li className="more"><button className="linkbtn small" onClick={() => setAll(!all)}>{all ? 'Show only what needs attention' : (() => { const shown = [...issues].sort(byLevel).slice(0, 3); const more = issues.filter(c => (c.level === 'warn' || c.level === 'bad') && !shown.includes(c)).length;
        return more ? `Show all ${r.checks.length} checks (${more} more to fix)` : issues.length > 3 ? `Show all ${r.checks.length} checks (${nof(issues.length - 3, 'more note')})` : `Show all ${r.checks.length} checks`; })()}</button></li></ul> : null}
    {edit ? <Modal title="Data loss target (RPO)" onClose={() => setEdit(false)} footer={<><div className="grow" /><Button onClick={() => setEdit(false)}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
      <Field label="Seconds of transactions it is acceptable to lose if the primary site disappears" hint="Above the target the pair has something to fix; above ten times the target it is not ready. Applies to all site pairs.">
        <input className="input" type="number" min={1} max={86400} value={rpo} onChange={e => setRpo(e.target.value)} /></Field></Modal> : null}
  </div>;
}

/** Disaster recovery of the pair: the policy (automatic failover / rejoin), what the monitor sees right now, and the last failover with what is left to do. */
function DrPanel({ g, role, prim, onPromote }: { g: Group; role: string; prim?: Site; onPromote: (s: Site) => void }) {
  const p = g.policy; const w = g.watch; const f = g.failover; const [edit, setEdit] = useState(false);
  if (!p) return null;
  const cand = w?.candidate ? g.sites.find(s => s.clusterId === w.candidate) : undefined;
  const snoozeIt = async () => { try { await api('POST', `/api/geo/snooze/${encodeURIComponent(g.sysid)}`, { minutes: 30 }); toast('Automatic failover suspended for 30 minutes for this pair', 'ok'); revalidate('/api/geo'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  const down = w && w.downSince ? Math.round((Date.now() - w.downSince) / 1000) : null;
  return <div className="stack" style={{ marginTop: 12 }}>
    {w && w.downSince ? <Banner kind="bad" title={`Primary site ${w.primaryName} has not responded for ${down} s`}
      actions={role === 'admin' && cand ? <><Button sm kind="danger" onClick={() => onPromote(cand)}>Promote {cand.name} now…</Button>{p.autoFailover && !w.snoozedUntil ? <Button sm onClick={snoozeIt}>False alarm: wait 30 min</Button> : null}</> : null}>
      <div>The console has not heard from it{w.lastSeenSec != null ? ` for ${w.lastSeenSec} s` : ''} and {w.witnesses.standbyName} no longer receives WAL from it: two independent confirmations.</div>
      <div className="small" style={{ marginTop: 4 }}>{w.snoozedUntil ? `Automatic failover suspended until ${dt(w.snoozedUntil)}.` : p.autoFailover ? (w.actInSec ? `Automatic failover to ${w.candidateName} in ${w.actInSec} s, unless the situation changes.` : `Automatic failover to ${w.candidateName} running or just decided.`) : 'Automatic failover is off: you decide on the promotion.'}</div></Banner>
      : w?.note && !f ? <div className="small muted"><Icon n="info" s={13} /> {w.note}</div> : null}
    {f && !f.rejoinedAt ? <Banner kind="warn" title={`${f.toName} has been the primary site since ${dt(f.at)} (${f.auto ? 'automatic failover' : 'manual promotion'})`}>
      {f.lossBytes != null ? <div>Estimated data lost: {f.lossBytes === 0 ? 'none' : `about ${bytes(f.lossBytes)} of WAL`} compared with the last known position of {f.fromName}.</div> : null}
      <div>{g.sites.find(s => s.clusterId === f.from)?.online ? `${f.fromName} is back: ${p.autoRejoin ? 'pg_arca is rejoining it as a standby site' : 'demote it to standby site (it must not accept writes)'}.` : `${f.fromName} is still unreachable: ${p.autoRejoin ? `when it comes back, pg_arca turns it into a standby site of ${f.toName} by itself` : 'when it comes back it must be demoted to standby site'}.`}</div>
      {f.rejoinError ? <div className="small" style={{ color: 'var(--bad)' }}>Last rejoin attempt: {f.rejoinError}</div> : null}</Banner> : null}
    <div className="row wrap gap-s small">
      <Icon n="shield" s={14} /><span><strong>Automatic failover between sites:</strong> {p.autoFailover ? <>on — after {p.confirmSec} s of confirmation, if the estimated loss does not exceed {p.maxLossMB} MB</> : 'off (a person decides on promoting the standby site)'}</span>
      <span className="faint">·</span><span><strong>Old primary when it returns:</strong> {p.autoRejoin ? 'becomes a standby site of the new primary by itself' : 'stays stopped until you demote it'}</span>
      <div className="grow" />{role === 'admin' ? <Button sm kind="ghost" onClick={() => setEdit(true)}>Edit…</Button> : null}</div>
    {edit ? <PolicyDialog g={g} p={p} prim={prim} onClose={() => setEdit(false)} /> : null}
  </div>;
}

function PolicyDialog({ g, p, prim, onClose }: { g: Group; p: Policy; prim?: Site; onClose: () => void }) {
  const [v, setV] = useState<Policy>(p); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const stand = g.sites.filter(s => s.role === 'standby');
  const save = async () => { setBusy(true); setErr(null); try { await api('PUT', `/api/geo/policy/${encodeURIComponent(g.sysid)}`, v); revalidate('/api/geo'); toast('Disaster recovery policy saved', 'ok'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title="Disaster recovery between sites" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
    <div className="stack">
      <label className="check"><input type="checkbox" checked={v.autoFailover} onChange={e => setV({ ...v, autoFailover: e.target.checked })} /><span><strong>Automatic failover</strong>: if {prim?.name || 'the primary site'} is lost, {stand.map(s => s.name).join(' / ') || 'the standby site'} is promoted without waiting for a person.</span></label>
      <p className="small muted" style={{ marginTop: -6 }}>It triggers only with two independent confirmations for the whole period set: the console hears no node of the primary site <em>and</em> the standby site no longer receives WAL from it. A network break between the sites alone, or an isolated console alone, promotes nothing. Before the promotion, the standby site also recovers from the shared WAL archive whatever streaming did not deliver.</p>
      <div className="grid g2">
        <Field label="Confirm for (seconds)" hint="From 10 s to 1 hour. Longer means fewer false alarms; shorter means less downtime."><input className="input" type="number" min={10} max={3600} value={v.confirmSec} onChange={e => setV({ ...v, confirmSec: Number(e.target.value) })} /></Field>
        <Field label="Maximum accepted loss (MB of WAL)" hint="Above this estimate, automatic failover stops and asks for a decision."><input className="input" type="number" min={0} value={v.maxLossMB} onChange={e => setV({ ...v, maxLossMB: Number(e.target.value) })} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={v.autoRejoin} onChange={e => setV({ ...v, autoRejoin: e.target.checked })} /><span><strong>Automatic rejoin</strong>: when the old primary comes back, it immediately becomes a standby site of the new one (never two primaries). Whatever it wrote after the promotion point is discarded and reported.</span></label>
      <p className="small muted">Applications must reach the new primary by themselves (DNS, VIP or HAProxy following the leader): pg_arca does not change the network.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
