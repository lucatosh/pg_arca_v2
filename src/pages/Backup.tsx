import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, CopyBlock, Empty, Field, Icon, Skeleton, bytes, dt, dur, ago, num } from '../ui';
import { Op, revalidate, toast, useOpRunner, useQuery } from '../hooks';
import { OP_LABEL, OpPanel, Result } from './shared';

export const TYPE_LABEL: Record<string, string> = { full: 'Completo', diff: 'Differenziale', incr: 'Incrementale' };
export interface SetRow { id: string; type: 'full' | 'diff' | 'incr'; parent?: string; status: string; start_time?: string; stop_time?: string; duration_sec?: number; bytes_logical: number; bytes_written: number; reason?: string; timeline?: number }

/** Order sets as chains: newest full first, followed by the diffs / incrementals that depend on it. */
export function chains(sets: SetRow[]): { row: SetRow; depth: number }[] {
  const by = new Map(sets.map(s => [s.id, s]));
  const rootOf = (s: SetRow): string => { let c = s; const seen = new Set<string>(); while (c.parent && by.has(c.parent) && !seen.has(c.id)) { seen.add(c.id); c = by.get(c.parent)!; } return c.id; };
  const groups = new Map<string, SetRow[]>();
  for (const s of sets) { const r = rootOf(s); (groups.get(r) || groups.set(r, []).get(r)!).push(s); }
  const out: { row: SetRow; depth: number }[] = [];
  [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).forEach(([r, list]) => {
    list.sort((a, b) => a.id.localeCompare(b.id)).forEach(s => out.push({ row: s, depth: s.id === r ? 0 : 1 }));
  });
  return out;
}

export interface Protection { kind: 'ok' | 'warn' | 'bad'; title: string; text: string }
export function protection(d: any): Protection {
  const bk = d.backup; const ar = d.archiver; const wal = d.wal; const pol = d.policy;
  if (d.archiveMode === 'off') return { kind: 'bad', title: 'Archiviazione WAL spenta', text: 'Senza WAL archiviati non si può ripristinare a un istante preciso e i backup non sono consistenti. Segui le istruzioni qui sotto.' };
  if (ar && ar.failed_count > 0 && ar.last_failed_time && (!ar.last_archived_time || ar.last_failed_time > ar.last_archived_time))
    return { kind: 'bad', title: 'L’archiviazione WAL sta fallendo', text: `Ultimo errore su ${ar.last_failed_wal} (${ago(ar.last_failed_time)}). Il disco di PostgreSQL si riempie finché non viene risolto.` };
  if (wal && wal.continuous === false) return { kind: 'bad', title: 'Buchi nei WAL archiviati', text: `${wal.gap_count || wal.gaps?.length} interruzioni: il ripristino a un istante preciso non è possibile oltre il primo buco. Esegui un nuovo backup completo.` };
  if (!bk?.sets) return { kind: 'warn', title: 'Nessun backup valido', text: bk?.failed_sets ? 'Esistono solo tentativi falliti: controlla l’operazione e riprova.' : 'Esegui il primo backup completo.' };
  const maxH = pol?.enabled ? Math.max(pol.incrEveryHours || pol.fullEveryHours, 1) * 2 : 36;
  if (bk.last_backup_age_hours != null && bk.last_backup_age_hours > maxH) return { kind: 'warn', title: 'Ultimo backup datato', text: `Risale a ${ago(bk.last_backup?.stop_time)}${pol?.enabled ? ', più del doppio dell’intervallo pianificato' : ''}.` };
  if (!pol?.enabled) return { kind: 'warn', title: 'Backup riusciti, ma non pianificati', text: 'Attiva la pianificazione per non dipendere da un’azione manuale.' };
  return { kind: 'ok', title: 'Dati protetti', text: `Ultimo backup ${ago(bk.last_backup?.stop_time)}, WAL continui${wal?.last_segment ? ` fino a ${wal.last_segment}` : ''}.` };
}

