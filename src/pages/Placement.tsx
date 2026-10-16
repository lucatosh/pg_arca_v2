import React, { useState } from 'react';
import { Badge, Button, Icon, bytes } from '../ui';
import { useDraft, useQuery } from '../hooks';
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

const TYPE_LABEL: Record<string, string> = { local: 'local disk', nfs: 'NFS', smb: 'SMB/CIFS' };
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
  return <div className={`placement ${compact ? 'compact' : ''}`} role="group" aria-label="Where recovery runs">
    <div className="ph"><Icon n="server" s={15} /><strong>Where recovery runs</strong><div className="grow" />
      <Button sm onClick={() => setDlg('check')} icon="search">Verify</Button><Button sm onClick={() => setDlg('edit')}>Change for this cluster</Button>
      <Button sm kind="ghost" onClick={() => go('infra/ephemeral')}>General settings</Button></div>
    <dl className="kv">
      <dt>Node</dt><dd>{e.centralMissing ? <span style={{ color: 'var(--bad)' }}>the configured central node no longer exists</span> : e.node ? <><strong>{e.node.name}</strong>{' '}
        {e.placement === 'central' ? <Badge kind="accent">central node</Badge> : <Badge>{e.node.role === 'primary' ? 'cluster primary' : 'cluster node'}</Badge>}{!e.node.online ? <> <Badge kind="bad">offline</Badge></> : null}{from(e.sources, 'placement')}</> : '—'}</dd>
      <dt>Scratch directory</dt><dd><code>{e.scratchDir}</code>{from(e.sources, 'scratchDir')}<div><DiskLine d={e.scratchDisk} /></div>
        {e.scratchSharesData ? <div className="small" style={{ color: 'var(--warn)' }}>It is on the same disk as the cluster data: extraction and recovery consume production’s space and I/O. A separate volume is better.</div> : null}</dd>
      {!compact ? <><dt>PostgreSQL binaries</dt><dd>{e.binDir ? <code>{e.binDir}</code> : 'picked automatically for the backup’s version'}{from(e.sources, 'binDir')}</dd>
        <dt>Memory</dt><dd>shared_buffers {e.sharedBuffersMb} MB{from(e.sources, 'sharedBuffersMb')}</dd></> : null}
    </dl>
    {dlg === 'edit' ? <ClusterScopeEditor kind="ephemeral" clusterId={clusterId} onClose={() => setDlg('')} /> : null}
    {dlg === 'check' ? <ClusterEphemeralCheck clusterId={clusterId} onClose={() => setDlg('')} /> : null}
  </div>;
}

/** "Where do the backups of this cluster go?" — on the backup page, with free space, the pending (configured but not yet applied) change, and the way to change it. */
export function BackupPlacement({ clusterId }: { clusterId: string }) {
  const q = useQuery<Placement>(`/api/clusters/${encodeURIComponent(clusterId)}/placement`, { interval: 15000 });
  const [dlg, setDlg] = useDraft<'' | 'edit' | 'apply'>(`placement:${clusterId}:bk`, '');
  const b = q.data?.backup;
  if (!b) return null;
  const sameDisk = !!(b.repoDisk && b.dataDisk && b.repoDisk.dev !== undefined && b.repoDisk.dev === b.dataDisk.dev);
  return <div className="placement" role="group" aria-label="Backup storage">
    <div className="ph"><Icon n="server" s={15} /><strong>Destination</strong><Badge>{TYPE_LABEL[b.type] || b.type}</Badge><div className="grow" />
      <Button sm onClick={() => setDlg('edit')}>Change for this cluster</Button><Button sm icon="check" onClick={() => setDlg('apply')}>Check</Button><Button sm kind="ghost" onClick={() => go('infra/destination')}>General settings</Button></div>
    <dl className="kv">
      <dt>Repository</dt><dd><code>{b.repoPath || '—'}</code>{from(b.sources, 'repoPath')}<div><DiskLine d={b.repoDisk} /></div></dd>
      <dt>WAL archive</dt><dd><code>{b.walPath || '—'}</code>{from(b.sources, 'walPath')}<div><DiskLine d={b.walDisk} /></div></dd>
    </dl>
    {sameDisk ? <div className="small" style={{ color: 'var(--warn)' }}>The repository is on the same disk as the data: a disk failure loses data and backups together, and backups consume production’s space. A separate volume is better (NFS, SMB or a dedicated disk).</div> : null}
    {b.walDisk && pctFree(b.walDisk)! < 10 ? <div className="small" style={{ color: 'var(--bad)' }}>The WAL archive has less than 10% free: if it fills up, archiving fails and WAL piles up on PostgreSQL’s disk.</div> : null}
    {b.pending ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">A configured destination ({b.configured?.repo_path || b.configured?.wal_path}) is not applied to the nodes yet.</span><Button sm onClick={() => setDlg('apply')}>Check and apply</Button></div> : null}
    {(b.previous?.repo?.length || b.previous?.wal?.length) ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">Previous location still used by restores: <code>{[...(b.previous.repo || []), ...(b.previous.wal || [])].join(', ')}</code>{b.migrating ? ' — migration running' : ''}.</span>
      <Button sm onClick={() => setDlg('apply')}>{b.migrating ? 'Follow the migration' : 'Migrate or delete'}</Button></div> : null}
    {dlg === 'edit' ? <ClusterScopeEditor kind="destination" clusterId={clusterId} onClose={() => setDlg('')} /> : null}
    {dlg === 'apply' ? <ClusterDestinationCheck clusterId={clusterId} onClose={() => setDlg('')} /> : null}
  </div>;
}
