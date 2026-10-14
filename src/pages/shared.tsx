import React, { useEffect, useState } from 'react';
import { Op, isTerminal, useQuery } from '../hooks';
import { openOpLog } from '../OpLog';
import { Badge, Banner, Button, Progress, ago, bytes, dur, num } from '../ui';
import { itCheck } from '../i18n';

export const OP_LABEL: Record<string, string> = {
  pg_reload: 'Ricarica configurazione', wal_switch: 'Cambio segmento WAL', checkpoint: 'Checkpoint', discovery_scan: 'Rilevamento', compat_check: 'Verifica compatibilità PostgreSQL', agent_config_get: 'Lettura impostazioni agent', agent_config_set: 'Impostazioni agent', list_objects: 'Elenco oggetti',
  pg_set_param: 'Modifica parametro', patroni_switchover: 'Switchover', patroni_failover: 'Failover', patroni_restart: 'Riavvio membro', patroni_reinit: 'Ricostruzione replica', archive_enable: 'Attivazione archiviazione WAL', patroni_reload: 'Ricarica Patroni',
  patroni_pause: 'Modalità manutenzione', patroni_config_patch: 'Modifica config Patroni', backup_run: 'Backup', backup_info: 'Info repository', backup_verify: 'Verifica backup',
  backup_expire: 'Scadenza e pulizia', backup_catalog: 'Catalogo backup', restore_plan: 'Piano di ripristino', restore_instance: 'Ripristino istanza', restore_database: 'Ripristino database',
  restore_object: 'Ripristino oggetto', wal_forensics: 'Analisi WAL', hba_read: 'Lettura pg_hba', hba_plan: 'Verifica pg_hba', hba_apply: 'Modifica pg_hba', hba_rollback: 'Ripristino pg_hba', restore_promote: 'Riporta nel database', restore_drill: 'Prova di disaster recovery', restore_diff: 'Confronto riga per riga', restore_apply_rows: 'Recupero righe', hba_expire: 'Scadenza regole pg_hba',
  ephemeral_preflight: 'Verifica dell’istanza di recupero', ephemeral_install: 'Installazione dei binari PostgreSQL', destination_check: 'Controllo della destinazione dei backup', destination_migrate: 'Migrazione dei backup', destination_drop_old: 'Eliminazione della posizione precedente', pg_restart: 'Riavvio di PostgreSQL', restore_db_swap: 'Sostituzione del database con quello ripristinato', geo_failover: 'Promozione del sito di replica (disaster recovery)', geo_promote: 'Promozione del sito', geo_demote: 'Passaggio del sito a replica', geo_archive_fallback: 'Riserva dall’archivio WAL del sito di replica', restored_stop: 'Arresto della copia ripristinata', restored_start: 'Avvio della copia ripristinata', restored_resume: 'Conclusione del recupero della copia', restored_keep: 'Durata della copia ripristinata', restored_drop: 'Eliminazione della copia ripristinata', restored_list: 'Copie ripristinate',
};
export const STATUS_LABEL: Record<string, string> = { sending: 'Invio…', queued: 'In coda', leased: 'Assegnata', running: 'In esecuzione', succeeded: 'Completata', failed: 'Fallita', expired: 'Scaduta', cancelled: 'Annullata' };
export const statusBadge = (s: string) => <Badge kind={s === 'succeeded' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' || s === 'leased' ? 'info' : undefined}>{STATUS_LABEL[s] || s}</Badge>;
export const PHASE: Record<string, string> = { catalog: 'Lettura del catalogo', checkpoint: 'Checkpoint di PostgreSQL', copy: 'Copia dei dati', finalize: 'Chiusura del backup', wal: 'Attesa archiviazione WAL', extract: 'Estrazione dei file', starting: 'Avvio istanza temporanea', recovery: 'Recovery dei WAL', transfer: 'Trasferimento dati', verify: 'Verifica dei chunk', 'restore-test': 'Prova di ripristino', scan: 'Analisi dei WAL', chunks: 'Copia dei blocchi', sets: 'Copia dei backup', done: 'Verifica finale', wal_flush: 'Archiviazione del WAL più recente', prepare: 'Preparazione', swap: 'Sostituzione' };

/** Throughput and time left of the current phase, measured in the browser between progress samples (same operation, same phase). */
const samples = new Map<string, { t: number; v: number; phase: string }>();
function rateOf(op: Op): string | null {
  const p = op.progress; if (!p || isTerminal(op.status)) return null;
  const [v, total, unit] = p.bytes_total ? [p.bytes || 0, p.bytes_total, 'B'] : p.segments_total ? [p.segments || 0, p.segments_total, 'seg'] : p.files_total ? [p.files || 0, p.files_total, 'f'] : [null, null, ''];
  if (v == null || !total) return null;
  const now = Date.now(); const k = op.id; const s0 = samples.get(k);
  if (!s0 || s0.phase !== p.phase || v < s0.v) { samples.set(k, { t: now, v, phase: p.phase }); return null; }
  const dt = (now - s0.t) / 1000; if (dt < 4 || v === s0.v) return null;
  const r = (v - s0.v) / dt; const left = (total - v) / r;
  const eta = left < 90 ? `${Math.max(1, Math.round(left))} s` : left < 5400 ? `${Math.round(left / 60)} min` : `${(left / 3600).toFixed(1)} h`;
  const rate = unit === 'B' ? `${bytes(r)}/s` : unit === 'seg' ? `${r.toFixed(1)} segmenti/s` : `${r.toFixed(0)} file/s`;
  return `${rate} · fine fase stimata tra ${eta}`;
}

export function pctOf(p: any): number | null {
  if (!p) return null;
  if (p.bytes_total) return Math.round((p.bytes / p.bytes_total) * 100);
  if (p.files_total) return Math.round((p.files / p.files_total) * 100);
  if (p.segments_total) return Math.round(((p.segments || 0) / p.segments_total) * 100);
  return null;
}

const secs = (from: string | number, now: number) => Math.max(0, Math.round((now - (typeof from === 'number' ? from : Date.parse(from))) / 1000));
const elapsed = (s: number) => (s < 90 ? `${s} s` : s < 5400 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${(s / 3600).toFixed(1)} h`);
const sinceStatus = (op: Op, st: string) => [...(op.history || [])].reverse().find(h => h.status === st)?.at;
function useTick(on: boolean) { const [n, setN] = useState(Date.now()); useEffect(() => { if (!on) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [on]); return n; }

/** Where the operation is, in the same four steps for every operation of the product: sent to the console → taken by the agent → running → outcome. */
function Steps({ op }: { op: Op }) {
  const order = ['sending', 'queued', 'leased', 'running'];
  const at = op.status === 'sending' ? 0 : op.status === 'queued' ? 1 : op.status === 'leased' ? 2 : op.status === 'running' ? 3 : 4;
  const failedAt = op.status === 'failed' || op.status === 'cancelled' || op.status === 'expired' ? (sinceStatus(op, 'running') ? 3 : sinceStatus(op, 'leased') ? 2 : 1) : -1;
  const labels = ['Inviata alla console', 'Presa in carico dall’agent', 'In esecuzione', op.status === 'succeeded' ? 'Completata' : op.status === 'failed' ? 'Fallita' : op.status === 'cancelled' ? 'Annullata' : op.status === 'expired' ? 'Scaduta' : 'Esito'];
  return <ol className="opsteps" aria-label="Avanzamento">{labels.map((l, i) => {
    const cls = failedAt >= 0 && i === 3 ? 'bad' : failedAt >= 0 && i > failedAt ? 'skip' : i < at || (i === 3 && op.status === 'succeeded') ? 'done' : i === at && order[i] ? 'now' : '';
    return <li key={i} className={cls}>{l}</li>;
  })}</ol>;
}

/** Live view of one operation: steps, phase, progress, elapsed time, who is executing it, cancel, and on failure where and why. Result rendering is up to the caller. */
export function OpPanel({ op, error, cancel, label }: { op: Op | null; error?: string | null; cancel?: () => void; label?: string }) {
  const live = !!op && !isTerminal(op.status);
  const now = useTick(live);
  const nodes = useQuery<{ nodes: any[] }>(op?.nodeId && (op.status === 'queued' || op.status === 'failed' || op.status === 'expired') ? '/api/nodes' : null, { interval: op?.status === 'queued' ? 5000 : 0 });
  if (!op && !error) return null;
  if (!op) return <Banner kind="bad" title={/non risponde/.test(error || '') ? 'La console non risponde: operazione non inviata' : 'Operazione non avviata'}>{itCheck(error)}{hintFor(error) ? <p className="small" style={{ marginTop: 8 }}>{hintFor(error)}</p> : null}</Banner>;
  const done = isTerminal(op.status); const p = op.progress; const pct = pctOf(p);
  const speed = rateOf(op);
  const node = (nodes.data?.nodes || []).find(n => n.id === op.nodeId);
  const runningSince = sinceStatus(op, 'running') || sinceStatus(op, 'leased');
  const phase = p?.phase ? PHASE[p.phase] || p.phase : '';
  let what: React.ReactNode;
  if (op.status === 'sending') { const s = secs(op.createdAt, now); what = s < 6 ? 'Invio della richiesta alla console…' : `La console non ha ancora risposto (${elapsed(s)}): riprovo da solo; se la richiesta era già arrivata non verrà eseguita due volte.`; }
  else if (op.status === 'queued') {
    const s = secs(op.createdAt, now);
    what = node && !node.online ? <>L’agent di <strong>{node.name}</strong> non si fa sentire da {ago(node.lastSeen, now)}: l’operazione parte quando torna online (oppure scade senza fare nulla).</>
      : s < 8 ? `In attesa che l’agent${node ? ` di ${node.name}` : ''} la prenda in carico…`
      : <>In coda da {elapsed(s)}{node ? <> sull’agent di <strong>{node.name}</strong></> : null}: l’agent esegue le operazioni sui dati una alla volta, parte appena finisce quella in corso (la vedi in «Attività»).</>;
  }
  else if (op.status === 'leased') what = 'L’agent l’ha presa in carico e sta partendo…';
  else if (!done) what = <>{phase || 'In corso…'}{runningSince ? ` — da ${elapsed(secs(runningSince, now))}` : ''}
    {p?.phase === 'checkpoint' ? `${p.fast ? '' : ' (checkpoint distribuito: su un server carico può durare alcuni minuti; l’annullamento lo interrompe)'}` : ''}{p?.files_total ? ` — ${num(p.files)} / ${num(p.files_total)} file` : ''}{p?.bytes_total ? `, ${bytes(p.bytes)} / ${bytes(p.bytes_total)}` : ''}{p?.chunks ? ` — ${num(p.chunks)} chunk verificati` : ''}{p?.segments_total ? ` — ${num(p.segments)} / ${num(p.segments_total)} segmenti` : ''}{p?.msg ? ` — ${p.msg}` : ''}</>;
  const total = done && op.createdAt ? secs(op.createdAt, Date.parse(op.updatedAt)) : null;
  return <div className="stack oppanel">
    <div className="row wrap"><strong>{label || OP_LABEL[op.type] || op.type}</strong>{statusBadge(op.status)}
      {op.cancelRequested && !done ? <Badge kind="warn">Annullamento richiesto…</Badge> : null}
      <div className="grow" />
      {op.id ? <Button sm kind="ghost" icon="logs" onClick={() => openOpLog(op.id, label || OP_LABEL[op.type])}>Log</Button> : null}
      {!done && cancel && op.id && !op.cancelRequested ? <Button sm kind="danger" icon="stop" onClick={cancel}>Annulla</Button> : null}</div>
    <Steps op={op} />
    {!done ? <>
      {op.status === 'running' ? <Progress pct={pct} /> : null}{speed ? <div className="small faint">{speed}</div> : null}
      <div className="small muted" aria-live="polite">{what}</div></> : null}
    {op.status === 'failed' ? <Banner kind="bad" title={`Fallita${p?.phase ? ` durante «${phase}»` : ''}${node ? ` su ${node.name}` : ''}${total != null ? ` dopo ${elapsed(total)}` : ''}`}>
      <span style={{ whiteSpace: 'pre-wrap' }}>{itCheck(op.error || error)}</span>{hintFor(op.error || error) ? <p className="small" style={{ marginTop: 8 }}>{hintFor(op.error || error)}</p> : null}
      <p className="small" style={{ marginTop: 8 }}>Il log completo (cosa ha fatto l’agent passo per passo) è nel pulsante «Log» qui sopra.</p></Banner> : null}
    {op.status === 'expired' ? <Banner kind="warn" title="Nessun agent ha preso in carico l’operazione">{node ? <>L’agent di <strong>{node.name}</strong> {node.online ? 'era occupato' : `è offline (ultimo contatto ${ago(node.lastSeen)})`}. </> : 'Il nodo è offline o occupato. '}Nulla è stato eseguito: puoi riprovare.</Banner> : null}
    {op.status === 'cancelled' ? <Banner kind="warn" title="Operazione annullata">Eventuali dati parziali sono stati rimossi.</Banner> : null}
    {error && op.status !== 'failed' ? <Banner kind="warn">{error}</Banner> : null}
  </div>;
}

export const Result = ({ op }: { op: Op | null }) => op?.status === 'succeeded' && op.result ? <>{op.result.warning ? <div className="banner warn" role="status" style={{ marginTop: 8 }}><div className="grow small">{String(op.result.warning)}</div></div> : null}{op.result.pending_restart || op.result.restart_required ? <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>Il nuovo valore vale dopo un riavvio (Patroni: «Riavvia» nella scheda Alta affidabilità).</div> : null}<details><summary className="small muted" style={{ cursor: 'pointer' }}>Dettagli tecnici</summary><pre className="out">{JSON.stringify(op.result, null, 2)}</pre></details></> : null;
export { dur };


/** Plain-language next step for the most common refusals (the raw message stays visible above). */
export function hintFor(msg?: string | null): string {
  const m = String(msg || '');
  if (/console pg_arca .* non risponde/.test(m)) return 'Controlla che il servizio della console sia attivo sul server e che questo browser lo raggiunga (stesso indirizzo di prima, VPN, proxy). Quando torna raggiungibile ripremi lo stesso pulsante: la richiesta ha un identificativo, quindi non può partire due volte.';
  if (/is not healthy/.test(m)) return 'La replica scelta non è in salute (non sta replicando). Scegline un’altra con stato “running”, oppure sistema prima quella replica: Patroni non può promuoverla.';
  if (/no healthy replica/.test(m)) return 'Nessuna replica è in salute: finché una replica non torna “running” non c’è un nodo su cui spostare il primario. Controlla i log di Patroni dei nodi in errore.';
  if (/stale request/.test(m)) return 'Nel frattempo il primario è cambiato. Aggiorna la pagina e riprova.';
  if (/Patroni is not configured|not reachable|unreachable/.test(m)) return 'L’agent di questo nodo non riesce a parlare con l’API REST di Patroni. Controlla l’URL in Nodi → Percorsi e rilevamento (di solito http://127.0.0.1:8008) e che Patroni sia in esecuzione.';
  if (/PGA-GEN-096/.test(m)) return 'Dopo lo scambio alcune righe punterebbero a righe che non esistono (chiave esterna): non è stato cambiato nulla. Ripristina anche le tabelle collegate allo stesso istante, oppure riportale «accanto agli originali» e recupera le righe che servono. Se sai che va bene così puoi procedere: quelle chiavi esterne resteranno NON VALIDE.';
  if (/NOT confirmed/.test(m)) return 'Patroni ha accettato la richiesta ma il cambio non è stato confermato in tempo: controlla lo stato dei membri e i log di Patroni.';
  return '';
}
