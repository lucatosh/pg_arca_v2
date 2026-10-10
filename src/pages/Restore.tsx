import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Banner, Button, Card, Confirm, Empty, Field, Icon, Skeleton, bytes, dt, num, ago } from '../ui';
import { Op, useOpRunner, useQuery } from '../hooks';
import { OpPanel, Result } from './shared';
import { RecoveryTimeline, TlEvent } from './Timeline';
import { SetRow, TYPE_LABEL, chains } from './Backup';

type Scope = 'instance' | 'database' | 'object';
type Target = { mode: 'latest' } | { mode: 'time'; ms: number } | { mode: 'lsn'; lsn: string; label: string };
const STEPS = ['Cosa', 'Quando', 'Dove', 'Conferma'];
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
  const [scope, setScope] = useState<Scope>('database');
  const [db, setDb] = useState(''); const [obj, setObj] = useState(''); const [search, setSearch] = useState('');
  const [tgt, setTgt] = useState<Target>({ mode: 'latest' });
  const [dest, setDest] = useState(''); const [newName, setNewName] = useState(''); const [action, setAction] = useState<'promote' | 'pause'>('promote'); const [delta, setDelta] = useState(false);
  const [ask, setAsk] = useState(false);
  const prom = useOpRunner(c.id); const [pmode, setPmode] = useState<'as_new' | 'replace'>('as_new'); const [pdrop, setPdrop] = useState(true); const [askPromote, setAskPromote] = useState(false);
  const dbsR = useOpRunner(c.id); const objR = useOpRunner(c.id); const plan = useOpRunner(c.id); const exec = useOpRunner(c.id); const fx = useOpRunner(c.id);

  const from = useMemo(() => Math.min(...sets.map(s => Date.parse(s.stop_time!))), [sets]);
  const to = Math.max(Date.now(), d.archiver?.last_archived_time ? Date.parse(d.archiver.last_archived_time) : 0);
  const events: (TlEvent & { raw: any })[] = useMemo(() => (fx.op?.result?.events || []).map((e: any) => ({ at: Date.parse(e.time), label: `${e.kind}: ${(e.names || []).join(', ')}`, raw: e })).filter((e: any) => Number.isFinite(e.at)), [fx.op]);

  // catalogue pickers: run once per scope entry, through the agent (the catalogue lives next to the repository)
  useEffect(() => { if ((scope === 'database' || scope === 'object') && !dbsR.op && !dbsR.busy) dbsR.run('backup_catalog', { set: 'latest' }); }, [scope]);
  useEffect(() => { if (scope === 'object' && db) { const t = setTimeout(() => objR.run('backup_catalog', { set: 'latest', database: db, search, limit: 400 }), search ? 350 : 0); return () => clearTimeout(t); } }, [scope, db, search]);
  useEffect(() => { if (!newName && db) setNewName(`${db}_restored`.slice(0, 63)); }, [db]);

  const tparams = (): Record<string, any> => tgt.mode === 'time' ? { target_time: new Date(tgt.ms).toISOString() } : tgt.mode === 'lsn' ? { target_lsn: tgt.lsn, inclusive: false } : {};
  const params = (): { type: string; p: Record<string, any> } => scope === 'instance' ? { type: 'restore_instance', p: { destination: dest, action, delta, ...tparams() } }
    : scope === 'database' ? { type: 'restore_database', p: { database: db, new_name: newName, ...tparams() } } : { type: 'restore_object', p: { object: obj, ...tparams() } };
  const planParams = () => { const x = params().p; return { scope, ...x }; };

  const dbs: any[] = dbsR.op?.result?.databases || [];
  const okWhat = scope === 'instance' || (scope === 'database' && !!db) || (scope === 'object' && !!obj);
  const okWhere = scope === 'instance' ? dest.startsWith('/') : scope === 'database' ? /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(newName) : true;
  const okWhen = tgt.mode !== 'time' || (tgt.ms >= from && tgt.ms <= to + 60000);
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
      <div className="grid g3">
        <button className="choice" aria-pressed={scope === 'database'} onClick={() => setScope('database')}><Icon n="db" s={22} /><div><strong>Un database</strong><p className="sub">Estrae solo i file di quel database: molto più veloce del cluster intero. Arriva con un nome nuovo.</p></div></button>
        <button className="choice" aria-pressed={scope === 'object'} onClick={() => setScope('object')}><Icon n="file" s={22} /><div><strong>Una tabella</strong><p className="sub">Recupera una singola tabella (es. cancellata per errore) in un database di quarantena.</p></div></button>
        <button className="choice" aria-pressed={scope === 'instance'} onClick={() => setScope('instance')}><Icon n="server" s={22} /><div><strong>Tutto il cluster</strong><p className="sub">Ricostruisce una copia completa in una cartella vuota. Non tocca mai l’istanza in esecuzione.</p></div></button></div>
      {scope !== 'instance' ? (dbsR.op && dbsR.op.status === 'succeeded' ? <>
        <Field label="Database"><select className="input" value={db} onChange={e => { setDb(e.target.value); setObj(''); }}><option value="">Scegli…</option>{dbs.filter(x => x.connectable).map(x => <option key={x.name} value={x.name}>{x.name} — {bytes(x.size)}, {x.objects} tabelle</option>)}</select></Field>
        {scope === 'object' && db ? <ObjectPicker r={objR.op} busy={objR.busy} search={search} setSearch={setSearch} db={db} value={obj} onPick={setObj} /> : null}</> :
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
      <details open={!!events.length || !!fx.op}><summary style={{ cursor: 'pointer', fontWeight: 500 }}>Hai cancellato qualcosa? Cerca DROP e TRUNCATE nei WAL</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="row"><Button sm icon="search" busy={fx.busy} onClick={() => fx.run('wal_forensics', { limit: 20 })}>Cerca eventi distruttivi</Button><span className="small muted">Legge i WAL archiviati con pg_waldump; può richiedere qualche minuto.</span></div>
          {fx.op && fx.op.status !== 'succeeded' ? <OpPanel op={fx.op} error={fx.error} cancel={fx.cancel} /> : null}
          {fx.op?.status === 'succeeded' ? (fx.op.result.events.length ? <table className="t"><thead><tr><th>Evento</th><th>Oggetti</th><th>Quando</th><th /></tr></thead><tbody>
            {[...fx.op.result.events].reverse().map((e: any, i: number) => <tr key={i}><td><Badge kind="bad">{e.kind}</Badge></td><td className="small">{(e.names || []).join(', ') || '—'}</td><td className="small nowrap">{e.time}</td>
              <td className="num"><Button sm onClick={() => setTgt({ mode: 'lsn', lsn: e.lsn, label: `${e.kind} ${(e.names || [])[0] || ''} (${e.lsn})` })}>Ripristina subito prima</Button></td></tr>)}</tbody></table> : <p className="muted">Nessun DROP o TRUNCATE trovato nei WAL esaminati ({num(fx.op.result.segments_scanned)} segmenti).</p>) : null}
        </div></details>
      <div className="row"><Button onClick={() => setStep(0)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhen || !baseSet && tgt.mode === 'time'} onClick={() => setStep(2)}>Avanti</Button></div></div></Card>}

    {step === 2 && <Card title="Dove?"><div className="stack">
      {scope === 'instance' ? <>
        <Field label="Cartella di destinazione" hint="Percorso assoluto sul server, vuoto o inesistente. La data directory in uso e le cartelle di sistema sono rifiutate." error={dest && !dest.startsWith('/') ? 'Deve iniziare con /' : null}><input className="input mono" value={dest} onChange={e => setDest(e.target.value)} placeholder="/var/lib/postgresql/restore-2026" /></Field>
        <Field label="Al termine del recovery"><div className="seg"><button aria-pressed={action === 'promote'} onClick={() => setAction('promote')}>Diventa un’istanza normale</button><button aria-pressed={action === 'pause'} onClick={() => setAction('pause')}>Resta in pausa per controllare</button></div></Field>
        <label className="check"><input type="checkbox" checked={delta} onChange={e => setDelta(e.target.checked)} />Ripristino differenziale su una cartella già ripristinata (copia solo ciò che differisce)</label></> :
        scope === 'database' ? <Field label="Nome del nuovo database" hint="Non sovrascrive mai un database esistente: se il nome c’è già, il ripristino si ferma prima di iniziare."><input className="input" value={newName} onChange={e => setNewName(e.target.value)} /></Field> :
        <Banner kind="info" title="Quarantena">La tabella viene ricostruita in un database temporaneo separato. Da lì la controlli e la sposti dove serve; il tuo database originale non viene toccato.</Banner>}
      <div className="row"><Button onClick={() => setStep(1)}>Indietro</Button><div className="grow" /><Button kind="primary" disabled={!okWhere} onClick={next}>Controlla piano</Button></div></div></Card>}

    {step === 3 && <div className="stack-l">
      <Card title="Piano di ripristino"><div className="stack">
        {plan.op?.status === 'succeeded' ? <PlanView p={plan.op.result} scope={scope} /> : <OpPanel op={plan.op} error={plan.error} label="Verifica del piano" />}
        {plan.op?.status === 'failed' ? <div><Button onClick={() => setStep(1)}>Cambia istante</Button></div> : null}</div></Card>
      {plan.op?.status === 'succeeded' && !exec.op ? <div className="row"><Button onClick={() => setStep(2)}>Indietro</Button><div className="grow" /><Button kind="primary" icon="restore" onClick={() => setAsk(true)}>Avvia ripristino</Button></div> : null}
      {(exec.op || exec.error) ? <Card title="Ripristino"><div className="stack"><OpPanel op={exec.op} error={exec.error} cancel={exec.cancel} />
        {doneOk ? <Banner kind="ok" title="Ripristino completato">{scope === 'instance' ? <>Cartella pronta in <code>{exec.op!.result.destination}</code>. {exec.op!.result.start_hint}</> : <>Dati disponibili nel database <code>{exec.op!.result.result_database}</code>.{exec.op!.result.inspect ? <> Per controllare: <code>{exec.op!.result.inspect}</code></> : null}</>}</Banner> : null}
        {doneOk && scope === 'object' && exec.op!.result.result_database ? <Promote stage={exec.op!.result.result_database} obj={obj} mode={pmode} setMode={setPmode} drop={pdrop} setDrop={setPdrop} runner={prom} ask={() => setAskPromote(true)} /> : null}
        {doneOk && scope === 'object' && exec.op!.result.result_database ? <RowRecovery clusterId={c.id} stage={exec.op!.result.result_database} obj={obj} /> : null}
        <Result op={exec.op} />
        {(exec.op && !running) ? <div><Button onClick={() => { exec.reset(); plan.reset(); setStep(0); }}>Nuovo ripristino</Button></div> : null}</div></Card> : null}
    </div>}

    {askPromote ? <Confirm title="Riportare la tabella nel database?" danger={pmode === 'replace'} confirmLabel="Riporta" onClose={() => setAskPromote(false)} onConfirm={() => { setAskPromote(false); prom.run('restore_promote', { stage_db: exec.op!.result.result_database, object: obj, mode: pmode, drop_stage: pdrop }); }}>
      <p>{pmode === 'as_new' ? <>La tabella ripristinata compare accanto all’originale con un nome che termina in <code>_pitr_&lt;data&gt;</code>. L’originale non viene toccato.</> : <>L’originale viene rinominata <code>_old_&lt;data&gt;</code> (i dati restano) e la tabella ripristinata prende il suo nome. Chiavi esterne, viste e funzioni continuano a puntare alla vecchia.</>}</p>
      <p className="small muted">{pdrop ? 'Il database di quarantena viene eliminato a operazione riuscita.' : 'Il database di quarantena resta disponibile.'}</p></Confirm> : null}
    {ask ? <Confirm title="Avviare il ripristino?" confirmLabel="Avvia" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); const x = params(); exec.run(x.type, x.p); }}>
      <p>{scope === 'instance' ? <>Ricostruisce il cluster in <code>{dest}</code>.</> : scope === 'database' ? <>Crea il database <code>{newName}</code> da <code>{db}</code>.</> : <>Ricostruisce <code>{obj}</code> in un database di quarantena.</>} L’istanza in esecuzione e i suoi dati non vengono modificati. Se qualcosa fallisce, ciò che è stato creato viene rimosso.</p></Confirm> : null}
  </div>;
}

