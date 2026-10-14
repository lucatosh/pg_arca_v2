import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { itCheck, itFix } from '../i18n';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Field, Icon, Modal, Skeleton, Tabs, bytes, ago, num } from '../ui';
import { Op, clearDrafts, isTerminal, revalidate, toast, useDraft, useOpRunner, useQuery } from '../hooks';
import { OpPanel } from './shared';
import { go } from '../router';

/* ====================================================================================================================================================
 * Where recoveries run (ephemeral instance) and where backups are written (destination): both decided per level
 *   cluster > folder > environment > global, field by field. Same screen, same behaviour; only the form and the checks differ.
 * ==================================================================================================================================================== */
type Scope = 'global' | 'env' | 'folder' | 'cluster';
interface SCluster { id: string; name: string; environment: string; folder: string; source: string; effective: { value: Record<string, any>; sources: Record<string, { scope: string; key: string }> } }
interface SNode { id: string; name: string; clusterId: string | null; online: boolean; pg: boolean; worker?: boolean; label?: string; pgMajors?: number[] }
interface SView { kind: string; defaults: Record<string, any>; assignments: Record<string, Record<string, any>>; folders: string[]; clusters: SCluster[]; nodes: SNode[] }
const ENVS = ['prod', 'prep', 'int', 'dev', 'test'];
const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test' };
const scopeKey = (s: Scope, k: string) => (s === 'global' ? 'global' : `${s}:${k}`);
const srcText = (s?: { scope: string; key: string }) => !s || s.scope === 'default' ? 'default' : s.scope === 'cluster' ? 'this cluster' : s.scope === 'folder' ? `folder ${s.key.replace(/^folder:/, '')}` : s.scope === 'env' ? `environment ${s.key.replace(/^env:/, '')}` : 'global';

interface FormProps { value: Record<string, any>; set: (k: string, v: any) => void; view: SView }
interface KindUI { title: string; intro: string; Form: React.FC<FormProps>; summary: (v: Record<string, any>) => React.ReactNode; fields: string[]; labels: Record<string, string> }

/* ---------------------------------------------------------------------------------------------------------------------- ephemeral instance */
const EPH_LABELS: Record<string, string> = { placement: 'Where it runs', centralNode: 'Central node', scratchDir: 'Scratch directory', binDir: 'PostgreSQL binaries', portMin: 'Ports', sharedBuffersMb: 'Memory (shared_buffers)', keepOnFailure: 'Keep on failure', installDir: 'Installation directory', installMode: 'Installation', centralInto: 'Result delivery' };
const ephSummary = (v: Record<string, any>) => <>
  {v.placement === 'central' ? <Badge kind="accent">Central node</Badge> : <Badge>On the cluster node</Badge>}{' '}
  <span className="small muted">{[v.scratchDir ? `scratch ${v.scratchDir}` : null, v.binDir ? `binaries ${v.binDir}` : 'binaries picked automatically per version', v.portMin ? `ports ${v.portMin}-${v.portMax}` : null, `${v.sharedBuffersMb} MB`].filter(Boolean).join(' · ')}</span></>;

