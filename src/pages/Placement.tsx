import React, { useState } from 'react';
import { Badge, Button, Icon, bytes } from '../ui';
import { revalidate, useDraft, useQuery } from '../hooks';
import { StorageWizard } from './StorageWizard';
import { go } from '../router';
import { ClusterDestinationCheck, ClusterEphemeralCheck, ClusterScopeEditor, scopeSourceText } from './Infra';

/** What GET /api/clusters/:id/placement answers: where recoveries run and where backups are written for this cluster, with free space and the configuration level of each value. */
type Disk = { path: string; free_bytes: number; total_bytes: number; dev?: number } | null;
type Src = Record<string, { scope: string; key: string }>;
interface Placement {
  ephemeral: { placement: 'node' | 'central'; node: { id: string; name: string; online: boolean; role: string | null } | null; centralMissing: boolean; scratchDir: string; scratchDisk: Disk;
    scratchSharesData: boolean; binDir: string | null; sharedBuffersMb: number; keepOnFailure: boolean; sources: Src };
  backup: { repoPath: string | null; walPath: string | null; repoDisk: Disk; walDisk: Disk; dataDisk: Disk; configured: any; pending: boolean; type: string; sources: Src; node: { name: string } | null;
    previous?: { repo: string[]; wal: string[] }; migrating?: boolean };
}

const pctFree = (d: Disk) => (d && d.total_bytes ? Math.round((100 * d.free_bytes) / d.total_bytes) : null);

function DiskLine({ d, need }: { d: Disk; need?: number }) {
  if (!d) return <span className="small faint">space not reported by the agent yet</span>;
  const p = pctFree(d)!; const after = need != null ? d.free_bytes - need : null;
  const tone = after != null && after < 0 ? 'bad' : p < 10 ? 'warn' : 'ok';
  return <span className={`diskline ${tone}`}><span className="db" aria-hidden="true"><i style={{ width: `${100 - p}%` }} /></span><span className="small">{bytes(d.free_bytes)} free of {bytes(d.total_bytes)} ({p}%)</span></span>;
}
const from = (s: Src, f: string) => { const t = scopeSourceText(s?.[f]); return t === 'default' ? null : <span className="small faint"> · set for {t}</span>; };

/** "Where will this recovery happen?" — shown in the restore wizard before the operator starts, with a way to change it on the spot. */
export function RecoveryPlacement({ clusterId, compact }: { clusterId: string; compact?: boolean }) {
  const q = useQuery<Placement>(`/api/clusters/${encodeURIComponent(clusterId)}/placement`, { interval: 15000 });
  const [dlg, setDlg] = useDraft<'' | 'edit' | 'check'>(`placement:${clusterId}:rec`, '');
  const e = q.data?.ephemeral;
  if (!e) return null;
  return <div className={`placement ${compact ? 'compact' : ''}`} role="group" aria-label="Where restores run">
    <div className="ph"><Icon n="server" s={15} /><strong>Where restores run</strong><div className="grow" />
      <Button sm onClick={() => setDlg('check')} icon="search">Verify</Button><Button sm onClick={() => setDlg('edit')}>Change for this cluster</Button>
      <Button sm kind="ghost" onClick={() => go('infra/ephemeral')}>General settings</Button></div>
    <dl className="kv">
      <dt>Recovery host</dt><dd>{e.centralMissing ? <span style={{ color: 'var(--bad)' }}>the configured central recovery host no longer exists</span> : e.node ? <><strong>{e.node.name}</strong>{' '}
        {e.placement === 'central' ? <Badge kind="accent">central recovery host</Badge> : <Badge>{e.node.role === 'primary' ? 'cluster primary' : 'cluster node'}</Badge>}{!e.node.online ? <> <Badge kind="bad">offline</Badge></> : null}{from(e.sources, 'placement')}</> : '—'}</dd>
      <dt>Scratch directory</dt><dd><code>{e.scratchDir}</code>{from(e.sources, 'scratchDir')}<div><DiskLine d={e.scratchDisk} /></div>
        {e.scratchSharesData ? <div className="small" style={{ color: 'var(--warn)' }}>It is on the same disk as the cluster data: extraction and recovery consume production’s space and I/O. A separate volume is better.</div> : null}</dd>
      {!compact ? <><dt>PostgreSQL binaries</dt><dd>{e.binDir ? <code>{e.binDir}</code> : 'picked automatically for the backup’s version'}{from(e.sources, 'binDir')}</dd>
        <dt>Recovery instance memory</dt><dd>shared_buffers {e.sharedBuffersMb} MB{from(e.sources, 'sharedBuffersMb')}</dd></> : null}
    </dl>
    {dlg === 'edit' ? <ClusterScopeEditor kind="ephemeral" clusterId={clusterId} onClose={() => setDlg('')} /> : null}
    {dlg === 'check' ? <ClusterEphemeralCheck clusterId={clusterId} onClose={() => setDlg('')} /> : null}
  </div>;
}

