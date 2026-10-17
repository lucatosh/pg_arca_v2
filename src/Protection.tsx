import React from 'react';
import { Dot, ago } from './ui';

/** "Is it protected?" in one sentence (server: health.protectionOf, shared by the cluster list, the cluster header and Today). */
export interface Protection { state: 'ok' | 'warn' | 'bad' | 'none'; reason?: string; lastBackupAt?: string | null; lastFullAt?: string | null; backups?: number;
  rpoSeconds?: number | null; rpoState?: string; archiving?: 'ok' | 'off' | 'failing'; rtoSeconds?: number | null; offsiteAt?: string | null; problems?: { code: string; severity: string; title: string }[] }

const span = (s: number) => s >= 7200 ? `${Math.round(s / 3600)} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`;

/** The main sentence: up to when the data can be restored. */
export function protectionHeadline(p?: Protection | null): string {
  if (!p) return '…';
  if (p.state === 'none') return p.reason === 'standby_site' ? 'Backed up on its primary site' : 'Not backed up by this console';
  if (!p.backups) return 'No backup yet: not protected';
  if (p.archiving === 'off') return 'Restorable only to a backup (WAL archiving is off)';
  if (p.archiving === 'failing') return 'Restorable only up to the last archived WAL segment (WAL archiving is failing)';
  if (p.rpoSeconds == null) return 'Restorable at least to the last backup (recovery point not measurable now)';
  return p.rpoSeconds <= 120 ? 'Restorable to within 2 min of now (estimated RPO)' : `Restorable to within ${span(p.rpoSeconds)} of now (estimated RPO)`;
}

/** The details that follow: last backup, last full, offsite copy, estimated full restore time. */
export function protectionDetails(p?: Protection | null, long = false): string[] {
  if (!p || p.state === 'none' || !p.backups) return [];
  const out: string[] = [];
  if (p.lastBackupAt) out.push(`last backup ${ago(p.lastBackupAt)}`);
  if (long && p.lastFullAt && p.lastFullAt !== p.lastBackupAt) out.push(`last full ${ago(p.lastFullAt)}`);
  if (p.offsiteAt !== undefined) out.push(p.offsiteAt ? `offsite copy ${ago(p.offsiteAt)}` : 'offsite copy never synced');
  if (long && p.rtoSeconds) out.push(`full restore ≈ ${span(p.rtoSeconds)} (estimated from the last drill)`);
  return out;
}

export function ProtectionLine({ p, long = false, problems = true }: { p?: Protection | null; long?: boolean; problems?: boolean }) {
  // when the problems are listed apart (cluster header), the dot answers only the sentence next to it: how far back the data can be restored
  const st = !problems && p && p.backups && p.archiving === 'ok' && p.rpoState === 'ok' ? 'ok' : p?.state;
  const kind = !p ? undefined : st === 'ok' ? 'ok' : st === 'warn' ? 'warn' : st === 'bad' ? 'bad' : undefined;
  const det = protectionDetails(p, long);
  return <span className="protline" title={(p?.problems || []).map(x => x.title).join('\n') || undefined}>
    <Dot kind={kind as any} /><span><strong>{protectionHeadline(p)}</strong>{det.length ? <span className="faint">{' · '}{det.join(' · ')}</span> : null}
      {long && problems && p?.problems?.length ? <span className="small" style={{ display: 'block', color: p.state === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>{p.problems.map(x => x.title).join(' · ')}</span> : null}</span></span>;
}
