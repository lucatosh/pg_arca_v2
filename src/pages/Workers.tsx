import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Modal, Skeleton, ago, bytes } from '../ui';
import { revalidate, toast, useOpRunner, useQuery, useDraft, clearDrafts } from '../hooks';
import { go } from '../router';
import { OP_LABEL, OpPanel, statusBadge } from './shared';
import { CheckList } from './Infra';

/* ====================================================================================================================================================
 * Operational machines ("macchine operative"): servers with the pg_arca agent and no database of their own — backup servers, hosts for the recovery
 * instances, machines for restore drills. Here: what each one can do (PostgreSQL versions installed, disks and network shares, CPU/memory), what it is
 * used for (roles, central recovery node of which levels), and the actions that make sense on it.
 * ==================================================================================================================================================== */
interface WRow { id: string; name: string; label: string; roles: string[]; online: boolean; lastSeen?: string; agentVersion?: string; remoteIp?: string; os?: string; cpus?: number;
  memTotal?: number; memAvailable?: number; root: boolean; sudo: boolean; pgMajors: number[]; remoteMounts: number; usedBy: { scope: string; key: string }[]; reported: boolean }
interface WFull extends WRow { installations: any[]; mounts: any[]; dirs: Record<string, any>; host: any; system: any; recent: any[] }

const ROLE_LABEL: Record<string, { label: string; hint: string }> = {
  recovery: { label: 'Recovery host', hint: 'runs the ephemeral restore instances (PITR of databases, tables, schemas) instead of the production nodes' },
  repository: { label: 'Backup server', hint: 'hosts repositories and WAL archives, usually exported to the nodes over NFS/SMB' },
  drill: { label: 'Restore drills', hint: 'runs the periodic tests that the backups really restore' },
};
const usedText = (u: { key: string }) => u.key === 'global' ? 'all clusters' : u.key.startsWith('env:') ? `environment ${u.key.slice(4)}` : u.key.startsWith('folder:') ? `folder ${u.key.slice(7)}` : u.key.startsWith('cluster:') ? 'one cluster' : u.key;

export function WorkersPage({ role }: { role: string }) {
  const q = useQuery<{ workers: WRow[]; candidates: { id: string; name: string; clusterName?: string }[] }>('/api/workers', { interval: 10000 });
  const [add, setAdd] = useState(false); const [conv, setConv] = useState<{ id: string; name: string; clusterName?: string } | null>(null);
  const d = q.data;
  return <>
    <div className="pagehead"><div className="grow"><h1>Worker hosts</h1>
      <p className="sub">Servers without a database of their own that work for the clusters: backup servers, recovery hosts, drill machines. Here the agent does not look for a PostgreSQL to manage: it reports what the machine can do.</p></div>
      {role === 'admin' ? <Button kind="primary" icon="plus" onClick={() => setAdd(true)}>Add worker host</Button> : null}</div>
    {d?.candidates?.length && role === 'admin' ? <Banner kind="info" title="Servers without a database registered as clusters">
      {d.candidates.map(c => <div key={c.id} className="row small"><span className="grow"><strong>{c.name}</strong>{c.clusterName ? <> — in cluster “{c.clusterName}”, where PostgreSQL was never found</> : null}</span>
        <Button sm onClick={() => setConv(c)}>Make it a worker host</Button></div>)}</Banner> : null}
    {!d ? <Skeleton h={180} /> : !d.workers.length ? <Empty icon="server" title="No worker hosts"
      action={role === 'admin' ? <Button kind="primary" icon="plus" onClick={() => setAdd(true)}>Add worker host</Button> : undefined}>
      A backup server or a host dedicated to restores takes load and space off the production nodes. Install the agent with the “worker host” role.</Empty> :
      <Card pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Host</th><th>Roles</th><th>PostgreSQL installed</th><th>Resources</th><th>Used by</th><th>Status</th></tr></thead><tbody>
        {d.workers.map(w => <tr key={w.id} className="click" onClick={() => go(`w/${encodeURIComponent(w.id)}`)}>
          <td><strong>{w.name}</strong>{w.label ? <div className="small muted">{w.label}</div> : null}</td>
          <td>{w.roles.length ? <div className="row wrap gap-s">{w.roles.map(r => <Badge key={r} kind="accent">{ROLE_LABEL[r]?.label || r}</Badge>)}</div> : <span className="faint">—</span>}</td>
          <td>{w.pgMajors.length ? w.pgMajors.map(m => <Badge key={m}>{m}</Badge>) : <span className="faint">{w.reported ? 'none' : '…'}</span>}</td>
          <td className="small">{w.cpus ? `${w.cpus} CPU · ` : ''}{w.memTotal ? `${bytes(w.memTotal)} RAM` : ''}{w.remoteMounts ? ` · ${w.remoteMounts} network shares` : ''}</td>
          <td className="small">{w.usedBy.length ? `recovery for ${w.usedBy.map(usedText).join(', ')}` : <span className="faint">—</span>}</td>
          <td>{w.online ? <Badge kind="ok">online</Badge> : <Badge kind="bad" title={w.lastSeen ? `last seen ${ago(w.lastSeen)}` : undefined}>offline</Badge>}</td></tr>)}</tbody></table></div></Card>}
    {add ? <AddWorker onClose={() => setAdd(false)} /> : null}
    {conv ? <Confirm title={`Make ${conv.name} a worker host?`} confirmLabel="Make it a worker host" onClose={() => setConv(null)} onConfirm={async () => {
      try { const r = await api<any>('POST', `/api/nodes/${encodeURIComponent(conv.id)}/make-worker`, {}); toast(r.clusterRemoved ? 'Done: the empty cluster was removed' : 'Done', 'ok'); revalidate('/api/workers'); revalidate('/api/workers-summary'); revalidate('/api/clusters'); }
      catch (e: any) { toast(e.body?.message || e.message, 'bad'); } setConv(null); }}>
      <p>The agent stops looking for a database on this server and reports what it can do (installed PostgreSQL versions, disks, shares). {conv.clusterName ? <>Cluster “{conv.clusterName}” is removed if it ends up empty.</> : null}</p></Confirm> : null}
  </>;
}