const EphForm: React.FC<FormProps> = ({ value: v, set, view }) => {
  const inp = (k: string, ph: string, mono = true) => <input className={`input ${mono ? 'mono' : ''}`} placeholder={ph} value={v[k] ?? ''} onChange={e => set(k, e.target.value)} />;
  const num = (k: string, ph: string) => <input className="input" type="number" placeholder={ph} value={v[k] ?? ''} onChange={e => set(k, e.target.value === '' ? '' : Number(e.target.value))} />;
  const central = v.placement === 'central';
  return <div className="stack">
    <Field label="Where the recovery instance runs" hint="Extracting a table or a database needs a temporary PostgreSQL instance. Leaving “Same as the level above” inherits the setting.">
      <div className="seg"><button aria-pressed={!v.placement} onClick={() => set('placement', '')}>Same as the level above</button><button aria-pressed={v.placement === 'node'} onClick={() => set('placement', 'node')}>On the cluster node</button><button aria-pressed={central} onClick={() => set('placement', 'central')}>On a central node</button></div></Field>
    {v.placement === 'node' ? <p className="small muted">Same machine as the database: it uses its disks and CPU during the restore. No network in between.</p> : null}
    {central ? <div className="opt-body stack">
      <Field label="Central node" hint="A node with an agent, dedicated to restores. It must read the cluster’s repository and WAL archive (network share mounted at the same paths) and reach the cluster’s primary.">
        <select className="input" value={v.centralNode ?? ''} onChange={e => set('centralNode', e.target.value)}><option value="">Choose…</option>
          {view.nodes.some(n => n.worker) ? <optgroup label="Worker hosts (recommended: no load on production)">{view.nodes.filter(n => n.worker).map(n => <option key={n.id} value={n.id}>{n.name}{n.label ? ` — ${n.label}` : ''}{n.pgMajors?.length ? ` · PG ${n.pgMajors.join('/')}` : ' · without PostgreSQL'}{n.online ? '' : ' (offline)'}</option>)}</optgroup> : null}
          <optgroup label="Cluster nodes">{view.nodes.filter(n => !n.worker).map(n => <option key={n.id} value={n.id}>{n.name}{n.online ? '' : ' (offline)'}</option>)}</optgroup></select></Field>
      <div className="grid g3"><Field label="Delivery: primary host" hint="Empty = the detected one"><input className="input" value={v.centralInto?.host ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), host: e.target.value })} /></Field>
        <Field label="Port"><input className="input" type="number" value={v.centralInto?.port ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), port: e.target.value ? Number(e.target.value) : '' })} /></Field>
        <Field label="User"><input className="input" value={v.centralInto?.user ?? ''} onChange={e => set('centralInto', { ...(v.centralInto || {}), user: e.target.value })} /></Field></div>
      <p className="small muted">The recovered tables are delivered to the cluster’s primary: this needs a pg_hba rule for the central node and a password in the agent user’s <code>.pgpass</code>. The check below (“Verify”) actually tests the connection.</p></div> : null}
    <div className="grid g2">
      <Field label="Scratch directory" hint="Where files are extracted during recovery. Preferably a fast local disk, separate from the data disk."><>{inp('scratchDir', '/var/tmp/pg_arca_scratch')}</></Field>
      <Field label="PostgreSQL binaries directory" hint="Empty = picked automatically for the backup’s version (node, system packages, pg_arca installations).">{inp('binDir', 'automatic')}</Field>
      <Field label="Ports (from)" hint="Useful with local firewalls. Empty = any free port, on 127.0.0.1 only.">{num('portMin', 'e.g. 55000')}</Field>
      <Field label="Ports (to)">{num('portMax', 'e.g. 55100')}</Field>
      <Field label="shared_buffers (MB)" hint="More memory speeds up recovery. Default 256.">{num('sharedBuffersMb', '256')}</Field>
      <Field label="If PostgreSQL is missing">
        <select className="input" value={v.installMode ?? ''} onChange={e => set('installMode', e.target.value)}><option value="">Same as the level above</option><option value="private">Private installation (no root)</option><option value="system">System packages (needs root or sudo)</option></select></Field>
      <Field label="Private installations directory" hint="Default /var/lib/pgarca/pg.">{inp('installDir', '/var/lib/pgarca/pg')}</Field>
      <Field label="Keep the instance if recovery fails" hint="To find out what went wrong: it must then be deleted by hand.">
        <select className="input" value={v.keepOnFailure === undefined || v.keepOnFailure === '' ? '' : v.keepOnFailure ? '1' : '0'} onChange={e => set('keepOnFailure', e.target.value === '' ? '' : e.target.value === '1')}><option value="">Same as the level above</option><option value="0">No</option><option value="1">Yes</option></select></Field></div></div>;
};

/* ---------------------------------------------------------------------------------------------------------------------- destination */
const DEST_LABELS: Record<string, string> = { type: 'Type', repoPath: 'Repository', walPath: 'WAL archive', requireMount: 'Mount required', minFreeGb: 'Minimum space' };
const TYPE_LABEL: Record<string, string> = { local: 'Local directory', nfs: 'NFS share', smb: 'SMB/CIFS share' };
const destSummary = (v: Record<string, any>) => <>
  <Badge kind={v.type === 'local' ? undefined : 'accent'}>{TYPE_LABEL[v.type] || v.type}</Badge>{' '}
  <span className="small muted mono">{[v.repoPath ? `repo ${v.repoPath}` : null, v.walPath ? `wal ${v.walPath}` : null].filter(Boolean).join('  ') || 'paths not set'}{v.requireMount ? ' · mount required' : ''}</span></>;
const PREVIEW = [{ id: 's3', label: 'Amazon S3 / MinIO / Ceph RGW' }, { id: 'azure', label: 'Azure Blob Storage' }, { id: 'gcs', label: 'Google Cloud Storage' }, { id: 'sftp', label: 'SFTP' }];

const DestForm: React.FC<FormProps> = ({ value: v, set }) => <div className="stack">
  <Field label="Where backups are written" hint="The engine writes to file paths: a local directory or a network share (NFS, SMB) already mounted on the nodes. pg_arca mounts nothing: it checks that the mount is really there.">
    <select className="input" value={v.type ?? ''} onChange={e => set('type', e.target.value)}>
      <option value="">Same as the level above</option><option value="local">Local directory on the node</option><option value="nfs">NFS network share (mounted)</option><option value="smb">SMB/CIFS network share (mounted)</option>
      <optgroup label="Preview — not available yet">{PREVIEW.map(p => <option key={p.id} value={p.id} disabled>{p.label} (Preview)</option>)}</optgroup></select></Field>
  <div className="grid g2">
    <Field label="Repository directory" hint="Placeholders: {cluster} {env} {id}. Several clusters can share the same repository (each has its own space)."><input className="input mono" placeholder="/mnt/backup/pgarca" value={v.repoPath ?? ''} onChange={e => set('repoPath', e.target.value)} /></Field>
    <Field label="WAL archive directory" hint="Must be different for each cluster: use {cluster} or {id}."><input className="input mono" placeholder="/mnt/backup/wal/{env}/{cluster}" value={v.walPath ?? ''} onChange={e => set('walPath', e.target.value)} /></Field>
    <Field label="Minimum free space (GiB)" hint="The check fails below this threshold."><input className="input" type="number" min={0} value={v.minFreeGb ?? ''} onChange={e => set('minFreeGb', e.target.value === '' ? '' : Number(e.target.value))} /></Field>
    <Field label="Mount required" hint="Rejects the path if it is on the system disk: prevents backups from filling the local disk when the share is not mounted.">
      <select className="input" value={v.requireMount === undefined || v.requireMount === '' ? '' : v.requireMount ? '1' : '0'} onChange={e => set('requireMount', e.target.value === '' ? '' : e.target.value === '1')}><option value="">Same as the level above</option><option value="1">Yes</option><option value="0">No</option></select></Field></div>
  <Banner kind="info" title="What happens when you change the destination">Existing backups stay where they are: they are not moved. The new destination starts with a new full backup; restores from older points keep reading from the old path as long as you keep it.</Banner></div>;

