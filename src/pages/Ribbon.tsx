import React from 'react';
import { useQuery } from '../hooks';
import { ago, dt, dday } from '../ui';
import { go } from '../router';

const RANK: Record<string, number> = { full: 3, diff: 2, incr: 1 };
const NAME: Record<string, string> = { full: 'full', diff: 'differential', incr: 'incremental' };
const DAYS = 30;

/** The cluster's recoverability at a glance: one cell per day (strongest backup of that day) + WAL continuity + the window you can restore into. */
export function ProtectionRibbon({ c }: { c: any }) {
  const q = useQuery<any>(`/api/clusters/${encodeURIComponent(c.id)}/backups`, { interval: 15000 });
  const d = q.data; if (!d?.agent) return null;
  const sets: any[] = (d.backup?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE' && s.stop_time);
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const cells = Array.from({ length: DAYS }, (_, i) => {
    const start = day0.getTime() - (DAYS - 1 - i) * 86400e3, end = start + 86400e3;
    const inDay = sets.filter(s => { const t = Date.parse(s.stop_time); return t >= start && t < end; });
    const best = inDay.sort((a, b) => (RANK[b.type] || 0) - (RANK[a.type] || 0))[0];
    return { start, type: best?.type as string | undefined, n: inDay.length, today: i === DAYS - 1 };
  });
  const first = sets.length ? Math.min(...sets.map(s => Date.parse(s.stop_time))) : null;
  const wal = d.wal?.continuous === false ? 'bad' : d.archiver && d.archiveMode !== 'off' ? 'ok' : 'none';
  const last = sets.length ? sets.reduce((a, s) => (Date.parse(s.stop_time) > Date.parse(a.stop_time) ? s : a)) : null;
  const msg = !sets.length ? 'No backups yet: restore is not possible.'
    : wal === 'ok' ? `You can go back to any point between ${dt(new Date(first!).toISOString())} and now.`
    : wal === 'bad' ? 'The WAL has gaps: point-in-time recovery is limited.' : `Without archived WAL you can only go back to backup points (last ${ago(last.stop_time)}).`;
  return <button type="button" className="ribbon" onClick={() => go(`c/${encodeURIComponent(c.id)}/restore`)} aria-label={`Data protection: ${msg}`}>
    <div className="cells" aria-hidden="true">{cells.map((x, i) => <i key={i} className={`${x.type || 'none'} ${x.today ? 'today' : ''}`} title={`${dday(x.start)}: ${x.type ? `${x.n} backup (${NAME[x.type]})` : 'no backups'}`} />)}</div>
    <div className={`wal ${wal}`} aria-hidden="true" />
    <div className="cap"><span>{msg}</span><span className="muted">30 days · WAL {wal === 'ok' ? 'continuous' : wal === 'bad' ? 'with gaps' : 'not archived'}</span></div>
  </button>;
}
