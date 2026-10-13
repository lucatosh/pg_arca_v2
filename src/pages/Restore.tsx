import { RecoveryPlacement } from './Placement';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Details, Empty, Field, Icon, Skeleton, bytes, dt, num, ago } from '../ui';
import { Op, useDraft, useOpRunner, useQuery } from '../hooks';
import { OpPanel, Result } from './shared';
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
type Target = { mode: 'latest' } | { mode: 'time'; ms: number } | { mode: 'lsn'; lsn: string; label: string } | { mode: 'xid'; xid: string; label: string };
const STEPS = ['Situazione', 'Cosa', 'Quando', 'Controllo', 'Ripristino'];
const KIND_LABEL: Record<string, string> = { DROP: 'Oggetto eliminato o riscritto', TRUNCATE: 'Tabella svuotata', 'DROP DATABASE': 'Database eliminato' };
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'locale'; } };
const localInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 19); };
const ago2 = (ms: number) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'adesso' : m < 60 ? `${m} min fa` : m < 1440 ? `${Math.round(m / 60)} ore fa` : `${Math.round(m / 1440)} giorni fa`; };
const shortName = (id: string) => { const p = splitId(id); return p.slice(1).join('.') || id; };

const INTENTS: { id: Intent; icon: string; title: string; text: string }[] = [
  { id: 'table', icon: 'trash', title: 'Ho eliminato o svuotato una tabella', text: 'Anche uno schema intero. pg_arca cerca da solo quando è successo e la riporta com’era subito prima.' },
  { id: 'rows', icon: 'file', title: 'Ho cancellato o modificato righe per errore', text: 'Un DELETE o un UPDATE sbagliato. Confronti la tabella di prima con quella di adesso e riporti solo le righe che scegli.' },
  { id: 'database', icon: 'db', title: 'Mi serve un database com’era prima', text: 'Eliminato, danneggiato o solo da consultare: torna come nuovo database accanto agli altri, senza toccare nulla.' },
  { id: 'cluster', icon: 'server', title: 'Devo ricostruire tutto il server', text: 'Disastro, migrazione o copia completa: l’intero cluster in una cartella vuota. La produzione non viene toccata.' },
];

/** A point to go back to, found in the WAL: just before a DROP / TRUNCATE / mass DELETE-UPDATE. */
type Sugg = { key: string; title: string; at: number; exact: boolean; tgt: Target };

export function RestoreTab({ c }: { c: any }) {
  const q = useQuery<any>(c.source !== 'direct' && !c.isSandbox ? `/api/clusters/${encodeURIComponent(c.id)}/backups` : null, { interval: 15000 });
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con l’agent per ripristinare.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="restore" title="Serve l’agent">Il ripristino legge il repository sul server del database: installa l’agent su un nodo del cluster.</Empty></Card>;
  if (!q.data) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const sets: SetRow[] = (q.data.backup?.recent_sets || []).filter((s: SetRow) => s.status === 'COMPLETE');
  if (!q.data.agent) return <Card><Empty icon="restore" title="Nessun agent su questo cluster" /></Card>;
  if (!sets.length) return <Card><Empty icon="restore" title="Nessun backup da cui ripristinare">Esegui prima un backup completo dalla scheda Backup.</Empty></Card>;
  return <Wizard c={c} d={q.data} sets={sets} />;
}