const KINDS: Record<'ephemeral' | 'destination', KindUI> = {
  ephemeral: { title: 'Recovery instance', intro: 'To restore a database, a schema or a table without touching the running cluster, pg_arca starts a temporary PostgreSQL instance on files extracted from the backup. Here you decide where it runs and with which resources: for all clusters, per environment, per folder or per cluster.', Form: EphForm, summary: ephSummary, fields: Object.keys(EPH_LABELS), labels: EPH_LABELS },
  destination: { title: 'Backup destination', intro: 'Where the repository and WAL archive go. Once for all clusters, per environment, per folder or per cluster; the {cluster} {env} {id} placeholders give each cluster its own directory. Before applying, every node verifies that the destination really works.', Form: DestForm, summary: destSummary, fields: Object.keys(DEST_LABELS), labels: DEST_LABELS },
};

/** Edit what ONE level sets. Empty fields are not stored: they keep inheriting. */
function ScopeDialog({ kind, scope, k, label, view, onClose }: { kind: 'ephemeral' | 'destination'; scope: Scope; k: string; label: string; view: SView; onClose: () => void }) {
  const ui = KINDS[kind]; const cur = view.assignments[scopeKey(scope, k)];
  const DK = `scope:${kind}:${scope}:${k}`;
  const [v, setV] = useDraft<Record<string, any>>(DK + ':v', () => ({ ...(cur || {}) }));      // kept if the page is left with the dialog open; discarded when it is closed
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const close = () => { clearDrafts(DK); onClose(); };
  const set = (key: string, val: any) => setV(x => { const n = { ...x }; if (val === '' || val === undefined) delete n[key]; else n[key] = val; if (key === 'centralInto' && val && !Object.values(val).some(Boolean)) delete n[key]; return n; });
  const save = async (inherit: boolean) => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/scoped/${kind}/assignments`, { scope, key: k, ...(inherit ? { inherit: true } : { value: v }) }); revalidate(`/api/scoped/${kind}`); toast(inherit ? 'Inheriting again' : 'Settings saved', 'ok'); close(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Modal wide title={`${ui.title} — ${label}`} onClose={close} footer={<>{cur ? <Button kind="ghost" onClick={() => save(true)} disabled={busy}>Remove: inherit</Button> : null}<div className="grow" /><Button onClick={close}>Cancel</Button><Button kind="primary" busy={busy} disabled={!Object.keys(v).length} onClick={() => save(false)}>Save</Button></>}>
    <div className="stack"><ui.Form value={v} set={set} view={view} />{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- ephemeral: preflight + install */
const LEVEL_KIND: Record<string, 'ok' | 'warn' | 'bad'> = { ok: 'ok', warn: 'warn', bad: 'bad' };
export function CheckList({ checks }: { checks: any[] }) {
  return <div className="stack">{checks.map((c, i) => <div key={i} className="row gap-s" style={{ alignItems: 'flex-start' }}><Badge kind={LEVEL_KIND[c.level]}>{c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'warning' : 'problem'}</Badge>
    <div className="grow"><div>{itCheck(c.text)}</div>{c.fix ? <div className="small muted">→ {itFix(c.fix)}</div> : null}</div></div>)}</div>;
}

function PreflightModal({ cluster, onClose }: { cluster: SCluster; onClose: () => void }) {
  const pre = useOpRunner(cluster.id, undefined, `eph:${cluster.id}:pre`); const ins = useOpRunner(cluster.id, () => pre.run('ephemeral_preflight', {}), `eph:${cluster.id}:ins`);
  const [mode, setMode] = useDraft<'private' | 'system'>(`eph:${cluster.id}:mode`, 'private'); const [ask, setAsk] = useState(false);
  useEffect(() => { if (!ins.busy) pre.run('ephemeral_preflight', {}); }, []);   // a fresh check each time it is opened (not while an installation runs)
  const r = pre.op?.status === 'succeeded' ? pre.op.result : null;
  const plan = r?.install_plan; const modes = plan?.modes || {};
  useEffect(() => { if (plan?.recommended) setMode(plan.recommended); }, [plan?.recommended]);
  const m = modes[mode];
  return <Modal wide title={`Recovery check — ${cluster.name}`} onClose={onClose} footer={<><Button icon="refresh" onClick={() => pre.run('ephemeral_preflight', {})} busy={pre.busy}>Run the check again</Button><div className="grow" /><Button onClick={onClose}>Close</Button></>}>
    <div className="stack">
      {!r ? <OpPanel op={pre.op} error={pre.error} label="Recovery instance check" /> : <>
        <Banner kind={r.ok ? (r.level === 'warn' ? 'warn' : 'ok') : 'bad'} title={r.ok ? 'This node can run recoveries' : 'Recovery cannot start from this node'}>
          PostgreSQL {r.major ?? '?'} backup · {r.host?.os} · {r.host?.cpus} CPU · {bytes(r.host?.mem_available)} memory available{r.settings?.placement === 'central' ? ' · central node' : ''}</Banner>
        <CheckList checks={r.checks} />
        {r.installations?.length ? <details><summary className="small muted" style={{ cursor: 'pointer' }}>PostgreSQL installations found ({r.installations.length})</summary>
          <table className="t"><thead><tr><th>Version</th><th>Directory</th><th>Source</th><th>Complete</th></tr></thead><tbody>{r.installations.map((i: any) => <tr key={i.bindir}><td>{i.version}</td><td className="mono small">{i.bindir}</td><td>{({ system: 'system package', private: 'installed by pg_arca', configured: 'configured' } as any)[i.source] || i.source}</td><td>{i.complete ? <Badge kind="ok">yes</Badge> : <Badge kind="warn" title={`missing: ${i.missing_tools.join(', ')}`}>no</Badge>}</td></tr>)}</tbody></table></details> : null}
        {plan ? <Card title={`Install PostgreSQL ${plan.major}`}><div className="stack">
          {plan.blocked ? <Banner kind="warn" title="Automatic installation not available">{plan.blocked}</Banner> : <>
            <p className="small muted">The binaries for the backup’s version are missing. A different version cannot open those files: pg_arca can install it, but only if you ask here and with the permissions shown.</p>
            {(['private', 'system'] as const).map(k => modes[k] ? <label key={k} className={`opt ${mode === k ? 'on' : ''}`}><input type="radio" checked={mode === k} onChange={() => setMode(k)} />
              <div><div><strong>{k === 'private' ? 'Private installation' : 'System packages'}</strong> {modes[k].possible ? <Badge kind="ok">possible</Badge> : <Badge kind="bad">not possible</Badge>}{plan.recommended === k ? <Badge kind="accent">recommended</Badge> : null}</div>
                <div className="small muted">{k === 'private' ? 'No root: downloads the packages and extracts their files into a pg_arca directory. No service, no system changes. Needs network access to the package repository.' : 'Regular package installation. Needs root or passwordless sudo for the agent’s user.'}</div></div></label> : null)}
            {m ? <div className="stack">
              {m.blockers?.length ? <Banner kind="bad" title="What blocks the installation">{m.blockers.map((b: string, i: number) => <div key={i} className="small">{b}</div>)}</Banner> : null}
              <div className="small"><strong>Permissions and requirements</strong><ul>{m.needs.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
              <div className="small"><strong>Commands that will run</strong><pre className="out">{m.commands.join('\n')}</pre></div>
              {m.warnings?.length ? <Banner kind="warn" title="Good to know first">{m.warnings.map((x: string, i: number) => <div key={i} className="small">{x}</div>)}</Banner> : null}
              <div><Button kind="primary" icon="zap" disabled={!m.possible || ins.busy} busy={ins.busy} onClick={() => setAsk(true)}>Install PostgreSQL {plan.major}</Button></div></div> : null}</>}
          {ins.op || ins.error ? <OpPanel op={ins.op} error={ins.error} label="Installing the binaries" /> : null}</div></Card> : null}</>}
    </div>
    {ask ? <Confirm title={`Install PostgreSQL ${plan?.major}?`} confirmLabel="Install" requireText="INSTALL" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); ins.run('ephemeral_install', { major: plan.major, mode, confirm: 'INSTALL' }); }}>
      <p>{mode === 'private' ? 'The packages are downloaded and extracted into a pg_arca directory, without root.' : 'The packages are installed with the system package manager.'} In a protected environment another administrator must approve.</p></Confirm> : null}
  </Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- destination: check + apply */
function NodeCheck({ opId }: { opId: string }) {
  const q = useQuery<{ operation: Op }>(`/api/operations/${opId}`, { interval: 1500 });
  const op = q.data?.operation;
  if (!op) return <Skeleton h={18} />;
  if (!isTerminal(op.status)) return <div className="small muted">Check running…</div>;
  if (op.status !== 'succeeded') return <Banner kind="bad" title="The check failed">{op.error || op.status}</Banner>;
  const r = op.result;
  return <div className="stack">{(r.paths || []).map((p: any) => <div key={p.kind} className="stack"><div className="small"><strong>{p.kind === 'repo' ? 'Repository' : 'WAL archive'}</strong> <span className="mono">{p.path}</span>{p.mount ? <span className="muted"> · {p.mount.fstype}</span> : null}{p.free_bytes != null ? <span className="muted"> · {bytes(p.free_bytes)} free</span> : null}</div>
    <CheckList checks={p.checks} />{p.bench && !p.bench.error ? <div className="small muted">Measured: write {p.bench.write_mb_s} MB/s, read {p.bench.read_mb_s} MB/s ({p.bench.note})</div> : null}
    {p.identity ? <Writers id={p.identity} /> : null}
    {p.fix_commands?.length && p.checks.some((c: any) => c.level !== 'ok') ? <details open={p.checks.some((c: any) => c.level === 'bad')}><summary className="small" style={{ cursor: 'pointer' }}>Commands to fix the permissions (run as root on the node)</summary>
      <pre className="out">{p.fix_commands.join('\n')}</pre><p className="small muted">pg_arca does not run them itself: they change system users, groups and permissions. Afterwards, run the check again.</p></details> : null}</div>)}
    {r.server_probe ? <div className="small muted">{r.server_probe === 'not run: no running PostgreSQL on this node (the agent\'s own identity was tested)' ? 'PostgreSQL is not running on this node: only the agent’s user was tested.' : r.server_probe}</div> : null}</div>;
}

/** Who writes there: the agent and the PostgreSQL server (archive_command), as each check saw them. */
function Writers({ id }: { id: any }) {
  const a = id.agent || {}; const s = id.server;
  return <div className="small muted">Directory owned by <span className="mono">{id.dir_owner}:{id.dir_group}</span> ({id.dir_mode}{id.acl ? ', ACL' : ''}) · the agent writes as <span className="mono">{a.user}</span> (uid {a.uid}){s ? <> · PostgreSQL (archive_command) writes as <span className="mono">{s.user}</span> (uid {s.uid}){s.user !== a.user ? ' — different users: a common group is needed' : ''}</> : null}</div>;
}

/** The location the backups and WAL were in before the last change: still read by restores until migrated; migrate in the background or delete. */
function PreviousLocation({ cluster, d }: { cluster: SCluster; d: any }) {
  const prev = d.previous || {}; const repo: any[] = prev.repo || []; const wal: any[] = prev.wal || [];
  const PL = `prevloc:${cluster.id}`;
  const plan = useOpRunner(cluster.id, undefined, PL + ':plan'); const mig = useOpRunner(cluster.id, () => { revalidate(`/api/clusters/${encodeURIComponent(cluster.id)}/destination`); }, PL + ':mig'); const drop = useOpRunner(cluster.id, undefined, PL + ':drop');
  const [mb, setMb] = useDraft(PL + ':mb', ''); const [ask, setAsk] = useState(false); const [askDrop, setAskDrop] = useState(false); const [abandon, setAbandon] = useState(false);
  const [src0, setSrc0] = useDraft<any>(PL + ':src', null);              // the location being worked on: the agent stops reporting it once migrated or deleted
  const src = src0 || { ...(repo[0] ? { source_repo: repo[0].path } : {}), ...(wal[0] ? { source_wal: wal[0].path } : {}) };
  if (!repo.length && !wal.length && !mig.op && !drop.op) return null;
  const p = plan.op?.status === 'succeeded' ? plan.op.result : null;
  const gib = (b: number) => bytes(b);
  return <Card title="Previous location"><div className="stack">
    <p className="small">After the last destination change, the existing backups and WAL stayed here. Restores still read them (including a PITR that spans the change), but nothing new is written to this location.</p>
    {!repo.length && !wal.length ? <p className="small muted">Restores no longer use the previous location.</p> : null}
    <dl className="kv">{repo.map(x => <Fragment key={x.path}><dt>Repository</dt><dd className="mono">{x.path} {x.readable ? null : <Badge kind="bad">unreachable</Badge>}</dd></Fragment>)}
      {wal.map(x => <Fragment key={x.path}><dt>WAL archive</dt><dd className="mono">{x.path} {x.readable ? null : <Badge kind="bad">unreachable</Badge>}</dd></Fragment>)}</dl>
    <div className="row wrap gap-s"><Button icon="search" busy={plan.busy} onClick={() => plan.run('destination_migrate', { ...src, dry_run: true })}>Work out what to move</Button></div>
    {plan.op && !p ? <OpPanel op={plan.op} error={plan.error} label="Migration plan" /> : plan.error ? <Banner kind="bad">{plan.error}</Banner> : null}
    {p ? <div className="stack">
      {p.nothing_to_do ? <Banner kind="ok" title="Nothing to move">Everything needed is already in the new destination: restores no longer need the previous location.</Banner> : <>
        <table className="t"><tbody>
          <tr><td>Backups to move</td><td className="num">{p.sets.length} ({p.sets.filter((x: any) => x.type === 'full').length} full)</td></tr>
          <tr><td>Backup chunks</td><td className="num">{num(p.chunks)} · {gib(p.chunk_bytes + p.set_bytes)}</td></tr>
          <tr><td>WAL files</td><td className="num">{num(p.wal_files)} · {gib(p.wal_bytes)}</td></tr>
          <tr><td><strong>Total to copy</strong></td><td className="num"><strong>{gib(p.total_bytes)}</strong></td></tr>
          {p.source_usage_bytes != null ? <tr><td>Current usage of the previous location</td><td className="num">{gib((p.source_usage_bytes || 0) + (p.source_wal_usage_bytes || 0))}</td></tr> : null}
          {(p.space || []).map((sp: any) => <tr key={sp.path}><td>Free space on the new one (<span className="mono">{sp.path}</span>)</td><td className="num">{gib(sp.free_bytes)} of {gib(sp.total_bytes)} · about {gib(Math.max(0, sp.free_bytes - p.total_bytes))} after the copy</td></tr>)}
          {p.estimated_seconds ? <tr><td>Estimated duration</td><td className="num">about {p.estimated_seconds >= 120 ? `${Math.round(p.estimated_seconds / 60)} minutes` : `${p.estimated_seconds} seconds`} (measured write speed {p.write_mb_s} MB/s)</td></tr> : null}
        </tbody></table>
        <CheckList checks={p.checks} />
        <div className="row wrap gap-s" style={{ alignItems: 'flex-end' }}><Field label="Bandwidth limit (MB/s, empty = none)"><input className="input" style={{ width: 120 }} value={mb} onChange={e => setMb(e.target.value.replace(/[^0-9.]/g, ''))} /></Field>
          <Button kind="primary" icon="zap" disabled={!p.ok || mig.busy} busy={mig.busy} onClick={() => setAsk(true)}>Start the migration in the background</Button></div>
        <p className="small muted">Verified copy (every file is read back and compared), resumable: if interrupted, running it again continues where it was. Backups keep running in the meantime. The previous location is not deleted.</p></>}
    </div> : null}
    {mig.op || mig.error ? <OpPanel op={mig.op} error={mig.error} cancel={mig.cancel} label="Backup migration" /> : null}
    {mig.op?.status === 'succeeded' ? <Banner kind={mig.op.result.complete ? 'ok' : 'warn'} title={mig.op.result.complete ? 'Migration completed' : 'Partial migration'}>
      {num(mig.op.result.copied.sets)} backups, {num(mig.op.result.copied.chunks)} chunks and {num(mig.op.result.copied.wal)} WAL files copied and verified in {Math.round(mig.op.result.seconds)} s. {mig.op.result.complete ? 'Restores no longer use the previous location.' : `Left: ${mig.op.result.left.sets.length} backups, ${mig.op.result.left.wal_files} WAL files.`}</Banner> : null}
    <div className="hr" />
    <div className="row wrap gap-s"><Button kind="danger" icon="trash" busy={drop.busy} onClick={() => setAskDrop(true)}>Delete the previous location…</Button>
      <span className="small muted">Only this cluster’s data; refused while something exists only there and until the new destination has a full backup.</span></div>
    {drop.op || drop.error ? <OpPanel op={drop.op} error={drop.error} label="Deleting the previous location" /> : null}
    {ask ? <Confirm title="Start the migration?" confirmLabel="Start" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); setSrc0(src); mig.run('destination_migrate', { ...src, ...(mb ? { throttle_mb_s: Number(mb) } : {}) }); }}>
      <p>Copies {p ? gib(p.total_bytes) : ''} to the new destination, in the background{mb ? `, at most ${mb} MB/s` : ''}. You can cancel and resume it.</p></Confirm> : null}
    {askDrop ? <Confirm title="Delete the backups from the previous location?" danger requireText="DELETE" confirmLabel="Delete" onClose={() => setAskDrop(false)} onConfirm={() => { setAskDrop(false); setSrc0(src); drop.run('destination_drop_old', { ...src, confirm: 'DELETE', ...(abandon ? { abandon: true } : {}) }); }}>
      <p>The backups and WAL of <strong>{cluster.name}</strong> in {[repo[0]?.path, wal[0]?.path].filter(Boolean).join(' and ')} are deleted. There is no way back.</p>
      <label className="check"><input type="checkbox" checked={abandon} onChange={e => setAbandon(e.target.checked)} />Even if something was not migrated (the restore history it holds is lost)</label></Confirm> : null}
  </div></Card>;
}

function DestinationModal({ cluster, onClose }: { cluster: SCluster; onClose: () => void }) {
  const url = `/api/clusters/${encodeURIComponent(cluster.id)}/destination`;
  const q = useQuery<any>(url, { interval: 3000 });
  const [busy, setBusy] = useState(''); const [err, setErr] = useState<string | null>(null); const [bench, setBench] = useDraft(`dest:${cluster.id}:bench`, false); const [ops, setOps] = useDraft<any[]>(`dest:${cluster.id}:ops`, []); const [done, setDone] = useDraft<any>(`dest:${cluster.id}:done`, null);
  const lastD = useRef<any>(null);
  if (q.data) lastD.current = q.data;
  const d = q.data || lastD.current;            // a reload must not unmount the panels below (a running migration and its outcome live in them)
  const act = async (what: 'check' | 'apply') => {
    setBusy(what); setErr(null);
    try { const r = await api<any>('POST', `${url}/${what}`, what === 'check' ? { bench } : {}, { key: `dst-${what}-${cluster.id}-${Date.now()}` }); if (what === 'check') { setOps(r.operations); setDone(null); } else setDone(r); revalidate(url); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(''); }
  };
  const nodes: any[] = d?.nodes || []; const online = nodes.filter(n => n.online);
  const allOk = !!d?.destination && online.length > 0 && online.every(n => d.checks?.[n.id]?.ok === true && d.checks[n.id].fresh);
  return <Modal wide title={`Backup destination — ${cluster.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Close</Button></>}>
    {!d ? <Skeleton h={80} /> : !d.destination ? <div className="stack">
      {d.current?.repo ? <Banner kind="info" title="Destination set on the node">The cluster writes to <code>{d.current.repo}</code> (WAL to <code>{d.current.wal || '—'}</code>), from the agent configuration. To manage it from the console, set a path for this cluster, its environment, a folder or all clusters: then check and apply it from here.</Banner>
        : <Banner kind="warn" title="No destination configured">Set a path at the global, environment, folder or cluster level.</Banner>}
      <PreviousLocation cluster={cluster} d={d} /></div> : <div className="stack">
      <dl className="kv"><dt>Type</dt><dd>{TYPE_LABEL[d.destination.type]}</dd>{d.destination.repo_path ? <><dt>Repository</dt><dd className="mono">{d.destination.repo_path}</dd></> : null}{d.destination.wal_path ? <><dt>WAL archive</dt><dd className="mono">{d.destination.wal_path}</dd></> : null}
        <dt>Mount required</dt><dd>{d.destination.require_mount ? 'yes' : 'no'}</dd>{d.destination.min_free_gb ? <><dt>Minimum space</dt><dd>{d.destination.min_free_gb} GiB</dd></> : null}</dl>
      {d.destination.wal_shared_warning ? <Banner kind="warn" title="Shared WAL archive">{d.destination.wal_shared_warning}</Banner> : null}
      {d.destination.wal_collision ? <Banner kind="bad" title="WAL archive conflicts with another cluster">{d.destination.wal_collision}</Banner> : null}
      <div className="stack"><strong>Nodes</strong>{nodes.map(n => { const c = d.checks?.[n.id]; const op = ops.find(o => o.nodeId === n.id)?.operation?.id || c?.opId;
        return <Card key={n.id} title={<span className="row gap-s">{n.name}{n.online ? null : <Badge kind="warn">offline</Badge>}{c ? (c.ok === true ? <Badge kind="ok">check passed {ago(c.at)}</Badge> : c.ok === false ? <Badge kind="bad">check failed</Badge> : <Badge>running</Badge>) : <Badge>never checked</Badge>}{c && !c.fresh && c.ok ? <Badge kind="warn">stale: run again</Badge> : null}</span>}>
          {op ? <NodeCheck opId={op} /> : <p className="small muted">No check for this destination yet.</p>}</Card>; })}</div>
      <div className="row wrap gap-s"><Button icon="check" busy={busy === 'check'} disabled={!!busy || !online.length} onClick={() => act('check')}>Check on all nodes</Button>
        <label className="check"><input type="checkbox" checked={bench} onChange={e => setBench(e.target.checked)} />Also measure write throughput (writes 32 MiB)</label></div>
      <div className="hr" />
      {d.current ? <dl className="kv"><dt>In use now</dt><dd><span className="mono">{d.current.repo || '—'}</span> · WAL <span className="mono">{d.current.wal || '—'}</span></dd></dl> : null}
      <Banner kind="info" title="Applying the destination">Sets the repository and WAL archive on every node’s agent. On the primary, pg_arca immediately checks that the next WAL segment lands in the new directory; if it does not, it switches back to the previous one by itself and says so. Existing backups stay readable in the previous location (including for a PITR spanning the change) and you can migrate them in the background. The new destination starts with a full backup. In a protected environment a second administrator must approve.</Banner>
      <div><Button kind="primary" icon="zap" busy={busy === 'apply'} disabled={!allOk || !!busy} onClick={() => act('apply')}>Apply to the nodes</Button>{!allOk ? <span className="small muted"> Every node needs a recent passed check.</span> : null}</div>
      {done ? (done.approval ? <Banner kind="info" title="Awaiting approval">A destination change in this environment requires approval from another administrator (Today page). It is applied as soon as it is approved.</Banner>
        : <Banner kind="ok" title="Apply started">{done.operations.length} operations sent to the nodes (see the Activity panel). {done.note}</Banner>) : null}
      {err ? <Banner kind="bad">{err}</Banner> : null}
      <PreviousLocation cluster={cluster} d={d} /></div>}
  </Modal>;
}

