import { RecoveryPlacement } from './Placement';
import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Skeleton, bytes, dt, num, ago } from '../ui';
import { Op, useOpRunner, useQuery } from '../hooks';
import { OpPanel, Result } from './shared';
import { itCheck, itFix } from '../i18n';
import { RecoveryTimeline, TlEvent } from './Timeline';
import { SetRow, TYPE_LABEL, chains } from './Backup';
import { CatDb, DbPicker, DroppedNote, DropInfo, kindOf, parseWalTime, fmtWhen, qid, splitId } from './DbPicker';

type Scope = 'instance' | 'database' | 'object';
type Target = { mode: 'latest' } | { mode: 'time'; ms: number } | { mode: 'lsn'; lsn: string; label: string } | { mode: 'xid'; xid: string; label: string };
const STEPS = ['Cosa', 'Quando', 'Dove', 'Conferma'];
const KIND_LABEL: Record<string, string> = { DROP: 'Oggetto eliminato o riscritto', TRUNCATE: 'Tabella svuotata', 'DROP DATABASE': 'Database eliminato' };
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'locale'; } };
const localInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 19); };

export function RestoreTab({ c }: { c: any }) {
  const q = useQuery<any>(c.source !== 'direct' && !c.isSandbox ? `/api/clusters/${encodeURIComponent(c.id)}/backups` : null, { interval: 15000 });
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con l’agent per ripristinare.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="restore" title="Servono l’agent">Il ripristino legge il repository sul server del database: installa l’agent su un nodo del cluster.</Empty></Card>;
  if (!q.data) return <div className="stack"><Skeleton h={40} /><Skeleton h={220} /></div>;
  const sets: SetRow[] = (q.data.backup?.recent_sets || []).filter((s: SetRow) => s.status === 'COMPLETE');
  if (!q.data.agent) return <Card><Empty icon="restore" title="Nessun agent su questo cluster" /></Card>;
  if (!sets.length) return <Card><Empty icon="restore" title="Nessun backup da cui ripristinare">Esegui prima un backup completo dalla scheda Backup.</Empty></Card>;
  return <Wizard c={c} d={q.data} sets={sets} />;
}