function PlanView({ p, scope }: { p: any; scope: Scope }) {
  const saved = p.saved_pct;
  return <div className="stack">
    <Banner kind={p.missing_wal?.length ? 'bad' : 'ok'} title={p.missing_wal?.length ? 'Mancano dei WAL' : 'Ripristino possibile'}>{p.missing_wal?.length ? `Servono ${p.missing_wal.length} segmenti non archiviati.` : 'Il backup di partenza e i WAL necessari sono presenti.'}</Banner>
    <dl className="kv"><dt>Istante</dt><dd>{p.target === 'end of archive' ? 'ultimo disponibile' : Number.isFinite(Date.parse(p.target)) ? new Date(p.target).toLocaleString('it-CH') : p.target}</dd>
      <dt>Backup di partenza</dt><dd><span className="mono">{p.set}</span></dd>
      <dt>Catena</dt><dd className="mono small">{(p.chain || []).join(' → ')}</dd>
      {scope === 'instance' ? <><dt>Dati da estrarre</dt><dd>{bytes(p.bytes)} in {num(p.files)} file</dd></> : <><dt>Dati da estrarre</dt><dd>{bytes(p.extract_bytes)} su {bytes(p.cluster_bytes)} del cluster{saved != null ? <> — <strong>{saved}% in meno</strong></> : null}</dd></>}
      {p.tablespaces && Object.keys(p.tablespaces).length ? <><dt>Tablespace</dt><dd className="small">{Object.entries(p.tablespaces).map(([oid, path]: any) => <div key={oid}><span className="mono">{oid}</span> → <span className="mono">{String(path)}</span>{(p.tablespaces_relocated || []).includes(oid) ? <> <Badge kind="warn" title="La cartella originale appartiene al server di origine: non viene mai sovrascritta">spostato</Badge></> : null}</div>)}</dd></> : null}
      {p.destination_database ? <><dt>Nuovo database</dt><dd>{p.destination_database}</dd></> : null}{p.quarantine_database ? <><dt>Quarantena</dt><dd>{p.quarantine_database}</dd></> : null}</dl></div>;
}