/* ---------------------------------------------------------------------------------------------------------------------- page */
function ScopedTab({ kind }: { kind: 'ephemeral' | 'destination' }) {
  const ui = KINDS[kind]; const q = useQuery<SView>(`/api/scoped/${kind}`, { interval: 8000 });
  const [dlg, setDlg] = useDraft<{ scope: Scope; k: string; label: string } | null>(`infra:${kind}:dlg`, null); const [pre, setPre] = useDraft<SCluster | null>(`infra:${kind}:pre`, null);
  const v = q.data;
  const eff = (c: SCluster) => c.effective.value;
  const used = useMemo(() => new Set(Object.values(v?.assignments || {}).flatMap(a => Object.keys(a))), [v]);
  if (!v) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const line = (scope: Scope, k: string, title: string, sub?: string) => { const a = v.assignments[scopeKey(scope, k)]; return <tr key={scopeKey(scope, k)}>
    <td><strong>{title}</strong>{sub ? <div className="small muted">{sub}</div> : null}</td>
    <td>{a ? <div className="row wrap gap-s">{Object.keys(a).filter(f => f !== 'portMax').map(f => <Badge key={f} kind="accent" title={f === 'portMin' ? `${a.portMin}–${a.portMax}` : f === 'centralNode' ? (v.nodes.find(n => n.id === a[f])?.name || a[f]) : JSON.stringify(a[f])}>{f === 'centralNode' ? `Node: ${v.nodes.find(n => n.id === a[f])?.name || '?'}` : f === 'placement' ? (a[f] === 'central' ? 'On a central node' : 'On the cluster node') : ui.labels[f] || f}</Badge>)}</div> : <span className="muted">Inherits</span>}</td>
    <td className="num"><Button sm onClick={() => setDlg({ scope, k, label: title })}>Edit</Button></td></tr>; };
  return <div className="stack-l">
    <p className="sub" style={{ margin: 0, maxWidth: 820 }}>{ui.intro}</p>
    <Card title="Levels" pad={false}><div className="tablewrap"><table className="t"><thead><tr><th>Level</th><th>What it sets</th><th /></tr></thead><tbody>
      {line('global', '', 'All clusters', 'Fallback value')}
      {ENVS.map(e => line('env', e, `Environment: ${ENV_LABEL[e]}`, `${v.clusters.filter(c => c.environment === e).length} cluster`))}
      {v.folders.map(f => line('folder', f, `Folder: ${f}`, `${v.clusters.filter(c => c.folder === f || c.folder.startsWith(f + '/')).length} cluster`))}</tbody></table></div></Card>
    <Card title="Cluster" pad={false}>{!v.clusters.length ? <div style={{ padding: 16 }} className="muted">No connected clusters.</div> : <div className="tablewrap"><table className="t"><thead><tr><th>Cluster</th><th>In effect</th><th /></tr></thead><tbody>
      {v.clusters.map(c => <tr key={c.id}><td><strong>{c.name}</strong><div className="small muted">{c.environment}{c.folder ? ` · ${c.folder}` : ''}</div></td>
        <td><div>{ui.summary(eff(c))}</div><div className="small muted">{ui.fields.filter(f => c.effective.sources[f] && c.effective.sources[f].scope !== 'default' && eff(c)[f] !== undefined).map(f => `${ui.labels[f]}: ${srcText(c.effective.sources[f])}`).join(' · ') || 'defaults'}</div></td>
        <td className="num"><div className="row gap-s" style={{ justifyContent: 'flex-end' }}><Button sm onClick={() => setDlg({ scope: 'cluster', k: c.id, label: c.name })}>Edit</Button>
          <Button sm icon={kind === 'ephemeral' ? 'search' : 'check'} disabled={c.source === 'direct'} title={c.source === 'direct' ? 'Needs the agent on the cluster' : undefined} onClick={() => setPre(c)}>{kind === 'ephemeral' ? 'Verify' : 'Check and apply'}</Button></div></td></tr>)}</tbody></table></div>}</Card>
    {dlg ? <ScopeDialog kind={kind} scope={dlg.scope} k={dlg.k} label={dlg.label} view={v} onClose={() => setDlg(null)} /> : null}
    {pre ? (kind === 'ephemeral' ? <PreflightModal cluster={pre} onClose={() => setPre(null)} /> : <DestinationModal cluster={pre} onClose={() => setPre(null)} />) : null}
  </div>;
}