/** GET /api/clusters/:id/storage: where each node really keeps backups and WAL. Paths and sources only for administrators. */
type Loc = { kind: 'backup_server' | 'worker_share' | 'network_share' | 'local_disk' | 'unknown'; fstype: string | null; server: { id: string; name: string; online: boolean } | null;
  freeBytes: number | null; totalBytes: number | null; sameDiskAsData: boolean; path?: string | null; mountpoint?: string | null; source?: string | null };
interface Storage { admin: boolean; nodes: { id: string; name: string; online: boolean; role: string | null; repo: Loc; wal: Loc }[]; repoSharing: 'single' | 'shared' | 'split' | 'unknown'; walSharing: Storage['repoSharing'];
  backupServers: { id: string; name: string; online: boolean }[]; configured: any; applied: any }

const FS = (f: string | null) => (f ? ({ nfs: 'NFS', nfs4: 'NFS v4', cifs: 'SMB/CIFS', smb3: 'SMB 3', smbfs: 'SMB' } as Record<string, string>)[f] || f : '');
function LocText({ l }: { l: Loc }) {
  switch (l.kind) {
    case 'backup_server': return <><Icon n="server" s={14} /> Backup server <strong>{l.server!.name}</strong>{l.server && !l.server.online ? <> <Badge kind="warn">offline</Badge></> : null} <span className="faint">· {FS(l.fstype)}</span></>;
    case 'worker_share': return <><Icon n="server" s={14} /> Share from worker host <strong>{l.server!.name}</strong> <span className="faint">· {FS(l.fstype)} (the host has no Backup server role)</span></>;
    case 'network_share': return <><Icon n="layers" s={14} /> Network share <span className="faint">· {FS(l.fstype)}</span></>;
    case 'local_disk': return <><Icon n="hdd" s={14} /> Local disk of the node <span className="faint">· {l.fstype}</span></>;
    default: return <span className="faint">not reported yet (agent update or first check-in pending)</span>;
  }
}
/** One-line answer for the card header: the same storage everywhere, or the mix. */
function summary(st: Storage): string {
  const ls = st.nodes.map(n => n.repo).filter(l => l.kind !== 'unknown');
  if (!ls.length) return 'not reported yet';
  const kinds = new Set(ls.map(l => l.kind + ':' + (l.server?.id || '')));
  if (kinds.size > 1) return 'different on each node';
  const l = ls[0];
  return l.kind === 'backup_server' ? `backup server ${l.server!.name}` : l.kind === 'worker_share' ? `share from ${l.server!.name}` : l.kind === 'network_share' ? `network share (${FS(l.fstype)})` : st.nodes.length > 1 ? 'local disk of each node' : 'local disk';
}

/** "Where do the backups of this cluster go?" — on the backup page: per node, in plain terms (backup server, share, local disk), whether all nodes share it,
 *  free space, the pending change. Directories are revealed on request, to administrators only; changing the storage is a guided sequence (StorageWizard). */
