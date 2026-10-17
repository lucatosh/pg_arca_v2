import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, CopyBlock, Field, Icon, Modal, Skeleton } from '../ui';
import { clearDrafts, revalidate, toast, useDraft, useOpRunner, useQuery } from '../hooks';
import { OpPanel } from './shared';
import { go } from '../router';
import { ClusterDestinationCheck, DestPaths } from './Infra';

/* ====================================================================================================================================================
 * "Configure backup storage": the guided sequence an administrator follows to decide WHERE a cluster (or an environment, a folder, every cluster)
 * keeps its backups and WAL archive. Three answers, each with what it really implies:
 *   - a backup server: a worker host with the "Backup server" role, exporting a folder over NFS (or SMB) that every database node mounts;
 *     the check on the nodes proves the share really comes from THAT server;
 *   - a network share that already exists (NAS, storage array), mounted on every node;
 *   - the local disk of each node (single-node clusters, labs: each node keeps its own copy).
 * Locations are configuration details: they are shown here, to administrators, and on request elsewhere ("Show locations").
 * Saving changes the configuration only: the nodes switch after the per-node check and "Apply" (DestinationModal), as before.
 * ==================================================================================================================================================== */

type Where = 'server' | 'share' | 'local';
type Proto = 'nfs' | 'smb';
interface Worker { id: string; name: string; label: string; roles: string[]; online: boolean; remoteIp?: string; address?: string }
interface SView { assignments: Record<string, Record<string, any>>; folders: string[]; clusters: { id: string; name: string; environment: string; folder: string }[] }

const ENV_LABEL: Record<string, string> = { prod: 'Production', prep: 'Pre-production', int: 'Integration', dev: 'Development', test: 'Test' };
const STEPS = ['Where', 'Details', 'Applies to', 'Review'];
const abs = (p: string) => /^\/[^\0]*$/.test(p) && !p.split('/').includes('..');
const clean = (p: string) => (p || '').trim().replace(/\/+$/, '') || '/';
const hostOf = (w?: Worker) => (w ? (w.address || w.remoteIp || w.name).replace(/^::ffff:/, '') : '<server>');

/** The commands that make the backup server's folder appear on every node at the same path. pg_arca runs none of them: mounting is the system's job.
 *  The folder belongs to the uid/gid PostgreSQL has on the database nodes (the same on every node): files then show the same owner everywhere,
 *  which the node check requires (the agent and PostgreSQL must see each other's files the same way). No squashing of ordinary users. */
function shareCommands(proto: Proto, w: Worker | undefined, serverPath: string, mountPoint: string, owner: string) {
  const host = hostOf(w); const name = w?.name || 'the backup server';
  const [uid, gid] = /^\d+:\d+$/.test(owner) ? owner.split(':') : ['<uid>', '<gid>'];
  return proto === 'nfs'
    ? { server: `# on ${name}, as root: the folder, owned by PostgreSQL's uid:gid on the database nodes, and its export
mkdir -p ${serverPath} && chown ${uid}:${gid} ${serverPath} && chmod 0750 ${serverPath}
echo '${serverPath}  <database-nodes-network>/24(rw,sync,no_subtree_check)' >> /etc/exports
exportfs -ra`,
      nodes: `# on EVERY database node, as root: the same mount point everywhere, mounted at boot
mkdir -p ${mountPoint}
echo '${host}:${serverPath}  ${mountPoint}  nfs  hard,noatime,_netdev  0 0' >> /etc/fstab
mount ${mountPoint}` }
    : { server: `# on ${name}: share ${serverPath} as [pgarca] (Samba: path = ${serverPath}, read only = no, force user = the owner of the folder).
# The WAL archive publishes every segment with a hard link: Samba and Windows NTFS shares support them, Azure Files does not (the node check tests it).`,
      nodes: `# on EVERY database node, as root (credentials file readable by root only)
mkdir -p ${mountPoint}
echo '//${host}/pgarca  ${mountPoint}  cifs  credentials=/etc/pgarca-smb.cred,uid=${uid},gid=${gid},file_mode=0640,dir_mode=0750,_netdev  0 0' >> /etc/fstab
mount ${mountPoint}` };
}

