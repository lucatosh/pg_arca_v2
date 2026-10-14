import React, { useMemo, useState } from 'react';
import { Badge, Icon, bytes } from '../ui';

/** WAL timestamps come as "2026-10-11 01:36:04.742818 UTC": make them parseable everywhere (ms, ISO). */
export function parseWalTime(s?: string | null): number {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?\s*(?:UTC|Z|\+00(?::?00)?)?$/);
  return m ? Date.parse(`${m[1]}T${m[2]}.${(m[3] || '0').padEnd(3, '0').slice(0, 3)}Z`) : Date.parse(s);
}
export const fmtWhen = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export type CatDb = { name: string; oid: number | string; size: number; connectable?: boolean; tables?: number; objects?: number; matviews?: number; schemas?: number; in_latest?: boolean; last_set?: string; last_stop?: string; first_stop?: string; late?: boolean };
/** Object paths `db.schema.name` as the agent reads them: a part with a dot or a quote is double-quoted (db."sales.eu".orders). */
export const qpart = (x: string) => (/[."]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
export const qid = (...parts: string[]) => parts.map(qpart).join('.');
export function splitId(id: string): string[] {
  const out: string[] = []; let cur = ''; let i = 0;
  while (i < id.length) {
    if (id[i] === '"' && !cur) { let j = i + 1; let buf = ''; while (j < id.length) { if (id[j] === '"') { if (id[j + 1] === '"') { buf += '"'; j += 2; continue; } break; } buf += id[j++]; } cur = buf; i = j + 1; continue; }
    if (id[i] === '.') { out.push(cur); cur = ''; i++; continue; }
    cur += id[i++];
  }
  out.push(cur); return out;
}
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
        <span className="meta">{bytes(d.size)}{d.late ? ' · not in a backup yet' : <> · {plural(d.tables ?? d.objects ?? 0, 'table', 'tables')}</>}{d.matviews ? ` · ${plural(d.matviews, 'materialized view', 'materialized views')}` : ''}{d.schemas ? ` · ${plural(d.schemas, 'schema', 'schemas')}` : ''}</span></span>
      <span className="st">{r.dropped ? <>
        <span className="dropped" title="This database no longer exists on the server">DROPPED</span>
        <span className="when">{Number.isFinite(t) ? `${info!.time_exact ? '' : 'about '}${fmtWhen(t)}` : dropsState === 'running' ? <><Icon n="refresh" s={12} spin /> working out the date…</> : d.last_stop ? `existed at the backup of ${fmtWhen(Date.parse(d.last_stop))}` : 'date not found'}</span></>
        : d.late ? <span className="here" title="No backup contains it: it is rebuilt from the archived WAL">After the last backup</span> : live ? <span className="here">Present</span> : null}</span>
    </button>;
  };
  const group = (title: string, hint: string | null, list: typeof rows, tone?: string) => list.length ? <div className={`dbgroup ${tone || ''}`} key={title}><div className="gh"><span>{title}</span><span className="n">{list.length}</span>{hint ? <span className="hint">{hint}</span> : null}</div>{list.map(row)}</div> : null;

  return <div className="dbpicker">
    <div className="dbtop"><div className="search"><Icon n="search" s={15} /><input className="input" placeholder="Search a database…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search a database" /></div>
      {live && nDropped ? <span className="dropsum">{plural(nDropped, 'database', 'databases')} dropped from the server</span> : null}</div>
    <div role="radiogroup" aria-label="Database" className="dblist">
      {group('Dropped from the server', 'In the backups, gone now: they can still be restored', dropped, 'bad')}
      {group('Existing databases', null, here)}
      {work.length ? <details className="dbgroup"><summary className="gh"><span>pg_arca temporary</span><span className="n">{work.length}</span><span className="hint">created by earlier restores</span></summary>{work.map(row)}</details> : null}
      {sys.length ? <details className="dbgroup"><summary className="gh"><span>System</span><span className="n">{sys.length}</span></summary>{sys.map(row)}</details> : null}
      {!dropped.length && !here.length && !work.length && !sys.length ? <div className="muted small" style={{ padding: 12 }}>No database matches the search.</div> : null}
    </div>
    {live === null ? <div className="small muted">The current state of the databases is not available (node unreachable): the ones in the backups are shown.</div> : null}
  </div>;
}

export function DroppedNote({ db, info, lastStop }: { db: string; info: DropInfo; lastStop?: string }) {
  const t = info ? parseWalTime(info.time) : NaN;
  return <div className="dropnote" role="note"><Badge kind="bad">DROPPED</Badge>
    <div><strong>{db}</strong> no longer exists on the server{Number.isFinite(t) ? <> (dropped {info!.time_exact ? 'on' : 'around'} <strong>{fmtWhen(t)}</strong>)</> : null}. It can be restored: pg_arca rebuilds it
      from the backup {lastStop ? <>of {fmtWhen(Date.parse(lastStop))} </> : null}and the WAL up to just before the drop. No existing database is touched.</div></div>;
}
