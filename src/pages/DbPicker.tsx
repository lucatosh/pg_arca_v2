import React, { useMemo, useState } from 'react';
import { Badge, Icon, bytes } from '../ui';

/** WAL timestamps come as "2026-10-11 01:36:04.742818 UTC": make them parseable everywhere (ms, ISO). */
export function parseWalTime(s?: string | null): number {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?\s*(?:UTC|Z|\+00(?::?00)?)?$/);
  return m ? Date.parse(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}Z`) : Date.parse(s);
}
export const fmtWhen = (ms: number) => new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export type CatDb = { name: string; oid: number | string; size: number; connectable?: boolean; tables?: number; objects?: number; matviews?: number; schemas?: number; in_latest?: boolean; last_set?: string; last_stop?: string };
export type DropInfo = { time: string; time_exact: boolean } | null | undefined;
type Kind = 'app' | 'work' | 'system';
export const kindOf = (n: string): Kind => (/^(template[01]|postgres)$/.test(n) ? 'system' : /^(arca_rl_|pgarca_stage_)/.test(n) || /_(pitr|restored)(_?\d+)?$/.test(n) ? 'work' : 'app');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Database list of the restore wizard: what exists now, what was DROPPED (red, with the date when the WAL scan found it), temporary pg_arca databases kept apart. */
export function DbPicker({ dbs, live, drops, dropsState, value, onChange }: { dbs: CatDb[]; live: Set<string> | null; drops: Record<string, DropInfo>; dropsState: 'idle' | 'running' | 'done' | 'failed'; value: string; onChange: (n: string) => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => dbs.filter(d => d.connectable !== false).map(d => {
    const dropped = live ? !live.has(d.name) : false;
    return { d, dropped, kind: kindOf(d.name) };
  }), [dbs, live]);
  const match = (n: string) => !q || n.toLowerCase().includes(q.toLowerCase());
  const dropped = rows.filter(r => r.dropped && r.kind === 'app' && match(r.d.name));
  const here = rows.filter(r => !r.dropped && r.kind === 'app' && match(r.d.name));
  const work = rows.filter(r => r.kind === 'work' && match(r.d.name));
  const sys = rows.filter(r => r.kind === 'system' && match(r.d.name));
  const nDropped = rows.filter(r => r.dropped && r.kind === 'app').length;

  const row = (r: typeof rows[number]) => {
    const { d } = r; const info = drops[String(d.oid)]; const t = info ? parseWalTime(info.time) : NaN; const sel = value === d.name;
    return <button key={d.name} type="button" role="radio" aria-checked={sel} className={`dbrow ${sel ? 'on' : ''} ${r.dropped ? 'gone' : ''}`} onClick={() => onChange(d.name)}>
      <span className="rb" aria-hidden="true" />
      <span className="nm"><strong>{d.name}</strong>
        <span className="meta">{bytes(d.size)} · {plural(d.tables ?? d.objects ?? 0, 'tabella', 'tabelle')}{d.matviews ? ` · ${plural(d.matviews, 'vista materializzata', 'viste materializzate')}` : ''}{d.schemas ? ` · ${plural(d.schemas, 'schema', 'schemi')}` : ''}</span></span>
      <span className="st">{r.dropped ? <>
        <span className="dropped" title="Questo database non esiste più sul server">DROPPED</span>
        <span className="when">{Number.isFinite(t) ? `${info!.time_exact ? '' : 'circa '}${fmtWhen(t)}` : dropsState === 'running' ? <><Icon n="refresh" s={12} spin /> data in calcolo…</> : d.last_stop ? `esisteva al backup del ${fmtWhen(Date.parse(d.last_stop))}` : 'data non rilevata'}</span></>
        : live ? <span className="here">Presente</span> : null}</span>
    </button>;
  };
  const group = (title: string, hint: string | null, list: typeof rows, tone?: string) => list.length ? <div className={`dbgroup ${tone || ''}`} key={title}><div className="gh"><span>{title}</span><span className="n">{list.length}</span>{hint ? <span className="hint">{hint}</span> : null}</div>{list.map(row)}</div> : null;

  return <div className="dbpicker">
    <div className="dbtop"><div className="search"><Icon n="search" s={15} /><input className="input" placeholder="Cerca un database…" value={q} onChange={e => setQ(e.target.value)} aria-label="Cerca un database" /></div>
      {live && nDropped ? <span className="dropsum">{plural(nDropped, 'database eliminato', 'database eliminati')} dal server</span> : null}</div>
    <div role="radiogroup" aria-label="Database" className="dblist">
      {group('Eliminati dal server', 'Presenti nei backup, assenti ora: si possono ancora ripristinare', dropped, 'bad')}
      {group('Database presenti', null, here)}
      {work.length ? <details className="dbgroup"><summary className="gh"><span>Temporanei di pg_arca</span><span className="n">{work.length}</span><span className="hint">creati da ripristini precedenti</span></summary>{work.map(row)}</details> : null}
      {sys.length ? <details className="dbgroup"><summary className="gh"><span>Di sistema</span><span className="n">{sys.length}</span></summary>{sys.map(row)}</details> : null}
      {!dropped.length && !here.length && !work.length && !sys.length ? <div className="muted small" style={{ padding: 12 }}>Nessun database corrisponde alla ricerca.</div> : null}
    </div>
    {live === null ? <div className="small muted">Lo stato attuale dei database non è disponibile (nodo non raggiungibile): sono mostrati quelli presenti nei backup.</div> : null}
  </div>;
}

export function DroppedNote({ db, info, lastStop }: { db: string; info: DropInfo; lastStop?: string }) {
  const t = info ? parseWalTime(info.time) : NaN;
  return <div className="dropnote" role="note"><Badge kind="bad">DROPPED</Badge>
    <div><strong>{db}</strong> non esiste più sul server{Number.isFinite(t) ? <> (eliminato {info!.time_exact ? 'il' : 'intorno al'} <strong>{fmtWhen(t)}</strong>)</> : null}. Si può ripristinare: pg_arca lo ricostruisce
      dal backup {lastStop ? <>del {fmtWhen(Date.parse(lastStop))} </> : null}e dai WAL fino a un attimo prima dell’eliminazione, e lo crea con un nome nuovo. Nessun database esistente viene toccato.</div></div>;
}