export function BackupPlacement({ clusterId }: { clusterId: string }) {
  const q = useQuery<Placement>(`/api/clusters/${encodeURIComponent(clusterId)}/placement`, { interval: 15000 });
  const sq = useQuery<Storage>(`/api/clusters/${encodeURIComponent(clusterId)}/storage`, { interval: 15000 });
  const [dlg, setDlg] = useDraft<'' | 'wizard' | 'apply'>(`placement:${clusterId}:bk`, '');
  const [show, setShow] = useState(false);
  const b = q.data?.backup; const st = sq.data;
  if (!b || !st) return null;
  const admin = st.admin;
  const splitText = st.repoSharing === 'split' || st.walSharing === 'split';
  const sameDisk = st.nodes.some(n => n.repo.sameDiskAsData);
  return <div className="placement" role="group" aria-label="Backup storage">
    <div className="ph"><Icon n="server" s={15} /><strong>Where the backups are stored</strong><span className="small muted">{summary(st)}</span><div className="grow" />
      {admin ? <><Button sm kind="ghost" icon={show ? 'lock' : 'eye'} aria-pressed={show} onClick={() => setShow(!show)}>{show ? 'Hide locations' : 'Show locations'}</Button>
        <Button sm icon="check" onClick={() => setDlg('apply')}>Check and apply</Button><Button sm kind="primary" onClick={() => setDlg('wizard')}>Configure…</Button></>
        : <span className="small faint" title="Directories, shares and server addresses are visible to administrators">locations visible to administrators</span>}</div>
    <div className="tablewrap"><table className="t small storage"><thead><tr><th>Node</th><th>Backups (repository)</th><th>WAL archive</th></tr></thead><tbody>
      {st.nodes.map(n => <tr key={n.id}><td><strong>{n.name}</strong>{n.role ? <div className="faint">{n.role}</div> : null}{!n.online ? <Badge kind="warn">offline</Badge> : null}</td>
        {(['repo', 'wal'] as const).map(w => { const l = n[w]; return <td key={w}><div className="row gap-s wrap">{<LocText l={l} />}</div>
          {l.totalBytes ? <div><DiskLine d={{ path: '', free_bytes: l.freeBytes || 0, total_bytes: l.totalBytes }} /></div> : null}
          {show && admin ? <div className="mono faint" style={{ wordBreak: 'break-all' }}>{l.path || '—'}{l.source && l.kind !== 'local_disk' ? <> ← {l.source}</> : null}</div> : null}</td>; })}</tr>)}
    </tbody></table></div>
    {st.repoSharing === 'shared' && (st.walSharing === 'shared' || st.walSharing === 'unknown') ? <div className="small" style={{ color: 'var(--ok)' }}><Icon n="check" s={13} /> Every node uses the same storage (verified through a marker file inside it): after a switchover or a failover the new primary continues the same backup history and WAL archive.</div> : null}
    {splitText ? <div className="small" style={{ color: 'var(--bad)' }}>The nodes write to different storage{st.walSharing === 'split' ? ' (WAL archive included)' : ''}: after a switchover the backups and the WAL are split between machines and point-in-time recovery across it is not possible. Move the cluster to a backup server or a network share{admin ? ' (Configure…)' : ''}.</div> : null}
    {sameDisk ? <div className="small" style={{ color: 'var(--warn)' }}>The repository is on the same disk as the database files on {st.nodes.filter(n => n.repo.sameDiskAsData).map(n => n.name).join(', ')}: a disk failure loses data and backups together, and backups compete with production for space and I/O.</div> : null}
    {b.walDisk && pctFree(b.walDisk)! < 10 ? <div className="small" style={{ color: 'var(--bad)' }}>The WAL archive has less than 10% free: if it fills up, archiving fails and WAL piles up on PostgreSQL’s own disk.</div> : null}
    {b.pending ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">A new storage location is configured{st.configured?.server?.name ? ` (backup server ${st.configured.server.name})` : ''} but not applied to the nodes yet{show && admin && b.configured ? <>: <code>{b.configured.repo_path || b.configured.wal_path}</code></> : ''}.</span>{admin ? <Button sm onClick={() => setDlg('apply')}>Check and apply</Button> : null}</div> : null}
    {st.configured?.server?.missing ? <div className="small" style={{ color: 'var(--bad)' }}>The backup server chosen for this cluster is no longer registered: choose the storage again.</div> : null}
    {(b.previous?.repo?.length || b.previous?.wal?.length) ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">The previous location is still read by restores{show && admin ? <>: <code>{[...(b.previous.repo || []), ...(b.previous.wal || [])].join(', ')}</code></> : ''}{b.migrating ? ' — migration running' : ''}.</span>
      {admin ? <Button sm onClick={() => setDlg('apply')}>{b.migrating ? 'Follow the migration' : 'Migrate or delete'}</Button> : null}</div> : null}
    {dlg === 'wizard' ? <StorageWizard clusterId={clusterId} onClose={() => { setDlg(''); revalidate(`/api/clusters/${encodeURIComponent(clusterId)}/storage`); }} /> : null}
    {dlg === 'apply' ? <ClusterDestinationCheck clusterId={clusterId} onClose={() => { setDlg(''); revalidate(`/api/clusters/${encodeURIComponent(clusterId)}/storage`); }} /> : null}
  </div>;
}