export function InfraPage({ tab }: { tab?: string }) {
  const t: 'ephemeral' | 'destination' = tab === 'destination' ? 'destination' : 'ephemeral';
  return <>
    <div className="pagehead"><div className="grow"><h1>Recovery & storage</h1><p className="sub">Where recoveries run and where backups are written: once for everything, then exceptions per environment, folder or cluster.</p></div></div>
    <Tabs value={t} onChange={v => go(`infra/${v}`)} items={[{ id: 'ephemeral', label: 'Recovery instance', icon: 'restore' }, { id: 'destination', label: 'Backup destination', icon: 'server' }]} />
    <div style={{ marginTop: 16 }}><ScopedTab kind={t} key={t} /></div></>;
}

/* ---------------------------------------------------------------------------------------------------------------------- in-context editors (restore plan, backup page) */
/** The same dialogs as this page, opened from another screen for ONE cluster: change where it recovers / where it writes backups without losing the wizard. */
function WithCluster({ kind, clusterId, onClose, children }: { kind: 'ephemeral' | 'destination'; clusterId: string; onClose: () => void; children: (v: SView, c: SCluster) => React.ReactNode }) {
  const q = useQuery<SView>(`/api/scoped/${kind}`);
  const c = q.data?.clusters.find(x => x.id === clusterId);
  if (!q.data || !c) return <Modal title="Loading…" onClose={onClose}><Skeleton h={120} /></Modal>;
  return <>{children(q.data, c)}</>;
}
const closeAnd = (clusterId: string, onClose: () => void) => () => { revalidate(`/api/clusters/${clusterId}/placement`); onClose(); };
export const ClusterScopeEditor = ({ kind, clusterId, onClose }: { kind: 'ephemeral' | 'destination'; clusterId: string; onClose: () => void }) =>
  <WithCluster kind={kind} clusterId={clusterId} onClose={onClose}>{(v, c) => <ScopeDialog kind={kind} scope="cluster" k={c.id} label={c.name} view={v} onClose={closeAnd(clusterId, onClose)} />}</WithCluster>;
export const ClusterDestinationCheck = ({ clusterId, onClose }: { clusterId: string; onClose: () => void }) =>
  <WithCluster kind="destination" clusterId={clusterId} onClose={onClose}>{(_v, c) => <DestinationModal cluster={c} onClose={closeAnd(clusterId, onClose)} />}</WithCluster>;
export const ClusterEphemeralCheck = ({ clusterId, onClose }: { clusterId: string; onClose: () => void }) =>
  <WithCluster kind="ephemeral" clusterId={clusterId} onClose={onClose}>{(_v, c) => <PreflightModal cluster={c} onClose={closeAnd(clusterId, onClose)} />}</WithCluster>;
export { srcText as scopeSourceText };