function Wizard({ c, d, sets }: { c: any; d: any; sets: SetRow[] }) {
  // everything chosen here survives leaving the page (another tab, a setting opened from the check step, Back): see useDraft
  const K = `restore:${c.id}`;
  const [step, setStep] = useDraft(K + ':step', 0);
  const [intent, setIntent] = useDraft<Intent | null>(K + ':intent', null);
  const [scope, setScope] = useDraft<Scope>(K + ':scope', 'database'); const [objMode, setObjMode] = useDraft<'table' | 'schema'>(K + ':objMode', 'table');
  const [db, setDb] = useDraft(K + ':db', ''); const [objs, setObjs] = useDraft<string[]>(K + ':objs', []); const obj = objs[0] || ''; const [search, setSearch] = useDraft(K + ':search', '');
  const [tgt, setTgt] = useDraft<Target | null>(K + ':tgt', null);
  const [dest, setDest] = useDraft(K + ':dest', ''); const [newName, setNewName] = useDraft(K + ':newName', ''); const [action, setAction] = useDraft<'promote' | 'pause'>(K + ':action', 'promote'); const [delta, setDelta] = useDraft(K + ':delta', false); const [keepArch, setKeepArch] = useDraft(K + ':keepArch', false); const [mkRoles, setMkRoles] = useDraft(K + ':mkRoles', true);
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

  const tparams = (): Record<string, any> => !tgt ? {} : tgt.mode === 'time' ? { target_time: new Date(tgt.ms).toISOString() } : tgt.mode === 'lsn' ? { target_lsn: tgt.lsn, inclusive: false } : tgt.mode === 'xid' ? { target_xid: tgt.xid, inclusive: false } : {};
  const params = (): { type: string; p: Record<string, any> } => scope === 'instance' ? { type: 'restore_instance', p: { destination: dest, action, delta, ...(keepArch ? { keep_archiving: true } : {}), ...tparams() } }
    : scope === 'database' ? { type: 'restore_database', p: { database: db, new_name: newName, ...(mkRoles ? { create_missing_roles: true } : {}), ...tparams() } } : { type: 'restore_object', p: { object: obj, objects: objs, ...tparams() } };
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
      const at = parseWalTime(e.time); const what = e.rewrite_possible ? 'svuotata o riscritta' : e.kind === 'TRUNCATE' ? 'svuotata' : 'eliminata';
      const title = `${shortName(names.find(n => touches([n])) || names[0] || '')} ${what}`;
      out.push({ key: 'lsn:' + e.lsn, title, at, exact: e.time_exact !== false, tgt: { mode: 'lsn', lsn: e.lsn, label: `${title} (${Number.isFinite(at) ? fmtWhen(at) : e.lsn})` } });
    }
    if (intent === 'rows') for (const e of dml.op?.result?.events || []) {
      if (!touches(e.names || [])) continue; const at = parseWalTime(e.time);
      const what = e.kind === 'DELETE' ? `${num(e.deleted)} righe eliminate` : e.kind === 'UPDATE' ? `${num(e.updated)} righe modificate` : `${num(e.deleted)} eliminate e ${num(e.updated)} modificate`;
      out.push({ key: 'xid:' + e.xid, title: `${what} in ${shortName(e.names[0])}`, at, exact: e.time_exact !== false, tgt: { mode: 'xid', xid: String(e.xid), label: `${what} in ${shortName(e.names[0])} (${Number.isFinite(at) ? fmtWhen(at) : 'xid ' + e.xid})` } });
    }
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [intent, fx.op, tdropR.op, dml.op, objs, db, scope]);
  const tgtKey = (t: Target | null) => !t ? '' : t.mode === 'lsn' ? 'lsn:' + t.lsn : t.mode === 'xid' ? 'xid:' + t.xid : t.mode;
  // entering "when": the most recent thing that went wrong is the natural choice; a whole database or server defaults to the latest point
  useEffect(() => { if (step !== 2 || tgt) return; if (suggestions.length) setTgt(suggestions[0].tgt); else if (intent === 'database' || intent === 'cluster') setTgt({ mode: 'latest' }); }, [step, suggestions.length]);

  const okWhat = scope === 'instance' || (scope === 'database' && !!db) || (scope === 'object' && objs.length > 0 && (intent !== 'rows' || (objs.length === 1 && splitId(obj).length === 3)));
  const okName = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(newName);
  const okWhere = scope === 'instance' ? dest.startsWith('/') : scope === 'database' ? okName : true;
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
  const check = () => { if (okWhere) plan.run('restore_plan', planParams()); else plan.reset(); };
  // where the recovery runs changed (from the dialog opened in the check step, or by a colleague): the verdict shown is stale, check again
  const placement = useQuery<any>(scope !== 'instance' ? `/api/clusters/${encodeURIComponent(c.id)}/placement` : null);
  const plSig = placement.data ? JSON.stringify(placement.data.ephemeral || {}) : ''; const plSeen = useRef(plSig);
  useEffect(() => { if (!plSig || plSig === plSeen.current) return; const had = !!plSeen.current; plSeen.current = plSig; if (had && step === 3 && !exec.op && okWhere) check(); }, [plSig]);
  const goCheck = () => { setStep(3); if (scope !== 'instance' || dest.startsWith('/')) plan.run('restore_plan', planParams()); else plan.reset(); };
  const choose = (i: Intent) => {
    setIntent(i); setObjs([]); setTgt(null); plan.reset(); dml.reset(); prev.reset();
    if (i === 'cluster') { setScope('instance'); setStep(2); return; }
    setScope(i === 'database' ? 'database' : 'object'); setObjMode('table'); setStep(1);
  };
  const restart = () => { exec.reset(); plan.reset(); prom.reset(); prev.reset(); dml.reset(); fx.reset(); objR.reset(); liveR.reset(); setObjs([]); setTgt(null); setIntent(null); setPmode(null); setLastPromote(null); setSearch(''); setDest(''); setStep(0); };
  // a quick pick from what the WAL says went wrong recently: selects the table AND the point just before
  const pickEvent = (e: any) => {
    const names: string[] = (e.names || []).filter((n: string) => splitId(n).length === 3); if (!names.length) return;
    setDb(splitId(names[0])[0]); setObjs(names); const at = parseWalTime(e.time);
    const title = `${shortName(names[0])} ${e.kind === 'TRUNCATE' ? 'svuotata' : 'eliminata'}`;
    setTgt({ mode: 'lsn', lsn: e.lsn, label: `${title} (${Number.isFinite(at) ? fmtWhen(at) : e.lsn})` }); setStep(2);
  };

  const whatTxt = scope === 'instance' ? 'tutto il server' : scope === 'database' ? <>il database <strong>{db}</strong></> : objs.length === 1 ? <>{splitId(obj).length === 2 ? 'lo schema' : 'la tabella'} <strong>{shortName(obj)}</strong> di {splitId(obj)[0]}</> : <><strong>{objs.length}</strong> elementi di {db}</>;
  const whenTxt = !tgt ? '—' : tgt.mode === 'latest' ? (selDropped ? 'subito prima che venisse eliminato' : 'all’ultimo istante salvato') : tgt.mode === 'time' ? <>com’era il <strong>{new Date(tgt.ms).toLocaleString('it-CH')}</strong></> : <>subito prima di: <strong>{tgt.label}</strong></>;
  const reachable = (i: number) => i < step && !running && !exec.op && (i !== 1 || intent !== 'cluster');

  return <div className="stack-l">
    <div className="steps">{STEPS.map((s, i) => <button key={s} type="button" disabled={!reachable(i)} onClick={() => setStep(i)} className={`s ${i === step ? 'on' : i < step ? 'done' : ''}`}>{i < step ? <Icon n="check" s={14} /> : null}{s}</button>)}</div>
    {step > 0 && step < 4 ? <div className="rsum small"><span><Icon n="restore" s={14} /> {INTENTS.find(x => x.id === intent)?.title}</span>{step > 1 && scope !== 'instance' ? <span>{whatTxt}</span> : null}{step > 2 ? <span>{whenTxt}</span> : null}</div> : null}

    {step === 0 && <Card title="Cosa è successo?"><div className="stack">
      <p className="muted">Scegli la situazione più vicina alla tua. pg_arca ti guida passo per passo e <strong>non modifica i dati attuali</strong> finché non sei tu a confermarlo, alla fine.</p>
      <div className="grid choices">{INTENTS.map(x => <button key={x.id} className="choice" aria-pressed={intent === x.id} onClick={() => choose(x.id)}><Icon n={x.icon} s={22} /><div><strong>{x.title}</strong><p className="sub">{x.text}</p></div></button>)}</div>
    </div></Card>}

    {step === 1 && <Card title={intent === 'database' ? 'Quale database?' : intent === 'rows' ? 'In quale tabella?' : 'Cosa è stato eliminato o svuotato?'}><div className="stack">
      {intent === 'table' ? <RecentDrops op={fx.op} busy={fx.busy} onPick={pickEvent} /> : null}
      {dbsR.op && dbsR.op.status === 'succeeded' ? <>
        <Field label="Database"><DbPicker dbs={dbs} live={live} drops={drops} dropsState={dropsR.busy ? 'running' : dropsR.op?.status === 'succeeded' ? 'done' : dropsR.op ? 'failed' : 'idle'} value={db} onChange={n => { setDb(n); setObjs([]); setTgt(null); prev.reset(); }} /></Field>
        {selDropped && selDb ? <DroppedNote db={db} info={drops[String(selDb.oid)]} lastStop={selDb.last_stop} /> : null}
        {db && ((c.databases || []) as any[]).some(x => x.name === db && x.restoring) ? <Banner kind="warn" title="Database da un ripristino interrotto">{db} è stato creato da un ripristino che non è arrivato alla fine: il contenuto è incompleto. Ripristinarlo non ha senso: elimina questo database e ripeti il ripristino originale.</Banner> : null}
        {selDb?.late ? <Banner kind="info" title="Creato dopo l’ultimo backup">Nessun backup contiene <strong>{db}</strong>: pg_arca lo ricostruisce dai soli WAL archiviati. Funziona per ogni istante successivo alla sua creazione.</Banner> : null}
        {scope === 'object' && db ? <>
          {intent === 'table' ? <div className="seg" role="group" aria-label="Tabelle o schemi"><button aria-pressed={objMode === 'table'} onClick={() => { setObjMode('table'); setObjs([]); }}>Tabelle</button><button aria-pressed={objMode === 'schema'} onClick={() => { setObjMode('schema'); setObjs([]); }}>Uno schema intero</button></div> : null}
          <ObjectPicker r={selDb?.late ? null : objR.op} busy={selDb?.late ? liveR.busy : objR.busy} search={search} setSearch={setSearch} db={db} value={objs} onChange={v => { setObjs(intent === 'rows' ? v.filter(x => !objs.includes(x)).slice(-1) : v); setTgt(null); }} mode={objMode} live={objLive} drops={tblDrops} dropsBusy={tdropR.busy} err={objR.error} />
          {intent === 'rows' ? <p className="small muted">Si recuperano righe di una tabella alla volta: quella con le righe sbagliate.</p> : null}</> : null}</> :
        <OpPanel op={dbsR.op} error={dbsR.error} label="Lettura del catalogo dei backup" />}
      <div className="row"><Button onClick={() => setStep(0)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhat} onClick={() => setStep(2)}>Avanti</Button></div></div></Card>}

    {step === 2 && <Card title={intent === 'rows' ? 'Quando sono state toccate le righe?' : intent === 'table' ? 'A quando tornare?' : 'A quale momento?'}><div className="stack">
      {intent === 'rows' || intent === 'table' ? <WalScanState op={intent === 'rows' ? dml.op : fx.op} busy={intent === 'rows' ? dml.busy : fx.busy} found={suggestions.length}
        what={intent === 'rows' ? `DELETE e UPDATE da almeno ${num(dmlMin)} righe nelle ultime 24 ore` : `eliminazioni e svuotamenti negli ultimi ${Math.round(fxHours / 24)} giorni`}
        more={intent === 'rows' ? () => { dml.reset(); setDmlMin(10); setTimeout(() => dml.run('wal_forensics', { mode: 'dml', hours: 168, min_rows: 10, limit: 30 }), 0); } : () => { setFxHours(720); fx.run('wal_forensics', { mode: 'events', hours: 720, limit: 30 }); }} /> : null}
      <div className="stack-s" role="radiogroup" aria-label="Momento del ripristino">
        {tgt && (tgt.mode === 'lsn' || tgt.mode === 'xid') && !suggestions.some(s => s.key === tgtKey(tgt)) ? <label className="opt on"><input type="radio" checked readOnly /><div className="grow"><div><strong>Subito prima: {tgt.label}</strong></div><div className="small muted">Scelto dalla ricerca nei WAL: tutto ciò che è stato confermato prima resta.</div></div></label> : null}
        {suggestions.map((s, i) => <label key={s.key} className={`opt ${tgtKey(tgt) === s.key ? 'on' : ''}`}><input type="radio" checked={tgtKey(tgt) === s.key} onChange={() => setTgt(s.tgt)} /><div className="grow">
          <div><strong>Subito prima: {s.title}</strong> {i === 0 ? <Badge kind="ok">Consigliato</Badge> : null}</div>
          <div className="small muted">{Number.isFinite(s.at) ? `${s.exact ? '' : 'circa '}${fmtWhen(s.at)} · ${ago2(s.at)}` : 'ora non registrata nei WAL'}. Torni allo stato esatto di un attimo prima: tutto ciò che è stato confermato prima resta.</div></div></label>)}
        <label className={`opt ${tgt?.mode === 'latest' ? 'on' : ''}`}><input type="radio" checked={tgt?.mode === 'latest'} onChange={() => setTgt({ mode: 'latest' })} /><div className="grow">
          <div><strong>{selDropped ? 'Subito prima che venisse eliminato' : 'L’ultimo istante salvato'}</strong> {!suggestions.length && (intent === 'database' || intent === 'cluster') ? <Badge kind="ok">Consigliato</Badge> : null}</div>
          <div className="small muted">{selDropped ? <>pg_arca trova da solo nei WAL il momento del DROP di <strong>{db}</strong> e si ferma un attimo prima.</> : <>Fino all’ultima transazione archiviata ({d.archiver?.last_archived_time ? ago2(Date.parse(d.archiver.last_archived_time)) : 'adesso'}).</>}</div>
          {tgt?.mode === 'latest' && (intent === 'rows' || (intent === 'table' && goneNow === false)) ? <div className="hba-warn small" style={{ marginTop: 4 }}>Attenzione: l’ultimo istante contiene già l’errore. Scegli un momento precedente.</div> : null}</div></label>
        <label className={`opt ${tgt?.mode === 'time' ? 'on' : ''}`}><input type="radio" checked={tgt?.mode === 'time'} onChange={() => setTgt({ mode: 'time', ms: Math.max(from, Date.now() - 3600e3) })} /><div className="grow">
          <div><strong>Un momento preciso</strong></div>
          {tgt?.mode === 'time' ? <div className="stack-s" style={{ marginTop: 6 }} onClick={e => e.preventDefault()}>
            <div className="row wrap gap-s">{[[15, '15 minuti fa'], [60, '1 ora fa'], [240, '4 ore fa'], [1440, 'ieri a quest’ora']].map(([m, t]) => <Button key={m} sm onClick={() => setTgt({ mode: 'time', ms: Math.max(from, Date.now() - (m as number) * 60000) })}>{t}</Button>)}</div>
            <Field label={`Data e ora (${tzName()})`} error={!okWhen ? 'Fuori dall’intervallo recuperabile: dal ' + fmtWhen(from) + ' a adesso.' : null}>
              <input className="input" type="datetime-local" step={1} min={localInput(from)} max={localInput(to)} value={localInput(tgt.ms)} onChange={e => { const ms = new Date(e.target.value).getTime(); if (Number.isFinite(ms)) setTgt({ mode: 'time', ms }); }} /></Field>
          </div> : <div className="small muted">Scegli data e ora: puoi tornare a qualsiasi istante dal {fmtWhen(from)} a adesso.</div>}</div></label>
      </div>
      {selDb && !selDb.late && selDb.first_stop && tgt?.mode === 'time' && tgt.ms < Date.parse(selDb.first_stop) ? <Banner kind="warn" title={`${db} compare nei backup solo dal ${fmtWhen(Date.parse(selDb.first_stop))}`}>A questo istante potrebbe non esistere ancora: in quel caso il ripristino si ferma e lo dice.</Banner> : null}
      <Details k={`${K}:when-adv`} summary="Linea temporale dei backup e ricerca avanzata nei WAL">
        <div className="stack" style={{ marginTop: 10 }}>
          <RecoveryTimeline sets={sets} from={from} to={to} value={tgt?.mode === 'time' ? tgt.ms : null} onChange={ms => setTgt(ms == null ? { mode: 'latest' } : { mode: 'time', ms })} events={events} broken={d.wal?.continuous === false} />
          <div className="small muted">Le tacche sono i backup, l’area colorata è l’intervallo recuperabile. Backup di partenza per la scelta attuale: {baseSet ? <span className="mono">{baseSet.id}</span> : <span style={{ color: 'var(--bad)' }}>nessuno prima di questo istante</span>}</div>
          <ForensicsTools fx={fx} dml={dml} fxHours={fxHours} setFxHours={setFxHours} dmlMin={dmlMin} setDmlMin={setDmlMin} onPick={t => setTgt(t)} />
        </div></Details>
      <div className="row"><Button onClick={() => setStep(intent === 'cluster' ? 0 : 1)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhen || (!baseSet && tgt?.mode === 'time')} onClick={goCheck}>Avanti</Button></div></div></Card>}

    {step === 3 && <div className="stack-l">
      <Card title="Controlla e conferma"><div className="stack">
        <div className="rplan">
          <p>Recuperi {whatTxt}, {whenTxt}.</p>
          <ol className="small">{scope === 'instance' ? <><li>Una copia completa del server viene ricostruita nella cartella che indichi qui sotto.</li><li>Il server in esecuzione e i suoi dati non vengono toccati.</li><li>Alla fine ti diamo il comando per avviare la copia (parte senza archiviare nell’archivio della produzione).</li></>
            : scope === 'database' ? <><li>pg_arca crea il nuovo database <strong>{newName || '…'}</strong> con il contenuto recuperato.</li><li>{live?.has(db) ? <>Il database {db} attuale resta com’è.</> : <>Nessun database esistente viene toccato.</>}</li><li>Lo controlli e, se va bene, decidi tu come usarlo (anche al posto dell’originale).</li></>
            : intent === 'rows' ? <><li>La tabella viene ricostruita com’era in un database di quarantena separato.</li><li>Confronti riga per riga la versione recuperata con quella di adesso.</li><li>Riporti solo le righe che scegli; prima viene salvata una copia di sicurezza delle righe toccate.</li></>
            : <><li>{objs.length === 1 ? 'Quanto scelto viene ricostruito' : 'Le tabelle scelte vengono ricostruite'}, con ciò da cui dipendono, in un database di quarantena separato.</li><li>Nessuna tabella attuale viene modificata in questa fase.</li><li>Poi la rimetti al suo posto con un clic{goneNow ? '' : ' (quella attuale resta salvata con un altro nome)'}.</li></>}</ol>
        </div>
        {scope === 'database' ? <Field label="Nome del nuovo database" hint="Non sovrascrive mai un database esistente." error={newName && !okName ? 'Solo lettere, cifre e _ (max 63 caratteri), senza spazi.' : null}><div className="row gap-s"><input className="input" value={newName} onChange={e => setNewName(e.target.value)} onBlur={check} /><Button sm icon="refresh" busy={plan.busy} onClick={check}>Ricontrolla</Button></div></Field> : null}
        {scope === 'instance' ? <>
          <Field label="Cartella di destinazione sul server" hint="Percorso assoluto, vuoto o inesistente. La cartella dati in uso e quelle di sistema sono rifiutate." error={dest && !dest.startsWith('/') ? 'Deve iniziare con /' : null}><div className="row gap-s"><input className="input mono" value={dest} onChange={e => setDest(e.target.value)} placeholder="/var/lib/postgresql/ripristino" /><Button sm icon="search" busy={plan.busy} disabled={!dest.startsWith('/')} onClick={check}>Verifica</Button></div></Field>
          <Details k={`${K}:inst-adv`} summary="Opzioni avanzate"><div className="stack" style={{ marginTop: 8 }}>
            <Field label="Al termine del recupero"><div className="seg"><button aria-pressed={action === 'promote'} onClick={() => setAction('promote')}>Diventa un’istanza normale</button><button aria-pressed={action === 'pause'} onClick={() => setAction('pause')}>Resta in pausa per controllare</button></div></Field>
            <label className="check"><input type="checkbox" checked={delta} onChange={e => setDelta(e.target.checked)} />Ripristino differenziale su una cartella già ripristinata (copia solo ciò che differisce)</label>
            <label className="check"><input type="checkbox" checked={keepArch} onChange={e => setKeepArch(e.target.checked)} />Questa copia sostituirà il server originale: lascia attiva l’archiviazione WAL</label>
            <p className="small muted">{keepArch ? 'Avviata, la copia archivierà nello stesso archivio WAL della produzione: fallo solo se il server originale non tornerà.' : 'Di norma la copia parte con l’archiviazione WAL spenta, senza standby da attendere, senza seguire un primario, senza sottoscrizioni di replica logica attive e senza librerie che lavorano da sole su altri server (pg_cron…): puoi avviarla accanto alla produzione senza toccarla.'}</p></div></Details></> : null}
        {scope === 'instance' && !dest.startsWith('/') ? <p className="small muted">Indica la cartella per far partire i controlli.</p>
          : pres && (plan.op?.status === 'succeeded' || plan.busy) ? <div className={plan.busy ? 'stale' : ''} aria-busy={plan.busy} title={plan.busy ? 'Ricontrollo in corso…' : undefined}><Verdict p={pres} /></div> : <OpPanel op={plan.op} error={plan.error} label="Controlli prima di partire" />}
        {scope === 'database' && pres && (pres.missing_roles || []).length ? <div>
          <label className="check"><input type="checkbox" checked={mkRoles} onChange={e => setMkRoles(e.target.checked)} />Crea i ruoli mancanti ({(pres.missing_roles as string[]).slice(0, 6).join(', ')}{pres.missing_roles.length > 6 ? '…' : ''}) come segnaposto, per tenere proprietari e permessi</label>
          <p className="small muted" style={{ marginTop: -6 }}>{mkRoles ? 'I ruoli vengono creati senza accesso (NOLOGIN), senza password e senza appartenenze ad altri ruoli: un account eliminato non torna mai attivo, i suoi oggetti tengono solo proprietario e permessi.' : 'Senza questi ruoli, gli oggetti del database ripristinato apparterranno all’utente dell’agent e perderanno i permessi concessi.'}</p></div> : null}
        {pres ? <Details k={`${K}:tech`} summary="Dettagli tecnici (backup usati, spazio su disco, dove avviene il recupero)"><div className="stack" style={{ marginTop: 10 }}>
          <PlanView p={pres} scope={scope} />{scope !== 'instance' ? <RecoveryPlacement clusterId={c.id} /> : null}</div></Details> : null}
        {plan.op?.status === 'failed' && scope === 'instance' && /PGA-RST-040/.test(String(plan.op.error || '')) && !exec.op ? <Banner kind="info" title="In quella cartella c’è un ripristino interrotto" actions={<Button sm icon="restore" onClick={() => { setStep(4); exec.run('restore_instance', { ...params().p, resume: true }); }}>Riprendilo</Button>}>Riprendendo, pg_arca completa la copia scrivendo solo ciò che manca o è diverso. Per ricominciare da zero svuota la cartella o scegline un’altra.</Banner> : null}
        <div className="row"><Button onClick={() => setStep(2)}>Indietro</Button><div className="grow" />{blocked ? <span className="small" style={{ color: 'var(--bad)' }}>Risolvi i punti in rosso per procedere</span> : null}
          <Button kind="primary" icon="restore" disabled={blocked || plan.op?.status !== 'succeeded' || !okWhere} onClick={() => setAsk(true)}>Avvia il ripristino</Button></div></div></Card>
    </div>}

    {step === 4 && <Card title="Ripristino"><div className="stack"><OpPanel op={exec.op} error={exec.error} cancel={exec.cancel} />
      {doneOk ? <Banner kind="ok" title="Ripristino completato">{scope === 'instance' ? <>Copia pronta in <code>{exec.op!.result.destination}</code>. Per avviarla: <code>{exec.op!.result.start_hint}</code></>
        : scope === 'database' ? <>Il database <code>{exec.op!.result.result_database}</code> è pronto: collegati e controllalo. {live?.has(db) ? <>L’originale <code>{db}</code> non è stato toccato.</> : null}</>
        : <>Recuperato nel database di quarantena <code>{exec.op!.result.result_database}</code>. Ora scegli come rimetterlo a posto, qui sotto.</>}</Banner> : null}
      {doneOk ? <Notices r={exec.op!.result} /> : null}
      {doneOk && scope === 'database' && live?.has(db) ? <details><summary className="small" style={{ cursor: 'pointer' }}>Voglio che prenda il posto di {db}</summary><div className="stack-s small" style={{ marginTop: 8 }}>
        <p>Ferma prima le applicazioni che usano {db}, poi esegui sul server (l’originale resta come <code>{db}_prima</code> finché non lo elimini tu):</p>
        <pre className="out">{`ALTER DATABASE "${db}" RENAME TO "${db}_prima";\nALTER DATABASE "${exec.op!.result.result_database}" RENAME TO "${db}";`}</pre></div></details> : null}
      {doneOk && scope === 'object' && exec.op!.result.result_database ? (intent === 'rows' && objs.length === 1 && splitId(obj).length === 3 ? <>
        <RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} auto />
        <Details k={`${K}:whole`} summary="Oppure riporta l’intera tabella">
          <Promote stage={exec.op!.result.result_database} what={objs} deps={exec.op!.result.dependencies} warnings={exec.op!.result.warnings} mode={pmode || 'as_new'} recommended="as_new" anyGone={goneNow} setMode={m => { setPmode(m); prev.reset(); }} drop={pdrop} setDrop={setPdrop} runner={prom} preview={prev} ask={() => setAskPromote(true)} allowOrphans={lastPromote.current ? () => setAskOrphans(true) : undefined} schema={pschema} setSchema={v => { setPschema(v); prev.reset(); }} /></Details></> : <>
        <Promote stage={exec.op!.result.result_database} what={objs} deps={exec.op!.result.dependencies} warnings={exec.op!.result.warnings} mode={pmode || recommendedMode(goneNow)} recommended={recommendedMode(goneNow)} anyGone={goneNow} setMode={m => { setPmode(m); prev.reset(); }} drop={pdrop} setDrop={setPdrop} runner={prom} preview={prev} ask={() => setAskPromote(true)} allowOrphans={lastPromote.current ? () => setAskOrphans(true) : undefined} schema={pschema} setSchema={v => { setPschema(v); prev.reset(); }} />
        {objs.length === 1 && splitId(obj).length === 3 && goneNow !== true ? <Details k={`${K}:somerows`} summary="Recupera solo alcune righe"><RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} /></Details> : null}</>) : null}
      <Result op={exec.op} />
      {scope === 'instance' && exec.op && ['failed', 'cancelled'].includes(exec.op.status) && /PGA-RST-040|cancel|interrott|No space|ENOSPC|PGA-RST-03/i.test(String(exec.op.error || '')) ? <Banner kind="info" title="Ripristino interrotto" actions={<Button sm icon="restore" onClick={() => exec.run('restore_instance', { ...(exec.op!.params || params().p), resume: true })}>Riprendi da dove si è fermato</Button>}>
        La copia parziale in <code>{(exec.op.params || {}).destination || dest}</code> è riconosciuta: riprendendo, pg_arca scrive solo ciò che manca o è diverso (utile dopo un annullamento, un disco pieno liberato o un riavvio dell’agent).</Banner> : null}
      {exec.op && exec.op.status === 'failed' && !running ? <div><Button onClick={() => { exec.reset(); setStep(3); check(); }}>Torna ai controlli</Button></div> : null}
      {(exec.op && !running) ? <div><Button onClick={restart}>Nuovo ripristino</Button></div> : null}</div></Card>}

    {askOrphans ? <Confirm title="Procedere lasciando righe orfane?" danger requireText="ORFANE" confirmLabel="Procedi" onClose={() => setAskOrphans(false)} onConfirm={() => { setAskOrphans(false); prom.run('restore_promote', { ...lastPromote.current, allow_orphans: true }); }}>
      <p>Le tabelle vengono sostituite comunque. Le chiavi esterne coinvolte restano <strong>non valide</strong>: le righe orfane rimangono finché non le sistemi a mano, e l’applicazione potrebbe trovarle.</p></Confirm> : null}
    {askPromote ? (() => { const m = pmode || (intent === 'rows' ? 'as_new' : recommendedMode(goneNow)); return <Confirm title="Riportare nel database?" danger={m === 'replace'} requireText={m === 'replace' ? 'SOSTITUISCI' : undefined} confirmLabel="Riporta" onClose={() => setAskPromote(false)} onConfirm={() => { setAskPromote(false); setLastPromote({ stage_db: exec.op!.result.result_database, object: obj, mode: m, drop_stage: pdrop, ...(m === 'replace' ? { confirm: 'SOSTITUISCI' } : {}), ...(m === 'as_new' && pschema ? { target_schema: pschema } : {}) }); prom.run('restore_promote', { stage_db: exec.op!.result.result_database, object: obj, mode: m, drop_stage: pdrop, ...(m === 'replace' ? { confirm: 'SOSTITUISCI' } : {}), ...(m === 'as_new' && pschema ? { target_schema: pschema } : {}) }); }}>
      <p>{m === 'as_new' ? <>Le tabelle recuperate compaiono accanto alle originali con un nome che termina in <code>_pitr_&lt;data&gt;</code>. Nulla di esistente viene toccato.</> : m === 'missing_only' ? <>Tornano solo le tabelle che oggi non esistono, con il loro nome; quelle presenti restano com’è.</> : <>Le tabelle attuali vengono rinominate <code>_old_&lt;data&gt;</code> (i loro dati restano, puoi tornare indietro) e quelle recuperate prendono il loro posto in un’unica transazione. Chiavi esterne e viste vengono ricollegate.</>}</p>
      <p className="small muted">{pdrop ? 'Il database di quarantena viene eliminato a operazione riuscita.' : 'Il database di quarantena resta disponibile.'}</p></Confirm>; })() : null}
    {ask ? <Confirm title="Avviare il ripristino?" confirmLabel="Avvia" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); const x = params(); setStep(4); exec.run(x.type, x.p); }}>
      <p>{scope === 'instance' ? <>Ricostruisce il server in <code>{dest}</code>.</> : scope === 'database' ? <>Crea il database <code>{newName}</code> da <code>{db}</code>.</> : <>Ricostruisce {objs.length === 1 ? <code>{shortName(obj)}</code> : <>{objs.length} elementi</>} in un database di quarantena.</>} I dati attuali non vengono modificati. Se qualcosa fallisce, ciò che è stato creato viene rimosso.</p></Confirm> : null}
  </div>;
}