function ObjectPicker({ r, busy, search, setSearch, db, value, onPick }: { r: Op | null; busy: boolean; search: string; setSearch: (s: string) => void; db: string; value: string; onPick: (o: string) => void }) {
  const schemas: any[] = r?.status === 'succeeded' ? r.result.schemas || [] : [];
  return <div className="stack"><Field label="Tabella"><input className="input" placeholder="Cerca per nome" value={search} onChange={e => setSearch(e.target.value)} /></Field>
    <div className="tree">{busy && !schemas.length ? <div style={{ padding: 12 }} className="muted">Lettura del catalogo…</div> : null}
      {schemas.map(s => <div key={s.name}><div className="sch">{s.name}</div>{s.objects.map((o: any) => { const id = `${db}.${s.name}.${o.name}`; return <button key={id} aria-pressed={value === id} onClick={() => onPick(id)}><Icon n="file" s={14} /><span className="grow">{o.name}</span><span className="faint small">{bytes(o.size)}</span></button>; })}</div>)}
      {r?.status === 'succeeded' && !schemas.length ? <div style={{ padding: 12 }} className="muted">Nessuna tabella corrisponde.</div> : null}
      {r?.status === 'failed' ? <div style={{ padding: 12 }} className="muted">{r.error}</div> : null}</div>
    {r?.result?.truncated ? <p className="small muted">Elenco troncato: affina la ricerca.</p> : null}
    <p className="small muted">Le dipendenze (chiavi esterne, viste, sequenze) non vengono incluse: si recupera la sola tabella.</p></div>;
}

