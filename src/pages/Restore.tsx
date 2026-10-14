import { RecoveryPlacement } from './Placement';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Details, Empty, Field, Icon, Skeleton, bytes, dt, num, ago } from '../ui';
import { Op, useDraft, useOpRunner, useQuery } from '../hooks';
import { OpPanel, Result, hintFor } from './shared';
import { DestPicker, RestoredCard, RestoredList, TTL_CHOICES } from './Restored';
import { itCheck, itFix } from '../i18n';

/** <db>_restored as a plain identifier (the engine's rule): 'Vendite Q1-2026' -> Vendite_Q1_2026_restored. */
export const restoredName = (db: string) => {
  let b = db.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'db';
  if (/^[0-9]/.test(b)) b = 'db_' + b;
  return b.slice(0, 63 - '_restored'.length) + '_restored';
};
import { RecoveryTimeline, TlEvent } from './Timeline';
import { SetRow, TYPE_LABEL, chains } from './Backup';
import { CatDb, DbPicker, DroppedNote, DropInfo, kindOf, parseWalTime, fmtWhen, qid, splitId } from './DbPicker';

type Scope = 'instance' | 'database' | 'object';
type Intent = 'table' | 'rows' | 'database' | 'cluster';
type Target = { mode: 'latest' } | { mode: 'time'; ms: number } | { mode: 'lsn'; lsn: string; label: string } | { mode: 'xid'; xid: string; label: string; lsn?: string };
const STEPS = ['Situation', 'What', 'When', 'Check', 'Restore'];
const KIND_LABEL: Record<string, string> = { DROP: 'Object dropped or rewritten', TRUNCATE: 'Table truncated', 'DROP DATABASE': 'Database dropped' };
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'locale'; } };
const localInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 19); };
const ago2 = (ms: number) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const shortName = (id: string) => { const p = splitId(id); return p.slice(1).join('.') || id; };

const INTENTS: { id: Intent; icon: string; title: string; text: string }[] = [
  { id: 'table', icon: 'trash', title: 'I dropped or truncated a table', text: 'Or a whole schema. pg_arca finds out when it happened and brings it back as it was just before.' },
  { id: 'rows', icon: 'file', title: 'I deleted or updated rows by mistake', text: 'A wrong DELETE or UPDATE. You compare the table as it was with the table as it is now and bring back only the rows you choose.' },
  { id: 'database', icon: 'db', title: 'I need a database as it was before', text: 'Dropped or damaged: pg_arca puts it back in place as it was (the current one is kept as a safety copy), or makes a copy for you to inspect.' },
  { id: 'cluster', icon: 'server', title: 'I need to rebuild the whole server', text: 'Damage or disaster on the whole server: pg_arca puts it back in place as it was and restarts it, or starts a full copy for you to inspect.' },
];

/** A point to go back to, found in the WAL: just before a DROP / TRUNCATE / mass DELETE-UPDATE. */
type Sugg = { key: string; title: string; at: number; exact: boolean; tgt: Target };

export function RestoreTab({ c }: { c: any }) {
  const q = useQuery<any>(c.source !== 'direct' && !c.isSandbox ? `/api/clusters/${encodeURIComponent(c.id)}/backups` : null, { interval: 15000 });
  if (c.isSandbox) return <Banner kind="info" title="Not available on the demo cluster">Connect a real cluster with the agent to restore.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="restore" title="The agent is required">Restore reads the repository on the database server: install the agent on a node of the cluster.</Empty></Card>;
  if (!q.data) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const sets: SetRow[] = (q.data.backup?.recent_sets || []).filter((s: SetRow) => s.status === 'COMPLETE');
  if (!q.data.agent) return <Card><Empty icon="restore" title="No agent on this cluster" /></Card>;
  if (!sets.length) return <Card><Empty icon="restore" title="No backup to restore from">Take a full backup first from the Backup tab.</Empty></Card>;
  return <div className="stack-l"><RestoredList list={q.data.restored || []} clusterId={c.id} /><Wizard c={c} d={q.data} sets={sets} /></div>;
}