const recommendedMode = (gone: boolean | null): PMode => gone === true ? 'missing_only' : gone === false ? 'replace' : 'as_new';

/** "A table is gone": what the WAL says was dropped or emptied recently, one click to recover it as it was just before. */
function RecentDrops({ op, busy, onPick }: { op: Op | null; busy: boolean; onPick: (e: any) => void }) {
  const evs = (op?.status === 'succeeded' ? op.result.events || [] : []).filter((e: any) => (e.names || []).some((n: string) => splitId(n).length === 3)).slice(-6).reverse();
  if (busy || (op && !isTerminalOp(op))) return <div className="small muted row gap-s"><Icon n="refresh" spin s={14} />Cerco nei WAL le tabelle eliminate o svuotate di recente…</div>;
  if (!evs.length) return op?.status === 'succeeded' ? <p className="small muted">Nei WAL degli ultimi giorni non risultano tabelle eliminate o svuotate: scegli qui sotto database e tabella.</p> : null;
  return <div className="recent"><div className="small"><strong>Trovato nei WAL di recente</strong> — clicca per recuperare com’era subito prima</div>
    {evs.map((e: any, i: number) => { const t = parseWalTime(e.time); const names: string[] = (e.names || []).filter((n: string) => splitId(n).length === 3);
      return <button key={i} className="recentrow" onClick={() => onPick(e)}><Badge kind="bad">{e.rewrite_possible ? 'svuotata o riscritta' : e.kind === 'TRUNCATE' ? 'svuotata' : 'eliminata'}</Badge>
        <span className="grow"><strong>{names.slice(0, 3).map(shortName).join(', ')}</strong>{names.length > 3 ? ` e altre ${names.length - 3}` : ''} <span className="faint">in {splitId(names[0])[0]}</span></span>
        <span className="small faint nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'circa ' : ''}${fmtWhen(t)} · ${ago2(t)}` : ''}</span><span className="small" style={{ color: 'var(--accent)' }}>Recupera</span></button>; })}</div>;
}
const isTerminalOp = (o: Op) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(o.status);

/** What the automatic WAL search is doing / found, with "look further back". */
function WalScanState({ op, busy, found, what, more }: { op: Op | null; busy: boolean; found: number; what: string; more: () => void }) {
  if (busy || (op && !isTerminalOp(op))) return <div className="small muted row gap-s"><Icon n="refresh" spin s={14} />Cerco nei WAL {what}…</div>;
  if (!op) return null;
  if (op.status !== 'succeeded') return <p className="small muted">La ricerca automatica nei WAL non è riuscita ({op.error || op.status}): scegli un momento preciso.</p>;
  return found ? <p className="small muted">Ho cercato {what}: ecco cosa ho trovato.</p>
    : <p className="small muted">Nessun evento trovato ({what}). <button className="linkbtn" onClick={more}>Cerca più indietro</button> oppure scegli un momento preciso.</p>;
}

/** The full WAL forensics, for those who want to look for themselves (advanced). */
function ForensicsTools({ fx, dml, fxHours, setFxHours, dmlMin, setDmlMin, onPick }: { fx: ReturnType<typeof useOpRunner>; dml: ReturnType<typeof useOpRunner>; fxHours: number; setFxHours: (h: number) => void; dmlMin: number; setDmlMin: (n: number) => void; onPick: (t: Target) => void }) {
  return <div className="stack">
    <strong className="small">Eliminazioni e svuotamenti (DROP, TRUNCATE)</strong>
    <div className="row wrap"><span className="seg" role="group" aria-label="Quanto indietro cercare">{[[24, 'Ultime 24 ore'], [168, '7 giorni'], [720, '30 giorni'], [0, 'Tutto l’archivio']].map(([h, t]) => <button key={h} aria-pressed={fxHours === h} onClick={() => setFxHours(h as number)}>{t}</button>)}</span>
      <Button sm icon="search" busy={fx.busy} onClick={() => fx.run('wal_forensics', { mode: 'events', hours: fxHours, limit: 30 })}>Avvia analisi</Button></div>
    {fx.op && fx.op.status !== 'succeeded' ? <OpPanel op={fx.op} error={fx.error} cancel={fx.cancel} /> : null}
    {fx.op?.status === 'succeeded' ? <>
      <div className="small muted">{num(fx.op.result.segments_scanned)} segmenti analizzati{fx.op.result.segments_cached ? ` (${num(fx.op.result.segments_cached)} già in memoria)` : ''} in {fx.op.result.elapsed_sec} s{fx.op.result.window?.from ? ` · dal ${fx.op.result.window.from}` : ''}</div>
      {fx.op.result.complete === false ? <Banner kind="warn" title="Analisi parziale">È stato raggiunto il tempo massimo: rilancia la ricerca per continuare da dove si era fermata.</Banner> : null}
      {fx.op.result.events.length ? <table className="t"><thead><tr><th>Evento</th><th>Oggetti</th><th>Quando</th><th /></tr></thead><tbody>
        {[...fx.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); return <tr key={i}><td><Badge kind="bad" title={e.rewrite_possible ? 'Il WAL di un TRUNCATE e quello di una riscrittura (VACUUM FULL, CLUSTER, ALTER TABLE che cambia tipo) sono identici: controlla se a quell’ora era in corso una manutenzione.' : undefined}>{e.rewrite_possible ? 'Tabella svuotata o riscritta' : KIND_LABEL[e.kind] || e.kind}</Badge></td><td className="small">{(e.names || []).join(', ') || '—'}{e.nrels > (e.names || []).length ? ` e altri ${e.nrels - e.names.length}` : ''}</td>
          <td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'circa ' : ''}${fmtWhen(t)}` : e.time}</td>
          <td className="num"><Button sm onClick={() => onPick({ mode: 'lsn', lsn: e.lsn, label: `${KIND_LABEL[e.kind] || e.kind} ${(e.names || [])[0] || ''} (${Number.isFinite(t) ? fmtWhen(t) : e.lsn})` })}>Ripristina subito prima</Button></td></tr>; })}</tbody></table>
        : <p className="muted small">Nessuna eliminazione o svuotamento trovato nel periodo analizzato.</p>}</> : null}
    <strong className="small">Righe cancellate o modificate in massa (DELETE o UPDATE senza WHERE)</strong>
    <p className="small muted">Transazioni confermate che hanno eliminato o modificato molte righe di una tabella. Ripristinando «subito prima» quella transazione è esclusa; le transazioni annullate (ROLLBACK) non compaiono.</p>
    <div className="row wrap"><span className="seg" role="group" aria-label="Righe minime">{[[100, 'da 100 righe'], [1000, 'da 1.000'], [10000, 'da 10.000'], [100000, 'da 100.000']].map(([n, t]) => <button key={n} aria-pressed={dmlMin === n} onClick={() => setDmlMin(n as number)}>{t}</button>)}</span>
      <Button sm icon="search" busy={dml.busy} onClick={() => dml.run('wal_forensics', { mode: 'dml', hours: fxHours, min_rows: dmlMin, limit: 30 })}>Cerca modifiche di massa</Button></div>
    {dml.op && dml.op.status !== 'succeeded' ? <OpPanel op={dml.op} error={dml.error} cancel={dml.cancel} /> : null}
    {dml.op?.status === 'succeeded' ? (dml.op.result.events.length ? <table className="t"><thead><tr><th>Cosa</th><th>Tabella</th><th>Quando</th><th /></tr></thead><tbody>
      {[...dml.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); const what = e.kind === 'DELETE' ? `${num(e.deleted)} righe eliminate` : e.kind === 'UPDATE' ? `${num(e.updated)} righe modificate` : `${num(e.deleted)} eliminate, ${num(e.updated)} modificate`;
        return <tr key={i}><td><Badge kind="bad">{what}</Badge>{e.committed === false ? <div className="small faint">conferma non trovata nei WAL vicini</div> : null}</td><td className="small">{(e.names || []).join(', ')}</td><td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'circa ' : ''}${fmtWhen(t)}` : e.time}</td>
          <td className="num"><Button sm onClick={() => onPick({ mode: 'xid', xid: String(e.xid), label: `${what} in ${(e.names || [])[0] || ''} (${Number.isFinite(t) ? fmtWhen(t) : 'xid ' + e.xid})` })}>Ripristina subito prima</Button></td></tr>; })}</tbody></table>
      : <p className="muted small">Nessuna transazione con almeno {num(dml.op.result.min_rows)} righe eliminate o modificate nel periodo ({num(dml.op.result.segments_scanned)} segmenti analizzati).</p>) : null}
  </div>;
}