function AddWorker({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState(''); const [r, setR] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setErr(null); try { setR(await api<any>('POST', '/api/enrollment-tokens', { label: label || 'worker host', kind: 'worker', ttlMinutes: 120 })); } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); } };
  return <Modal title="Add a worker host" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Close</Button>{!r ? <Button kind="primary" busy={busy} onClick={create}>Create the install command</Button> : null}</>}>
    <div className="stack">
      {!r ? <><Field label="What it is for" hint="For example: “Backup server DC1”, “Recovery host for production”."><input className="input" value={label} onChange={e => setLabel(e.target.value)} /></Field>
        <p className="small muted">The machine needs Python 3.6+. PostgreSQL is not needed: for restores pg_arca can install the binaries of the required version in a private directory, without touching the system.</p></> :
        <><p>Run on the machine, as root (the command works once, for 2 hours):</p><pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.installCommand}</pre>
          <Button sm icon="copy" onClick={() => { navigator.clipboard?.writeText(r.installCommand); toast('Copied', 'ok'); }}>Copy</Button>
          <p className="small muted">The agent runs as the postgres user if it exists, otherwise as a dedicated system user “pgarca”. The host will appear in the sidebar within a few seconds.</p></>}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

export function WorkerView({ id, role }: { id: string; role: string }) {
  const q = useQuery<WFull>(`/api/workers/${encodeURIComponent(id)}`, { interval: 8000 });
  const cl = useQuery<{ clusters: any[] }>('/api/clusters');
  const w = q.data;
  const [dlg, setDlg0] = useDraft<'' | 'edit' | 'use' | 'dest' | 'install'>(`worker:${id}:dlg`, '');
  const setDlg = (v: '' | 'edit' | 'use' | 'dest' | 'install') => { if (!v) clearDrafts(`worker:${id}:form`); setDlg0(v); };
  const pre = useOpRunner(`worker:${id}`, () => revalidate(`/api/workers/${encodeURIComponent(id)}`), `worker:${id}:op`);
  const majors = useMemo(() => { const s = new Set<number>(); for (const c of cl.data?.clusters || []) { const m = parseInt(String(c.pgVersion || ''), 10); if (m) s.add(m); } return [...s].sort((a, b) => b - a); }, [cl.data]);
  const [major, setMajor] = useState<number | ''>('');
  const mj = major || majors[0] || w?.pgMajors[0] || 16;
  if (q.error && !w) return <Empty icon="server" title="Worker host not found">It may have been removed. <a href="#/workers">All worker hosts</a></Empty>;
  if (!w) return <div className="stack"><Skeleton h={40} w={300} /><Skeleton h={200} /></div>;
  const res = pre.op?.status === 'succeeded' ? pre.op.result : null;
  const missingMajors = majors.filter(m => !w.pgMajors.includes(m));
  return <div className="stack-l">
    <div className="pagehead"><div className="grow"><h1>{w.name} {w.online ? <Badge kind="ok">online</Badge> : <Badge kind="bad">offline</Badge>}</h1>
      <p className="sub">{w.label || 'Worker host'} · {w.os || 'OS not reported yet'}{w.remoteIp ? ` · ${w.remoteIp.replace(/^::ffff:/, '')}` : ''}{w.agentVersion ? ` · agent ${w.agentVersion}` : ''}</p></div>
      {role === 'admin' ? <Button onClick={() => setDlg('edit')}>Name and roles</Button> : null}</div>

    {!w.reported ? <Banner kind="info" title="Waiting for the inventory">The agent has not reported what is on this machine yet (update the agent to a version that supports worker hosts, or wait for the next check-in).</Banner> : null}
    {majors.length && missingMajors.length ? <Banner kind="warn" title={`PostgreSQL ${missingMajors.join(', ')} binaries are missing`}>Restoring those clusters’ backups on this machine needs the binaries of the same version.
      {role === 'admin' ? <> <Button sm onClick={() => { setMajor(missingMajors[0]); setDlg('install'); }}>Install PostgreSQL {missingMajors[0]}</Button></> : null}</Banner> : null}

    <div className="grid g2">
      <Card title="Capabilities"><div className="stack">
        <dl className="kv small">
          <dt>Roles</dt><dd>{w.roles.length ? w.roles.map(r => <div key={r}><strong>{ROLE_LABEL[r]?.label}</strong> <span className="muted">— {ROLE_LABEL[r]?.hint}</span></div>) : <span className="faint">none set</span>}</dd>
          <dt>PostgreSQL</dt><dd>{w.installations.length ? w.installations.map((i: any) => <div key={i.bindir}><Badge>{i.major}</Badge> <span className="mono">{i.bindir}</span> <span className="faint">{i.source === 'private' ? 'pg_arca private installation' : i.source === 'system' ? 'system packages' : 'configured'}</span></div>) : <span className="faint">no installation found</span>}</dd>
          <dt>Resources</dt><dd>{w.cpus ?? '?'} CPU · {bytes(w.memTotal)} memory ({bytes(w.memAvailable)} available)</dd>
          <dt>Privileges</dt><dd>{w.root ? 'root' : w.sudo ? 'user with passwordless sudo' : 'unprivileged user (private installations only)'}</dd>
          <dt>Used by</dt><dd>{w.usedBy.length ? `recovery node for ${w.usedBy.map(usedText).join(', ')}` : <span className="faint">no configuration uses it yet</span>}</dd>
        </dl>
        <div className="row wrap">{role !== 'viewer' ? <Button sm icon="search" busy={pre.busy} onClick={() => pre.run('ephemeral_preflight', { major: mj })}>Verify as recovery host (PG {mj})</Button> : null}
          {role === 'admin' ? <Button sm onClick={() => setDlg('use')}>Use it for restores…</Button> : null}
          {role !== 'viewer' ? <Button sm onClick={() => setDlg('dest')}>Check a backup directory…</Button> : null}</div>
        {majors.length > 1 ? <div className="row small"><span className="muted">Version to verify:</span><select className="input" style={{ width: 'auto' }} value={mj} onChange={e => setMajor(Number(e.target.value))}>{majors.map(m => <option key={m} value={m}>PostgreSQL {m}</option>)}</select></div> : null}
        {pre.op && !res ? <OpPanel op={pre.op} error={pre.error} /> : null}
        {res && pre.op?.type === 'ephemeral_preflight' ? <><Banner kind={res.ok ? (res.level === 'warn' ? 'warn' : 'ok') : 'bad'} title={res.ok ? 'It can run restores' : 'It cannot run restores yet'}>PostgreSQL {res.major ?? mj}</Banner><CheckList checks={res.checks || []} /></> : null}
        {res && pre.op?.type === 'destination_check' ? <><Banner kind={res.ok ? 'ok' : 'bad'} title={res.ok ? 'Directory usable' : 'Directory not usable'} />{res.checks ? <CheckList checks={res.checks} /> : null}</> : null}
      </div></Card>
      <Card title="Disks and shares"><div className="stack">
        {w.mounts.length ? <table className="t small"><thead><tr><th>Mount point</th><th>Type</th><th className="num">Free</th></tr></thead><tbody>
          {w.mounts.map((m: any) => { const p = m.total_bytes ? Math.round(100 * m.free_bytes / m.total_bytes) : 0; return <tr key={m.mount}><td className="mono">{m.mount}</td><td>{m.remote ? <Badge kind="accent">{m.fstype}</Badge> : m.fstype}</td>
            <td className="num"><span style={{ color: p < 10 ? 'var(--bad)' : undefined }}>{bytes(m.free_bytes)}</span> <span className="faint">/ {bytes(m.total_bytes)}</span></td></tr>; })}</tbody></table> : <span className="faint small">not reported yet</span>}
        <dl className="kv small">{Object.entries(w.dirs || {}).filter(([, v]) => v).map(([k, v]: any) => <React.Fragment key={k}><dt>{k === 'scratch' ? 'Scratch directory' : k === 'repo' ? 'Repository' : 'WAL archive'}</dt>
          <dd><span className="mono">{v.path}</span> {v.exists ? (v.writable ? <Badge kind="ok">writable</Badge> : <Badge kind="bad">not writable</Badge>) : <Badge>to be created</Badge>} {v.free_bytes != null ? <span className="faint">{bytes(v.free_bytes)} free</span> : null}</dd></React.Fragment>)}</dl>
      </div></Card>
    </div>

    <Card title="Recent operations on this host">{w.recent.length ? <table className="t small"><tbody>{w.recent.map((o: any) => <tr key={o.id}><td>{OP_LABEL[o.type] || o.type}</td><td>{statusBadge(o.status)}</td><td className="faint">{o.createdBy}</td><td className="faint">{ago(o.updatedAt)}</td></tr>)}</tbody></table> : <span className="faint small">none</span>}</Card>

    {dlg === 'edit' ? <EditWorker w={w} onClose={() => setDlg('')} /> : null}
    {dlg === 'use' ? <UseForRecovery w={w} clusters={cl.data?.clusters || []} onClose={() => setDlg('')} /> : null}
    {dlg === 'dest' ? <DestCheck onRun={(p) => { pre.run('destination_check', p); setDlg(''); }} onClose={() => setDlg('')} /> : null}
    {dlg === 'install' ? <Confirm title={`Install PostgreSQL ${mj} on ${w.name}?`} confirmLabel="Install" requireText="INSTALL" onClose={() => setDlg('')}
      onConfirm={() => { pre.run('ephemeral_install', { major: mj, mode: w.root || w.sudo ? 'system' : 'private', confirm: 'INSTALL' }); setDlg(''); }}>
      <p>{w.root || w.sudo ? 'With the system packages (the machine has the privileges).' : 'In a pg_arca private directory, without root privileges.'} Only the server binaries are needed; no instance is started.</p></Confirm> : null}
  </div>;
}