function Wizard({ c, d, sets }: { c: any; d: any; sets: SetRow[] }) {
  // everything chosen here survives leaving the page (another tab, a setting opened from the check step, Back): see useDraft
  const K = `restore:${c.id}`;
  const [step, setStep] = useDraft(K + ':step', 0);
  const [intent, setIntent] = useDraft<Intent | null>(K + ':intent', null);
  const [scope, setScope] = useDraft<Scope>(K + ':scope', 'database'); const [objMode, setObjMode] = useDraft<'table' | 'schema'>(K + ':objMode', 'table');
  const [db, setDb] = useDraft(K + ':db', ''); const [objs, setObjs] = useDraft<string[]>(K + ':objs', []); const obj = objs[0] || ''; const [search, setSearch] = useDraft(K + ':search', '');
  const [tgt, setTgt] = useDraft<Target | null>(K + ':tgt', null);
  const [dest, setDest] = useDraft(K + ':dest', ''); const [newName, setNewName] = useDraft(K + ':newName', ''); const [action, setAction] = useDraft<'promote' | 'pause'>(K + ':action', 'promote'); const [delta, setDelta] = useDraft(K + ':delta', false); const [keepArch, setKeepArch] = useDraft(K + ':keepArch', false); const [mkRoles, setMkRoles] = useDraft(K + ':mkRoles', true); const [ttl, setTtl] = useDraft(K + ':ttl', 24);
  // the END of the job, chosen before starting: the tool repairs the original (default) or only produces a copy to look at
  const [fin, setFin] = useDraft<'fix' | 'copy'>(K + ':fin', 'fix');
  const [ask, setAsk] = useState(false);
  const prom = useOpRunner(c.id, undefined, K + ':prom'); const prev = useOpRunner(c.id, undefined, K + ':prev'); const [pmode, setPmode] = useDraft<PMode | null>(K + ':pmode', null); const [pdrop, setPdrop] = useDraft(K + ':pdrop', true); const [askPromote, setAskPromote] = useState(false); const [askOrphans, setAskOrphans] = useState(false);
  const [lastPromoteV, setLastPromote] = useDraft<any>(K + ':lastPromote', null); const lastPromote = { current: lastPromoteV }; const [pschema, setPschema] = useDraft(K + ':pschema', '');
  const dbsR = useOpRunner(c.id, undefined, K + ':dbs'); const dropsR = useOpRunner(c.id, undefined, K + ':drops'); const liveR = useOpRunner(c.id, undefined, K + ':live'); const tdropR = useOpRunner(c.id, undefined, K + ':tdrop'); const [fxHours, setFxHours] = useDraft(K + ':fxHours', 72);
  const objR = useOpRunner(c.id, undefined, K + ':obj'); const plan = useOpRunner(c.id, undefined, K + ':plan'); const exec = useOpRunner(c.id, undefined, K + ':exec'); const fx = useOpRunner(c.id, undefined, K + ':fx'); const dml = useOpRunner(c.id, undefined, K + ':dml'); const [dmlMin, setDmlMin] = useDraft(K + ':dmlMin', 100);

  const from = useMemo(() => Math.min(...sets.map(s => Date.parse(s.stop_time!))), [sets]);
  const to = Math.max(Date.now(), d.archiver?.last_archived_time ? Date.parse(d.archiver.last_archived_time) : 0);
  const events: (TlEvent & { raw: any })[] = useMemo(() => (fx.op?.result?.events || []).map((e: any) => ({ at: parseWalTime(e.time), label: `${e.kind}: ${(e.names || []).join(', ')}`, raw: e })).filter((e: any) => Number.isFinite(e.at)), [fx.op]);

  // catalogue pickers: run once per scope entry, through the agent (the catalogue lives next to the repository)
  useEffect(() => { if ((scope === 'database' || scope === 'object') && intent && !dbsR.op && !dbsR.busy) dbsR.run('backup_catalog', { set: 'all' }); }, [scope, intent]);
  useEffect(() => { if (scope === 'object' && db && !dbs.find(x => x.name === db)?.late && !objR.busy && !(objR.op && objR.op.params?.database === db && (objR.op.params?.search || '') === search && objR.op.status === 'succeeded')) { const t = setTimeout(() => objR.run('backup_catalog', { set: dbs.find(x => x.name === db)?.last_set || 'latest', database: db, search, limit: 400 }), search ? 350 : 0); return () => clearTimeout(t); } }, [scope, db, search, intent, !objR.op && !objR.busy]);
  const dbSeen = useRef(db);
  useEffect(() => { if (db && (db !== dbSeen.current || !newName)) setNewName(restoredName(db)); dbSeen.current = db; }, [db]);
  // "a table is gone": look for what happened right away (DROP / TRUNCATE, cached and in its own queue: it never slows a backup or a restore)
  useEffect(() => { if (intent === 'table' && !fx.op && !fx.busy) fx.run('wal_forensics', { mode: 'events', hours: fxHours, limit: 30 }); }, [intent]);
  // "wrong rows": once the table is known, look for the mass DELETE / UPDATE
  useEffect(() => { if (intent === 'rows' && step === 2 && obj && !dml.op && !dml.busy) dml.run('wal_forensics', { mode: 'dml', hours: 24, min_rows: dmlMin, limit: 30 }); }, [intent, step, obj]);

  // functions, not values: they read state declared further down (what exists now, what is gone)
  const dbExists = () => !!live?.has(db);
  const finMode = (): PMode => pmode || recommendedMode(goneNow);
  // the destination: the one the operator picked, else the one the agent proposed in the last check
  const destNow = (): string => dest || (plan.op?.status === 'succeeded' && plan.op.params?.scope === 'instance' && !plan.op.params?.replace_production ? String(plan.op.result?.destination || '') : '');
  const tparams = (): Record<string, any> => !tgt ? {} : tgt.mode === 'time' ? { target_time: new Date(tgt.ms).toISOString() } : tgt.mode === 'lsn' ? { target_lsn: tgt.lsn, inclusive: false } : tgt.mode === 'xid' ? { target_xid: tgt.xid, inclusive: false, ...(tgt.lsn ? { xid_lsn: tgt.lsn } : {}) } : {};
  // a whole server: 'fix' puts PRODUCTION itself back to that point (standalone servers; a Patroni cluster gets the copy)
  const patroni = !!c.haState?.managedByPatroni;
  const fixServer = () => scope === 'instance' && fin === 'fix' && !patroni;
  const params = (): { type: string; p: Record<string, any> } => fixServer() ? { type: 'restore_instance', p: { replace_production: true, confirm: 'REPLACE', label: c.name, ...tparams() } }
    : scope === 'instance' ? { type: 'restore_instance', p: { ...(destNow() ? { destination: destNow() } : {}), label: c.name, action, delta, ttl_hours: ttl, ...(keepArch ? { keep_archiving: true } : {}), ...tparams() } }
    : scope === 'database' ? { type: 'restore_database', p: { database: db, new_name: fin === 'fix' ? (dbExists() ? restoredName(db) : db) : newName, ...(fin === 'fix' && dbExists() ? { replace_original: true, confirm: 'REPLACE' } : {}), ...(mkRoles ? { create_missing_roles: true } : {}), ...tparams() } }
    : { type: 'restore_object', p: { object: obj, objects: objs, ...tparams(), ...(fin === 'fix' ? (intent === 'rows' ? { finish: 'rows_all' } : { finish: 'promote', promote_mode: finMode(), ...(finMode() === 'replace' ? { confirm: 'REPLACE' } : {}) }) : {}) } };
  const planParams = () => { const x = params().p; return { scope, ...x }; };

  const catDbs: CatDb[] = dbsR.op?.result?.databases || [];
  // databases that exist now but in NO backup (created after the last one): restorable from the WAL alone, so they are offered too
  const dbs: CatDb[] = useMemo(() => dbsR.op?.status !== 'succeeded' ? catDbs : [...catDbs, ...((c.databases || []) as any[]).filter(x => x?.name && !catDbs.some(d => d.name === x.name))
    .map(x => ({ name: String(x.name), oid: String(x.oid ?? ''), size: Number(x.size) || 0, late: true }))], [dbsR.op, c.databases]);
  // what exists NOW (agent snapshot): a database in the backups and not here was DROPPED
  const live: Set<string> | null = Array.isArray(c.databases) && c.databases.length ? new Set<string>(c.databases.map((x: any) => x.name)) : null;
  const droppedDbs = useMemo(() => (live ? dbs.filter(x => !live.has(x.name) && kindOf(x.name) === 'app') : []), [dbs, live]);
  const drops: Record<string, DropInfo> = useMemo(() => { const m: Record<string, DropInfo> = {}; for (const x of dropsR.op?.result?.dropped || []) m[String(x.oid)] = { time: x.time, time_exact: !!x.time_exact }; return m; }, [dropsR.op]);
  useEffect(() => {
    if (!droppedDbs.length || dropsR.op || dropsR.busy) return;
    const oldest = Math.min(...droppedDbs.map(x => Date.parse(x.last_stop || '') || Date.now())); const since = Math.max(oldest - 3600e3, Date.now() - 14 * 86400e3);
    dropsR.run('wal_forensics', { background: true, mode: 'databases', since_iso: new Date(since).toISOString(), limit: 100, budget_sec: 300 });
  }, [droppedDbs.length]);
  const selDb = dbs.find(x => x.name === db); const selDropped = !!selDb && droppedDbs.some(x => x.name === db);
  useEffect(() => { if (scope === 'object' && db && live?.has(db) && (!liveR.op || liveR.op.params?.database !== db)) liveR.run('list_objects', { database: db, background: true }); }, [scope, db, intent, !liveR.op]);
  const objLive = useMemo(() => {
    if (!db || selDropped) return db && selDropped ? { tables: new Set<string>(), schemas: new Set<string>(), all: true } : null;
    const r = liveR.op?.status === 'succeeded' ? liveR.op.result : null; if (!r) return null;
    return { tables: new Set<string>((r.objects || []).map((o: any) => qid(db, o.schema, o.table))), schemas: new Set<string>((r.schemas || []).map((n: string) => qid(db, n))), all: false,
             objects: (r.objects || []) as { schema: string; table: string }[] };
  }, [liveR.op, db, selDropped]);
  const catSchemas: any[] = objR.op?.status === 'succeeded' ? objR.op.result.schemas || [] : [];
  const anyTblGone = !!objLive && !objLive.all && catSchemas.some(sc => !objLive.schemas.has(qid(db, sc.name)) || (sc.objects || []).some((o: any) => !objLive.tables.has(qid(db, sc.name, o.name))));
  useEffect(() => { if (anyTblGone && !tdropR.op && !tdropR.busy) tdropR.run('wal_forensics', { background: true, mode: 'events', hours: 336, limit: 200, detail: true, budget_sec: 300 }); }, [anyTblGone]);
  const tblDrops: Record<string, DropInfo> = useMemo(() => { const m: Record<string, DropInfo> = {}; for (const e of tdropR.op?.result?.events || []) if (e.kind === 'DROP') for (const t of e.tables || []) m[t] = { time: e.time, time_exact: e.time_exact !== false }; return m; }, [tdropR.op]);
  // the selected tables that do not exist any more (null: not known yet)
  const goneNow: boolean | null = scope !== 'object' || !objs.length ? null : objLive ? objs.every(id => splitId(id).length === 2 ? (objLive.all || !objLive.schemas.has(id)) : (objLive.all || !objLive.tables.has(id))) : null;

  // ---- points to go back to, found in the WAL, for what was selected
  const touches = (names: string[]) => names.some(n => objs.some(id => n === id || n.startsWith(id + '.')) || (scope === 'database' && splitId(n)[0] === db));
  const suggestions: Sugg[] = useMemo(() => {
    const out: Sugg[] = []; const seen = new Set<string>();
    if (intent === 'table') for (const e of [...(fx.op?.result?.events || []), ...(tdropR.op?.result?.events || [])]) {
      const names: string[] = [...(e.names || []), ...(e.tables || [])]; if (!e.lsn || seen.has(e.lsn) || !touches(names)) continue; seen.add(e.lsn);
      const at = parseWalTime(e.time); const what = e.rewrite_possible ? 'truncated or rewritten' : e.kind === 'TRUNCATE' ? 'truncated' : 'dropped';
      const title = `${shortName(names.find(n => touches([n])) || names[0] || '')} ${what}`;
      out.push({ key: 'lsn:' + e.lsn, title, at, exact: e.time_exact !== false, tgt: { mode: 'lsn', lsn: e.lsn, label: `${title} (${Number.isFinite(at) ? fmtWhen(at) : e.lsn})` } });
    }
    if (intent === 'rows') for (const e of dml.op?.result?.events || []) {
      if (!touches(e.names || [])) continue; const at = parseWalTime(e.time);
      const what = e.kind === 'DELETE' ? `${num(e.deleted)} rows deleted` : e.kind === 'UPDATE' ? `${num(e.updated)} rows updated` : `${num(e.deleted)} deleted and ${num(e.updated)} updated`;
      out.push({ key: 'xid:' + e.xid, title: `${what} in ${shortName(e.names[0])}`, at, exact: e.time_exact !== false, tgt: { mode: 'xid', xid: String(e.xid), lsn: e.lsn, label: `${what} in ${shortName(e.names[0])} (${Number.isFinite(at) ? fmtWhen(at) : 'xid ' + e.xid})` } });
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [intent, fx.op, tdropR.op, dml.op, objs, db, scope]);
  const tgtKey = (t: Target | null) => !t ? '' : t.mode === 'lsn' ? 'lsn:' + t.lsn : t.mode === 'xid' ? 'xid:' + t.xid : t.mode;
  // entering "when": the most recent thing that went wrong is the natural choice; a whole database or server defaults to the latest point
  useEffect(() => { if (step !== 2 || tgt) return; if (suggestions.length) setTgt(suggestions[0].tgt); else if (intent === 'database' || intent === 'cluster') setTgt({ mode: 'latest' }); }, [step, suggestions.length]);

  const okWhat = scope === 'instance' || (scope === 'database' && !!db) || (scope === 'object' && objs.length > 0 && (intent !== 'rows' || (objs.length === 1 && splitId(obj).length === 3)));
  const okName = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(newName);
  // the end of the job overwrites something that exists now: typed confirmation
  const overwrites = () => fixServer() || (fin === 'fix' && ((scope === 'database' && dbExists()) || (scope === 'object' && intent !== 'rows' && finMode() === 'replace')));
  const okWhere = fixServer() ? true : scope === 'instance' ? destNow().startsWith('/') : scope === 'database' ? (fin === 'fix' || okName) : true;
  const okWhen = !!tgt && (tgt.mode !== 'time' || (tgt.ms >= from && tgt.ms <= to + 60000));
  const lastPlan = useRef<any>(null); if (plan.op?.status === 'succeeded') lastPlan.current = plan.op.result; else if (!plan.op && !plan.busy) lastPlan.current = null;
  const pres = plan.op?.status === 'succeeded' ? plan.op.result : plan.busy ? lastPlan.current : null;
  const blocked = plan.op?.status === 'succeeded' && (!!plan.op.result?.missing_wal?.length || plan.op.result?.preflight?.ok === false);
  const baseSet = useMemo(() => {
    const t = tgt?.mode === 'time' ? tgt.ms : Infinity; const ok = sets.filter(s => Date.parse(s.stop_time!) <= t);
    return ok.length ? ok[ok.length - 1] : null;
  }, [sets, tgt]);
  const running = exec.busy;
  const doneOk = exec.op?.status === 'succeeded';
  const check = () => { if (okWhere || scope === 'instance') plan.run('restore_plan', planParams()); else plan.reset(); };
  // the end changed (another destination name for a database): the check runs again with it
  const finSeen = useRef(fin);
  useEffect(() => { if (finSeen.current === fin) return; finSeen.current = fin; if (step === 3 && !exec.op && (scope === 'database' || scope === 'instance')) { if (scope === 'instance') { setDest(''); plan.run('restore_plan', planParams()); } else check(); } }, [fin]);
  const pickDest = (p: string) => { setDest(p); setTimeout(() => plan.run('restore_plan', { scope: 'instance', ...params().p, destination: p }), 0); };
  // where the recovery runs changed (from the dialog opened in the check step, or by a colleague): the verdict shown is stale, check again
  const placement = useQuery<any>(scope !== 'instance' ? `/api/clusters/${encodeURIComponent(c.id)}/placement` : null);
  const plSig = placement.data ? JSON.stringify(placement.data.ephemeral || {}) : ''; const plSeen = useRef(plSig);
  useEffect(() => { if (!plSig || plSig === plSeen.current) return; const had = !!plSeen.current; plSeen.current = plSig; if (had && step === 3 && !exec.op && okWhere) check(); }, [plSig]);
  // a whole instance needs no destination to be checked: the agent proposes one (and every other volume it could use) and the check runs on it
  const goCheck = () => { setStep(3); plan.run('restore_plan', planParams()); };
  const choose = (i: Intent) => {
    setIntent(i); setObjs([]); setTgt(null); plan.reset(); dml.reset(); prev.reset(); setFin('fix'); setPmode(null);
    if (i === 'cluster') { setScope('instance'); setFin(c.haState?.managedByPatroni ? 'copy' : 'fix'); setStep(2); return; }
    setScope(i === 'database' ? 'database' : 'object'); setObjMode('table'); setStep(1);
  };
  const restart = () => { exec.reset(); plan.reset(); prom.reset(); prev.reset(); dml.reset(); fx.reset(); objR.reset(); liveR.reset(); setObjs([]); setTgt(null); setIntent(null); setPmode(null); setLastPromote(null); setSearch(''); setDest(''); setStep(0); };
  // a quick pick from what the WAL says went wrong recently: selects the table AND the point just before
  const pickEvent = (e: any) => {
    const names: string[] = (e.names || []).filter((n: string) => splitId(n).length === 3); if (!names.length) return;
    setDb(splitId(names[0])[0]); setObjs(names); const at = parseWalTime(e.time);
    const title = `${shortName(names[0])} ${e.kind === 'TRUNCATE' ? 'truncated' : 'dropped'}`;
    setTgt({ mode: 'lsn', lsn: e.lsn, label: `${title} (${Number.isFinite(at) ? fmtWhen(at) : e.lsn})` }); setStep(2);
  };

  const whatTxt = scope === 'instance' ? 'the whole server' : scope === 'database' ? <>database <strong>{db}</strong></> : objs.length === 1 ? <>{splitId(obj).length === 2 ? 'schema' : 'table'} <strong>{shortName(obj)}</strong> in {splitId(obj)[0]}</> : <><strong>{objs.length}</strong> objects in {db}</>;
  const whenTxt = !tgt ? '—' : tgt.mode === 'latest' ? (selDropped ? 'just before it was dropped' : 'to the latest saved point') : tgt.mode === 'time' ? <>as it was on <strong>{new Date(tgt.ms).toLocaleString('en-GB')}</strong></> : <>just before: <strong>{tgt.label}</strong></>;
  const reachable = (i: number) => i < step && !running && !exec.op && (i !== 1 || intent !== 'cluster');

  return <div className="stack-l">
    <div className="steps">{STEPS.map((s, i) => <button key={s} type="button" disabled={!reachable(i)} onClick={() => setStep(i)} className={`s ${i === step ? 'on' : i < step ? 'done' : ''}`}>{i < step ? <Icon n="check" s={14} /> : null}{s}</button>)}</div>
    {step > 0 && step < 4 ? <div className="rsum small"><span><Icon n="restore" s={14} /> {INTENTS.find(x => x.id === intent)?.title}</span>{step > 1 && scope !== 'instance' ? <span>{whatTxt}</span> : null}{step > 2 ? <span>{whenTxt}</span> : null}</div> : null}

    {step === 0 && <Card title="What happened?"><div className="stack">
      <p className="muted">Pick the situation closest to yours. pg_arca guides you step by step and <strong>does not change the current data</strong> until you confirm it, at the end.</p>
      <div className="grid choices">{INTENTS.map(x => <button key={x.id} className="choice" aria-pressed={intent === x.id} onClick={() => choose(x.id)}><Icon n={x.icon} s={22} /><div><strong>{x.title}</strong><p className="sub">{x.text}</p></div></button>)}</div>
    </div></Card>}

    {step === 1 && <Card title={intent === 'database' ? 'Which database?' : intent === 'rows' ? 'Which table?' : 'What was dropped or truncated?'}><div className="stack">
      {intent === 'table' ? <RecentDrops op={fx.op} busy={fx.busy} onPick={pickEvent} /> : null}
      {dbsR.op && dbsR.op.status === 'succeeded' ? <>
        <Field label="Database"><DbPicker dbs={dbs} live={live} drops={drops} dropsState={dropsR.busy ? 'running' : dropsR.op?.status === 'succeeded' ? 'done' : dropsR.op ? 'failed' : 'idle'} value={db} onChange={n => { setDb(n); setObjs([]); setTgt(null); prev.reset(); }} /></Field>
        {selDropped && selDb ? <DroppedNote db={db} info={drops[String(selDb.oid)]} lastStop={selDb.last_stop} /> : null}
        {db && ((c.databases || []) as any[]).some(x => x.name === db && x.restoring) ? <Banner kind="warn" title="Database left by an interrupted restore">{db} was created by a restore that did not complete: its content is incomplete. Restoring it makes no sense: drop this database and run the original restore again.</Banner> : null}
        {selDb?.late ? <Banner kind="info" title="Created after the last backup">No backup contains <strong>{db}</strong>: pg_arca rebuilds it from the archived WAL alone. This works for any point in time after it was created.</Banner> : null}
        {scope === 'object' && db ? <>
          {intent === 'table' ? <div className="seg" role="group" aria-label="Tables or schemas"><button aria-pressed={objMode === 'table'} onClick={() => { setObjMode('table'); setObjs([]); }}>Tables</button><button aria-pressed={objMode === 'schema'} onClick={() => { setObjMode('schema'); setObjs([]); }}>A whole schema</button></div> : null}
          <ObjectPicker r={selDb?.late ? null : objR.op} busy={selDb?.late ? liveR.busy : objR.busy} search={search} setSearch={setSearch} db={db} value={objs} onChange={v => { setObjs(intent === 'rows' ? v.filter(x => !objs.includes(x)).slice(-1) : v); setTgt(null); }} mode={objMode} live={objLive} drops={tblDrops} dropsBusy={tdropR.busy} err={objR.error} />
          {intent === 'rows' ? <p className="small muted">Rows are recovered one table at a time: the one with the wrong rows.</p> : null}</> : null}</> :
        <OpPanel op={dbsR.op} error={dbsR.error} label="Reading the backup catalog" />}
      <div className="row"><Button onClick={() => setStep(0)}>Back</Button><div className="grow" /><Button kind="primary" disabled={!okWhat} onClick={() => setStep(2)}>Next</Button></div></div></Card>}

    {step === 2 && <Card title={intent === 'rows' ? 'When were the rows changed?' : intent === 'table' ? 'Back to when?' : 'To which point in time?'}><div className="stack">
      {intent === 'rows' || intent === 'table' ? <WalScanState op={intent === 'rows' ? dml.op : fx.op} busy={intent === 'rows' ? dml.busy : fx.busy} found={suggestions.length}
        what={intent === 'rows' ? `DELETEs and UPDATEs of at least ${num(dmlMin)} rows in the last 24 hours` : `drops and truncations in the last ${Math.round(fxHours / 24)} days`}
        more={intent === 'rows' ? () => { dml.reset(); setDmlMin(10); setTimeout(() => dml.run('wal_forensics', { mode: 'dml', hours: 168, min_rows: 10, limit: 30 }), 0); } : () => { setFxHours(720); fx.run('wal_forensics', { mode: 'events', hours: 720, limit: 30 }); }} /> : null}
      <div className="stack-s" role="radiogroup" aria-label="Recovery target">
        {tgt && (tgt.mode === 'lsn' || tgt.mode === 'xid') && !suggestions.some(s => s.key === tgtKey(tgt)) ? <label className="opt on"><input type="radio" checked readOnly /><div className="grow"><div><strong>Just before: {tgt.label}</strong></div><div className="small muted">Picked from the WAL search: everything committed before it is kept.</div></div></label> : null}
        {suggestions.map((s, i) => <label key={s.key} className={`opt ${tgtKey(tgt) === s.key ? 'on' : ''}`}><input type="radio" checked={tgtKey(tgt) === s.key} onChange={() => setTgt(s.tgt)} /><div className="grow">
          <div><strong>Just before: {s.title}</strong> {i === 0 ? <Badge kind="ok">Recommended</Badge> : null}</div>
          <div className="small muted">{Number.isFinite(s.at) ? `${s.exact ? '' : 'about '}${fmtWhen(s.at)} · ${ago2(s.at)}` : 'time not recorded in the WAL'}. You go back to the exact state of a moment before: everything committed before it is kept.</div></div></label>)}
        <label className={`opt ${tgt?.mode === 'latest' ? 'on' : ''}`}><input type="radio" checked={tgt?.mode === 'latest'} onChange={() => setTgt({ mode: 'latest' })} /><div className="grow">
          <div><strong>{selDropped ? 'Just before it was dropped' : 'The latest saved point'}</strong> {!suggestions.length && (intent === 'database' || intent === 'cluster') ? <Badge kind="ok">Recommended</Badge> : null}</div>
          <div className="small muted">{selDropped ? <>pg_arca finds the DROP of <strong>{db}</strong> in the WAL by itself and stops just before it.</> : <>Up to the last archived transaction ({d.archiver?.last_archived_time ? ago2(Date.parse(d.archiver.last_archived_time)) : 'just now'}).</>}</div>
          {tgt?.mode === 'latest' && (intent === 'rows' || (intent === 'table' && goneNow === false)) ? <div className="hba-warn small" style={{ marginTop: 4 }}>Careful: the latest point already contains the mistake. Pick an earlier point in time.</div> : null}</div></label>
        <label className={`opt ${tgt?.mode === 'time' ? 'on' : ''}`}><input type="radio" checked={tgt?.mode === 'time'} onChange={() => setTgt({ mode: 'time', ms: Math.max(from, Date.now() - 3600e3) })} /><div className="grow">
          <div><strong>A specific point in time</strong></div>
          {tgt?.mode === 'time' ? <div className="stack-s" style={{ marginTop: 6 }} onClick={e => e.preventDefault()}>
            <div className="row wrap gap-s">{[[15, '15 minutes ago'], [60, '1 hour ago'], [240, '4 hours ago'], [1440, 'this time yesterday']].map(([m, t]) => <Button key={m} sm onClick={() => setTgt({ mode: 'time', ms: Math.max(from, Date.now() - (m as number) * 60000) })}>{t}</Button>)}</div>
            <Field label={`Date and time (${tzName()})`} error={!okWhen ? 'Outside the recoverable window: from ' + fmtWhen(from) + ' to now.' : null}>
              <input className="input" type="datetime-local" step={1} min={localInput(from)} max={localInput(to)} value={localInput(tgt.ms)} onChange={e => { const ms = new Date(e.target.value).getTime(); if (Number.isFinite(ms)) setTgt({ mode: 'time', ms }); }} /></Field>
          </div> : <div className="small muted">Pick a date and time: you can go back to any point from {fmtWhen(from)} to now.</div>}</div></label>
      </div>
      {selDb && !selDb.late && selDb.first_stop && tgt?.mode === 'time' && tgt.ms < Date.parse(selDb.first_stop) ? <Banner kind="warn" title={`${db} appears in the backups only since ${fmtWhen(Date.parse(selDb.first_stop))}`}>It may not exist yet at this point in time: in that case the restore stops and says so.</Banner> : null}
      <Details k={`${K}:when-adv`} summary="Backup timeline and advanced WAL search">
        <div className="stack" style={{ marginTop: 10 }}>
          <RecoveryTimeline sets={sets} from={from} to={to} value={tgt?.mode === 'time' ? tgt.ms : null} onChange={ms => setTgt(ms == null ? { mode: 'latest' } : { mode: 'time', ms })} events={events} broken={d.wal?.continuous === false} />
          <div className="small muted">The ticks are backups, the coloured area is the recoverable window. Base backup for the current choice: {baseSet ? <span className="mono">{baseSet.id}</span> : <span style={{ color: 'var(--bad)' }}>none before this point in time</span>}</div>
          <ForensicsTools fx={fx} dml={dml} fxHours={fxHours} setFxHours={setFxHours} dmlMin={dmlMin} setDmlMin={setDmlMin} onPick={t => setTgt(t)} />
        </div></Details>
      <div className="row"><Button onClick={() => setStep(intent === 'cluster' ? 0 : 1)}>Back</Button><div className="grow" /><Button kind="primary" disabled={!okWhen || (!baseSet && tgt?.mode === 'time')} onClick={goCheck}>Next</Button></div></div></Card>}

    {step === 3 && <div className="stack-l">
      <Card title="Review and confirm"><div className="stack">
        <div className="rplan">
          <p>You recover {whatTxt}, {whenTxt}.</p>
          <ol className="small">{fixServer() ? <><li>The server is rebuilt as it was <strong>next to the current data</strong>, on the same disk, while production keeps running.</li><li>Then pg_arca <strong>stops PostgreSQL</strong>, swaps the rebuilt data in for the current data and starts it again: it recovers up to the chosen point and comes back as primary, on the same port and address. Applications are down only during this step.</li><li>The previous data is kept in a safety directory next to it (to go back); if the server does not start, pg_arca puts everything back as it was by itself.</li></>
            : scope === 'instance' ? <><li>A full copy of the server is rebuilt in the directory chosen below (pg_arca proposes the best-suited disk).</li><li>pg_arca <strong>starts</strong> the copy on a free port, isolated from production: it does not archive, replicate or run jobs. The running server is not touched.</li><li>{ttl ? <>It stays available for {TTL_CHOICES.find(x => x[0] === ttl)?.[1] || `${ttl} hours`}, then pg_arca stops and deletes it (you can keep it longer at any time).</> : <>It stays until you delete it.</>}</li></>
            : scope === 'database' ? <><li>pg_arca rebuilds database {fin === 'fix' ? <strong>{db}</strong> : <>into the new database <strong>{newName || '…'}</strong></>} as it was at that point.</li><li>{live?.has(db) ? <>The current {db} database stays as it is for now.</> : <>No existing database is touched.</>}</li><li>{fin === 'fix' ? (live?.has(db) ? <>At the end it takes the place of <strong>{db}</strong> (open sessions are terminated; the current {db} is kept as a safety copy).</> : <>It comes back under its own name, <strong>{db}</strong>.</>) : <>You check it and, if it is fine, swap it in for the original with one click.</>}</li></>
            : intent === 'rows' ? <><li>The table is rebuilt as it was in a separate quarantine database.</li><li>{fin === 'fix' ? 'pg_arca compares row by row and brings back every row deleted or updated after that point (rows inserted afterwards are kept).' : 'You compare the recovered version with the current one row by row and bring back only the rows you choose.'}</li><li>Before the table is touched, a safety copy of the affected rows is saved; everything runs in a single transaction.</li></>
            : <><li>{objs.length === 1 ? 'The selection is rebuilt' : 'The selected tables are rebuilt'}, with what they depend on, in a separate quarantine database.</li><li>No current table is changed at this stage.</li><li>{fin === 'fix' ? <>At the end pg_arca puts it back into <strong>{db}</strong> by itself{finMode() === 'replace' ? ' (the current one is kept under another name)' : finMode() === 'as_new' ? ', next to the original' : ''}.</> : <>Then you decide how to put it back.</>}</li></>}</ol>
        </div>
        {scope === 'instance' ? <ServerEnd fin={patroni ? 'copy' : fin} setFin={setFin} patroni={patroni} /> : null}
        {scope !== 'instance' ? <EndChoice fin={fin} setFin={setFin} kind={scope === 'database' ? 'database' : intent === 'rows' ? 'rows' : 'objects'} db={db} exists={dbExists()} newName={newName}
          mode={finMode()} setMode={m => setPmode(m)} gone={goneNow} what={objs.length === 1 ? shortName(obj) : `${objs.length} objects`} /> : null}
        {scope === 'database' && fin === 'copy' ? <Field label="New database name" hint="Never overwrites an existing database." error={newName && !okName ? 'Letters, digits and _ only (max 63 characters), no spaces.' : null}><div className="row gap-s"><input className="input" value={newName} onChange={e => setNewName(e.target.value)} onBlur={check} /><Button sm icon="refresh" busy={plan.busy} onClick={check}>Check again</Button></div></Field> : null}
        {fixServer() && pres?.replace ? <ReplaceFacts r={pres.replace} /> : null}
        {scope === 'instance' && !fixServer() ? <>
          <Field label="Where to put the copy">{pres?.destinations ? <DestPicker where={pres.destinations} value={destNow()} onPick={pickDest} busy={plan.busy} /> : plan.busy || !plan.op ? <p className="small muted">Looking for disks with enough free space on the server…</p> : null}</Field>
          <Field label="What to do with the copy"><div className="seg"><button aria-pressed={action === 'promote'} onClick={() => setAction('promote')}>Use it right away</button><button aria-pressed={action === 'pause'} onClick={() => setAction('pause')}>Check it first (stays paused)</button></div></Field>
          <p className="small muted" style={{ marginTop: -6 }}>{action === 'promote' ? 'Once it reaches the chosen point it becomes a normal read-write server.' : 'It pauses at the chosen point, read-only: you check the data and then decide whether to finish recovery.'}</p>
          <Field label="How long to keep it"><div className="seg">{TTL_CHOICES.map(([h, t]) => <button key={h} aria-pressed={ttl === h} onClick={() => setTtl(h)}>{t}</button>)}</div></Field>
          <Details k={`${K}:inst-adv`} summary="Advanced options"><div className="stack" style={{ marginTop: 8 }}>
            <label className="check"><input type="checkbox" checked={delta} onChange={e => setDelta(e.target.checked)} />Delta restore onto an already restored directory (copies only what differs)</label>
            <label className="check"><input type="checkbox" checked={keepArch} onChange={e => setKeepArch(e.target.checked)} />This copy will replace the original server: keep WAL archiving enabled (pg_arca does not start it: you start it in its final place)</label>
            <p className="small muted">{keepArch ? 'Once started, the copy will archive into the same WAL archive as production: do this only if the original server will not come back.' : 'By default the copy starts with WAL archiving off, no synchronous standbys to wait for, no primary to follow, no active logical replication subscriptions and no libraries that act on other servers by themselves (pg_cron…): you can start it next to production without affecting it.'}</p></div></Details></> : null}
        {pres && (plan.op?.status === 'succeeded' || plan.busy) ? <div className={plan.busy ? 'stale' : ''} aria-busy={plan.busy} title={plan.busy ? 'Checking again…' : undefined}><Verdict p={pres} /></div> : <OpPanel op={plan.op} error={plan.error} label="Pre-flight checks" />}
        {scope === 'database' && pres && (pres.missing_roles || []).length ? <div>
          <label className="check"><input type="checkbox" checked={mkRoles} onChange={e => setMkRoles(e.target.checked)} />Create the missing roles ({(pres.missing_roles as string[]).slice(0, 6).join(', ')}{pres.missing_roles.length > 6 ? '…' : ''}) as placeholders, to keep owners and privileges</label>
          <p className="small muted" style={{ marginTop: -6 }}>{mkRoles ? 'The roles are created without login (NOLOGIN), without a password and without membership in other roles: a dropped account never becomes active again, its objects only keep owner and privileges.' : 'Without these roles, the objects of the restored database will be owned by the agent’s user and lose the privileges granted on them.'}</p></div> : null}
        {pres ? <Details k={`${K}:tech`} summary="Technical details (backups used, disk space, where recovery runs)"><div className="stack" style={{ marginTop: 10 }}>
          <PlanView p={pres} scope={scope} />{scope !== 'instance' ? <RecoveryPlacement clusterId={c.id} /> : null}</div></Details> : null}
        {plan.op?.status === 'failed' && scope === 'instance' && /PGA-RST-040/.test(String(plan.op.error || '')) && !exec.op ? <Banner kind="info" title="That directory holds an interrupted restore" actions={<Button sm icon="restore" onClick={() => { setStep(4); exec.run('restore_instance', { ...params().p, resume: true }); }}>Resume it</Button>}>When resuming, pg_arca completes the copy by writing only what is missing or different. To start from scratch, empty the directory or choose another one.</Banner> : null}
        <div className="row"><Button onClick={() => setStep(2)}>Back</Button><div className="grow" />{blocked ? <span className="small" style={{ color: 'var(--bad)' }}>Resolve the items in red to proceed</span> : null}
          <Button kind="primary" icon="restore" disabled={blocked || plan.op?.status !== 'succeeded' || !okWhere} onClick={() => setAsk(true)}>Start the restore</Button></div></div></Card>
    </div>}

    {step === 4 && <Card title="Restore"><div className="stack"><OpPanel op={exec.op} error={exec.error} cancel={exec.cancel} />
      {doneOk ? <Banner kind="ok" title="Restore completed">{scope === 'instance' && exec.op!.result.replace?.replaced ? <>The production server is back as it was {whenTxt} and is <strong>primary</strong> again, on the same port. The previous data is kept in <code>{exec.op!.result.replace.old_kept_as}</code>.
          <ul className="small" style={{ margin: '6px 0 0 18px' }}>{(exec.op!.result.replace.steps || []).map((x: string, i: number) => <li key={i}>{itCheck(x)}</li>)}</ul>
          <p className="small">pg_arca takes a new full backup by itself on the next run (production is on a new timeline).</p></>
        : scope === 'instance' ? (exec.op!.result.instance ? <>The server copy is <strong>{exec.op!.result.instance.state === 'paused' ? 'paused at the chosen point' : 'running'}</strong>: the connection details are below.</> : <>Copy ready in <code>{exec.op!.result.destination}</code>{exec.op!.result.start_hint ? <>: start it in its final place (<code>{exec.op!.result.start_hint}</code>).</> : '.'}</>)
        : scope === 'database' ? (exec.op!.result.swap?.replaced ? <><strong>{db}</strong> is back as it was {whenTxt}. {exec.op!.result.swap.old_kept_as ? <>The database as it was before the restore is kept as <code>{exec.op!.result.swap.old_kept_as}</code> (drop it once you have checked){exec.op!.result.swap.sessions_ended ? `; sessions terminated: ${exec.op!.result.swap.sessions_ended}` : ''}.</> : null}</>
            : exec.op!.result.result_database === db ? <><strong>{db}</strong> is back under its own name, as it was {whenTxt}.</>
            : <>Database <code>{exec.op!.result.result_database}</code> is ready: check it and swap it in for {db} below. {live?.has(db) ? <>The original <code>{db}</code> has not been touched.</> : null}</>)
        : exec.op!.result.finished === 'promote' ? <>{objs.length === 1 ? <strong>{shortName(obj)}</strong> : <>{objs.length} objects</>} back in place in <strong>{db}</strong>, as it was {whenTxt}.
            {(exec.op!.result.finish?.promoted || []).length ? <> Restored: {(exec.op!.result.finish.promoted as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}.</> : null}
            {(exec.op!.result.finish?.old_kept || []).length ? <> The previous versions are kept as {(exec.op!.result.finish.old_kept as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}: drop them once you have checked.</> : null}</>
        : exec.op!.result.finished === 'rows_all' ? <>Rows of <strong>{shortName(obj)}</strong> brought back as they were {whenTxt}: {num(exec.op!.result.finish?.inserted ?? 0)} re-inserted, {num(exec.op!.result.finish?.updated ?? 0)} reverted.{exec.op!.result.finish?.safety_copy ? <> The replaced versions are kept in <code>{exec.op!.result.finish.safety_copy}</code>.</> : null}{exec.op!.result.finish?.note ? <div className="small">{itCheck(exec.op!.result.finish.note)}</div> : null}</>
        : <>Recovered into the quarantine database <code>{exec.op!.result.result_database}</code>. Now choose below how to put it back.</>}</Banner> : null}
      {doneOk && (exec.op!.result.finish_error || exec.op!.result.swap_error) ? <Banner kind="warn" title="Recovered, but not put back">
        <span style={{ whiteSpace: 'pre-wrap' }}>{itCheck(exec.op!.result.finish_error || exec.op!.result.swap_error)}</span>{hintFor(exec.op!.result.finish_error || exec.op!.result.swap_error) ? <p className="small">{hintFor(exec.op!.result.finish_error || exec.op!.result.swap_error)}</p> : null}
        <p className="small">Nothing in the original database has been touched. The recovered content is intact: choose below how to proceed.</p></Banner> : null}
      {scope === 'instance' && exec.op && (exec.op.params?.replace_production) && (doneOk || exec.op.status === 'failed') ? <KeptDirs clusterId={c.id} nodeId={exec.op.nodeId} initial={exec.op.result?.replace?.kept} /> : null}
      {doneOk && scope === 'instance' && exec.op!.result.instance ? <RestoredCard clusterId={c.id} r={{ ...exec.op!.result.instance, ...((d.restored || []).find((x: any) => x.id === exec.op!.result.instance.id) || { nodeId: exec.op!.nodeId, nodeName: '', online: true }) }} /> : null}
      {doneOk ? <Notices r={exec.op!.result} /> : null}
      {doneOk && scope === 'database' && exec.op!.result.result_database && exec.op!.result.result_database !== db ? <SwapDb clusterId={c.id} restored={exec.op!.result.result_database} original={db} exists={!!live?.has(db)} /> : null}
      {doneOk && scope === 'object' && exec.op!.result.result_database && !exec.op!.result.finished ? (intent === 'rows' && objs.length === 1 && splitId(obj).length === 3 ? <>
        <RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} auto />
        <Details k={`${K}:whole`} summary="Or bring back the whole table">
          <Promote stage={exec.op!.result.result_database} what={objs} deps={exec.op!.result.dependencies} warnings={exec.op!.result.warnings} mode={pmode || 'as_new'} recommended="as_new" anyGone={goneNow} setMode={m => { setPmode(m); prev.reset(); }} drop={pdrop} setDrop={setPdrop} runner={prom} preview={prev} ask={() => setAskPromote(true)} allowOrphans={lastPromote.current ? () => setAskOrphans(true) : undefined} schema={pschema} setSchema={v => { setPschema(v); prev.reset(); }} /></Details></> : <>
        <Promote stage={exec.op!.result.result_database} what={objs} deps={exec.op!.result.dependencies} warnings={exec.op!.result.warnings} mode={pmode || recommendedMode(goneNow)} recommended={recommendedMode(goneNow)} anyGone={goneNow} setMode={m => { setPmode(m); prev.reset(); }} drop={pdrop} setDrop={setPdrop} runner={prom} preview={prev} ask={() => setAskPromote(true)} allowOrphans={lastPromote.current ? () => setAskOrphans(true) : undefined} schema={pschema} setSchema={v => { setPschema(v); prev.reset(); }} />
        {objs.length === 1 && splitId(obj).length === 3 && goneNow !== true ? <Details k={`${K}:somerows`} summary="Recover only some rows"><RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} /></Details> : null}</>) : null}
      <Result op={exec.op} />
      {scope === 'instance' && exec.op && ['failed', 'cancelled'].includes(exec.op.status) && /PGA-RST-040|cancel|interrott|interrupt|No space|ENOSPC|PGA-RST-03/i.test(String(exec.op.error || '')) ? <Banner kind="info" title="Restore interrupted" actions={<Button sm icon="restore" onClick={() => exec.run('restore_instance', { ...(exec.op!.params || params().p), resume: true })}>Resume where it stopped</Button>}>
        The partial copy in <code>{(exec.op.params || {}).destination || dest}</code> is recognised: when resuming, pg_arca writes only what is missing or different (useful after a cancellation, a full disk that was freed, or an agent restart).</Banner> : null}
      {exec.op && exec.op.status === 'failed' && !running ? <div><Button onClick={() => { exec.reset(); setStep(3); check(); }}>Back to the checks</Button></div> : null}
      {(exec.op && !running) ? <div><Button onClick={restart}>New restore</Button></div> : null}</div></Card>}

    {askOrphans ? <Confirm title="Proceed leaving orphaned rows?" danger requireText="ORPHANS" confirmLabel="Proceed" onClose={() => setAskOrphans(false)} onConfirm={() => { setAskOrphans(false); prom.run('restore_promote', { ...lastPromote.current, allow_orphans: true }); }}>
      <p>The tables are replaced anyway. The foreign keys involved stay <strong>NOT VALID</strong>: the orphaned rows remain until you fix them by hand, and the application may run into them.</p></Confirm> : null}
    {askPromote ? (() => { const m = pmode || (intent === 'rows' ? 'as_new' : recommendedMode(goneNow)); return <Confirm title="Bring back into the database?" danger={m === 'replace'} requireText={m === 'replace' ? 'REPLACE' : undefined} confirmLabel="Bring back" onClose={() => setAskPromote(false)} onConfirm={() => { setAskPromote(false); setLastPromote({ stage_db: exec.op!.result.result_database, object: obj, mode: m, drop_stage: pdrop, ...(m === 'replace' ? { confirm: 'REPLACE' } : {}), ...(m === 'as_new' && pschema ? { target_schema: pschema } : {}) }); prom.run('restore_promote', { stage_db: exec.op!.result.result_database, object: obj, mode: m, drop_stage: pdrop, ...(m === 'replace' ? { confirm: 'REPLACE' } : {}), ...(m === 'as_new' && pschema ? { target_schema: pschema } : {}) }); }}>
      <p>{m === 'as_new' ? <>The recovered tables appear next to the originals with a name ending in <code>_pitr_&lt;date&gt;</code>. Nothing existing is touched.</> : m === 'missing_only' ? <>Only the tables that no longer exist come back, under their own names; the existing ones stay as they are.</> : <>The current tables are renamed <code>_old_&lt;date&gt;</code> (their data is kept, you can go back) and the recovered ones take their place in a single transaction. Foreign keys and views are re-attached.</>}</p>
      <p className="small muted">{pdrop ? 'The quarantine database is dropped once the operation succeeds.' : 'The quarantine database stays available.'}</p></Confirm>; })() : null}
    {ask ? <Confirm title="Start the restore?" confirmLabel="Start" danger={overwrites()} requireText={overwrites() ? 'REPLACE' : undefined} onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); const x = params(); setStep(4); exec.run(x.type, x.p); }}>
      <p>{fixServer() ? <>Rebuilds the server as it was {whenTxt} and puts it <strong>in place of production</strong>: PostgreSQL is stopped, restarted on the restored data and comes back as primary. The current data is kept in a safety directory.</>
        : scope === 'instance' ? <>Rebuilds the server in <code>{destNow()}</code> and starts it{keepArch ? ' (no: with archiving enabled you start it yourself)' : ''}. The current data is not changed.</>
        : scope === 'database' ? (fin === 'fix' && dbExists() ? <>Rebuilds <code>{db}</code> as it was and puts it <strong>in place</strong> of the current one: open sessions on <code>{db}</code> are terminated, the current one is kept as <code>{db}_before_…</code>.</> : fin === 'fix' ? <>Brings <code>{db}</code> back under its own name.</> : <>Creates database <code>{newName}</code> from <code>{db}</code>. The current data is not changed.</>)
        : intent === 'rows' && fin === 'fix' ? <>Brings back into <code>{shortName(obj)}</code> every row deleted or updated after that point (safety copy first, a single transaction).</>
        : fin === 'fix' ? <>Puts {objs.length === 1 ? <code>{shortName(obj)}</code> : <>{objs.length} objects</>} back into <code>{db}</code>{finMode() === 'replace' ? <> <strong>in place</strong> of the current versions (which are kept, renamed)</> : finMode() === 'as_new' ? ' next to the current versions' : ' (only what is missing)'}.</>
        : <>Rebuilds {objs.length === 1 ? <code>{shortName(obj)}</code> : <>{objs.length} objects</>} in a quarantine database. The current data is not changed.</>} If anything fails before the end, whatever was created is removed.</p></Confirm> : null}
  </div>;
}