/** The verdict of the checks, in plain words: ready / ready with something to know / blocked (and the way out). */
function Verdict({ p }: { p: any }) {
  const pf = p.preflight; const warn = (pf?.checks || []).filter((x: any) => x.level === 'warn'); const bad = (pf?.checks || []).filter((x: any) => x.level === 'bad');
  if (p.missing_wal?.length) return <Banner kind="bad" title="Non si può ripristinare a questo momento">Mancano {p.missing_wal.length} file WAL nell’archivio (il primo: <code>{p.missing_wal[0]}</code>): il recupero non può attraversare quel buco. Scegli un momento precedente o un altro backup.</Banner>;
  return <div className="stack-s">
    {bad.length ? <Banner kind="bad" title="Prima va sistemato qualcosa">{bad.map((x: any) => <div key={x.id}>{itCheck(x.text)}{x.fix ? <div className="fix small">Cosa fare: {itFix(x.fix)}</div> : null}</div>)}</Banner>
      : <Banner kind="ok" title={warn.length ? (warn.length === 1 ? 'Pronto: leggi la nota qui sotto' : `Pronto: leggi le ${warn.length} note qui sotto`) : 'Tutto pronto'}>Il backup e i WAL necessari ci sono{pf ? ` (controlli superati: ${pf.checks.filter((x: any) => x.level === 'ok').length})` : ''}.{p.extract_bytes ? ` Verranno estratti circa ${bytes(p.extract_bytes)}.` : p.bytes ? ` Verranno scritti circa ${bytes(p.bytes)}.` : ''}</Banner>}
    {warn.length ? <div className="preflight warn" role="group" aria-label="Da sapere"><ul>{warn.map((x: any) => <li key={x.id} className="warn"><Icon n="alert" s={14} /><span><span>{itCheck(x.text)}</span>{x.fix ? <span className="fix small">{itFix(x.fix)}</span> : null}</span></li>)}</ul></div> : null}
  </div>;
}