export function BackupTab({ c }: { c: any }) {
  const key = `/api/clusters/${encodeURIComponent(c.id)}/backups`;
  const agentic = c.source !== 'direct' && !c.isSandbox;
  const q = useQuery<any>(agentic ? key : null, { interval: 5000 });
  if (c.isSandbox) return <Banner kind="info" title="Non disponibile sul cluster demo">Collega un cluster reale con l’agent per eseguire backup.</Banner>;
  if (c.source === 'direct') return <Card><Empty icon="shield" title="Servono l’agent">Backup e ripristino girano sul server del database. Installa l’agent su un nodo di questo cluster: la console non può leggere i file di dati attraverso una semplice connessione SQL.</Empty></Card>;
  if (q.loading || !q.data) return <div className="stack"><Skeleton h={60} /><Skeleton h={200} /></div>;
  const d = q.data;
  if (!d.agent) return <Card><Empty icon="shield" title="Nessun agent su questo cluster">Collega un nodo dalla scheda Nodi.</Empty></Card>;
  const v = protection(d); const sets: SetRow[] = d.backup?.recent_sets || [];
  const done = sets.filter(s => s.status === 'COMPLETE');
  return <div className="stack-l">
    <Banner kind={v.kind} title={v.title}>{v.text}</Banner>
    {d.archiveMode === 'off' ? <ArchiveSetup /> : null}
    <RunCard c={c} hasFull={done.some(s => s.type === 'full')} running={d.running || []} refresh={q.refresh} />
    <div className="grid g2"><PolicyCard c={c} policy={d.policy} onSaved={q.refresh} /><HealthCard c={c} d={d} refresh={q.refresh} /></div>
    <SetsCard sets={sets} d={d} />
  </div>;
}

function ArchiveSetup() {
  return <Card title="Attiva l’archiviazione WAL"><div className="stack"><p>Aggiungi queste righe a <code>postgresql.conf</code> sul primario e riavvia PostgreSQL (è l’unico passo che richiede un riavvio):</p>
    <CopyBlock text={`wal_level = replica\narchive_mode = on\narchive_command = '/usr/local/bin/pg-arca-wal archive %p %f'\nfull_page_writes = on`} />
    <p className="small muted">Con Patroni, applica le stesse impostazioni con <code>patronictl edit-config</code>. Per gli incrementali serve anche <code>data_checksums</code> o <code>wal_log_hints = on</code>.</p></div></Card>;
}

function RunCard({ c, hasFull, running, refresh }: { c: any; hasFull: boolean; running: Op[]; refresh: () => void }) {
  const [type, setType] = useState<'full' | 'diff' | 'incr'>(hasFull ? 'incr' : 'full');
  useEffect(() => { if (!hasFull) setType('full'); }, [hasFull]);
  const r = useOpRunner(c.id, () => { refresh(); revalidate(`/api/operations?clusterId=${encodeURIComponent(c.id)}`); });
  const other = running.filter(o => o.id !== r.op?.id && o.type !== 'backup_info');
  const cancelOther = async (id: string) => { try { await api('POST', `/api/operations/${id}/cancel`); refresh(); } catch (e: any) { toast(e.message, 'bad'); } };
  const active = r.busy || other.length > 0;
  const hint = { full: 'Copia tutto. È il punto di partenza di ogni catena.', diff: 'Solo ciò che è cambiato dall’ultimo completo.', incr: 'Solo le pagine cambiate dall’ultimo backup: veloce e piccolo.' }[type];
  return <Card title="Esegui un backup">
    <div className="stack">
      <div className="row wrap"><div className="seg" role="group" aria-label="Tipo di backup">{(['full', 'diff', 'incr'] as const).map(t => <button key={t} aria-pressed={type === t} disabled={active || (t !== 'full' && !hasFull)} onClick={() => { setType(t); r.reset(); }}>{TYPE_LABEL[t]}</button>)}</div>
        <Button kind="primary" icon="play" busy={r.busy} disabled={active} onClick={() => r.run('backup_run', { type })}>Avvia backup</Button><span className="small muted">{hint}</span></div>
      {!hasFull ? <p className="small muted">Il primo backup deve essere completo.</p> : null}
      {(r.op || r.error) ? <><OpPanel op={r.op} error={r.error} cancel={r.cancel} />{r.op?.status === 'succeeded' ? <Banner kind="ok" title={`Backup ${r.op.result?.set} completato`}>{bytes(r.op.result?.bytes_logical)} letti, {bytes(r.op.result?.bytes_written)} scritti nel repository in {dur(r.op.result?.duration_sec)}{r.op.result?.chunks_dedup ? `; ${num(r.op.result.chunks_dedup)} blocchi già presenti (deduplica)` : ''}.</Banner> : null}</> : null}
      {other.map(o => <div key={o.id} className="stack"><OpPanel op={o} cancel={() => cancelOther(o.id)} /></div>)}
    </div></Card>;
}