const recommendedMode = (gone: boolean | null): PMode => gone === true ? 'missing_only' : gone === false ? 'replace' : 'as_new';

/** "A table is gone": what the WAL says was dropped or emptied recently, one click to recover it as it was just before. */
function RecentDrops({ op, busy, onPick }: { op: Op | null; busy: boolean; onPick: (e: any) => void }) {
  const evs = (op?.status === 'succeeded' ? op.result.events || [] : []).filter((e: any) => (e.names || []).some((n: string) => splitId(n).length === 3)).slice(-6).reverse();
  if (busy || (op && !isTerminalOp(op))) return <div className="small muted row gap-s"><Icon n="refresh" spin s={14} />Searching the WAL for recently dropped or truncated tables…</div>;
  if (!evs.length) return op?.status === 'succeeded' ? <p className="small muted">The WAL of the last few days shows no dropped or truncated tables: pick the database and table below.</p> : null;
  return <div className="recent"><div className="small"><strong>Found in the WAL recently</strong> — click to recover it as it was just before</div>
    {evs.map((e: any, i: number) => { const t = parseWalTime(e.time); const names: string[] = (e.names || []).filter((n: string) => splitId(n).length === 3);
      return <button key={i} className="recentrow" onClick={() => onPick(e)}><Badge kind="bad">{e.rewrite_possible ? 'truncated or rewritten' : e.kind === 'TRUNCATE' ? 'truncated' : 'dropped'}</Badge>
        <span className="grow"><strong>{names.slice(0, 3).map(shortName).join(', ')}</strong>{names.length > 3 ? ` and ${names.length - 3} more` : ''} <span className="faint">in {splitId(names[0])[0]}</span></span>
        <span className="small faint nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'about ' : ''}${fmtWhen(t)} · ${ago2(t)}` : ''}</span><span className="small" style={{ color: 'var(--accent)' }}>Recover</span></button>; })}</div>;
}
const isTerminalOp = (o: Op) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(o.status);

/** What the automatic WAL search is doing / found, with "look further back". */
function WalScanState({ op, busy, found, what, more }: { op: Op | null; busy: boolean; found: number; what: string; more: () => void }) {
  if (busy || (op && !isTerminalOp(op))) return <div className="small muted row gap-s"><Icon n="refresh" spin s={14} />Searching the WAL for {what}…</div>;
  if (!op) return null;
  if (op.status !== 'succeeded') return <p className="small muted">The automatic WAL search failed ({op.error || op.status}): pick a specific point in time.</p>;
  return found ? <p className="small muted">Searched for {what}: here is what was found.</p>
    : <p className="small muted">No events found ({what}). <button className="linkbtn" onClick={more}>Search further back</button> or pick a specific point in time.</p>;
}

/** The full WAL forensics, for those who want to look for themselves (advanced). */
function ForensicsTools({ fx, dml, fxHours, setFxHours, dmlMin, setDmlMin, onPick }: { fx: ReturnType<typeof useOpRunner>; dml: ReturnType<typeof useOpRunner>; fxHours: number; setFxHours: (h: number) => void; dmlMin: number; setDmlMin: (n: number) => void; onPick: (t: Target) => void }) {
  return <div className="stack">
    <strong className="small">Drops and truncations (DROP, TRUNCATE)</strong>
    <div className="row wrap"><span className="seg" role="group" aria-label="How far back to search">{[[24, 'Last 24 hours'], [168, '7 days'], [720, '30 days'], [0, 'Whole archive']].map(([h, t]) => <button key={h} aria-pressed={fxHours === h} onClick={() => setFxHours(h as number)}>{t}</button>)}</span>
      <Button sm icon="search" busy={fx.busy} onClick={() => fx.run('wal_forensics', { mode: 'events', hours: fxHours, limit: 30 })}>Start the scan</Button></div>
    {fx.op && fx.op.status !== 'succeeded' ? <OpPanel op={fx.op} error={fx.error} cancel={fx.cancel} /> : null}
    {fx.op?.status === 'succeeded' ? <>
      <div className="small muted">{num(fx.op.result.segments_scanned)} segments scanned{fx.op.result.segments_cached ? ` (${num(fx.op.result.segments_cached)} already cached)` : ''} in {fx.op.result.elapsed_sec} s{fx.op.result.window?.from ? ` · since ${fx.op.result.window.from}` : ''}</div>
      {fx.op.result.complete === false ? <Banner kind="warn" title="Partial scan">The time limit was reached: run the search again to continue where it stopped.</Banner> : null}
      {fx.op.result.events.length ? <table className="t"><thead><tr><th>Event</th><th>Objects</th><th>When</th><th /></tr></thead><tbody>
        {[...fx.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); return <tr key={i}><td><Badge kind="bad" title={e.rewrite_possible ? 'The WAL of a TRUNCATE and that of a table rewrite (VACUUM FULL, CLUSTER, ALTER TABLE changing a type) are identical: check whether maintenance was running at that time.' : undefined}>{e.rewrite_possible ? 'Table truncated or rewritten' : KIND_LABEL[e.kind] || e.kind}</Badge></td><td className="small">{(e.names || []).join(', ') || '—'}{e.nrels > (e.names || []).length ? ` and ${e.nrels - e.names.length} more` : ''}</td>
          <td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'about ' : ''}${fmtWhen(t)}` : e.time}</td>
          <td className="num"><Button sm onClick={() => onPick({ mode: 'lsn', lsn: e.lsn, label: `${KIND_LABEL[e.kind] || e.kind} ${(e.names || [])[0] || ''} (${Number.isFinite(t) ? fmtWhen(t) : e.lsn})` })}>Restore to just before</Button></td></tr>; })}</tbody></table>
        : <p className="muted small">No drop or truncation found in the scanned period.</p>}</> : null}
    <strong className="small">Mass deletes or updates (DELETE or UPDATE without WHERE)</strong>
    <p className="small muted">Committed transactions that deleted or updated many rows of a table. Restoring to “just before” excludes that transaction; rolled-back transactions do not appear.</p>
    <div className="row wrap"><span className="seg" role="group" aria-label="Minimum rows">{[[100, '100+ rows'], [1000, '1,000+'], [10000, '10,000+'], [100000, '100,000+']].map(([n, t]) => <button key={n} aria-pressed={dmlMin === n} onClick={() => setDmlMin(n as number)}>{t}</button>)}</span>
      <Button sm icon="search" busy={dml.busy} onClick={() => dml.run('wal_forensics', { mode: 'dml', hours: fxHours, min_rows: dmlMin, limit: 30 })}>Search for mass changes</Button></div>
    {dml.op && dml.op.status !== 'succeeded' ? <OpPanel op={dml.op} error={dml.error} cancel={dml.cancel} /> : null}
    {dml.op?.status === 'succeeded' ? (dml.op.result.events.length ? <table className="t"><thead><tr><th>What</th><th>Table</th><th>When</th><th /></tr></thead><tbody>
      {[...dml.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); const what = e.kind === 'DELETE' ? `${num(e.deleted)} rows deleted` : e.kind === 'UPDATE' ? `${num(e.updated)} rows updated` : `${num(e.deleted)} deleted, ${num(e.updated)} updated`;
        return <tr key={i}><td><Badge kind="bad">{what}</Badge>{e.committed === false ? <div className="small faint">commit not found in the nearby WAL</div> : null}</td><td className="small">{(e.names || []).join(', ')}</td><td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'about ' : ''}${fmtWhen(t)}` : e.time}</td>
          <td className="num"><Button sm onClick={() => onPick({ mode: 'xid', xid: String(e.xid), lsn: e.lsn, label: `${what} in ${(e.names || [])[0] || ''} (${Number.isFinite(t) ? fmtWhen(t) : 'xid ' + e.xid})` })}>Restore to just before</Button></td></tr>; })}</tbody></table>
      : <p className="muted small">No transaction deleted or updated at least {num(dml.op.result.min_rows)} rows in the period ({num(dml.op.result.segments_scanned)} segments scanned).</p>) : null}
  </div>;
}