const ROLE_IT: Record<string, string> = { scratch: 'istanza di recupero (estrazione, WAL, dump)', data: 'dati del cluster in produzione', dest: 'destinazione del ripristino', tablespace: 'tablespace ricollocati' };
type Vol = { paths: string[]; roles: string[]; need: number; free: number; total: number; free_after?: number };
/** Disk space per FILESYSTEM: what is used now, what the restore will write, what is left. Two folders on the same volume are one bar (their needs add up). */
export function SpaceBars({ vols }: { vols?: Vol[] }) {
  if (!vols || !vols.length) return null;
  return <div className="spacebars" role="group" aria-label="Spazio su disco">
    <div className="ph"><strong>Spazio su disco</strong><span className="small faint">calcolato sul server, per volume</span></div>
    {vols.map((v, i) => {
      const used = Math.max(0, v.total - v.free); const after = v.free - v.need; const live = v.roles.includes('data');
      const pct = (x: number) => `${Math.max(0, Math.min(100, (100 * x) / Math.max(v.total, 1)))}%`;
      const tone = after < 0 ? 'bad' : (live ? after < Math.max(0.05 * v.total, 2 ** 30) : after < 0.02 * v.total) ? 'bad' : live && after < 0.1 * v.total ? 'warn' : 'ok';
      return <div key={i} className={`vol ${tone}`}>
        <div className="row small"><span className="grow"><strong>{v.roles.map(r => ROLE_IT[r] || r).join(' + ')}</strong><span className="faint"> — {v.paths.join(', ')}</span></span>
          <span className="nowrap">{after < 0 ? <>mancano <strong>{bytes(-after)}</strong></> : <>restano <strong>{bytes(after)}</strong> ({Math.round((100 * after) / Math.max(v.total, 1))}%)</>}</span></div>
        <div className="bar" aria-hidden="true"><i className="used" style={{ width: pct(used) }} /><i className="need" style={{ width: pct(Math.min(v.need, Math.max(v.free, 0))) }} />{after < 0 ? <i className="over" style={{ width: pct(-after) }} /> : null}</div>
        <div className="small faint">occupato {bytes(used)} · serve {bytes(v.need)} · libero ora {bytes(v.free)} su {bytes(v.total)}{live ? ' · volume del cluster in produzione: deve restare almeno il 5% libero' : ''}</div>
      </div>; })}
  </div>;
}