function EditWorker({ w, onClose }: { w: WFull; onClose: () => void }) {
  const [label, setLabel] = useDraft(`worker:${w.id}:form:label`, w.label); const [roles, setRoles] = useDraft<string[]>(`worker:${w.id}:form:roles`, w.roles); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('PATCH', `/api/workers/${encodeURIComponent(w.id)}`, { label, roles }); revalidate(`/api/workers/${encodeURIComponent(w.id)}`); revalidate('/api/workers-summary'); revalidate('/api/workers'); onClose(); } catch (e: any) { setErr(e.body?.message || e.message); } };
  return <Modal title={`${w.name}: name and roles`} onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Save</Button></>}>
    <div className="stack"><Field label="Description"><input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Backup server DC1" /></Field>
      {Object.entries(ROLE_LABEL).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={roles.includes(k)} onChange={e => setRoles(r => e.target.checked ? [...r, k] : r.filter(x => x !== k))} /><span><strong>{v.label}</strong> <span className="small muted">— {v.hint}</span></span></label>)}
      <p className="small muted">Roles describe the machine; its actual use for restores is decided with “Use it for restores”.</p>
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/** Make this machine the central recovery node for every cluster, an environment or one cluster: writes placement=central + centralNode into that level, keeping its other fields. */
function UseForRecovery({ w, clusters, onClose }: { w: WFull; clusters: any[]; onClose: () => void }) {
  const [scope, setScope] = useDraft(`worker:${w.id}:form:scope`, 'global'); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const envs = [...new Set(clusters.filter(c => !c.isSandbox).map(c => c.environment))];
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const view = await api<any>('GET', '/api/scoped/ephemeral');
      const [s, k] = scope === 'global' ? ['global', ''] : scope.split(/:(.*)/s);
      const cur = view.assignments[scope === 'global' ? 'global' : scope] || {};
      await api('PUT', '/api/scoped/ephemeral/assignments', { scope: s, key: k, value: { ...cur, placement: 'central', centralNode: w.id } });
      revalidate(`/api/workers/${encodeURIComponent(w.id)}`); revalidate('/api/scoped/ephemeral'); toast('From now on, restores at that level run on ' + w.name, 'ok'); onClose();
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal title={`Use ${w.name} for restores`} onClose={onClose} footer={<><Button kind="ghost" onClick={() => go('infra/ephemeral')}>All settings</Button><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Use this host</Button></>}>
    <div className="stack">
      <p>The ephemeral restore instance (databases, tables, schemas, drills) will run on <strong>{w.name}</strong> instead of the cluster nodes; the result is delivered to the cluster’s primary. The machine must see the backup repository (same path, for example over NFS) and reach the primary on the PostgreSQL port.</p>
      <Field label="For which clusters"><select className="input" value={scope} onChange={e => setScope(e.target.value)}>
        <option value="global">All clusters</option>{envs.map(e => <option key={e} value={`env:${e}`}>Environment {e}</option>)}
        {clusters.filter(c => !c.isSandbox && c.source !== 'direct').map(c => <option key={c.id} value={`cluster:${c.id}`}>Cluster {c.name}</option>)}</select></Field>
      {w.pgMajors.length ? null : <Banner kind="warn">PostgreSQL is not on this machine yet: install the binaries of the backups’ version before the first restore.</Banner>}
      {err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

function DestCheck({ onRun, onClose }: { onRun: (p: any) => void; onClose: () => void }) {
  const [type, setType] = useDraft('workerdest:type', 'local'); const [repo, setRepo] = useDraft('workerdest:repo', ''); const [wal, setWal] = useDraft('workerdest:wal', '');
  const ok = (p: string) => !p || p.startsWith('/');
  return <Modal title="Check a backup directory from this host" onClose={onClose} footer={<><div className="grow" /><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!repo || !ok(repo) || !ok(wal)} onClick={() => onRun({ type, repo_path: repo, ...(wal ? { wal_path: wal } : {}), require_mount: type !== 'local' })}>Check</Button></>}>
    <div className="stack"><p className="small muted">A real check: filesystem type, exclusive write with fsync and atomic rename, free space. Nothing is moved.</p>
      <Field label="Type"><div className="seg">{['local', 'nfs', 'smb'].map(t => <button key={t} aria-pressed={type === t} onClick={() => setType(t)}>{t === 'local' ? 'Local disk' : t.toUpperCase()}</button>)}</div></Field>
      <Field label="Repository directory" error={ok(repo) ? null : 'Absolute path required'}><input className="input mono" value={repo} onChange={e => setRepo(e.target.value)} placeholder="/backup/pgarca/repo" /></Field>
      <Field label="WAL archive directory (optional)" error={ok(wal) ? null : 'Absolute path required'}><input className="input mono" value={wal} onChange={e => setWal(e.target.value)} placeholder="/backup/pgarca/wal" /></Field></div></Modal>;
}