/** The verdict of the checks, in plain words: ready / ready with something to know / blocked (and the way out). */
function Verdict({ p }: { p: any }) {
  const pf = p.preflight; const warn = (pf?.checks || []).filter((x: any) => x.level === 'warn'); const bad = (pf?.checks || []).filter((x: any) => x.level === 'bad');
  if (p.missing_wal?.length) return <Banner kind="bad" title="Cannot restore to this point in time">{p.missing_wal.length} WAL files are missing from the archive (the first: <code>{p.missing_wal[0]}</code>): recovery cannot cross that gap. Pick an earlier point in time or another backup.</Banner>;
  return <div className="stack-s">
    {bad.length ? <Banner kind="bad" title="Something must be fixed first">{bad.map((x: any) => <div key={x.id}>{itCheck(x.text)}{x.fix ? <div className="fix small">What to do: {itFix(x.fix)}</div> : null}</div>)}</Banner>
      : <Banner kind="ok" title={warn.length ? (warn.length === 1 ? 'Ready: read the note below' : `Ready: read the ${warn.length} notes below`) : 'All set'}>The required backup and WAL are available{pf ? ` (checks passed: ${pf.checks.filter((x: any) => x.level === 'ok').length})` : ''}.{p.extract_bytes ? ` About ${bytes(p.extract_bytes)} will be extracted.` : p.bytes ? ` About ${bytes(p.bytes)} will be written.` : ''}</Banner>}
    {warn.length ? <div className="preflight warn" role="group" aria-label="Good to know"><ul>{warn.map((x: any) => <li key={x.id} className="warn"><Icon n="alert" s={14} /><span><span>{itCheck(x.text)}</span>{x.fix ? <span className="fix small">{itFix(x.fix)}</span> : null}</span></li>)}</ul></div> : null}
  </div>;
}