/** The checks the agent ran before the long recovery: what is fine, what deserves attention, what blocks (with the way out). */
function Preflight({ pf }: { pf: { level: string; ok: boolean; checks: { id: string; level: string; text: string; fix?: string }[] } }) {
  const order: Record<string, number> = { bad: 0, warn: 1, ok: 2 };
  const list = [...pf.checks].sort((a, b) => order[a.level] - order[b.level]);
  const n = (l: string) => pf.checks.filter(c => c.level === l).length;
  return <div className={`preflight ${pf.level}`} role="group" aria-label="Controlli prima di partire">
    <div className="ph"><strong>Controlli prima di partire</strong><span className="small faint">{n('ok')} ok{n('warn') ? ` · ${n('warn')} da vedere` : ''}{n('bad') ? ` · ${n('bad')} bloccanti` : ''}</span></div>
    <ul>{list.map(c => <li key={c.id} className={c.level}><Icon n={c.level === 'ok' ? 'check' : 'alert'} s={14} /><span><span>{itCheck(c.text)}</span>{c.fix && c.level !== 'ok' ? <span className="fix small">{itFix(c.fix)}</span> : null}</span></li>)}</ul></div>;
}

function PlanView({ p, scope }: { p: any; scope: Scope }) {
  const saved = p.saved_pct;
  return <div className="stack">
    {p.missing_wal?.length ? <Banner kind="bad" title="Mancano dei WAL">{`Servono ${p.missing_wal.length} segmenti non archiviati.`}</Banner>
      : p.preflight?.ok === false ? <Banner kind="bad" title="Non si può ancora avviare">Il backup e i WAL ci sono, ma un controllo preliminare blocca il ripristino: vedi sotto cosa fare.</Banner>
        : <Banner kind="ok" title="Ripristino possibile">Il backup di partenza e i WAL necessari sono presenti.</Banner>}
    {p.preflight?.checks?.length ? <Preflight pf={p.preflight} /> : null}
    <SpaceBars vols={p.space} />
    <dl className="kv"><dt>Istante</dt><dd>{p.target === 'end of archive' ? 'ultimo disponibile' : Number.isFinite(Date.parse(p.target)) ? new Date(p.target).toLocaleString('it-CH') : p.target}</dd>
      <dt>Backup di partenza</dt><dd><span className="mono">{p.set}</span></dd>
      <dt>Catena</dt><dd className="mono small">{(p.chain || []).join(' → ')}</dd>
      {scope === 'instance' ? <><dt>Dati da estrarre</dt><dd>{bytes(p.bytes)} in {num(p.files)} file</dd></> : <><dt>Dati da estrarre</dt><dd>{bytes(p.extract_bytes)} su {bytes(p.cluster_bytes)} del cluster{saved != null ? <> — <strong>{saved}% in meno</strong></> : null}</dd></>}
      {p.tablespaces && Object.keys(p.tablespaces).length ? <><dt>Tablespace</dt><dd className="small">{Object.entries(p.tablespaces).map(([oid, path]: any) => <div key={oid}><span className="mono">{oid}</span> → <span className="mono">{String(path)}</span>{(p.tablespaces_relocated || []).includes(oid) ? <> <Badge kind="warn" title="La cartella originale appartiene al server di origine: non viene mai sovrascritta">spostato</Badge></> : null}</div>)}</dd></> : null}
      {p.destination_free_bytes != null ? <><dt>Spazio libero</dt><dd>{bytes(p.destination_free_bytes)} nella destinazione{p.space_warning ? <span className="small" style={{ display: 'block', color: 'var(--warn, #d9a441)' }}>{p.space_warning}</span> : null}</dd></> : null}
      {p.destination_database ? <><dt>Nuovo database</dt><dd>{p.destination_database}</dd></> : null}{p.quarantine_database ? <><dt>Quarantena</dt><dd>{p.quarantine_database}</dd></> : null}</dl></div>;
}

