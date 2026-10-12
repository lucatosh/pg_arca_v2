import React, { useState } from 'react';
import { Badge, Button, Icon, bytes } from '../ui';
import { useQuery } from '../hooks';
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

const TYPE_IT: Record<string, string> = { local: 'disco locale', nfs: 'NFS', smb: 'SMB/CIFS' };
const pctFree = (d: Disk) => (d && d.total_bytes ? Math.round((100 * d.free_bytes) / d.total_bytes) : null);

function DiskLine({ d, need }: { d: Disk; need?: number }) {
  if (!d) return <span className="small faint">spazio non ancora riportato dall’agent</span>;
  const p = pctFree(d)!; const after = need != null ? d.free_bytes - need : null;
  const tone = after != null && after < 0 ? 'bad' : p < 10 ? 'warn' : 'ok';
  return <span className={`diskline ${tone}`}><span className="db" aria-hidden="true"><i style={{ width: `${100 - p}%` }} /></span><span className="small">{bytes(d.free_bytes)} liberi su {bytes(d.total_bytes)} ({p}%)</span></span>;
}
const from = (s: Src, f: string) => { const t = scopeSourceText(s?.[f]); return t === 'predefinito' ? null : <span className="small faint"> · impostato per {t}</span>; };

/** "Where will this recovery happen?" — shown in the restore wizard before the operator starts, with a way to change it on the spot. */
export function RecoveryPlacement({ clusterId, compact }: { clusterId: string; compact?: boolean }) {
  const q = useQuery<Placement>(`/api/clusters/${encodeURIComponent(clusterId)}/placement`, { interval: 15000 });
  const [dlg, setDlg] = useState<'' | 'edit' | 'check'>('');
  const e = q.data?.ephemeral;
  if (!e) return null;
  return <div className={`placement ${compact ? 'compact' : ''}`} role="group" aria-label="Dove avviene il recupero">
    <div className="ph"><Icon n="server" s={15} /><strong>Dove avviene il recupero</strong><div className="grow" />
      <Button sm onClick={() => setDlg('check')} icon="search">Verifica</Button><Button sm onClick={() => setDlg('edit')}>Cambia per questo cluster</Button>
      <Button sm kind="ghost" onClick={() => go('infra/ephemeral')}>Impostazioni generali</Button></div>
    <dl className="kv">
      <dt>Nodo</dt><dd>{e.centralMissing ? <span style={{ color: 'var(--bad)' }}>il nodo centrale configurato non esiste più</span> : e.node ? <><strong>{e.node.name}</strong>{' '}
        {e.placement === 'central' ? <Badge kind="accent">nodo centrale</Badge> : <Badge>{e.node.role === 'primary' ? 'primario del cluster' : 'nodo del cluster'}</Badge>}{!e.node.online ? <> <Badge kind="bad">offline</Badge></> : null}{from(e.sources, 'placement')}</> : '—'}</dd>
      <dt>Cartella temporanea</dt><dd><code>{e.scratchDir}</code>{from(e.sources, 'scratchDir')}<div><DiskLine d={e.scratchDisk} /></div>
        {e.scratchSharesData ? <div className="small" style={{ color: 'var(--warn)' }}>È sullo stesso disco dei dati del cluster: estrazione e recupero consumano lo spazio e l’I/O della produzione. Meglio un volume separato.</div> : null}</dd>
      {!compact ? <><dt>Binari PostgreSQL</dt><dd>{e.binDir ? <code>{e.binDir}</code> : 'scelti in automatico per la versione del backup'}{from(e.sources, 'binDir')}</dd>
        <dt>Memoria</dt><dd>shared_buffers {e.sharedBuffersMb} MB{from(e.sources, 'sharedBuffersMb')}</dd></> : null}
    </dl>
    {dlg === 'edit' ? <ClusterScopeEditor kind="ephemeral" clusterId={clusterId} onClose={() => setDlg('')} /> : null}
    {dlg === 'check' ? <ClusterEphemeralCheck clusterId={clusterId} onClose={() => setDlg('')} /> : null}
  </div>;
}

/** "Where do the backups of this cluster go?" — on the backup page, with free space, the pending (configured but not yet applied) change, and the way to change it. */
export function BackupPlacement({ clusterId }: { clusterId: string }) {
  const q = useQuery<Placement>(`/api/clusters/${encodeURIComponent(clusterId)}/placement`, { interval: 15000 });
  const [dlg, setDlg] = useState<'' | 'edit' | 'apply'>('');
  const b = q.data?.backup;
  if (!b) return null;
  const sameDisk = !!(b.repoDisk && b.dataDisk && b.repoDisk.dev !== undefined && b.repoDisk.dev === b.dataDisk.dev);
  return <div className="placement" role="group" aria-label="Dove vanno i backup">
    <div className="ph"><Icon n="server" s={15} /><strong>Dove vanno i backup</strong><Badge>{TYPE_IT[b.type] || b.type}</Badge><div className="grow" />
      <Button sm onClick={() => setDlg('edit')}>Cambia per questo cluster</Button><Button sm icon="check" onClick={() => setDlg('apply')}>Controlla</Button><Button sm kind="ghost" onClick={() => go('infra/destination')}>Impostazioni generali</Button></div>
    <dl className="kv">
      <dt>Repository</dt><dd><code>{b.repoPath || '—'}</code>{from(b.sources, 'repoPath')}<div><DiskLine d={b.repoDisk} /></div></dd>
      <dt>Archivio WAL</dt><dd><code>{b.walPath || '—'}</code>{from(b.sources, 'walPath')}<div><DiskLine d={b.walDisk} /></div></dd>
    </dl>
    {sameDisk ? <div className="small" style={{ color: 'var(--warn)' }}>Il repository è sullo stesso disco dei dati: un guasto del disco perde dati e backup insieme, e i backup consumano lo spazio della produzione. Meglio un volume separato (NFS, SMB o un disco dedicato).</div> : null}
    {b.walDisk && pctFree(b.walDisk)! < 10 ? <div className="small" style={{ color: 'var(--bad)' }}>L’archivio WAL ha meno del 10% libero: se si riempie l’archiviazione fallisce e i WAL si accumulano nel disco di PostgreSQL.</div> : null}
    {b.pending ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">C’è una destinazione configurata ({b.configured?.repo_path || b.configured?.wal_path}) non ancora applicata ai nodi.</span><Button sm onClick={() => setDlg('apply')}>Controlla e applica</Button></div> : null}
    {(b.previous?.repo?.length || b.previous?.wal?.length) ? <div className="row small" style={{ color: 'var(--warn)' }}><span className="grow">Posizione precedente ancora usata dai ripristini: <code>{[...(b.previous.repo || []), ...(b.previous.wal || [])].join(', ')}</code>{b.migrating ? ' — migrazione in corso' : ''}.</span>
      <Button sm onClick={() => setDlg('apply')}>{b.migrating ? 'Segui la migrazione' : 'Migra o elimina'}</Button></div> : null}
    {dlg === 'edit' ? <ClusterScopeEditor kind="destination" clusterId={clusterId} onClose={() => setDlg('')} /> : null}
    {dlg === 'apply' ? <ClusterDestinationCheck clusterId={clusterId} onClose={() => setDlg('')} /> : null}
  </div>;
}
