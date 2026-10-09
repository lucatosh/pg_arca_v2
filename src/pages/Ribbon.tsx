import React from 'react';
import { useQuery } from '../hooks';
import { ago, dt } from '../ui';
import { go } from '../router';

const RANK: Record<string, number> = { full: 3, diff: 2, incr: 1 };
const NAME: Record<string, string> = { full: 'completo', diff: 'differenziale', incr: 'incrementale' };
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
  const msg = !sets.length ? 'Nessun backup ancora: il ripristino non è possibile.'
    : wal === 'ok' ? `Puoi tornare a qualsiasi istante tra ${dt(new Date(first!).toISOString())} e adesso.`
    : wal === 'bad' ? 'I WAL hanno dei buchi: il ripristino a un istante preciso è limitato.' : `Senza WAL archiviati puoi tornare solo ai momenti dei backup (ultimo ${ago(last.stop_time)}).`;
  return <button type="button" className="ribbon" onClick={() => go(`c/${encodeURIComponent(c.id)}/restore`)} aria-label={`Protezione dei dati: ${msg}`}>
    <div className="cells" aria-hidden="true">{cells.map((x, i) => <i key={i} className={`${x.type || 'none'} ${x.today ? 'today' : ''}`} title={`${new Date(x.start).toLocaleDateString('it-CH')}: ${x.type ? `${x.n} backup (${NAME[x.type]})` : 'nessun backup'}`} />)}</div>
    <div className={`wal ${wal}`} aria-hidden="true" />
    <div className="cap"><span>{msg}</span><span className="muted">30 giorni · WAL {wal === 'ok' ? 'continui' : wal === 'bad' ? 'con buchi' : 'non archiviati'}</span></div>
  </button>;
}