const ROLE_LABEL: Record<string, string> = { scratch: 'recovery instance (extraction, WAL, dump)', data: 'production cluster data', dest: 'restore destination', tablespace: 'relocated tablespaces' };
type Vol = { paths: string[]; roles: string[]; need: number; free: number; total: number; free_after?: number };
/** Disk space per FILESYSTEM: what is used now, what the restore will write, what is left. Two folders on the same volume are one bar (their needs add up). */
export function SpaceBars({ vols }: { vols?: Vol[] }) {
  if (!vols || !vols.length) return null;
  return <div className="spacebars" role="group" aria-label="Disk space">
    <div className="ph"><strong>Disk space</strong><span className="small faint">measured on the server, per volume</span></div>
    {vols.map((v, i) => {
      const used = Math.max(0, v.total - v.free); const after = v.free - v.need; const live = v.roles.includes('data');
      const pct = (x: number) => `${Math.max(0, Math.min(100, (100 * x) / Math.max(v.total, 1)))}%`;
      const tone = after < 0 ? 'bad' : (live ? after < Math.max(0.05 * v.total, 2 ** 30) : after < 0.02 * v.total) ? 'bad' : live && after < 0.1 * v.total ? 'warn' : 'ok';
      return <div key={i} className={`vol ${tone}`}>
        <div className="row small"><span className="grow"><strong>{v.roles.map(r => ROLE_LABEL[r] || r).join(' + ')}</strong><span className="faint"> — {v.paths.join(', ')}</span></span>
          <span className="nowrap">{after < 0 ? <><strong>{bytes(-after)}</strong> short</> : <><strong>{bytes(after)}</strong> left ({Math.round((100 * after) / Math.max(v.total, 1))}%)</>}</span></div>
        <div className="bar" aria-hidden="true"><i className="used" style={{ width: pct(used) }} /><i className="need" style={{ width: pct(Math.min(v.need, Math.max(v.free, 0))) }} />{after < 0 ? <i className="over" style={{ width: pct(-after) }} /> : null}</div>
        <div className="small faint">used {bytes(used)} · needed {bytes(v.need)} · free now {bytes(v.free)} of {bytes(v.total)}{live ? ' · production cluster volume: at least 5% must stay free' : ''}</div>
      </div>; })}
  </div>;
}