function PolicyCard({ c, policy, onSaved }: { c: any; policy: any; onSaved: () => void }) {
  const [p, setP] = useState(policy); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => setP(policy), [JSON.stringify(policy)]);
  const dirty = JSON.stringify(p) !== JSON.stringify(policy);
  const n = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: Number(e.target.value) });
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('PUT', `/api/clusters/${encodeURIComponent(c.id)}/backup-policy`, p); toast('Pianificazione salvata', 'ok'); onSaved(); }
    catch (e: any) { setErr(e.body?.message || e.message); } finally { setBusy(false); }
  };
  return <Card title="Pianificazione" actions={<label className="check"><input type="checkbox" checked={!!p.enabled} onChange={e => setP({ ...p, enabled: e.target.checked })} />Attiva</label>}>
    <div className="stack"><div className="grid g2">
      <Field label="Backup completo ogni (ore)"><input className="input" type="number" min={6} max={720} value={p.fullEveryHours} onChange={n('fullEveryHours')} /></Field>
      <Field label="Incrementale ogni (ore)" hint="0 = solo completi"><input className="input" type="number" min={0} max={168} value={p.incrEveryHours} onChange={n('incrEveryHours')} /></Field>
      <Field label="Backup completi da conservare"><input className="input" type="number" min={1} max={365} value={p.retentionFull} onChange={n('retentionFull')} /></Field>
      <Field label="Verifica ogni (ore)" hint="0 = mai. Include una prova di ripristino."><input className="input" type="number" min={0} max={720} value={p.verifyEveryHours} onChange={n('verifyEveryHours')} /></Field></div>
      <label className="check"><input type="checkbox" checked={!!p.verifyDeep} onChange={e => setP({ ...p, verifyDeep: e.target.checked })} />Verifica approfondita (rilegge ogni blocco: più lenta)</label>
      {err ? <Banner kind="bad">{err}</Banner> : null}
      <div className="row"><Button kind="primary" busy={busy} disabled={!dirty} onClick={save}>Salva</Button>{!p.enabled ? <span className="small muted">Pianificazione spenta: i backup partono solo a mano.</span> : <span className="small muted">Una operazione dati alla volta; dopo un errore riprova dopo {p.retryAfterMinutes} min.</span>}</div></div></Card>;
}