export function StorageWizard({ clusterId, onClose }: { clusterId?: string; onClose: () => void }) {
  const K = `storagewiz:${clusterId || '-'}`;
  const workers = useQuery<{ workers: Worker[] }>('/api/workers');
  const view = useQuery<SView>('/api/scoped/destination');
  const servers = (workers.data?.workers || []).filter(w => w.roles.includes('repository'));
  const cluster = view.data?.clusters.find(c => c.id === clusterId);

  const [step, setStep] = useDraft(K + ':step', 0);
  const [where, setWhere] = useDraft<Where | ''>(K + ':where', '');
  const [serverId, setServerId] = useDraft(K + ':server', '');
  const [proto, setProto] = useDraft<Proto>(K + ':proto', 'nfs');
  const [serverPath, setServerPath] = useDraft(K + ':spath', '/srv/pgarca');
  const [mountPoint, setMountPoint] = useDraft(K + ':mnt', '/mnt/pgarca');
  const [localRoot, setLocalRoot] = useDraft(K + ':local', '/var/lib/pgarca');
  const [dedicated, setDedicated] = useDraft(K + ':dedicated', false);
  const [custom, setCustom] = useDraft<{ repo?: string; wal?: string }>(K + ':custom', {});
  const [minFree, setMinFree] = useDraft<number | ''>(K + ':minfree', '');
  const [owner, setOwner] = useDraft(K + ':owner', '');
  const [scope, setScope] = useDraft(K + ':scope', clusterId ? `cluster:${clusterId}` : 'global');
  const [saved, setSaved] = useDraft(K + ':saved', false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [apply, setApply] = useState(false);
  const srv = servers.find(w => w.id === serverId);
  const chk = useOpRunner(`worker:${serverId || '-'}`, undefined, serverId ? `${K}:srvcheck:${serverId}` : undefined);

  const base = where === 'local' ? clean(localRoot) : clean(mountPoint);
  const repoPath = custom.repo ?? `${base}/repo`;
  const walPath = custom.wal ?? `${base}/wal/{env}/{cluster}`;
  const value = useMemo(() => ({
    type: where === 'local' ? 'local' : proto, repoPath: clean(repoPath), walPath: clean(walPath), requireMount: where === 'local' ? dedicated : true,
    ...(minFree !== '' && minFree > 0 ? { minFreeGb: minFree } : {}),
    ...(where === 'server' && serverId ? { server: serverId, serverPath: clean(serverPath) } : {}),
  }), [where, proto, repoPath, walPath, dedicated, minFree, serverId, serverPath]);

  const [sc, sk] = scope === 'global' ? ['global', ''] : (scope.split(/:(.*)/s) as [string, string]);
  const affected = (view.data?.clusters || []).filter(c => sc === 'global' || (sc === 'env' && c.environment === sk) || (sc === 'cluster' && c.id === sk) || (sc === 'folder' && (c.folder === sk || c.folder.startsWith(sk + '/'))));
  const scopeText = sc === 'global' ? 'all clusters' : sc === 'env' ? `the ${ENV_LABEL[sk] || sk} environment` : sc === 'folder' ? `folder ${sk}` : `cluster ${cluster?.name || sk}`;
  const walOk = /\{(cluster|id)\}/.test(walPath) || sc === 'cluster';

  const detailsOk = where === 'server' ? !!srv && abs(serverPath) && abs(mountPoint) && clean(mountPoint) !== '/'
    : where === 'share' ? abs(mountPoint) && clean(mountPoint) !== '/' : abs(localRoot);
  const pathsOk = abs(repoPath) && abs(walPath) && clean(repoPath) !== clean(walPath) && walOk;
  const reachable = (i: number) => i === 0 || (i >= 1 && !!where && (i < 2 || (detailsOk && pathsOk)));

  const close = () => { clearDrafts(K); onClose(); };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api('PUT', '/api/scoped/destination/assignments', { scope: sc, key: sk, value });
      revalidate('/api/scoped/destination'); if (clusterId) { revalidate(`/api/clusters/${clusterId}/placement`); revalidate(`/api/clusters/${clusterId}/storage`); }
      setSaved(true); toast(`Backup storage saved for ${scopeText}`, 'ok');
    } catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };

  if (apply && clusterId) return <ClusterDestinationCheck clusterId={clusterId} onClose={close} />;
  const loading = !workers.data || !view.data;
  const next = <Button kind="primary" disabled={!reachable(step + 1)} onClick={() => setStep(step + 1)}>Continue</Button>;
  const footer = saved
    ? <><div className="grow" /><Button onClick={close}>Close</Button>
      {clusterId && affected.some(c => c.id === clusterId) ? <Button kind="primary" icon="check" onClick={() => setApply(true)}>Check and apply on the nodes</Button>
        : <Button kind="primary" onClick={() => { close(); go('infra/destination'); }}>Check and apply per cluster</Button>}</>
    : <>{step > 0 ? <Button kind="ghost" onClick={() => setStep(step - 1)}>Back</Button> : null}<div className="grow" /><Button onClick={close}>Cancel</Button>
      {step < 3 ? next : <Button kind="primary" busy={busy} disabled={!pathsOk || !detailsOk} onClick={save}>Save</Button>}</>;

  return <Modal wide title={`Configure backup storage${cluster ? ` — ${cluster.name}` : ''}`} onClose={close} footer={footer}>
    {loading ? <Skeleton h={160} /> : <div className="stack">
      <div className="steps" role="tablist" aria-label="Steps">{STEPS.map((s, i) => <button key={s} type="button" role="tab" aria-selected={i === step} disabled={saved || !reachable(i)} onClick={() => setStep(i)}
        className={`s ${i === step ? 'on' : i < step ? 'done' : ''}`}>{i < step ? <Icon n="check" s={14} /> : null}{s}</button>)}</div>

      {step === 0 ? <div className="stack">
        <p className="muted">Where should the backups (the repository) and the WAL archive live? Every node of a cluster must reach the same storage: after a switchover or a failover the new primary continues the same backup history and archive.</p>
        <div className="grid choices">
          <button className="choice" aria-pressed={where === 'server'} onClick={() => setWhere('server')}><Icon n="server" s={22} /><div><strong>A backup server</strong>
            <p className="sub">A machine you enrolled as a worker host with the Backup server role. It exports a folder over NFS or SMB; every database node mounts it. {servers.length ? `${servers.length} available.` : 'None yet.'}</p></div></button>
          <button className="choice" aria-pressed={where === 'share'} onClick={() => setWhere('share')}><Icon n="layers" s={22} /><div><strong>An existing network share</strong>
            <p className="sub">A NAS or storage array share (NFS or SMB) that is, or will be, mounted at the same path on every database node.</p></div></button>
          <button className="choice" aria-pressed={where === 'local'} onClick={() => setWhere('local')}><Icon n="hdd" s={22} /><div><strong>The local disk of each node</strong>
            <p className="sub">Each node keeps its own copy. Suitable for single-node clusters and test systems; a disk failure loses data and backups together.</p></div></button>
        </div>
      </div> : null}

      {step === 1 && where === 'server' ? <div className="stack">
        {!servers.length ? <Banner kind="warn" title="No backup server yet" actions={<Button sm onClick={() => { close(); go('workers'); }}>Worker hosts</Button>}>
          Install the agent on the machine that will hold the backups (as a worker host), then give it the <strong>Backup server</strong> role from its page (Name and roles). It appears here as soon as it reports.</Banner>
          : <Field label="Backup server"><div className="grid choices">{servers.map(w => <button key={w.id} className="choice" aria-pressed={serverId === w.id} onClick={() => setServerId(w.id)}>
            <Icon n="server" s={20} /><div><strong>{w.name}</strong> {w.online ? <Badge kind="ok">online</Badge> : <Badge kind="bad">offline</Badge>}<p className="sub">{w.label || 'Backup server'}</p></div></button>)}</div></Field>}
        {srv ? <>
          <Field label="Protocol"><div className="seg">{(['nfs', 'smb'] as const).map(p => <button key={p} aria-pressed={proto === p} onClick={() => setProto(p)}>{p === 'nfs' ? 'NFS' : 'SMB/CIFS'}</button>)}</div></Field>
          <div className="grid g2">
            <Field label={`Folder on ${srv.name}`} hint="Where the files physically live on the backup server." error={abs(serverPath) ? null : 'Absolute path required'}>
              <input className="input mono" value={serverPath} onChange={e => setServerPath(e.target.value)} /></Field>
            <Field label="Mount point on the database nodes" hint="The same path on every node; backups are refused if the share is not mounted there." error={abs(mountPoint) && clean(mountPoint) !== '/' ? null : 'An absolute path other than /'}>
              <input className="input mono" value={mountPoint} onChange={e => setMountPoint(e.target.value)} /></Field></div>
          <div className="row wrap"><Button sm icon="search" busy={chk.busy} disabled={!srv.online || !abs(serverPath)}
            onClick={() => chk.run('destination_check', { type: 'local', repo_path: `${clean(serverPath)}/repo`, wal_path: `${clean(serverPath)}/wal`, require_mount: false })}>Check the folder on {srv.name}</Button>
            <span className="small muted">Writes and removes one small file; creates the folder if its parent exists.</span></div>
          {chk.op && chk.op.status !== 'succeeded' ? <OpPanel op={chk.op} error={chk.error} /> : null}
          {chk.op?.status === 'succeeded' ? <><Banner kind={chk.op.result?.ok ? 'ok' : 'bad'} title={chk.op.result?.ok ? `The folder on ${srv.name} is usable` : 'The folder is not usable yet: each problem below has its remedy'} /><DestPaths r={chk.op.result} /></> : null}
          <details open><summary className="small" style={{ cursor: 'pointer' }}>Commands: export the folder and mount it on the nodes</summary><div className="stack" style={{ marginTop: 8 }}>
            <Field label="Owner of the files: PostgreSQL's uid:gid on the database nodes" hint="Run “id postgres” on a node. It must be the same on every node; the commands below use it." error={!owner || /^\d+:\d+$/.test(owner) ? null : 'Format uid:gid, e.g. 26:26'}>
              <input className="input mono" style={{ maxWidth: 160 }} value={owner} placeholder="26:26" onChange={e => setOwner(e.target.value.trim())} /></Field>
            {(() => { const c = shareCommands(proto, srv, clean(serverPath), clean(mountPoint), owner); return <><CopyBlock text={c.server} /><CopyBlock text={c.nodes} /></>; })()}
            <p className="small muted">pg_arca never mounts anything itself. The check on the nodes (after saving) proves that the path is mounted from {srv.name} and writable the way the engine writes.</p></div></details>
        </> : null}
      </div> : null}

      {step === 1 && where === 'share' ? <div className="stack">
        <Field label="Protocol"><div className="seg">{(['nfs', 'smb'] as const).map(p => <button key={p} aria-pressed={proto === p} onClick={() => setProto(p)}>{p === 'nfs' ? 'NFS' : 'SMB/CIFS'}</button>)}</div></Field>
        <Field label="Mount point on the database nodes" hint="Where the share is mounted, at the same path on every node. Backups are refused when the share is not mounted there, so they can never fill a local disk by mistake."
          error={abs(mountPoint) && clean(mountPoint) !== '/' ? null : 'An absolute path other than /'}><input className="input mono" value={mountPoint} onChange={e => setMountPoint(e.target.value)} /></Field>
        <details><summary className="small" style={{ cursor: 'pointer' }}>Mount command for the nodes</summary>
          <CopyBlock text={shareCommands(proto, undefined, '<exported path>', clean(mountPoint), '').nodes.replace('<server>', '<nas>')} /></details>
      </div> : null}

      {step === 1 && where === 'local' ? <div className="stack">
        <Field label="Directory on each node" error={abs(localRoot) ? null : 'Absolute path required'}><input className="input mono" value={localRoot} onChange={e => setLocalRoot(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={dedicated} onChange={e => setDedicated(e.target.checked)} />It is a dedicated disk mounted there (recommended): refuse the path if it sits on the system disk</label>
        <Banner kind="warn" title="Each node keeps its own copy">With more than one node, the backups and WAL written by one node are not visible to the others: after a switchover the history is split between nodes and point-in-time recovery across it is not possible. Use a backup server or a network share for replicated clusters.</Banner>
      </div> : null}

      {step === 1 && where ? <details><summary className="small" style={{ cursor: 'pointer' }}>Advanced: exact directories and free-space threshold</summary><div className="grid g2" style={{ marginTop: 8 }}>
        <Field label="Repository (backups)" hint="Several clusters can share it: each one has its own space inside." error={abs(repoPath) ? null : 'Absolute path required'}>
          <input className="input mono" value={repoPath} onChange={e => setCustom({ ...custom, repo: e.target.value })} /></Field>
        <Field label="WAL archive" hint="One per cluster: keep {cluster} (or {id}) in the path. Placeholders: {cluster} {env} {id}." error={!abs(walPath) ? 'Absolute path required' : !walOk ? 'Include {cluster} or {id}: every cluster needs its own WAL archive' : clean(walPath) === clean(repoPath) ? 'Must differ from the repository' : null}>
          <input className="input mono" value={walPath} onChange={e => setCustom({ ...custom, wal: e.target.value })} /></Field>
        <Field label="Minimum free space (GiB)" hint="The node check fails below this."><input className="input" type="number" min={0} value={minFree} onChange={e => setMinFree(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
        <div className="row" style={{ alignItems: 'end' }}>{custom.repo !== undefined || custom.wal !== undefined ? <Button sm kind="ghost" onClick={() => setCustom({})}>Back to the suggested directories</Button> : null}</div></div></details> : null}

      {step === 2 ? <div className="stack">
        <p className="muted">Decide once for many clusters, then make exceptions: a value set for a cluster wins over its folder, which wins over its environment, which wins over all clusters.</p>
        <Field label="Apply this storage to"><select className="input" value={scope} onChange={e => setScope(e.target.value)}>
          {cluster ? <option value={`cluster:${cluster.id}`}>This cluster only ({cluster.name})</option> : null}
          {cluster ? <option value={`env:${cluster.environment}`}>Every cluster of the {ENV_LABEL[cluster.environment] || cluster.environment} environment</option>
            : Object.keys(ENV_LABEL).map(e => <option key={e} value={`env:${e}`}>Every cluster of the {ENV_LABEL[e]} environment</option>)}
          {(cluster ? (view.data!.folders.filter(f => cluster.folder === f || cluster.folder.startsWith(f + '/'))) : view.data!.folders).map(f => <option key={f} value={`folder:${f}`}>Every cluster in folder {f}</option>)}
          <option value="global">All clusters</option></select></Field>
        <p className="small">{affected.length ? <>Affects {affected.length === 1 ? '1 cluster' : `${affected.length} clusters`} (unless a more specific level sets its own): {affected.slice(0, 8).map(c => c.name).join(', ')}{affected.length > 8 ? '…' : ''}.</> : 'No cluster is in this level yet: it applies to the ones that join it.'}</p>
        {view.data!.assignments[scope] ? <Banner kind="info" title="This level already has a storage setting">Saving replaces it.</Banner> : null}
        {!walOk ? <Banner kind="bad" title="Shared WAL archive">The WAL directory has no {'{cluster}'} placeholder: clusters at this level would overwrite each other’s WAL. Fix it under Details → Advanced.</Banner> : null}
      </div> : null}

      {step === 3 ? <div className="stack">
        <dl className="kv">
          <dt>Storage</dt><dd>{where === 'server' ? <>Backup server <strong>{srv?.name}</strong> over {proto === 'nfs' ? 'NFS' : 'SMB/CIFS'}</> : where === 'share' ? `Network share (${proto === 'nfs' ? 'NFS' : 'SMB/CIFS'})` : 'Local disk of each node'}</dd>
          {where === 'server' ? <><dt>Folder on the server</dt><dd className="mono">{clean(serverPath)}</dd></> : null}
          {where !== 'local' ? <><dt>Mounted on the nodes at</dt><dd className="mono">{clean(mountPoint)}</dd></> : null}
          <dt>Repository</dt><dd className="mono">{clean(repoPath)}</dd>
          <dt>WAL archive</dt><dd className="mono">{clean(walPath)}</dd>
          <dt>Protection</dt><dd>{value.requireMount ? 'refused when the path is not on its own mounted filesystem' : 'none (any filesystem accepted)'}{value.minFreeGb ? ` · at least ${value.minFreeGb} GiB free` : ''}</dd>
          <dt>Applies to</dt><dd>{scopeText}</dd>
        </dl>
        {saved ? <Banner kind="ok" title="Saved">Nothing has changed on the nodes yet. Next: every node checks the new location (mount, server, write, space){clusterId ? '' : ' — per cluster, from Storage & recovery → Backup storage'}; then you apply it. Existing backups stay readable where they are and can be migrated in the background.</Banner>
          : <Banner kind="info" title="What saving does">It records the setting. The nodes keep writing where they write today until the location is checked on every node and applied; after that, the first backup in the new location is a full one.</Banner>}
        {err ? <Banner kind="bad">{err}</Banner> : null}
      </div> : null}
    </div>}
  </Modal>;
}