/** The checks the agent ran before the long recovery: what is fine, what deserves attention, what blocks (with the way out). */
function Preflight({ pf }: { pf: { level: string; ok: boolean; checks: { id: string; level: string; text: string; fix?: string }[] } }) {
  const order: Record<string, number> = { bad: 0, warn: 1, ok: 2 };
  const list = [...pf.checks].sort((a, b) => order[a.level] - order[b.level]);
  const n = (l: string) => pf.checks.filter(c => c.level === l).length;
  return <div className={`preflight ${pf.level}`} role="group" aria-label="Pre-flight checks">
    <div className="ph"><strong>Pre-flight checks</strong><span className="small faint">{n('ok')} ok{n('warn') ? ` · ${n('warn')} to review` : ''}{n('bad') ? ` · ${n('bad')} blocking` : ''}</span></div>
    <ul>{list.map(c => <li key={c.id} className={c.level}><Icon n={c.level === 'ok' ? 'check' : 'alert'} s={14} /><span><span>{itCheck(c.text)}</span>{c.fix && c.level !== 'ok' ? <span className="fix small">{itFix(c.fix)}</span> : null}</span></li>)}</ul></div>;
}

function PlanView({ p, scope }: { p: any; scope: Scope }) {
  const saved = p.saved_pct;
  return <div className="stack">
    {p.missing_wal?.length ? <Banner kind="bad" title="WAL missing">{`${p.missing_wal.length} segments that were never archived are needed.`}</Banner>
      : p.preflight?.ok === false ? <Banner kind="bad" title="Cannot start yet">The backup and WAL are there, but a pre-flight check blocks the restore: see below what to do.</Banner>
        : <Banner kind="ok" title="Restore possible">The base backup and the required WAL are available.</Banner>}
    {p.preflight?.checks?.length ? <Preflight pf={p.preflight} /> : null}
    <SpaceBars vols={p.space} />
    <dl className="kv"><dt>Target</dt><dd>{p.target === 'end of archive' ? 'latest available' : Number.isFinite(Date.parse(p.target)) ? new Date(p.target).toLocaleString('en-GB') : p.target}</dd>
      <dt>Base backup</dt><dd><span className="mono">{p.set}</span></dd>
      <dt>Chain</dt><dd className="mono small">{(p.chain || []).join(' → ')}</dd>
      {scope === 'instance' ? <><dt>Data to extract</dt><dd>{bytes(p.bytes)} in {num(p.files)} files</dd></> : <><dt>Data to extract</dt><dd>{bytes(p.extract_bytes)} of the cluster’s {bytes(p.cluster_bytes)}{saved != null ? <> — <strong>{saved}% less</strong></> : null}</dd></>}
      {p.tablespaces && Object.keys(p.tablespaces).length ? <><dt>Tablespace</dt><dd className="small">{Object.entries(p.tablespaces).map(([oid, path]: any) => <div key={oid}><span className="mono">{oid}</span> → <span className="mono">{String(path)}</span>{(p.tablespaces_relocated || []).includes(oid) ? <> <Badge kind="warn" title="The original directory belongs to the source server: it is never overwritten">relocated</Badge></> : null}</div>)}</dd></> : null}
      {p.destination_free_bytes != null ? <><dt>Free space</dt><dd>{bytes(p.destination_free_bytes)} at the destination{p.space_warning ? <span className="small" style={{ display: 'block', color: 'var(--warn, #d9a441)' }}>{p.space_warning}</span> : null}</dd></> : null}
      {p.destination_database ? <><dt>New database</dt><dd>{p.destination_database}</dd></> : null}{p.quarantine_database ? <><dt>Quarantine</dt><dd>{p.quarantine_database}</dd></> : null}</dl></div>;
}

const Gone = ({ info, busy, lastLabel }: { info?: DropInfo; busy?: boolean; lastLabel?: string }) => { const t = info ? parseWalTime(info.time) : NaN;
  return <span className="gonechip"><span className="dropped">DROPPED</span><span className="when small">{Number.isFinite(t) ? `${info!.time_exact ? '' : 'about '}${fmtWhen(t)}` : busy ? 'working out the date…' : lastLabel || ''}</span></span>; };

function ObjectPicker({ r, busy, search, setSearch, db, value, onChange, mode, live, drops, dropsBusy, err }: { r: Op | null; busy: boolean; search: string; setSearch: (s: string) => void; db: string; value: string[]; onChange: (v: string[]) => void; mode: 'table' | 'schema';
  live: { tables: Set<string>; schemas: Set<string>; all: boolean; objects?: { schema: string; table: string }[] } | null; drops: Record<string, DropInfo>; dropsBusy: boolean; err?: string | null }) {
  // the backup catalog + the tables that exist now and in no backup (created after it: restorable from the WAL alone)
  const schemas: any[] = useMemo(() => {
    const cat: any[] = r?.status === 'succeeded' ? (r.result.schemas || []).map((sc: any) => ({ ...sc, objects: [...(sc.objects || [])] })) : [];
    const ql = search.trim().toLowerCase();
    for (const o of live?.objects || []) {
      if (ql && !`${o.schema}.${o.table}`.toLowerCase().includes(ql)) continue;
      let sc = cat.find(x => x.name === o.schema);
      if (sc?.objects.some((x: any) => x.name === o.table || (x.parts || []).some((p: any) => p.name === o.table))) continue;   // a partition is listed under its table
      if (!sc) { sc = { name: o.schema, objects: [], late: true }; cat.push(sc); }
      sc.objects.push({ name: o.table, late: true });
    }
    return cat;
  }, [r, live, search]);
  const has = (id: string) => value.includes(id);
  const toggleTable = (id: string) => onChange(has(id) ? value.filter(x => x !== id) : [...value, id]);
  const toggleSchema = (sch: string, tablesIds: string[]) => { const sid = qid(db, sch); onChange(mode === 'schema' ? (has(sid) ? value.filter(x => x !== sid) : [...value, sid]) : has(sid) ? value.filter(x => x !== sid) : [...value.filter(x => !tablesIds.includes(x)), sid]); };
  const tableGone = (id: string) => !!live && (live.all || !live.tables.has(id));
  const schemaGone = (sid: string) => !!live && (live.all || !live.schemas.has(sid));
  // a dropped schema was dropped together with its tables: the latest table drop is when it went
  const schemaDrop = (sid: string, ids: string[]): DropInfo => { let best: DropInfo = null; for (const id of ids) { const d = drops[id]; if (d && (!best || parseWalTime(d.time) > parseWalTime(best.time))) best = d; } return best; };
  const nGone = schemas.reduce((n, sc) => n + (schemaGone(qid(db, sc.name)) ? 1 : 0), 0);
  return <div className="stack"><Field label={mode === 'schema' ? 'Schemas' : 'Tables'} hint={mode === 'schema' ? 'Pick one or more schemas: tables, foreign keys, views, sequences and privileges are restored together.' : 'Tick one or more tables. Dependencies are included automatically.'}><input className="input" placeholder="Search by name" value={search} onChange={e => setSearch(e.target.value)} /></Field>
    {live && !live.all && schemas.length && (nGone || schemas.some(sc => sc.objects.some((o: any) => tableGone(qid(db, sc.name, o.name))))) ? <p className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Some {mode === 'schema' ? 'schemas' : 'tables'} are in the backups but no longer on the server: they are marked DROPPED.</p> : null}
    <div className={`tree ${mode}`}>{busy && !schemas.length ? <div style={{ padding: 12 }} className="muted">Reading the catalog…</div> : null}
      {schemas.map(s => { const sid = qid(db, s.name); const whole = has(sid); const ids = s.objects.map((o: any) => qid(db, s.name, o.name)); const sg = schemaGone(sid);
        return <div key={s.name}><label className={`sch ${sg ? 'gone' : ''}`}><input type="checkbox" checked={whole} onChange={() => toggleSchema(s.name, ids)} /> <strong>{s.name}</strong>{s.tables != null ? <span className="faint small"> — {s.tables} {s.tables === 1 ? 'table' : 'tables'}, {bytes(s.bytes)}{whole && mode === 'table' ? ' · whole schema' : ''}</span> : null}
          {sg ? <Gone info={schemaDrop(sid, ids)} busy={dropsBusy} lastLabel="dropped" /> : live ? <span className="here small">Present</span> : null}</label>
          {mode === 'table' ? s.objects.map((o: any) => { const id = qid(db, s.name, o.name); const on = whole || has(id); const g = tableGone(id);
            const kindTag = o.kind === 'v' ? 'view' : o.kind === 'm' ? 'materialized view' : null;
            return <React.Fragment key={id}><button aria-pressed={on} disabled={whole} onClick={() => toggleTable(id)} className={g ? 'gone' : ''}><input type="checkbox" readOnly checked={on} tabIndex={-1} /><span className="grow">{o.name}{kindTag ? <span className="faint small" style={{ marginLeft: 8 }}>{kindTag}</span> : null}{o.late ? <span className="here small" title="Not in any backup: it is rebuilt from the archived WAL" style={{ marginLeft: 8 }}>after the last backup</span> : null}</span>{g && !sg ? <Gone info={drops[id]} busy={dropsBusy} lastLabel="dropped" /> : null}<span className="faint small">{o.partitions ? `${o.partitions} partitions · ` : ''}{o.kind === 'v' ? '' : bytes(o.size)}</span></button>
              {o.parts?.length ? <details className="parts" style={{ marginLeft: 28 }}><summary className="small" style={{ cursor: 'pointer' }}>Only some partitions ({o.parts.length})</summary>
                <p className="small muted" style={{ margin: '4px 0' }}>A partition restored on its own is re-attached to the current table with the same bounds; today’s partition is kept, detached, with the _old suffix.</p>
                {o.parts.map((pt: any) => { const pid = qid(db, s.name, pt.name); const pon = whole || on || has(pid);
                  return <button key={pid} aria-pressed={pon} disabled={whole || on} onClick={() => toggleTable(pid)} style={{ paddingLeft: 8 + 16 * (pt.depth || 0) }}><input type="checkbox" readOnly checked={pon} tabIndex={-1} /><span className="grow">{pt.name}{pt.kind === 'p' ? <span className="faint small" style={{ marginLeft: 8 }}>with subpartitions</span> : null}</span>{tableGone(pid) && !g ? <Gone info={drops[pid]} busy={dropsBusy} lastLabel="dropped" /> : null}</button>; })}
              </details> : null}</React.Fragment>; }) : null}</div>; })}
      {r?.status === 'succeeded' && !schemas.length ? <div style={{ padding: 12 }} className="muted">No matches.</div> : null}
      {r?.status === 'failed' ? <div style={{ padding: 12 }} className="muted">{r.error}</div> : null}{!r && err ? <div style={{ padding: 12, color: 'var(--bad)' }}>{err}</div> : null}</div>
    {r?.result?.truncated ? <p className="small muted">List truncated: refine the search.</p> : null}
    {value.length ? <p className="small">Selection: {value.map(v => { const p = splitId(v); return <code key={v} style={{ marginRight: 6 }}>{p.slice(1).join('.')}{p.length === 2 ? ' (schema)' : ''}</code>; })}</p> : null}
    <p className="small muted">What you choose is restored together with what it needs to work: foreign keys, types, functions, sequences, views and privileges.</p></div>;
}

type PMode = 'as_new' | 'replace' | 'missing_only';

/** What the recovery itself found worth saying: a target past the archive, a database dropped right after the requested point. */
function Notices({ r }: { r: any }) {
  return <>{r.target_clamped ? <Banner kind="warn" title="Restored up to the end of the archive">{r.target_clamped.message}</Banner> : null}
    {r.stopped_before_drop ? <Banner kind="info" title="Stopped just before the DROP DATABASE">{r.stopped_before_drop.message}</Banner> : null}
    {(r.warnings || []).length ? <Banner kind="warn" title="Good to know">{(r.warnings as string[]).map((w, i) => <div key={i} className="small">{itCheck(w)}</div>)}</Banner> : null}</>;
}

const ACTION: Record<string, string> = { swap: 'replaces', create: 'is created', copy: 'copy alongside', skip: 'already present: unchanged' };