function HealthCard({ c, d, refresh }: { c: any; d: any; refresh: () => void }) {
  const r = useOpRunner(c.id, refresh); const [kind, setKind] = useState('');
  const [ask, setAsk] = useState(false);
  const run = (k: string, type: string, params: any) => { setKind(k); r.run(type, params); };
  const bk = d.backup; const res = r.op?.result;
  return <Card title="Salute del repository">
    <div className="stack">
      <dl className="kv small"><dt>Backup validi</dt><dd>{bk?.sets ?? 0}{bk?.failed_sets ? ` (+${bk.failed_sets} falliti)` : ''}</dd><dt>Spazio usato</dt><dd>{bytes(bk?.stored_bytes)} {bk?.dedup_ratio ? <span className="muted">— {bk.dedup_ratio}× di deduplica e compressione</span> : null}</dd>
        <dt>WAL archiviati</dt><dd>{num(d.wal?.total_segments)} segmenti, {d.wal?.continuous === false ? <Badge kind="bad">con buchi</Badge> : <Badge kind="ok">continui</Badge>}</dd>
        <dt>Archiviatore</dt><dd>{d.archiver ? `${num(d.archiver.archived_count)} ok, ${num(d.archiver.failed_count)} errori` : '—'}</dd></dl>
      <div className="row wrap"><Button sm disabled={r.busy} onClick={() => run('verify', 'backup_verify', {})}>Verifica rapida</Button><Button sm disabled={r.busy} onClick={() => run('deep', 'backup_verify', { deep: true })}>Verifica approfondita</Button>
        <Button sm disabled={r.busy || !bk?.sets} onClick={() => run('test', 'backup_verify', { restore_test: true })} title="Ripristina davvero l’ultimo backup in un’istanza temporanea">Prova di ripristino</Button>
        <Button sm disabled={r.busy || !bk?.sets} onClick={() => run('dry', 'backup_expire', { dry_run: true, retention_full: d.policy.retentionFull })}>Anteprima pulizia</Button></div>
      {(r.op || r.error) ? <><OpPanel op={r.op} error={r.error} cancel={r.cancel} label={kind === 'test' ? 'Prova di ripristino' : kind === 'dry' ? 'Anteprima pulizia' : kind === 'deep' ? 'Verifica approfondita' : 'Verifica'} />
        {r.op?.status === 'succeeded' && kind !== 'dry' ? (res?.ok ? <Banner kind="ok" title="Repository integro">{res.chunks_checked ? `${num(res.chunks_checked)} blocchi controllati.` : 'Controlli strutturali superati.'}{res.restore_test ? ' L’ultimo backup è stato ripristinato davvero e PostgreSQL ha completato il recovery.' : ''}</Banner> : <Banner kind="bad" title="Problemi trovati"><ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{(res?.problems || []).slice(0, 8).map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></Banner>) : null}
        {r.op?.status === 'succeeded' && kind === 'dry' ? <><Banner kind={res.delete_sets?.length ? 'warn' : 'ok'} title={res.delete_sets?.length ? `La pulizia eliminerebbe ${res.delete_sets.length} backup` : 'Niente da eliminare'}>{res.delete_sets?.length ? res.delete_sets.join(', ') : `Rientri già nelle ${res.retention_full} catene conservate.`}</Banner>
          {res.delete_sets?.length ? <div><Button kind="danger" sm onClick={() => setAsk(true)}>Elimina ora…</Button></div> : null}</> : null}
        {kind === 'expire' && r.op?.status === 'succeeded' ? <Banner kind="ok" title="Pulizia completata">{bytes(res.bytes_freed)} liberati, {num(res.wal_removed)} segmenti WAL rimossi.</Banner> : null}</> : null}
    </div>
    {ask ? <Confirm danger title="Eliminare i backup scaduti?" confirmLabel="Elimina" onClose={() => setAsk(false)} onConfirm={() => { setAsk(false); run('expire', 'backup_expire', { retention_full: d.policy.retentionFull }); }}>
      <p>I backup elencati e i WAL non più necessari verranno cancellati dal repository. L’operazione non è reversibile.</p></Confirm> : null}
  </Card>;
}

function SetsCard({ sets, d }: { sets: SetRow[]; d: any }) {
  const rows = useMemo(() => chains(sets), [sets]);
  if (!sets.length) return <Card title="Backup"><Empty icon="shield" title="Ancora nessun backup">Il primo backup completo crea il punto di partenza per tutti i ripristini.</Empty></Card>;
  return <Card title="Backup nel repository" pad={false}><div className="tablewrap"><table className="t sets"><thead><tr><th>Backup</th><th>Tipo</th><th>Stato</th><th>Avvio</th><th className="num">Durata</th><th className="num">Dati</th><th className="num">Scritto</th></tr></thead><tbody>
    {rows.map(({ row: s, depth }) => <tr key={s.id} className={depth ? 'd1' : 'chainrow'}>
      <td className="mono">{s.id}</td><td>{TYPE_LABEL[s.type]}</td>
      <td>{s.status === 'COMPLETE' ? <Badge kind="ok">Valido</Badge> : s.status === 'FAILED' || s.status === 'UNRECOVERABLE' ? <Badge kind="bad" title={s.reason}>{s.status === 'FAILED' ? 'Fallito' : 'Non recuperabile'}</Badge> : <Badge kind="info">{s.status === 'PENDING_WAL' ? 'Attesa WAL' : s.status === 'EXPIRING' ? 'In eliminazione' : 'In corso'}</Badge>}</td>
      <td title={dt(s.start_time)}>{ago(s.start_time)}</td><td className="num">{dur(s.duration_sec)}</td><td className="num">{bytes(s.bytes_logical)}</td><td className="num">{bytes(s.bytes_written)}</td></tr>)}
  </tbody></table></div></Card>;
}
