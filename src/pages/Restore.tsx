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
        {doneOk && exec.op!.result.promote_hint ? <p className="small muted">Per riportare la tabella nel database di produzione: <code>{exec.op!.result.promote_hint}</code></p> : null}
        <Result op={exec.op} />
        {(exec.op && !running) ? <div><Button onClick={() => { exec.reset(); plan.reset(); setStep(0); }}>Nuovo ripristino</Button></div> : null}</div></Card> : null}
    </div>}

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