function PromotePlan({ p }: { p: any }) {
  return <div className="stack">{p.preflight?.checks?.length && p.preflight.level !== 'ok' ? <Preflight pf={p.preflight} /> : null}<SpaceBars vols={p.space} /><table className="t"><thead><tr><th>Table</th><th>What happens</th><th className="num">Rows at the target</th></tr></thead><tbody>
    {(p.tables || []).map((t: any) => <tr key={`${t.schema}.${t.name}`}><td><code>{t.schema}.{t.name}</code></td><td className="small">{ACTION[t.action] || t.action}{t.old_kept_as ? <> — the current one is kept as <code>{t.old_kept_as}</code></> : null}{t.new_name ? <> as <code>{t.new_name}</code></> : null}{t.schema_drift ? <div className="hba-warn small" style={{ marginTop: 4 }}>Structure changed since then{t.schema_drift.columns_only_now?.length ? `: columns added later (${t.schema_drift.columns_only_now.join(', ')}) that the replacement removes` : ''}{t.schema_drift.type_changed?.length ? `; type changed: ${t.schema_drift.type_changed.join(', ')}` : ''}. Consider “next to the originals” or row recovery.</div> : null}</td><td className="num">{t.rows_at_target != null ? num(t.rows_at_target) : '—'}</td></tr>)}</tbody></table>
    <dl className="kv"><dt>Foreign keys to re-attach</dt><dd>{num((p.inbound_fks || []).length + (p.outbound_fks || []).length)}{(p.inbound_fks || []).length ? <span className="small muted"> — {(p.inbound_fks as any[]).slice(0, 4).map(f => `${f.table}→${f.ref_table}`).join(', ')}{p.inbound_fks.length > 4 ? '…' : ''}</span> : null}</dd>
      <dt>Views to recreate</dt><dd>{num((p.views || []).length)}{(p.views || []).length ? <span className="small muted"> — {(p.views as any[]).slice(0, 4).map(v => v.name).join(', ')}{p.views.length > 4 ? '…' : ''}</span> : null}</dd>
      {p.missing_prereq && Object.values(p.missing_prereq).some((x: any) => x.length) ? <><dt>To create first</dt><dd className="small">{Object.entries(p.missing_prereq).filter(([, v]: any) => v.length).map(([k, v]: any) => `${k}: ${v.join(', ')}`).join(' · ')}</dd></> : null}</dl>
    {(p.rebind || []).length ? <div className="small"><strong>Re-attached to the restored table:</strong> {(p.rebind as string[]).join(' · ')}</div> : null}
    {(p.blocking || []).length ? <Banner kind="bad" title="The promotion cannot start">{(p.blocking as string[]).map((w, i) => <div key={i} className="small">{itCheck(w)}</div>)}</Banner> : null}
    {(p.warnings || []).map((w: string, i: number) => <div key={i} className="small" style={{ color: 'var(--warn, #d9a441)' }}>{itCheck(w)}</div>)}</div>;
}

const PROMOTE_OPT: Record<PMode, { title: string; text: string }> = {
  missing_only: { title: 'Put back what was dropped', text: 'Tables that no longer exist come back under their own names, foreign keys and views included. Existing ones are not touched.' },
  replace: { title: 'Replace with the recovered version', text: 'The current tables are set aside with the _old_<date> suffix (the data is kept, you can go back) and the recovered ones take their place. Foreign keys and views are re-attached.' },
  as_new: { title: 'Place alongside to compare', text: 'The recovered tables appear next to the originals with the _pitr_<date> suffix (or in a separate schema). Nothing existing is touched: compare, then decide.' },
};

function Promote({ stage, what, deps, warnings, mode, recommended, anyGone, setMode, drop, setDrop, runner, preview, ask, allowOrphans, schema, setSchema }: { allowOrphans?: () => void; stage: string; what: string[]; deps?: any; warnings?: string[]; mode: PMode; recommended: PMode; anyGone: boolean | null; setMode: (m: PMode) => void; drop: boolean; setDrop: (b: boolean) => void; runner: ReturnType<typeof useOpRunner>; preview: ReturnType<typeof useOpRunner>; ask: () => void; schema: string; setSchema: (s: string) => void }) {
  const r = runner.op?.result; const done = runner.op?.status === 'succeeded';
  const p = preview.op?.status === 'succeeded' ? preview.op.result : null;
  const schemaOk = !schema || /^[a-z_][a-z0-9_]{0,62}$/.test(schema);
  // the preview (what exactly would change) is computed by itself for the chosen way, nothing is changed by it
  useEffect(() => { if (done || runner.busy || !schemaOk) return; const t = setTimeout(() => preview.run('restore_promote', { stage_db: stage, mode, dry_run: true, ...(mode === 'as_new' && schema ? { target_schema: schema } : {}) }), schema ? 500 : 0); return () => clearTimeout(t); }, [mode, schema, stage]);
  const order: PMode[] = [recommended, ...(['missing_only', 'replace', 'as_new'] as PMode[]).filter(m => m !== recommended)].filter(m => m !== 'missing_only' || anyGone !== false);
  return <div className="stack"><div className="hr" /><strong>Put it back</strong>
    <p className="small muted">The recovered data is in the quarantine database <code>{stage}</code>{deps ? <> ({deps.tables} tables, {deps.foreign_keys} foreign keys, {deps.views} views)</> : null}. Choose how to bring it back into <code>{what[0] ? splitId(what[0])[0] : ''}</code>.</p>
    {!done ? <>
      {order.map(m => <label key={m} className={`opt ${mode === m ? 'on' : ''}`}><input type="radio" checked={mode === m} onChange={() => setMode(m)} /><div className="grow"><div><strong>{PROMOTE_OPT[m].title}</strong> {m === recommended ? <Badge kind="ok">Recommended</Badge> : null}</div><div className="small muted">{PROMOTE_OPT[m].text}</div>
        {m === 'as_new' && mode === 'as_new' ? <div className="row gap-s" style={{ marginTop: 6 }} onClick={e => e.preventDefault()}><span className="small">Separate schema (optional)</span><input className="input mono" style={{ width: 220 }} value={schema} onChange={e => setSchema(e.target.value.toLowerCase())} placeholder="e.g. recovered_yesterday" aria-label="Target schema" />{!schemaOk ? <span className="small hba-err">lowercase letters, digits and _ only</span> : null}</div> : null}</div></label>)}
      {preview.op && !p ? <OpPanel op={preview.op} error={preview.error} label="What would change" /> : null}
      {p ? <details open={!!(p.blocking || []).length || (p.tables || []).some((t: any) => t.schema_drift)}><summary className="small" style={{ cursor: 'pointer' }}>What exactly would change ({(p.tables || []).length} tables, {num((p.inbound_fks || []).length + (p.outbound_fks || []).length)} foreign keys, {num((p.views || []).length)} views)</summary><PromotePlan p={p} /></details> : null}
      <label className="check"><input type="checkbox" checked={drop} onChange={e => setDrop(e.target.checked)} />Drop the quarantine database once the operation succeeds</label>
      <div className="row"><div className="grow" /><Button kind="primary" icon="restore" busy={runner.busy} disabled={runner.busy || !p || p?.preflight?.ok === false || !!(p?.blocking || []).length} title={p?.preflight?.ok === false ? 'Not enough space: see the details' : undefined} onClick={ask}>Bring back</Button></div></> : null}
    {(runner.op || runner.error) && !done ? <OpPanel op={runner.op} error={runner.error} label="Bringing back into the database" /> : null}
    {runner.op?.status === 'failed' && /PGA-GEN-096/.test(String(runner.op.error || '')) && allowOrphans ? <Banner kind="warn" title="Rows that would be orphaned" actions={<Button sm kind="danger" onClick={allowOrphans}>Proceed anyway</Button>}>
      You can still replace the tables, knowing those rows will be orphaned: the foreign keys involved will be left NOT VALID. Safer: restore the related tables together, or choose “Place alongside to compare”.</Banner> : null}
    {done ? <Banner kind="ok" title="Brought back into the database">{(r?.promoted || []).length ? <>Restored: {(r.promoted as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}.</> : <>{r?.note || 'Nothing to do.'}</>}
      {(r?.old_kept || []).length ? <> The previous ones are kept as {(r.old_kept as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}: drop them once you have checked.</> : null}
      {r?.foreign_keys_reattached ? <> {r.foreign_keys_reattached} foreign keys re-attached.</> : null}{r?.views_recreated ? <> {r.views_recreated} views recreated.</> : null}
      {(r?.plan?.warnings || warnings || []).length ? <span className="hba-warn"> {(r.plan?.warnings || warnings).map((w: string) => itCheck(w)).join(' · ')}</span> : null}</Banner> : null}
    {done ? <Result op={runner.op} /> : null}</div>;
}

const keyStr = (k: any[]) => JSON.stringify(k);
const brief = (o: any) => { const t = JSON.stringify(o); return t.length > 140 ? t.slice(0, 140) + '…' : t; };
function RowRecovery({ clusterId, stage, obj, auto }: { clusterId: string; stage: string; obj: string; auto?: boolean }) {
  const RK = `rows:${clusterId}:${stage}:${obj}`;
  const diff = useOpRunner(clusterId, undefined, RK + ':diff'); const apply = useOpRunner(clusterId, undefined, RK + ':apply');
  useEffect(() => { if (auto && !diff.op && !diff.busy) diff.run('restore_diff', { stage_db: stage, object: obj, limit: 200 }); }, [auto, stage, obj]);
  const [pick, setPick] = useDraft<Record<string, boolean>>(RK + ':pick', {}); const [del, setDel] = useDraft<Record<string, boolean>>(RK + ':del', {}); const [ask, setAsk] = useState(false);
  const [askAll, setAskAll] = useState(false); const [delAdded, setDelAdded] = useState(false);
  const d = diff.op?.status === 'succeeded' ? diff.op.result : null;
  const rest = Object.keys(pick).filter(k => pick[k]); const dels = Object.keys(del).filter(k => del[k]);
  const done = apply.op?.status === 'succeeded'; const r = apply.op?.result;
  const all = (rows: any[], on: boolean, set: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void) => set(x => { const n = { ...x }; rows.forEach(w => { n[keyStr(w.key)] = on; }); return n; });
  const list = (title: string, hint: string, rows: any[], state: Record<string, boolean>, set: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void, show: (w: any) => string, total: number) => rows.length || total ? <div className="stack">
    <div className="row"><strong>{title}</strong><Badge>{num(total)}</Badge><div className="grow" />{rows.length ? <><Button onClick={() => all(rows, true, set)}>Select all</Button><Button onClick={() => all(rows, false, set)}>None</Button></> : null}</div>
    <p className="small muted">{hint}{total > rows.length ? ` Showing the first ${rows.length} of ${num(total)}.` : ''}</p>
    {rows.map(w => <label key={keyStr(w.key)} className="check"><input type="checkbox" checked={!!state[keyStr(w.key)]} onChange={e => set(x => ({ ...x, [keyStr(w.key)]: e.target.checked }))} /><span><code>{keyStr(w.key)}</code> <span className="small muted">{show(w)}</span></span></label>)}</div> : null;
  return <div className="stack"><div className="hr" /><strong>Recover only some rows</strong>
    <p className="small muted">Compare the restored table (<code>{stage}</code>) with the current one and bring back only the rows you choose. Before anything is touched, the current versions are copied into a safety table; everything happens in a single transaction.</p>
    {!d && !done ? <div><Button icon="search" busy={diff.busy} disabled={diff.busy} onClick={() => diff.run('restore_diff', { stage_db: stage, object: obj, limit: 200 })}>Compare row by row</Button></div> : null}
    {(diff.op || diff.error) && !d ? <OpPanel op={diff.op} error={diff.error} label="Row comparison" /> : null}
    {d && !done ? <>
      <Banner kind={d.counts.missing_now + d.counts.changed + d.counts.added_since ? 'info' : 'ok'} title={d.counts.missing_now + d.counts.changed + d.counts.added_since ? 'Differences found' : 'The tables match'}>
        {d.key_from && d.key_from !== 'primary key' ? <>No primary key: rows matched by the unique index <code>{String(d.key_from).replace(/^unique index /, '')}</code> (<code>{d.primary_key.join(', ')}</code>)</> : <>Primary key <code>{d.primary_key.join(', ')}</code></>}: {num(d.restored_rows)} rows in the restore, {num(d.live_rows)} now. {d.columns_only_in_one_side.length ? <span className="hba-warn">Columns present on one side only (ignored in the comparison): {d.columns_only_in_one_side.join(', ')}.</span> : null}</Banner>
      {d.counts.missing_now + d.counts.changed ? <div className="row wrap gap-s"><Button kind="primary" icon="restore" onClick={() => setAskAll(true)}>Bring back all rows as they were ({num(d.counts.missing_now + d.counts.changed)})</Button>
        <span className="small muted">{num(d.counts.missing_now)} to re-insert, {num(d.counts.changed)} to revert{d.counts.missing_now + d.counts.changed > (d.missing_now.length + d.changed.length) ? ', including those not listed below' : ''}. Or pick individual rows.</span></div> : null}
      {list('Deleted after that point', 'They existed in the restore and are gone now: select them to re-insert them.', d.missing_now, pick, setPick, (w: any) => brief(w.restored), d.counts.missing_now)}
      {list('Updated', 'The restored value overwrites the current one (which is kept in the safety table).', d.changed, pick, setPick, (w: any) => `now ${brief(w.live)} → restored ${brief(w.restored)}`, d.counts.changed)}
      {list('Inserted after that point', 'They did not exist in the restore. Select them only if you want to delete them.', d.added_since, del, setDel, (w: any) => brief(w.live), d.counts.added_since)}
      <div className="row"><div className="grow" /><Button kind="primary" icon="restore" disabled={!rest.length && !dels.length} onClick={() => setAsk(true)}>Apply {rest.length + dels.length ? `(${rest.length + dels.length})` : ''}</Button></div></> : null}
    {(apply.op || apply.error) && !done ? <OpPanel op={apply.op} error={apply.error} label="Applying the rows" /> : null}
    {done ? <Banner kind="ok" title="Rows recovered">{num(r?.inserted ?? 0)} re-inserted, {num(r?.updated ?? 0)} reverted, {num(r?.deleted ?? 0)} deleted.{r?.safety_copy ? <> Previous version kept in <code>{r.safety_copy}</code>.</> : null}{r?.note ? <div className="small" style={{ marginTop: 4 }}>{itCheck(r.note)}</div> : null}</Banner> : null}
    {askAll && d ? <Confirm title="Bring back all rows as they were?" danger={delAdded} confirmLabel="Bring back" onClose={() => setAskAll(false)} onConfirm={() => { setAskAll(false); apply.run('restore_apply_rows', { stage_db: stage, object: obj, restore_all: ['missing', 'changed'], ...(delAdded ? { delete_all_added: true } : {}) }); }}>
      <p>{num(d.counts.missing_now)} deleted rows are re-inserted and {num(d.counts.changed)} updated rows are reverted to their value at that point, in a single transaction. The current versions of the affected rows are first copied into a <code>pgarca_rowsafe_…</code> table.</p>
      {d.counts.added_since ? <label className="check"><input type="checkbox" checked={delAdded} onChange={e => setDelAdded(e.target.checked)} />Also delete the {num(d.counts.added_since)} rows inserted after that point (usually not: they are new, valid data)</label> : null}</Confirm> : null}
    {ask ? <Confirm title="Apply the selected rows?" danger={dels.length > 0} confirmLabel="Apply" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); apply.run('restore_apply_rows', { stage_db: stage, object: obj, restore_keys: rest, delete_keys: dels }); }}>
      <p>{rest.length} rows will be re-inserted or overwritten with the restored version{dels.length ? <>, {dels.length} rows inserted later will be deleted</> : null}. The current version of every affected row is first copied into a <code>pgarca_rowsafe_…</code> table; if anything fails, nothing changes.</p></Confirm> : null}</div>;
}

