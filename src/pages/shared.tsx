import React from 'react';
import { Op, isTerminal } from '../hooks';
import { Badge, Banner, Button, Progress, bytes, dur, num } from '../ui';

export const OP_LABEL: Record<string, string> = {
  pg_reload: 'Ricarica configurazione', wal_switch: 'Cambio segmento WAL', checkpoint: 'Checkpoint', discovery_scan: 'Rilevamento', agent_config_get: 'Lettura impostazioni agent', agent_config_set: 'Impostazioni agent', list_objects: 'Elenco oggetti',
  pg_set_param: 'Modifica parametro', patroni_switchover: 'Switchover', patroni_failover: 'Failover', patroni_restart: 'Riavvio membro', patroni_reinit: 'Ricostruzione replica', archive_enable: 'Attivazione archiviazione WAL', patroni_reload: 'Ricarica Patroni',
  patroni_pause: 'Modalità manutenzione', patroni_config_patch: 'Modifica config Patroni', backup_run: 'Backup', backup_info: 'Info repository', backup_verify: 'Verifica backup',
  backup_expire: 'Scadenza e pulizia', backup_catalog: 'Catalogo backup', restore_plan: 'Piano di ripristino', restore_instance: 'Ripristino istanza', restore_database: 'Ripristino database',
  restore_object: 'Ripristino oggetto', wal_forensics: 'Analisi WAL', hba_read: 'Lettura pg_hba', hba_plan: 'Verifica pg_hba', hba_apply: 'Modifica pg_hba', hba_rollback: 'Ripristino pg_hba', restore_promote: 'Riporta tabella nel database',
};
export const STATUS_LABEL: Record<string, string> = { queued: 'In coda', leased: 'Assegnata', running: 'In esecuzione', succeeded: 'Completata', failed: 'Fallita', expired: 'Scaduta', cancelled: 'Annullata' };
export const statusBadge = (s: string) => <Badge kind={s === 'succeeded' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' || s === 'leased' ? 'info' : undefined}>{STATUS_LABEL[s] || s}</Badge>;
const PHASE: Record<string, string> = { catalog: 'Lettura del catalogo', checkpoint: 'Checkpoint di PostgreSQL', copy: 'Copia dei dati', finalize: 'Chiusura del backup', wal: 'Attesa archiviazione WAL', extract: 'Estrazione dei file', starting: 'Avvio istanza temporanea', recovery: 'Recovery dei WAL', transfer: 'Trasferimento dati', verify: 'Verifica dei chunk', 'restore-test': 'Prova di ripristino' };

export function pctOf(p: any): number | null {
  if (!p) return null;
  if (p.bytes_total) return Math.round((p.bytes / p.bytes_total) * 100);
  if (p.files_total) return Math.round((p.files / p.files_total) * 100);
  return null;
}

/** Live view of one operation: phase, progress, cancel, error. Result rendering is up to the caller. */
export function OpPanel({ op, error, cancel, label }: { op: Op | null; error?: string | null; cancel?: () => void; label?: string }) {
  if (!op && !error) return null;
  if (!op) return <Banner kind="bad" title="Operazione non avviata">{error}</Banner>;
  const done = isTerminal(op.status); const p = op.progress; const pct = pctOf(p);
  return <div className="stack">
    <div className="row wrap"><strong>{label || OP_LABEL[op.type] || op.type}</strong>{statusBadge(op.status)}
      {op.cancelRequested && !done ? <Badge kind="warn">Annullamento richiesto…</Badge> : null}
      <div className="grow" />{!done && cancel && !op.cancelRequested ? <Button sm kind="danger" icon="stop" onClick={cancel}>Annulla</Button> : null}</div>
    {!done ? <>
      <Progress pct={pct} />
      <div className="small muted">{p?.phase ? PHASE[p.phase] || p.phase : op.status === 'queued' ? 'In coda: l’agent esegue le operazioni sui dati una alla volta, parte appena finisce quella in corso.' : 'In corso…'}
        {p?.phase === 'checkpoint' ? ` — da ${p.elapsed_sec ?? 0} s${p.fast ? '' : ' (checkpoint distribuito: su un server carico può durare alcuni minuti; l’annullamento lo interrompe)'}` : ''}{p?.files_total ? ` — ${num(p.files)} / ${num(p.files_total)} file` : ''}{p?.bytes_total ? `, ${bytes(p.bytes)} / ${bytes(p.bytes_total)}` : ''}{p?.chunks ? ` — ${num(p.chunks)} chunk verificati` : ''}</div></> : null}
    {op.status === 'failed' ? <Banner kind="bad" title="Operazione fallita"><span style={{ whiteSpace: 'pre-wrap' }}>{op.error || error}</span>{hintFor(op.error || error) ? <p className="small" style={{ marginTop: 8 }}>{hintFor(op.error || error)}</p> : null}</Banner> : null}
    {op.status === 'expired' ? <Banner kind="warn" title="Nessun agent ha preso in carico l’operazione">Il nodo è offline o occupato. Nulla è stato eseguito.</Banner> : null}
    {op.status === 'cancelled' ? <Banner kind="warn" title="Operazione annullata">Eventuali dati parziali sono stati rimossi.</Banner> : null}
    {error && op.status !== 'failed' ? <Banner kind="bad">{error}</Banner> : null}
  </div>;
}

export const Result = ({ op }: { op: Op | null }) => op?.status === 'succeeded' && op.result ? <details><summary className="small muted" style={{ cursor: 'pointer' }}>Dettagli tecnici</summary><pre className="out">{JSON.stringify(op.result, null, 2)}</pre></details> : null;
export { dur };


/** Plain-language next step for the most common refusals (the raw message stays visible above). */
export function hintFor(msg?: string | null): string {
  const m = String(msg || '');
  if (/is not healthy/.test(m)) return 'La replica scelta non è in salute (non sta replicando). Scegline un’altra con stato “running”, oppure sistema prima quella replica: Patroni non può promuoverla.';
  if (/no healthy replica/.test(m)) return 'Nessuna replica è in salute: finché una replica non torna “running” non c’è un nodo su cui spostare il primario. Controlla i log di Patroni dei nodi in errore.';
  if (/stale request/.test(m)) return 'Nel frattempo il primario è cambiato. Aggiorna la pagina e riprova.';
  if (/Patroni is not configured|not reachable|unreachable/.test(m)) return 'L’agent di questo nodo non riesce a parlare con l’API REST di Patroni. Controlla l’URL in Nodi → Percorsi e rilevamento (di solito http://127.0.0.1:8008) e che Patroni sia in esecuzione.';
  if (/NOT confirmed/.test(m)) return 'Patroni ha accettato la richiesta ma il cambio non è stato confermato in tempo: controlla lo stato dei membri e i log di Patroni.';
  return '';
}