function Promote({ stage, obj, mode, setMode, drop, setDrop, runner, ask }: { stage: string; obj: string; mode: 'as_new' | 'replace'; setMode: (m: 'as_new' | 'replace') => void; drop: boolean; setDrop: (b: boolean) => void; runner: ReturnType<typeof useOpRunner>; ask: () => void }) {
  const r = runner.op?.result; const done = runner.op?.status === 'succeeded';
  return <div className="stack"><div className="hr" /><strong>Riporta la tabella nel database</strong>
    <p className="small muted">Controlla prima i dati nella quarantena (<code>{stage}</code>). Poi scegli come rimetterla in <code>{obj.split('.').slice(0, 1)}</code>: non cancella mai nulla.</p>
    {!done ? <>
      <label className={`opt ${mode === 'as_new' ? 'on' : ''}`}><input type="radio" checked={mode === 'as_new'} onChange={() => setMode('as_new')} /><div><div>Accanto all’originale (consigliato)</div><div className="small muted">Nuova tabella con suffisso <code>_pitr_&lt;data&gt;</code>: confronti e poi decidi.</div></div></label>
      <label className={`opt ${mode === 'replace' ? 'on' : ''}`}><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /><div><div>Al posto dell’originale</div><div className="small muted">L’originale diventa <code>_old_&lt;data&gt;</code> (dati conservati); quella ripristinata prende il nome.</div></div></label>
      <label className="check"><input type="checkbox" checked={drop} onChange={e => setDrop(e.target.checked)} />Elimina la quarantena dopo la riuscita</label>
      <div><Button kind="primary" icon="restore" busy={runner.busy} disabled={runner.busy} onClick={ask}>Riporta la tabella</Button></div></> : null}
    {(runner.op || runner.error) && !done ? <OpPanel op={runner.op} error={runner.error} label="Promozione della tabella" /> : null}
    {done ? <Banner kind="ok" title="Tabella riportata">{r?.mode === 'replace' ? <>La tabella ripristinata è ora <code>{r.promoted_as}</code>; l’originale è conservata come <code>{r.old_kept_as}</code>.</> : <>Creata <code>{r?.promoted_as}</code> accanto all’originale.</>}{r?.rows != null ? ` ${num(r.rows)} righe.` : ''}{r?.warning ? <span className="hba-warn"> {r.warning}</span> : null}</Banner> : null}
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
        Chiave primaria <code>{d.primary_key.join(', ')}</code>: {num(d.restored_rows)} righe nel ripristino, {num(d.live_rows)} oggi. {d.columns_only_in_one_side.length ? <span className="hba-warn">Colonne presenti solo da un lato (ignorate nel confronto): {d.columns_only_in_one_side.join(', ')}.</span> : null}</Banner>
      {list('Cancellate dopo quel momento', 'Esistevano nel ripristino e oggi non ci sono più: selezionale per reinserirle.', d.missing_now, pick, setPick, (w: any) => brief(w.restored), d.counts.missing_now)}
      {list('Modificate', 'Il valore ripristinato sovrascrive quello attuale (che resta nella tabella di sicurezza).', d.changed, pick, setPick, (w: any) => `ora ${brief(w.live)} → ripristino ${brief(w.restored)}`, d.counts.changed)}
      {list('Aggiunte dopo quel momento', 'Non esistevano nel ripristino. Selezionale solo se vuoi eliminarle.', d.added_since, del, setDel, (w: any) => brief(w.live), d.counts.added_since)}
      <div className="row"><div className="grow" /><Button kind="primary" icon="restore" disabled={!rest.length && !dels.length} onClick={() => setAsk(true)}>Applica {rest.length + dels.length ? `(${rest.length + dels.length})` : ''}</Button></div></> : null}
    {(apply.op || apply.error) && !done ? <OpPanel op={apply.op} error={apply.error} label="Applicazione delle righe" /> : null}
    {done ? <Banner kind="ok" title="Righe recuperate">Reinserite {num(r?.inserted ?? 0)}, ripristinate {num(r?.updated ?? 0)}, eliminate {num(r?.deleted ?? 0)}.{r?.safety_copy ? <> Versione precedente conservata in <code>{r.safety_copy}</code>.</> : null}</Banner> : null}
    {ask ? <Confirm title="Applicare le righe selezionate?" danger={dels.length > 0} confirmLabel="Applica" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); apply.run('restore_apply_rows', { stage_db: stage, object: obj, restore_keys: rest, delete_keys: dels }); }}>
      <p>{rest.length} righe verranno reinserite o sovrascritte con la versione ripristinata{dels.length ? <>, {dels.length} righe aggiunte dopo verranno eliminate</> : null}. La versione attuale di ogni riga toccata viene copiata prima in una tabella <code>pgarca_rowsafe_…</code>; se qualcosa fallisce non cambia nulla.</p></Confirm> : null}</div>;
}