/** What the restore does at the END: repair the original (the default - the tool finishes the job) or only produce a copy to look at. */
function EndChoice({ fin, setFin, kind, db, exists, newName, mode, setMode, gone, what }: { fin: 'fix' | 'copy'; setFin: (v: 'fix' | 'copy') => void; kind: 'database' | 'rows' | 'objects'; db: string; exists: boolean; newName: string;
  mode: PMode; setMode: (m: PMode) => void; gone: boolean | null; what: string }) {
  const fixTitle = kind === 'database' ? (exists ? `Replace ${db} with the recovered one` : `Bring ${db} back under its own name`) : kind === 'rows' ? 'Bring back all rows as they were' : `Put back into ${db}`;
  const fixText = kind === 'database' ? (exists ? `Open sessions on ${db} are terminated and the recovered database takes its name. The current one is kept as ${db}_before_<date> so you can go back.` : 'The dropped database comes back exactly as it was, under the same name.')
    : kind === 'rows' ? 'Re-inserts the deleted rows and reverts the updated ones to their value at that point. Rows inserted later are kept. The current versions are first saved into a safety table.'
    : mode === 'missing_only' ? 'Only what no longer exists comes back, under its own name; what exists stays as it is.' : mode === 'replace' ? 'The current versions are renamed (kept, so you can go back) and the recovered ones take their place, with foreign keys and views re-attached.' : 'The recovered versions appear next to the current ones with the _pitr_<date> suffix: nothing existing is touched.';
  const copyTitle = kind === 'database' ? `Only a copy to check (${newName || '…'})` : kind === 'rows' ? 'Compare and pick the rows myself' : 'Only a copy to check (quarantine database)';
  return <Field label="When done"><div className="stack-s" role="radiogroup" aria-label="When done">
    <label className={`opt ${fin === 'fix' ? 'on' : ''}`}><input type="radio" name="fin" checked={fin === 'fix'} onChange={() => setFin('fix')} /><div className="grow">
      <div><strong>{fixTitle}</strong> <Badge kind="ok">Recommended</Badge></div><div className="small muted">{fixText}</div>
      {fin === 'fix' && kind === 'objects' ? <div className="seg" style={{ marginTop: 6 }} role="group" aria-label={`How to put back ${what}`}>
        <button aria-pressed={mode === 'missing_only'} onClick={e => { e.preventDefault(); setMode('missing_only'); }}>Only what is missing{gone === true ? ' (recommended)' : ''}</button>
        <button aria-pressed={mode === 'replace'} onClick={e => { e.preventDefault(); setMode('replace'); }}>Replace the current ones{gone === false ? ' (recommended)' : ''}</button>
        <button aria-pressed={mode === 'as_new'} onClick={e => { e.preventDefault(); setMode('as_new'); }}>Next to the current ones</button></div> : null}</div></label>
    <label className={`opt ${fin === 'copy' ? 'on' : ''}`}><input type="radio" name="fin" checked={fin === 'copy'} onChange={() => setFin('copy')} /><div className="grow">
      <div><strong>{copyTitle}</strong></div><div className="small muted">{kind === 'database' ? 'The recovered database stays next to the original; once you have checked it, you swap it in with one click.' : kind === 'rows' ? 'You see the differences row by row and bring back only the ones you choose.' : 'You check the recovered content and then decide how to put it back.'}</div></div></label>
  </div></Field>;
}

function ServerEnd({ fin, setFin, patroni }: { fin: 'fix' | 'copy'; setFin: (v: 'fix' | 'copy') => void; patroni: boolean }) {
  return <Field label="When done"><div className="stack-s" role="radiogroup" aria-label="When done">
    <label className={`opt ${fin === 'fix' ? 'on' : ''} ${patroni ? 'dis' : ''}`}><input type="radio" name="sfin" disabled={patroni} checked={fin === 'fix'} onChange={() => setFin('fix')} /><div className="grow">
      <div><strong>Repair the production server</strong> {!patroni ? <Badge kind="ok">Recommended</Badge> : null}</div>
      <div className="small muted">{patroni ? 'Not available on a Patroni cluster: there you restore a database or a table (they go back into the running cluster), or rebuild the cluster from a copy.' : 'Production itself goes back to how it was: same server, same port, primary again. Short downtime; the current data is kept in a safety directory.'}</div></div></label>
    <label className={`opt ${fin === 'copy' ? 'on' : ''}`}><input type="radio" name="sfin" checked={fin === 'copy'} onChange={() => setFin('copy')} /><div className="grow">
      <div><strong>Only a temporary copy to inspect</strong></div><div className="small muted">Started next to production on another port, isolated: production is not touched.</div></div></label>
  </div></Field>;
}

const HOW_LABEL: Record<string, string> = { systemd: 'through its systemd service', pg_ctl: 'with pg_ctl, using the same start options' };
function ReplaceFacts({ r }: { r: any }) {
  return <div className="stack-s">
    <dl className="kv small">
      <dt>Production data</dt><dd><code>{r.data_directory}</code></dd>
      <dt>Stop and restart</dt><dd>{HOW_LABEL[r.method] || r.method}{r.unit ? <> (<code>{r.unit}</code>)</> : null}</dd>
      <dt>Current state</dt><dd>{r.was_running ? 'running' : <strong>stopped</strong>}</dd>
      {r.carry_unarchived_wal ? <><dt>WAL not yet archived</dt><dd>handed to recovery after the stop: nothing committed is lost</dd></> : null}
    </dl>
    {(r.warnings || []).map((w: string, i: number) => <Banner key={i} kind="warn">{itCheck(w)}</Banner>)}
    {(r.kept || []).length ? <p className="small muted">{r.kept.length} directories kept from earlier replacements already exist: they take up space on the same disk (you find them after the restore).</p> : null}
  </div>;
}

/** Data directories kept by a production replacement: the way back, and disk space to give back once the result is verified. */
function KeptDirs({ clusterId, nodeId, initial }: { clusterId: string; nodeId?: string; initial?: { path: string; kind: string }[] }) {
  const ls = useOpRunner(clusterId, undefined, `kept:${clusterId}`); const rm = useOpRunner(clusterId, () => ls.run('restore_kept_list', {}, { nodeId }));
  const [ask, setAsk] = useState<string | null>(null);
  const list: { path: string; kind: string }[] = ls.op?.status === 'succeeded' ? ls.op.result.kept || [] : initial || [];
  if (!list.length) return null;
  const KIND: Record<string, string> = { before: 'data from before the replacement', failed: 'failed attempt', partial: 'interrupted rebuild' };
  return <Card title="Kept directories"><div className="stack-s">
    <p className="small muted">They sit on the same disk as production. Delete them once you have verified the server is as you need it: after that there is no going back.</p>
    {list.map(k => <div key={k.path} className="row wrap gap-s"><code className="grow">{k.path}</code><span className="small muted">{KIND[k.kind] || k.kind}</span><Button sm icon="trash" busy={rm.busy && ask === null} onClick={() => setAsk(k.path)}>Delete</Button></div>)}
    {rm.op && rm.op.status === 'failed' ? <OpPanel op={rm.op} error={rm.error} /> : null}
    {ask ? <Confirm title="Delete the directory?" danger requireText={ask.split('/').pop()} confirmLabel="Delete" onClose={() => setAsk(null)} onConfirm={() => { const p = ask; setAsk(null); rm.run('restore_kept_drop', { path: p, confirm: p.split('/').pop() }, { nodeId }); }}>
      <p><code>{ask}</code> is deleted permanently.</p></Confirm> : null}
  </div></Card>;
}

/** A recovered database next to the original: put it in its place with one click (the tool renames both; the original is kept as <db>_before_<ts>). */
function SwapDb({ clusterId, restored, original, exists }: { clusterId: string; restored: string; original: string; exists: boolean }) {
  const r = useOpRunner(clusterId, undefined, `swapdb:${clusterId}:${restored}`); const [ask, setAsk] = useState(false);
  const done = r.op?.status === 'succeeded'; const res = r.op?.result;
  return <div className="stack-s">
    {!done ? <div className="row wrap gap-s"><Button kind="primary" icon="swap" busy={r.busy} onClick={() => setAsk(true)}>{exists ? `Swap ${restored} in for ${original}` : `Rename it to ${original}`}</Button>
      <span className="small muted">{exists ? `Open sessions on ${original} are terminated; the current one is kept as ${original}_before_<date>.` : `${original} does not exist now: the recovered database takes its name.`}</span></div> : null}
    {r.op && !done ? <OpPanel op={r.op} error={r.error} /> : r.error ? <Banner kind="bad">{r.error}</Banner> : null}
    {done ? <Banner kind="ok" title={`${original} replaced`}>{res?.old_kept_as ? <>The previous one is kept as <code>{res.old_kept_as}</code> (drop it once you have checked).</> : <>{restored} is now called {original}.</>}{res?.sessions_ended ? ` Sessions terminated: ${res.sessions_ended}.` : ''}</Banner> : null}
    {ask ? <Confirm title={exists ? `Swap ${restored} in for ${original}?` : `Rename ${restored} to ${original}?`} danger={exists} requireText={exists ? 'REPLACE' : undefined} confirmLabel={exists ? 'Replace' : 'Rename'} onClose={() => setAsk(false)}
      onConfirm={() => { setAsk(false); r.run('restore_db_swap', { restored, original, confirm: 'REPLACE' }); }}>
      <p>{exists ? <>Connections to <code>{original}</code> are terminated and refused for a few seconds, then <code>{original}</code> becomes <code>{original}_before_…</code> and <code>{restored}</code> takes its name, in a single transaction. Applications reconnect to the recovered database.</> : <><code>{restored}</code> is renamed to <code>{original}</code>.</>}</p></Confirm> : null}
  </div>;
}