const Gone = ({ info, busy, lastLabel }: { info?: DropInfo; busy?: boolean; lastLabel?: string }) => { const t = info ? parseWalTime(info.time) : NaN;
  return <span className="gonechip"><span className="dropped">DROPPED</span><span className="when small">{Number.isFinite(t) ? `${info!.time_exact ? '' : 'circa '}${fmtWhen(t)}` : busy ? 'data in calcolo…' : lastLabel || ''}</span></span>; };

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
  return <div className="stack"><Field label={mode === 'schema' ? 'Schemi' : 'Tabelle'} hint={mode === 'schema' ? 'Scegli uno o più schemi: tabelle, chiavi esterne, viste, sequenze e permessi vengono ripristinati insieme.' : 'Spunta una o più tabelle. Le dipendenze vengono incluse da sole.'}><input className="input" placeholder="Cerca per nome" value={search} onChange={e => setSearch(e.target.value)} /></Field>
    {live && !live.all && schemas.length && (nGone || schemas.some(sc => sc.objects.some((o: any) => tableGone(qid(db, sc.name, o.name))))) ? <p className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>Ci sono {mode === 'schema' ? 'schemi' : 'tabelle'} presenti nei backup e non più sul server: sono segnalati DROPPED.</p> : null}
    <div className={`tree ${mode}`}>{busy && !schemas.length ? <div style={{ padding: 12 }} className="muted">Lettura del catalogo…</div> : null}
      {schemas.map(s => { const sid = qid(db, s.name); const whole = has(sid); const ids = s.objects.map((o: any) => qid(db, s.name, o.name)); const sg = schemaGone(sid);
        return <div key={s.name}><label className={`sch ${sg ? 'gone' : ''}`}><input type="checkbox" checked={whole} onChange={() => toggleSchema(s.name, ids)} /> <strong>{s.name}</strong>{s.tables != null ? <span className="faint small"> — {s.tables} {s.tables === 1 ? 'tabella' : 'tabelle'}, {bytes(s.bytes)}{whole && mode === 'table' ? ' · schema intero' : ''}</span> : null}
          {sg ? <Gone info={schemaDrop(sid, ids)} busy={dropsBusy} lastLabel="eliminato" /> : live ? <span className="here small">Presente</span> : null}</label>
          {mode === 'table' ? s.objects.map((o: any) => { const id = qid(db, s.name, o.name); const on = whole || has(id); const g = tableGone(id);
            const kindTag = o.kind === 'v' ? 'vista' : o.kind === 'm' ? 'vista materializzata' : null;
            return <React.Fragment key={id}><button aria-pressed={on} disabled={whole} onClick={() => toggleTable(id)} className={g ? 'gone' : ''}><input type="checkbox" readOnly checked={on} tabIndex={-1} /><span className="grow">{o.name}{kindTag ? <span className="faint small" style={{ marginLeft: 8 }}>{kindTag}</span> : null}{o.late ? <span className="here small" title="Non è in nessun backup: si ricostruisce dai WAL archiviati" style={{ marginLeft: 8 }}>dopo l’ultimo backup</span> : null}</span>{g && !sg ? <Gone info={drops[id]} busy={dropsBusy} lastLabel="eliminata" /> : null}<span className="faint small">{o.partitions ? `${o.partitions} partizioni · ` : ''}{o.kind === 'v' ? '' : bytes(o.size)}</span></button>
              {o.parts?.length ? <details className="parts" style={{ marginLeft: 28 }}><summary className="small" style={{ cursor: 'pointer' }}>Solo alcune partizioni ({o.parts.length})</summary>
                <p className="small muted" style={{ margin: '4px 0' }}>Una partizione ripristinata da sola viene riattaccata alla tabella attuale con gli stessi limiti; quella di oggi resta, staccata, con il suffisso _old.</p>
                {o.parts.map((pt: any) => { const pid = qid(db, s.name, pt.name); const pon = whole || on || has(pid);
                  return <button key={pid} aria-pressed={pon} disabled={whole || on} onClick={() => toggleTable(pid)} style={{ paddingLeft: 8 + 16 * (pt.depth || 0) }}><input type="checkbox" readOnly checked={pon} tabIndex={-1} /><span className="grow">{pt.name}{pt.kind === 'p' ? <span className="faint small" style={{ marginLeft: 8 }}>con sottopartizioni</span> : null}</span>{tableGone(pid) && !g ? <Gone info={drops[pid]} busy={dropsBusy} lastLabel="eliminata" /> : null}</button>; })}
              </details> : null}</React.Fragment>; }) : null}</div>; })}
      {r?.status === 'succeeded' && !schemas.length ? <div style={{ padding: 12 }} className="muted">Nessuna corrispondenza.</div> : null}
      {r?.status === 'failed' ? <div style={{ padding: 12 }} className="muted">{r.error}</div> : null}{!r && err ? <div style={{ padding: 12, color: 'var(--bad)' }}>{err}</div> : null}</div>
    {r?.result?.truncated ? <p className="small muted">Elenco troncato: affina la ricerca.</p> : null}
    {value.length ? <p className="small">Selezione: {value.map(v => { const p = splitId(v); return <code key={v} style={{ marginRight: 6 }}>{p.slice(1).join('.')}{p.length === 2 ? ' (schema)' : ''}</code>; })}</p> : null}
    <p className="small muted">Si ripristina ciò che scegli più ciò che serve per farlo funzionare: chiavi esterne, tipi, funzioni, sequenze, viste e permessi.</p></div>;
}

type PMode = 'as_new' | 'replace' | 'missing_only';

/** What the recovery itself found worth saying: a target past the archive, a database dropped right after the requested point. */
function Notices({ r }: { r: any }) {
  return <>{r.target_clamped ? <Banner kind="warn" title="Ripristinato fino alla fine dell’archivio">{r.target_clamped.message}</Banner> : null}
    {r.stopped_before_drop ? <Banner kind="info" title="Fermato subito prima del DROP DATABASE">{r.stopped_before_drop.message}</Banner> : null}
    {(r.warnings || []).length ? <Banner kind="warn" title="Da sapere">{(r.warnings as string[]).map((w, i) => <div key={i} className="small">{itCheck(w)}</div>)}</Banner> : null}</>;
}

const ACTION: Record<string, string> = { swap: 'sostituisce', create: 'viene creata', copy: 'copia accanto', skip: 'già presente: invariata' };

function PromotePlan({ p }: { p: any }) {
  return <div className="stack">{p.preflight?.checks?.length && p.preflight.level !== 'ok' ? <Preflight pf={p.preflight} /> : null}<SpaceBars vols={p.space} /><table className="t"><thead><tr><th>Tabella</th><th>Cosa succede</th><th className="num">Righe al ripristino</th></tr></thead><tbody>
    {(p.tables || []).map((t: any) => <tr key={`${t.schema}.${t.name}`}><td><code>{t.schema}.{t.name}</code></td><td className="small">{ACTION[t.action] || t.action}{t.old_kept_as ? <> — la attuale resta come <code>{t.old_kept_as}</code></> : null}{t.new_name ? <> come <code>{t.new_name}</code></> : null}{t.schema_drift ? <div className="hba-warn small" style={{ marginTop: 4 }}>Struttura cambiata da allora{t.schema_drift.columns_only_now?.length ? `: colonne aggiunte dopo (${t.schema_drift.columns_only_now.join(', ')}) che con la sostituzione spariscono` : ''}{t.schema_drift.type_changed?.length ? `; tipo cambiato: ${t.schema_drift.type_changed.join(', ')}` : ''}. Valuta «accanto agli originali» o il recupero delle righe.</div> : null}</td><td className="num">{t.rows_at_target != null ? num(t.rows_at_target) : '—'}</td></tr>)}</tbody></table>
    <dl className="kv"><dt>Chiavi esterne da ricollegare</dt><dd>{num((p.inbound_fks || []).length + (p.outbound_fks || []).length)}{(p.inbound_fks || []).length ? <span className="small muted"> — {(p.inbound_fks as any[]).slice(0, 4).map(f => `${f.table}→${f.ref_table}`).join(', ')}{p.inbound_fks.length > 4 ? '…' : ''}</span> : null}</dd>
      <dt>Viste da ricreare</dt><dd>{num((p.views || []).length)}{(p.views || []).length ? <span className="small muted"> — {(p.views as any[]).slice(0, 4).map(v => v.name).join(', ')}{p.views.length > 4 ? '…' : ''}</span> : null}</dd>
      {p.missing_prereq && Object.values(p.missing_prereq).some((x: any) => x.length) ? <><dt>Da creare prima</dt><dd className="small">{Object.entries(p.missing_prereq).filter(([, v]: any) => v.length).map(([k, v]: any) => `${k}: ${v.join(', ')}`).join(' · ')}</dd></> : null}</dl>
    {(p.rebind || []).length ? <div className="small"><strong>Ricollegati alla tabella ripristinata:</strong> {(p.rebind as string[]).join(' · ')}</div> : null}
    {(p.blocking || []).length ? <Banner kind="bad" title="La promozione non può partire">{(p.blocking as string[]).map((w, i) => <div key={i} className="small">{itCheck(w)}</div>)}</Banner> : null}
    {(p.warnings || []).map((w: string, i: number) => <div key={i} className="small" style={{ color: 'var(--warn, #d9a441)' }}>{itCheck(w)}</div>)}</div>;
}

const PROMOTE_OPT: Record<PMode, { title: string; text: string }> = {
  missing_only: { title: 'Rimetti al suo posto ciò che è stato eliminato', text: 'Le tabelle che oggi non esistono tornano con il loro nome, chiavi esterne e viste comprese. Quelle presenti non vengono toccate.' },
  replace: { title: 'Sostituisci con la versione recuperata', text: 'Le tabelle di adesso vengono messe da parte con il suffisso _old_<data> (i dati restano, puoi tornare indietro) e quelle recuperate prendono il loro posto. Chiavi esterne e viste vengono ricollegate.' },
  as_new: { title: 'Affianca per confrontare', text: 'Le tabelle recuperate compaiono accanto alle originali con il suffisso _pitr_<data> (o in uno schema a parte). Nulla di esistente viene toccato: confronti e poi decidi.' },
};