function Wizard({ c, d, sets }: { c: any; d: any; sets: SetRow[] }) {
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<Scope>('database'); const [objMode, setObjMode] = useState<'table' | 'schema'>('table');
  const [db, setDb] = useState(''); const [objs, setObjs] = useState<string[]>([]); const obj = objs[0] || ''; const [search, setSearch] = useState('');
  const [tgt, setTgt] = useState<Target>({ mode: 'latest' });
  const [dest, setDest] = useState(''); const [newName, setNewName] = useState(''); const [action, setAction] = useState<'promote' | 'pause'>('promote'); const [delta, setDelta] = useState(false); const [keepArch, setKeepArch] = useState(false);
  const [ask, setAsk] = useState(false);
  const prom = useOpRunner(c.id); const prev = useOpRunner(c.id); const [pmode, setPmode] = useState<PMode>('as_new'); const [pdrop, setPdrop] = useState(true); const [askPromote, setAskPromote] = useState(false); const [pschema, setPschema] = useState('');
  const dbsR = useOpRunner(c.id); const dropsR = useOpRunner(c.id); const liveR = useOpRunner(c.id); const tdropR = useOpRunner(c.id); const [fxHours, setFxHours] = useState(24); const objR = useOpRunner(c.id); const plan = useOpRunner(c.id); const exec = useOpRunner(c.id); const fx = useOpRunner(c.id); const dml = useOpRunner(c.id); const [dmlMin, setDmlMin] = useState(1000);

  const from = useMemo(() => Math.min(...sets.map(s => Date.parse(s.stop_time!))), [sets]);
  const to = Math.max(Date.now(), d.archiver?.last_archived_time ? Date.parse(d.archiver.last_archived_time) : 0);
  const events: (TlEvent & { raw: any })[] = useMemo(() => (fx.op?.result?.events || []).map((e: any) => ({ at: parseWalTime(e.time), label: `${e.kind}: ${(e.names || []).join(', ')}`, raw: e })).filter((e: any) => Number.isFinite(e.at)), [fx.op]);

  // catalogue pickers: run once per scope entry, through the agent (the catalogue lives next to the repository)
  useEffect(() => { if ((scope === 'database' || scope === 'object') && !dbsR.op && !dbsR.busy) dbsR.run('backup_catalog', { set: 'all' }); }, [scope]);
  useEffect(() => { if (scope === 'object' && db && !dbs.find(x => x.name === db)?.late) { const t = setTimeout(() => objR.run('backup_catalog', { set: dbs.find(x => x.name === db)?.last_set || 'latest', database: db, search, limit: 400 }), search ? 350 : 0); return () => clearTimeout(t); } }, [scope, db, search]);
  useEffect(() => { if (!newName && db) setNewName(`${db}_restored`.slice(0, 63)); }, [db]);

  const tparams = (): Record<string, any> => tgt.mode === 'time' ? { target_time: new Date(tgt.ms).toISOString() } : tgt.mode === 'lsn' ? { target_lsn: tgt.lsn, inclusive: false } : tgt.mode === 'xid' ? { target_xid: tgt.xid, inclusive: false } : {};
  const params = (): { type: string; p: Record<string, any> } => scope === 'instance' ? { type: 'restore_instance', p: { destination: dest, action, delta, ...(keepArch ? { keep_archiving: true } : {}), ...tparams() } }
    : scope === 'database' ? { type: 'restore_database', p: { database: db, new_name: newName, ...tparams() } } : { type: 'restore_object', p: { object: obj, objects: objs, ...tparams() } };
  const planParams = () => { const x = params().p; return { scope, ...x }; };

  const catDbs: CatDb[] = dbsR.op?.result?.databases || [];
  // databases that exist now but in NO backup (created after the last one): restorable from the WAL alone, so they are offered too
  const dbs: CatDb[] = useMemo(() => dbsR.op?.status !== 'succeeded' ? catDbs : [...catDbs, ...((c.databases || []) as any[]).filter(x => x?.name && !catDbs.some(d => d.name === x.name))
    .map(x => ({ name: String(x.name), oid: String(x.oid ?? ''), size: Number(x.size) || 0, late: true }))], [dbsR.op, c.databases]);
  // what exists NOW (agent snapshot): a database in the backups and not here was DROPPED
  const live: Set<string> | null = Array.isArray(c.databases) && c.databases.length ? new Set<string>(c.databases.map((x: any) => x.name)) : null;
  const droppedDbs = useMemo(() => (live ? dbs.filter(x => !live.has(x.name) && kindOf(x.name) === 'app') : []), [dbs, live]);
  const drops: Record<string, DropInfo> = useMemo(() => { const m: Record<string, DropInfo> = {}; for (const x of dropsR.op?.result?.dropped || []) m[String(x.oid)] = { time: x.time, time_exact: !!x.time_exact }; return m; }, [dropsR.op]);
  // when did they disappear? one cheap WAL scan (Database records only, cached, own queue: it never blocks a backup or a restore); looks back at most 14 days
  useEffect(() => {
    if (!droppedDbs.length || dropsR.op || dropsR.busy) return;
    const oldest = Math.min(...droppedDbs.map(x => Date.parse(x.last_stop || '') || Date.now())); const since = Math.max(oldest - 3600e3, Date.now() - 14 * 86400e3);
    dropsR.run('wal_forensics', { background: true, mode: 'databases', since_iso: new Date(since).toISOString(), limit: 100, budget_sec: 300 });
  }, [droppedDbs.length]);
  const selDb = dbs.find(x => x.name === db); const selDropped = !!selDb && droppedDbs.some(x => x.name === db);
  // tables / schemas of the selected database that exist NOW: whatever the backup knows and the server does not was DROPPED (the database itself may be gone: then everything is)
  useEffect(() => { if (scope === 'object' && db && live?.has(db)) liveR.run('list_objects', { database: db, background: true }); }, [scope, db]);
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
  const okWhat = scope === 'instance' || (scope === 'database' && !!db) || (scope === 'object' && objs.length > 0);
  const okWhere = scope === 'instance' ? dest.startsWith('/') : scope === 'database' ? /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(newName) : true;
  const okWhen = tgt.mode !== 'time' || (tgt.ms >= from && tgt.ms <= to + 60000);
  const blocked = plan.op?.status === 'succeeded' && (!!plan.op.result?.missing_wal?.length || plan.op.result?.preflight?.ok === false);
  const next = () => { const n = step + 1; setStep(n); if (n === 3) plan.run('restore_plan', planParams()); };
  const baseSet = useMemo(() => {
    const t = tgt.mode === 'time' ? tgt.ms : Infinity; const ok = sets.filter(s => Date.parse(s.stop_time!) <= t);
    return ok.length ? ok[ok.length - 1] : null;
  }, [sets, tgt]);
  const running = exec.busy;
  const doneOk = exec.op?.status === 'succeeded';

  return <div className="stack-l">
    <div className="steps">{STEPS.map((s, i) => <span key={s} className={`s ${i === step ? 'on' : i < step ? 'done' : ''}`}>{i < step ? <Icon n="check" s={14} /> : null}{s}</span>)}</div>

    {step === 0 && <Card title="Cosa vuoi ripristinare?"><div className="stack">
      <div className="grid choices">
        <button className="choice" aria-pressed={scope === 'database'} onClick={() => setScope('database')}><Icon n="db" s={22} /><div><strong>Un database</strong><p className="sub">Estrae solo i file di quel database: molto più veloce del cluster intero. Arriva con un nome nuovo.</p></div></button>
        <button className="choice" aria-pressed={scope === 'object' && objMode === 'schema'} onClick={() => { setScope('object'); if (objMode !== 'schema') { setObjMode('schema'); setObjs([]); } }}><Icon n="layers" s={22} /><div><strong>Uno schema</strong><p className="sub">Recupera un intero schema con tutte le sue tabelle, chiavi esterne, viste, sequenze e permessi, anche se è stato eliminato. Passa da un database di quarantena.</p></div></button>
        <button className="choice" aria-pressed={scope === 'object' && objMode === 'table'} onClick={() => { setScope('object'); if (objMode !== 'table') { setObjMode('table'); setObjs([]); } }}><Icon n="file" s={22} /><div><strong>Una o più tabelle</strong><p className="sub">Recupera singole tabelle con ciò da cui dipendono, o righe puntuali. Le tabelle eliminate sono segnalate.</p></div></button>
        <button className="choice" aria-pressed={scope === 'instance'} onClick={() => setScope('instance')}><Icon n="server" s={22} /><div><strong>Tutto il cluster</strong><p className="sub">Ricostruisce una copia completa in una cartella vuota. Non tocca mai l’istanza in esecuzione.</p></div></button></div>
      {scope !== 'instance' ? (dbsR.op && dbsR.op.status === 'succeeded' ? <>
        <Field label="Database"><DbPicker dbs={dbs} live={live} drops={drops} dropsState={dropsR.busy ? 'running' : dropsR.op?.status === 'succeeded' ? 'done' : dropsR.op ? 'failed' : 'idle'} value={db} onChange={n => { setDb(n); setObjs([]); prev.reset(); }} /></Field>
        {selDropped && selDb ? <DroppedNote db={db} info={drops[String(selDb.oid)]} lastStop={selDb.last_stop} /> : null}
        {selDb?.late ? <Banner kind="info" title="Creato dopo l’ultimo backup">Nessun backup contiene <strong>{db}</strong>: pg_arca lo ricostruisce dai soli WAL archiviati (la creazione e tutte le modifiche vengono rigiocate). Funziona per ogni istante successivo alla sua creazione; un backup recente rende il ripristino più rapido.</Banner> : null}
        {scope === 'object' && db ? <ObjectPicker r={selDb?.late ? null : objR.op} busy={selDb?.late ? liveR.busy : objR.busy} search={search} setSearch={setSearch} db={db} value={objs} onChange={setObjs} mode={objMode} live={objLive} drops={tblDrops} dropsBusy={tdropR.busy} err={objR.error} /> : null}</> :
        <OpPanel op={dbsR.op} error={dbsR.error} label="Lettura del catalogo dei backup" />) : null}
      <div className="row"><div className="grow" /><Button kind="primary" disabled={!okWhat} onClick={() => setStep(1)}>Avanti</Button></div></div></Card>}

    {step === 1 && <Card title="A quale istante?"><div className="stack">
      <p className="muted">Trascina il segnalino o clicca sulla linea. Le tacche sono i backup; l’area colorata è l’intervallo recuperabile grazie ai WAL archiviati. A destra c’è l’ultimo istante disponibile.</p>
      <RecoveryTimeline sets={sets} from={from} to={to} value={tgt.mode === 'time' ? tgt.ms : tgt.mode === 'latest' ? null : null} onChange={ms => setTgt(ms == null ? { mode: 'latest' } : { mode: 'time', ms })} events={events} broken={d.wal?.continuous === false} />
      <div className="grid g2">
        <Field label={`Data e ora (${tzName()})`} error={!okWhen ? 'Fuori dall’intervallo recuperabile.' : null} hint="Viene inviato con il fuso orario: nessuna ambiguità.">
          <input className="input" type="datetime-local" step={1} min={localInput(from)} max={localInput(to)} value={tgt.mode === 'time' ? localInput(tgt.ms) : localInput(to)} onChange={e => { const ms = new Date(e.target.value).getTime(); if (Number.isFinite(ms)) setTgt({ mode: 'time', ms }); }} /></Field>
        <div className="stack"><div className="small muted">Scelta attuale</div>
          <div>{tgt.mode === 'latest' ? <strong>Ultimo istante disponibile</strong> : tgt.mode === 'time' ? <strong>{new Date(tgt.ms).toLocaleString('it-CH')}</strong> : <strong>Subito prima di {tgt.label}</strong>}</div>
          {tgt.mode !== 'latest' ? <Button sm onClick={() => setTgt({ mode: 'latest' })}>Usa l’ultimo istante</Button> : null}
          <div className="small muted">Backup di partenza: {baseSet ? <><span className="mono">{baseSet.id}</span> ({TYPE_LABEL[baseSet.type]})</> : <span style={{ color: 'var(--bad)' }}>nessuno prima di questo istante</span>}</div></div></div>
      {selDb && !selDb.late && selDb.first_stop && tgt.mode === 'time' && tgt.ms < Date.parse(selDb.first_stop) ? <Banner kind="warn" title={`${db} compare nei backup solo dal ${fmtWhen(Date.parse(selDb.first_stop))}`}>A questo istante potrebbe non esistere ancora: in quel caso il ripristino si ferma dopo il recupero e lo dice. Se è stato creato più tardi, scegli un istante successivo alla sua creazione.</Banner> : null}
      {selDropped && tgt.mode === 'latest' ? <Banner kind="info" title="Database eliminato: l’ultimo istante utile è subito prima del DROP">Per <strong>{db}</strong> “ultimo istante disponibile” significa un attimo prima che venisse eliminato: pg_arca lo individua da solo nei WAL. Scegli un istante diverso solo se ti serve una versione più vecchia.</Banner> : null}
      <details open={!!events.length || !!fx.op || !!dml.op}><summary style={{ cursor: 'pointer', fontWeight: 500 }}>Hai cancellato qualcosa? Cerca eliminazioni e svuotamenti nei WAL</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <p className="small muted">Individua i comandi che hanno eliminato o svuotato tabelle e database, con data e ora, così puoi tornare a un attimo prima. L’analisi gira in parallelo e non rallenta backup e ripristini; i risultati restano in memoria, quindi la ricerca successiva è quasi immediata.</p>
          <div className="row wrap"><span className="seg" role="group" aria-label="Quanto indietro cercare">{[[24, 'Ultime 24 ore'], [168, '7 giorni'], [720, '30 giorni'], [0, 'Tutto l’archivio']].map(([h, t]) => <button key={h} aria-pressed={fxHours === h} onClick={() => setFxHours(h as number)}>{t}</button>)}</span>
            <Button sm icon="search" busy={fx.busy} onClick={() => fx.run('wal_forensics', { mode: 'events', hours: fxHours, limit: 30 })}>Avvia analisi</Button></div>
          {fx.op && fx.op.status !== 'succeeded' ? <OpPanel op={fx.op} error={fx.error} cancel={fx.cancel} /> : null}
          {fx.op?.status === 'succeeded' ? <>
            <div className="small muted">{num(fx.op.result.segments_scanned)} segmenti analizzati{fx.op.result.segments_cached ? ` (${num(fx.op.result.segments_cached)} già in memoria)` : ''} in {fx.op.result.elapsed_sec} s · dal {fx.op.result.window?.from}</div>
            {fx.op.result.complete === false ? <Banner kind="warn" title="Analisi parziale">È stato raggiunto il tempo massimo: ho analizzato i segmenti più recenti. Rilancia la ricerca per continuare: riparte da dove si era fermata.</Banner> : null}
            {fx.op.result.events.length ? <table className="t"><thead><tr><th>Evento</th><th>Oggetti</th><th>Quando</th><th /></tr></thead><tbody>
              {[...fx.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); return <tr key={i}><td><Badge kind="bad" title={e.rewrite_possible ? 'Il WAL di un TRUNCATE e quello di una riscrittura (VACUUM FULL, CLUSTER, ALTER TABLE che cambia tipo) sono identici: controlla se a quell’ora era in corso una manutenzione.' : undefined}>{e.rewrite_possible ? 'Tabella svuotata o riscritta' : KIND_LABEL[e.kind] || e.kind}</Badge></td><td className="small">{(e.names || []).join(', ') || '—'}{e.nrels > (e.names || []).length ? ` e altri ${e.nrels - e.names.length}` : ''}</td>
                <td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'circa ' : ''}${fmtWhen(t)}` : e.time}</td>
                <td className="num"><Button sm onClick={() => setTgt(Number.isFinite(t) && e.time_exact !== false ? { mode: 'lsn', lsn: e.lsn, label: `${KIND_LABEL[e.kind] || e.kind} ${(e.names || [])[0] || ''} (${fmtWhen(t)})` } : { mode: 'lsn', lsn: e.lsn, label: `${KIND_LABEL[e.kind] || e.kind} ${(e.names || [])[0] || ''} (${e.lsn})` })}>Ripristina subito prima</Button></td></tr>; })}</tbody></table>
              : <p className="muted">Nessuna eliminazione o svuotamento trovato nel periodo analizzato. Prova con un periodo più lungo.</p>}</> : null}
          <div className="hr" />
          <strong className="small">Righe cancellate o modificate in massa (DELETE o UPDATE senza WHERE)</strong>
          <p className="small muted">Trova le transazioni confermate che hanno eliminato o modificato molte righe di una tabella, con l’ora esatta: ripristinando «subito prima» quella transazione è esclusa, tutto ciò che è stato confermato prima resta. Più lenta della ricerca qui sopra: legge ogni riga modificata nel periodo scelto. Le transazioni annullate (ROLLBACK) non compaiono.</p>
          <div className="row wrap"><span className="seg" role="group" aria-label="Righe minime">{[[1000, 'da 1.000 righe'], [10000, 'da 10.000'], [100000, 'da 100.000']].map(([n, t]) => <button key={n} aria-pressed={dmlMin === n} onClick={() => setDmlMin(n as number)}>{t}</button>)}</span>
            <Button sm icon="search" busy={dml.busy} onClick={() => dml.run('wal_forensics', { mode: 'dml', hours: fxHours, min_rows: dmlMin, limit: 30 })}>Cerca modifiche di massa</Button></div>
          {dml.op && dml.op.status !== 'succeeded' ? <OpPanel op={dml.op} error={dml.error} cancel={dml.cancel} /> : null}
          {dml.op?.status === 'succeeded' ? (dml.op.result.events.length ? <table className="t"><thead><tr><th>Cosa</th><th>Tabella</th><th>Quando</th><th /></tr></thead><tbody>
            {[...dml.op.result.events].reverse().map((e: any, i: number) => { const t = parseWalTime(e.time); const what = e.kind === 'DELETE' ? `${num(e.deleted)} righe eliminate` : e.kind === 'UPDATE' ? `${num(e.updated)} righe modificate` : `${num(e.deleted)} eliminate, ${num(e.updated)} modificate`;
              return <tr key={i}><td><Badge kind="bad">{what}</Badge>{e.committed === false ? <div className="small faint">conferma non trovata nei WAL vicini</div> : null}</td><td className="small">{(e.names || []).join(', ')}</td><td className="small nowrap">{Number.isFinite(t) ? `${e.time_exact === false ? 'circa ' : ''}${fmtWhen(t)}` : e.time}</td>
                <td className="num"><Button sm onClick={() => setTgt({ mode: 'xid', xid: String(e.xid), label: `${what} in ${(e.names || [])[0] || ''} (${Number.isFinite(t) ? fmtWhen(t) : 'xid ' + e.xid})` })}>Ripristina subito prima</Button></td></tr>; })}</tbody></table>
            : <p className="muted small">Nessuna transazione con almeno {num(dml.op.result.min_rows)} righe eliminate o modificate nel periodo ({num(dml.op.result.segments_scanned)} segmenti analizzati).</p>) : null}
        </div></details>
      <div className="row"><Button onClick={() => setStep(0)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhen || !baseSet && tgt.mode === 'time'} onClick={() => setStep(2)}>Avanti</Button></div></div></Card>}

    {step === 2 && <Card title="Dove?"><div className="stack">
      {scope === 'instance' ? <>
        <Field label="Cartella di destinazione" hint="Percorso assoluto sul server, vuoto o inesistente. La data directory in uso e le cartelle di sistema sono rifiutate." error={dest && !dest.startsWith('/') ? 'Deve iniziare con /' : null}><input className="input mono" value={dest} onChange={e => setDest(e.target.value)} placeholder="/var/lib/postgresql/restore-2026" /></Field>
        <Field label="Al termine del recovery"><div className="seg"><button aria-pressed={action === 'promote'} onClick={() => setAction('promote')}>Diventa un’istanza normale</button><button aria-pressed={action === 'pause'} onClick={() => setAction('pause')}>Resta in pausa per controllare</button></div></Field>
        <label className="check"><input type="checkbox" checked={delta} onChange={e => setDelta(e.target.checked)} />Ripristino differenziale su una cartella già ripristinata (copia solo ciò che differisce)</label>
        <label className="check"><input type="checkbox" checked={keepArch} onChange={e => setKeepArch(e.target.checked)} />Questa copia sostituirà il server originale: lascia attiva l’archiviazione WAL</label>
        <p className="small muted" style={{ marginTop: -6 }}>{keepArch ? 'Avviata, la copia archivierà nello stesso archivio WAL della produzione: fallo solo se il server originale non tornerà.' : 'Di norma la copia parte con l’archiviazione WAL spenta, senza standby sincroni da attendere e senza seguire un primario: così puoi avviarla accanto alla produzione senza toccarne l’archivio.'}</p></> :
        scope === 'database' ? <Field label="Nome del nuovo database" hint="Non sovrascrive mai un database esistente: se il nome c’è già, il ripristino si ferma prima di iniziare."><input className="input" value={newName} onChange={e => setNewName(e.target.value)} /></Field> :
        <Banner kind="info" title="Quarantena">Quanto scelto viene ricostruito, con tutto ciò da cui dipende, in un database temporaneo separato. Da lì lo controlli e lo riporti dove serve; il tuo database originale non viene toccato.</Banner>}
      <div className="row"><Button onClick={() => setStep(1)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhere} onClick={next}>Controlla piano</Button></div></div></Card>}

    {step === 3 && <div className="stack-l">
      <Card title="Piano di ripristino"><div className="stack">
        {plan.op?.status === 'succeeded' ? <PlanView p={plan.op.result} scope={scope} /> : <OpPanel op={plan.op} error={plan.error} label="Verifica del piano" />}
        {scope !== 'instance' && plan.op ? <RecoveryPlacement clusterId={c.id} /> : null}
        {plan.op?.status === 'failed' && scope === 'instance' && /PGA-RST-040/.test(String(plan.op.error || '')) && !exec.op ? <Banner kind="info" title="In quella cartella c’è un ripristino interrotto" actions={<Button sm icon="restore" onClick={() => exec.run('restore_instance', { ...params().p, resume: true })}>Riprendilo</Button>}>Riprendendo, pg_arca completa la copia scrivendo solo ciò che manca o è diverso. Per ricominciare da zero svuota la cartella o scegline un’altra.</Banner> : null}
        {plan.op?.status === 'failed' ? <div><Button onClick={() => setStep(1)}>Cambia istante</Button></div> : null}</div></Card>
      {plan.op?.status === 'succeeded' && !exec.op ? <div className="row"><Button onClick={() => setStep(2)}>Indietro</Button><div className="grow" />{blocked ? <span className="small" style={{ color: 'var(--bad)' }}>Risolvi i punti in rosso per procedere</span> : null}<Button kind="primary" icon="restore" disabled={blocked} onClick={() => setAsk(true)}>Avvia ripristino</Button></div> : null}
      {(exec.op || exec.error) ? <Card title="Ripristino"><div className="stack"><OpPanel op={exec.op} error={exec.error} cancel={exec.cancel} />
        {doneOk ? <Banner kind="ok" title="Ripristino completato">{scope === 'instance' ? <>Cartella pronta in <code>{exec.op!.result.destination}</code>. {exec.op!.result.start_hint}</> : <>Dati disponibili nel database <code>{exec.op!.result.result_database}</code>.{exec.op!.result.inspect ? <> Per controllare: <code>{exec.op!.result.inspect}</code></> : null}</>}</Banner> : null}
        {doneOk ? <Notices r={exec.op!.result} /> : null}
        {doneOk && scope === 'object' && exec.op!.result.result_database ? <Promote stage={exec.op!.result.result_database} what={objs} deps={exec.op!.result.dependencies} warnings={exec.op!.result.warnings} mode={pmode} setMode={m => { setPmode(m); prev.reset(); }} drop={pdrop} setDrop={setPdrop} runner={prom} preview={prev} ask={() => setAskPromote(true)} schema={pschema} setSchema={v => { setPschema(v); prev.reset(); }} /> : null}
        {doneOk && scope === 'object' && objs.length === 1 && splitId(objs[0]).length === 3 && exec.op!.result.result_database ? <RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} /> : null}
        <Result op={exec.op} />
        {scope === 'instance' && exec.op && ['failed', 'cancelled'].includes(exec.op.status) && /PGA-RST-040|cancel|interrott|No space|ENOSPC|PGA-RST-03/i.test(String(exec.op.error || '')) ? <Banner kind="info" title="Ripristino interrotto" actions={<Button sm icon="restore" onClick={() => exec.run('restore_instance', { ...(exec.op!.params || params().p), resume: true })}>Riprendi da dove si è fermato</Button>}>
          La copia parziale in <code>{(exec.op.params || {}).destination || dest}</code> è riconosciuta: riprendendo, pg_arca scrive solo ciò che manca o è diverso (utile dopo un annullamento, un disco pieno liberato o un riavvio dell’agent).</Banner> : null}
        {(exec.op && !running) ? <div><Button onClick={() => { exec.reset(); plan.reset(); prom.reset(); prev.reset(); setObjs([]); setStep(0); }}>Nuovo ripristino</Button></div> : null}</div></Card> : null}
    </div>}

    {askPromote ? <Confirm title="Riportare nel database?" danger={pmode === 'replace'} requireText={pmode === 'replace' ? 'SOSTITUISCI' : undefined} confirmLabel="Riporta" onClose={() => setAskPromote(false)} onConfirm={() => { setAskPromote(false); prom.run('restore_promote', { stage_db: exec.op!.result.result_database, object: obj, mode: pmode, drop_stage: pdrop, ...(pmode === 'replace' ? { confirm: 'SOSTITUISCI' } : {}), ...(pmode === 'as_new' && pschema ? { target_schema: pschema } : {}) }); }}>
      <p>{pmode === 'as_new' ? <>Le tabelle ripristinate compaiono accanto alle originali con un nome che termina in <code>_pitr_&lt;data&gt;</code>. Nulla di esistente viene toccato.</> : pmode === 'missing_only' ? <>Tornano solo le tabelle che oggi non esistono; quelle presenti restano com’è con i dati di adesso.</> : <>Le originali vengono rinominate <code>_old_&lt;data&gt;</code> (i dati restano) e le ripristinate prendono il loro nome in un’unica transazione: chiavi esterne e viste che dipendevano dalle vecchie vengono ricollegate alle nuove.</>}</p>
      <p className="small muted">{pdrop ? 'Il database di quarantena viene eliminato a operazione riuscita.' : 'Il database di quarantena resta disponibile.'}</p></Confirm> : null}
    {ask ? <Confirm title="Avviare il ripristino?" confirmLabel="Avvia" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); const x = params(); exec.run(x.type, x.p); }}>
      <p>{scope === 'instance' ? <>Ricostruisce il cluster in <code>{dest}</code>.</> : scope === 'database' ? <>Crea il database <code>{newName}</code> da <code>{db}</code>.</> : <>Ricostruisce {objs.length === 1 ? <code>{obj}</code> : <>{objs.length} elementi</>} in un database di quarantena.</>} L’istanza in esecuzione e i suoi dati non vengono modificati. Se qualcosa fallisce, ciò che è stato creato viene rimosso.</p></Confirm> : null}
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
    {(p.tables || []).map((t: any) => <tr key={`${t.schema}.${t.name}`}><td><code>{t.schema}.{t.name}</code></td><td className="small">{ACTION[t.action] || t.action}{t.old_kept_as ? <> — la attuale resta come <code>{t.old_kept_as}</code></> : null}{t.new_name ? <> come <code>{t.new_name}</code></> : null}</td><td className="num">{t.rows_at_target != null ? num(t.rows_at_target) : '—'}</td></tr>)}</tbody></table>
    <dl className="kv"><dt>Chiavi esterne da ricollegare</dt><dd>{num((p.inbound_fks || []).length + (p.outbound_fks || []).length)}{(p.inbound_fks || []).length ? <span className="small muted"> — {(p.inbound_fks as any[]).slice(0, 4).map(f => `${f.table}→${f.ref_table}`).join(', ')}{p.inbound_fks.length > 4 ? '…' : ''}</span> : null}</dd>
      <dt>Viste da ricreare</dt><dd>{num((p.views || []).length)}{(p.views || []).length ? <span className="small muted"> — {(p.views as any[]).slice(0, 4).map(v => v.name).join(', ')}{p.views.length > 4 ? '…' : ''}</span> : null}</dd>
      {p.missing_prereq && Object.values(p.missing_prereq).some((x: any) => x.length) ? <><dt>Da creare prima</dt><dd className="small">{Object.entries(p.missing_prereq).filter(([, v]: any) => v.length).map(([k, v]: any) => `${k}: ${v.join(', ')}`).join(' · ')}</dd></> : null}</dl>
    {(p.rebind || []).length ? <div className="small"><strong>Ricollegati alla tabella ripristinata:</strong> {(p.rebind as string[]).join(' · ')}</div> : null}
    {(p.blocking || []).length ? <Banner kind="bad" title="La promozione non può partire">{(p.blocking as string[]).map((w, i) => <div key={i} className="small">{itCheck(w)}</div>)}</Banner> : null}
    {(p.warnings || []).map((w: string, i: number) => <div key={i} className="small" style={{ color: 'var(--warn, #d9a441)' }}>{itCheck(w)}</div>)}</div>;
}

function Promote({ stage, what, deps, warnings, mode, setMode, drop, setDrop, runner, preview, ask, schema, setSchema }: { stage: string; what: string[]; deps?: any; warnings?: string[]; mode: PMode; setMode: (m: PMode) => void; drop: boolean; setDrop: (b: boolean) => void; runner: ReturnType<typeof useOpRunner>; preview: ReturnType<typeof useOpRunner>; ask: () => void; schema: string; setSchema: (s: string) => void }) {
  const r = runner.op?.result; const done = runner.op?.status === 'succeeded';
  const p = preview.op?.status === 'succeeded' ? preview.op.result : null;
  return <div className="stack"><div className="hr" /><strong>Riporta nel database</strong>
    <p className="small muted">Controlla prima i dati nella quarantena (<code>{stage}</code>){deps ? <> — {deps.tables} tabelle, {deps.foreign_keys} chiavi esterne, {deps.views} viste, {deps.sequences} sequenze, {deps.functions} funzioni</> : null}. Poi scegli come rimetterli in <code>{what[0] ? splitId(what[0])[0] : ''}</code>: non cancella mai nulla.</p>
    {!done ? <>
      <label className={`opt ${mode === 'as_new' ? 'on' : ''}`}><input type="radio" checked={mode === 'as_new'} onChange={() => setMode('as_new')} /><div><div>Accanto agli originali (consigliato)</div><div className="small muted">Nuove tabelle con suffisso <code>_pitr_&lt;data&gt;</code>, oppure con i loro nomi in uno schema separato: confronti e poi decidi.</div>
        {mode === 'as_new' ? <div className="row gap-s" style={{ marginTop: 6 }} onClick={e => e.preventDefault()}><span className="small">Schema separato (facoltativo)</span><input className="input mono" style={{ width: 220 }} value={schema} onChange={e => setSchema(e.target.value.toLowerCase())} placeholder="es. recuperato_ieri" aria-label="Schema di destinazione" />{schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) ? <span className="small hba-err">solo minuscole, cifre e _</span> : null}</div> : null}</div></label>
      <label className={`opt ${mode === 'replace' ? 'on' : ''}`}><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /><div><div>Al posto degli originali</div><div className="small muted">Le originali diventano <code>_old_&lt;data&gt;</code> (dati conservati); le ripristinate prendono il nome. Chiavi esterne e viste vengono ricollegate. Una tabella o uno schema cancellati tornano com’erano.</div></div></label>
      <label className={`opt ${mode === 'missing_only' ? 'on' : ''}`}><input type="radio" checked={mode === 'missing_only'} onChange={() => setMode('missing_only')} /><div><div>Solo ciò che manca</div><div className="small muted">Utile dopo un DROP di schema: tornano le tabelle sparite, quelle presenti non vengono toccate.</div></div></label>
      <label className="check"><input type="checkbox" checked={drop} onChange={e => setDrop(e.target.checked)} />Elimina la quarantena dopo la riuscita</label>
      <div className="row"><Button icon="search" busy={preview.busy} disabled={preview.busy || runner.busy} onClick={() => preview.run('restore_promote', { stage_db: stage, mode, dry_run: true, ...(mode === 'as_new' && schema ? { target_schema: schema } : {}) })}>Anteprima delle modifiche</Button>
        <Button kind="primary" icon="restore" busy={runner.busy} disabled={runner.busy || p?.preflight?.ok === false} title={p?.preflight?.ok === false ? "Spazio insufficiente: vedi l’anteprima" : undefined} onClick={ask}>Riporta</Button></div>
      {preview.op && !p ? <OpPanel op={preview.op} error={preview.error} label="Calcolo dell’anteprima" /> : null}
      {p ? <PromotePlan p={p} /> : null}</> : null}
    {(runner.op || runner.error) && !done ? <OpPanel op={runner.op} error={runner.error} label="Promozione" /> : null}
    {done ? <Banner kind="ok" title="Riportato nel database">{(r?.promoted || []).length ? <>Ripristinate: {(r.promoted as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}.</> : <>{r?.note || 'Niente da fare.'}</>}
      {(r?.old_kept || []).length ? <> Le precedenti sono conservate come {(r.old_kept as string[]).map(x => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}.</> : null}
      {r?.foreign_keys_reattached ? <> {r.foreign_keys_reattached} chiavi esterne ricollegate.</> : null}{r?.views_recreated ? <> {r.views_recreated} viste ricreate.</> : null}
      {(r?.plan?.warnings || warnings || []).length ? <span className="hba-warn"> {(r.plan?.warnings || warnings).join(' · ')}</span> : null}</Banner> : null}
    {done ? <Result op={runner.op} /> : null}</div>;
}

const keyStr = (k: any[]) => JSON.stringify(k);
const brief = (o: any) => { const t = JSON.stringify(o); return t.length > 140 ? t.slice(0, 140) + '…' : t; };
function RowRecovery({ clusterId, stage, obj }: { clusterId: string; stage: string; obj: string }) {
  const diff = useOpRunner(clusterId); const apply = useOpRunner(clusterId);
  const [pick, setPick] = useState<Record<string, boolean>>({}); const [del, setDel] = useState<Record<string, boolean>>({}); const [ask, setAsk] = useState(false);
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
    {done ? <Banner kind="ok" title="Righe recuperate">Reinserite {num(r?.inserted ?? 0)}, ripristinate {num(r?.updated ?? 0)}, eliminate {num(r?.deleted ?? 0)}.{r?.safety_copy ? <> Versione precedente conservata in <code>{r.safety_copy}</code>.</> : null}</Banner> : null}
    {ask ? <Confirm title="Applicare le righe selezionate?" danger={dels.length > 0} confirmLabel="Applica" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); apply.run('restore_apply_rows', { stage_db: stage, object: obj, restore_keys: rest, delete_keys: dels }); }}>
      <p>{rest.length} righe verranno reinserite o sovrascritte con la versione ripristinata{dels.length ? <>, {dels.length} righe aggiunte dopo verranno eliminate</> : null}. La versione attuale di ogni riga toccata viene copiata prima in una tabella <code>pgarca_rowsafe_…</code>; se qualcosa fallisce non cambia nulla.</p></Confirm> : null}</div>;
}