function Promote({ stage, what, deps, warnings, mode, recommended, anyGone, setMode, drop, setDrop, runner, preview, ask, allowOrphans, schema, setSchema }: { allowOrphans?: () => void; stage: string; what: string[]; deps?: any; warnings?: string[]; mode: PMode; recommended: PMode; anyGone: boolean | null; setMode: (m: PMode) => void; drop: boolean; setDrop: (b: boolean) => void; runner: ReturnType<typeof useOpRunner>; preview: ReturnType<typeof useOpRunner>; ask: () => void; schema: string; setSchema: (s: string) => void }) {
  const r = runner.op?.result; const done = runner.op?.status === 'succeeded';
  const p = preview.op?.status === 'succeeded' ? preview.op.result : null;
  const schemaOk = !schema || /^[a-z_][a-z0-9_]{0,62}$/.test(schema);
  // the preview (what exactly would change) is computed by itself for the chosen way, nothing is changed by it
  useEffect(() => { if (done || runner.busy || !schemaOk) return; const t = setTimeout(() => preview.run('restore_promote', { stage_db: stage, mode, dry_run: true, ...(mode === 'as_new' && schema ? { target_schema: schema } : {}) }), schema ? 500 : 0); return () => clearTimeout(t); }, [mode, schema, stage]);
  const order: PMode[] = [recommended, ...(['missing_only', 'replace', 'as_new'] as PMode[]).filter(m => m !== recommended)].filter(m => m !== 'missing_only' || anyGone !== false);
  return <div className="stack"><div className="hr" /><strong>Rimetti a posto</strong>
    <p className="small muted">Il recupero è nel database di quarantena <code>{stage}</code>{deps ? <> ({deps.tables} tabelle, {deps.foreign_keys} chiavi esterne, {deps.views} viste)</> : null}. Scegli come riportarlo in <code>{what[0] ? splitId(what[0])[0] : ''}</code>.</p>
    {!done ? <>
      {order.map(m => <label key={m} className={`opt ${mode === m ? 'on' : ''}`}><input type="radio" checked={mode === m} onChange={() => setMode(m)} /><div className="grow"><div><strong>{PROMOTE_OPT[m].title}</strong> {m === recommended ? <Badge kind="ok">Consigliato</Badge> : null}</div><div className="small muted">{PROMOTE_OPT[m].text}</div>
        {m === 'as_new' && mode === 'as_new' ? <div className="row gap-s" style={{ marginTop: 6 }} onClick={e => e.preventDefault()}><span className="small">Schema a parte (facoltativo)</span><input className="input mono" style={{ width: 220 }} value={schema} onChange={e => setSchema(e.target.value.toLowerCase())} placeholder="es. recuperato_ieri" aria-label="Schema di destinazione" />{!schemaOk ? <span className="small hba-err">solo minuscole, cifre e _</span> : null}</div> : null}</div></label>)}
      {preview.op && !p ? <OpPanel op={preview.op} error={preview.error} label="Cosa cambierebbe" /> : null}
      {p ? <details open={!!(p.blocking || []).length || (p.tables || []).some((t: any) => t.schema_drift)}><summary className="small" style={{ cursor: 'pointer' }}>Cosa cambierebbe esattamente ({(p.tables || []).length} tabelle, {num((p.inbound_fks || []).length + (p.outbound_fks || []).length)} chiavi esterne, {num((p.views || []).length)} viste)</summary><PromotePlan p={p} /></details> : null}
      <label className="check"><input type="checkbox" checked={drop} onChange={e => setDrop(e.target.checked)} />Elimina la quarantena a operazione riuscita</label>
      <div className="row"><div className="grow" /><Button kind="primary" icon="restore" busy={runner.busy} disabled={runner.busy || !p || p?.preflight?.ok === false || !!(p?.blocking || []).length} title={p?.preflight?.ok === false ? 'Spazio insufficiente: vedi i dettagli' : undefined} onClick={ask}>Riporta</Button></div></> : null}
    {(runner.op || runner.error) && !done ? <OpPanel op={runner.op} error={runner.error} label="Riporto nel database" /> : null}
    {runner.op?.status === 'failed' && /PGA-GEN-096/.test(String(runner.op.error || '')) && allowOrphans ? <Banner kind="warn" title="Righe che resterebbero orfane" actions={<Button sm kind="danger" onClick={allowOrphans}>Procedi comunque</Button>}>
      Puoi sostituire comunque le tabelle sapendo che quelle righe resteranno orfane: le chiavi esterne coinvolte verranno lasciate non valide. Più sicuro: ripristina insieme anche le tabelle collegate, oppure scegli «Affianca per confrontare».</Banner> : null}
    {done ? <Banner kind="ok" title="Riportato nel database">{(r?.promoted || []).length ? <>Ripristinate: {(r.promoted as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}.</> : <>{r?.note || 'Niente da fare.'}</>}
      {(r?.old_kept || []).length ? <> Le precedenti sono conservate come {(r.old_kept as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}: eliminale quando hai verificato.</> : null}
      {r?.foreign_keys_reattached ? <> {r.foreign_keys_reattached} chiavi esterne ricollegate.</> : null}{r?.views_recreated ? <> {r.views_recreated} viste ricreate.</> : null}
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
  const d = diff.op?.status === 'succeeded' ? diff.op.result : null;
  const rest = Object.keys(pick).filter(k => pick[k]); const dels = Object.keys(del).filter(k => del[k]);
  const done = apply.op?.status === 'succeeded'; const r = apply.op?.result;
  const all = (rows: any[], on: boolean, set: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void) => set(x => { const n = { ...x }; rows.forEach(w => { n[keyStr(w.key)] = on; }); return n; });
  const list = (title: string, hint: string, rows: any[], state: Record<string, boolean>, set: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void, show: (w: any) => string, total: number) => rows.length || total ? <div className="stack">
    <div className="row"><strong>{title}</strong><Badge>{num(total)}</Badge><div className="grow" />{rows.length ? <><Button onClick={() => all(rows, true, set)}>Seleziona tutte</Button><Button onClick={() => all(rows, false, set)}>Nessuna</Button></> : null}</div>
    <p className="small muted">{hint}{total > rows.length ? ` Mostrate le prime ${rows.length} di ${num(total)}.` : ''}</p>
    {rows.map(w => <label key={keyStr(w.key)} className="check"><input type="checkbox" checked={!!state[keyStr(w.key)]} onChange={e => set(x => ({ ...x, [keyStr(w.key)]: e.target.checked }))} /><span><code>{keyStr(w.key)}</code> <span className="small muted">{show(w)}</span></span></label>)}</div> : null;
  return <div className="stack"><div className="hr" /><strong>Recupera solo alcune righe</strong>
    <p className="small muted">Confronta la tabella ripristinata (<code>{stage}</code>) con quella attuale e riporta solo le righe che scegli. Prima di toccare qualcosa le versioni attuali vengono copiate in una tabella di sicurezza; tutto avviene in un’unica transazione.</p>
    {!d && !done ? <div><Button icon="search" busy={diff.busy} disabled={diff.busy} onClick={() => diff.run('restore_diff', { stage_db: stage, object: obj, limit: 200 })}>Confronta riga per riga</Button></div> : null}
    {(diff.op || diff.error) && !d ? <OpPanel op={diff.op} error={diff.error} label="Confronto delle righe" /> : null}
    {d && !done ? <>
      <Banner kind={d.counts.missing_now + d.counts.changed + d.counts.added_since ? 'info' : 'ok'} title={d.counts.missing_now + d.counts.changed + d.counts.added_since ? 'Differenze trovate' : 'Le tabelle coincidono'}>
        {d.key_from && d.key_from !== 'primary key' ? <>Senza chiave primaria: righe riconosciute dall’indice univoco <code>{String(d.key_from).replace(/^unique index /, '')}</code> (<code>{d.primary_key.join(', ')}</code>)</> : <>Chiave primaria <code>{d.primary_key.join(', ')}</code></>}: {num(d.restored_rows)} righe nel ripristino, {num(d.live_rows)} oggi. {d.columns_only_in_one_side.length ? <span className="hba-warn">Colonne presenti solo da un lato (ignorate nel confronto): {d.columns_only_in_one_side.join(', ')}.</span> : null}</Banner>
      {list('Cancellate dopo quel momento', 'Esistevano nel ripristino e oggi non ci sono più: selezionale per reinserirle.', d.missing_now, pick, setPick, (w: any) => brief(w.restored), d.counts.missing_now)}
      {list('Modificate', 'Il valore ripristinato sovrascrive quello attuale (che resta nella tabella di sicurezza).', d.changed, pick, setPick, (w: any) => `ora ${brief(w.live)} → ripristino ${brief(w.restored)}`, d.counts.changed)}
      {list('Aggiunte dopo quel momento', 'Non esistevano nel ripristino. Selezionale solo se vuoi eliminarle.', d.added_since, del, setDel, (w: any) => brief(w.live), d.counts.added_since)}
      <div className="row"><div className="grow" /><Button kind="primary" icon="restore" disabled={!rest.length && !dels.length} onClick={() => setAsk(true)}>Applica {rest.length + dels.length ? `(${rest.length + dels.length})` : ''}</Button></div></> : null}
    {(apply.op || apply.error) && !done ? <OpPanel op={apply.op} error={apply.error} label="Applicazione delle righe" /> : null}
    {done ? <Banner kind="ok" title="Righe recuperate">Reinserite {num(r?.inserted ?? 0)}, ripristinate {num(r?.updated ?? 0)}, eliminate {num(r?.deleted ?? 0)}.{r?.safety_copy ? <> Versione precedente conservata in <code>{r.safety_copy}</code>.</> : null}{r?.note ? <div className="small" style={{ marginTop: 4 }}>{itCheck(r.note)}</div> : null}</Banner> : null}
    {ask ? <Confirm title="Applicare le righe selezionate?" danger={dels.length > 0} confirmLabel="Applica" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); apply.run('restore_apply_rows', { stage_db: stage, object: obj, restore_keys: rest, delete_keys: dels }); }}>
      <p>{rest.length} righe verranno reinserite o sovrascritte con la versione ripristinata{dels.length ? <>, {dels.length} righe aggiunte dopo verranno eliminate</> : null}. La versione attuale di ogni riga toccata viene copiata prima in una tabella <code>pgarca_rowsafe_…</code>; se qualcosa fallisce non cambia nulla.</p></Confirm> : null}</div>;
}
