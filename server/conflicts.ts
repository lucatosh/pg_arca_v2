/**
 * Operations that must not run together on the same cluster, decided when they are SUBMITTED (not when an agent picks them up): with several DBAs on the
 * same console, the second person must learn at once that a colleague is already doing something incompatible, who, and since when.
 *
 * The lanes (ops.lease) already prevent two data operations from RUNNING at the same time on a cluster; they do not prevent queuing a duplicate backup
 * behind another, a retention that will delete the backup set a queued restore needs, a switchover that kills a running backup, or two promotions of the
 * same quarantine database. Those are refused here with the conflicting operation in the answer. `force: true` overrides only the "disruptive HA action
 * while data work runs" rule (a failover may be urgent); the others are never right.
 */
import type { Operation } from './store';

const ACTIVE = new Set(['queued', 'leased', 'running']);
const BACKUP_SETS_READERS = ['restore_instance', 'restore_database', 'restore_object', 'restore_drill', 'backup_verify', 'restore_plan', 'backup_catalog'];
const DATA_WORK = ['backup_run', 'backup_expire', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote', 'restore_drill', 'restore_apply_rows', 'archive_enable'];
const HA_DISRUPTIVE = ['patroni_switchover', 'patroni_failover', 'patroni_restart', 'patroni_reinit', 'geo_promote', 'geo_demote'];
/** at most one of each, queued or running, per cluster */
/** operations that rewrite the same thing (pg_hba: the file or the DCS list): never two at once on a cluster, whatever their exact type */
const GROUPS: string[][] = [['hba_apply', 'hba_restore', 'hba_expire', 'hba_rollback'], ['geo_archive_fallback', 'geo_promote', 'geo_demote']];
const SINGLETON = ['backup_run', 'backup_expire', 'backup_verify', 'archive_enable', 'restore_instance', 'restore_drill', 'patroni_switchover', 'patroni_failover', 'patroni_pause', 'patroni_config_patch', 'hba_apply', 'ephemeral_install', 'geo_promote', 'geo_demote'];

export const OP_IT: Record<string, string> = {
  backup_run: 'un backup', backup_expire: 'la pulizia dei backup scaduti', backup_verify: 'una verifica dei backup', archive_enable: 'l’attivazione dell’archiviazione WAL',
  restore_instance: 'un ripristino dell’istanza', restore_database: 'un ripristino di database', restore_object: 'un ripristino di oggetti', restore_promote: 'una promozione dalla quarantena',
  restore_drill: 'una prova di ripristino', restore_apply_rows: 'un recupero di righe', patroni_switchover: 'uno switchover', patroni_failover: 'un failover', patroni_restart: 'un riavvio',
  patroni_reinit: 'la ricostruzione di una replica', patroni_pause: 'la pausa di Patroni', patroni_config_patch: 'una modifica della configurazione Patroni', hba_apply: 'una modifica di pg_hba', hba_restore: 'il ripristino di una versione di pg_hba', hba_expire: 'la rimozione delle regole pg_hba scadute', hba_rollback: 'il ripristino del pg_hba precedente', geo_archive_fallback: 'la configurazione della riserva dall’archivio',
  ephemeral_install: 'un’installazione di PostgreSQL', geo_promote: 'la promozione del sito', geo_demote: 'il passaggio del sito a standby', restore_plan: 'la verifica di un piano di ripristino', backup_catalog: 'la lettura del catalogo',
};
const it = (t: string) => OP_IT[t] || t;

export interface Conflict { error: 'conflict'; message: string; with: { id: string; type: string; status: string; createdBy: string; createdAt: string }; overridable: boolean }

export function conflictFor(operations: Operation[], clusterId: string, type: string, params: any, actor?: string): Conflict | null {
  const active = operations.filter(o => o.clusterId === clusterId && ACTIVE.has(o.status));
  const hit = (o: Operation, message: string, overridable = false): Conflict => ({ error: 'conflict', message, overridable,
    with: { id: o.id, type: o.type, status: o.status, createdBy: o.createdBy, createdAt: o.createdAt } });
  const who = (o: Operation) => (o.createdBy === actor ? 'da te' : `da ${o.createdBy}`);
  const state = (o: Operation) => (o.status === 'queued' ? 'è già in coda' : 'è già in corso');
  for (const o of active) {
    const grp = GROUPS.find(g => g.includes(type));
    if (grp && grp.includes(o.type) && o.type !== type) return hit(o, `C’è ${it(o.type)} che ${state(o)} su questo cluster (avviato ${who(o)}): ${it(type)} tocca la stessa configurazione. Attendi che finisca.`);
    if ((SINGLETON.includes(type) || grp) && o.type === type) return hit(o, `C’è ${it(type)} che ${state(o)} su questo cluster (avviato ${who(o)}). Attendi che finisca o annullalo.`);
    if (type === 'backup_expire' && BACKUP_SETS_READERS.includes(o.type) && o.type !== 'restore_plan' && o.type !== 'backup_catalog')
      return hit(o, `La pulizia dei backup scaduti potrebbe eliminare il backup che sta usando ${it(o.type)} (avviato ${who(o)}): riprova quando è finito.`);
    if (BACKUP_SETS_READERS.includes(type) && o.type === 'backup_expire' && type !== 'restore_plan' && type !== 'backup_catalog')
      return hit(o, `È in coda la pulizia dei backup scaduti (avviata ${who(o)}): potrebbe eliminare il backup da cui partiresti. Attendi che finisca.`);
    if (type === 'restore_promote' && o.type === 'restore_promote' && params?.stage_db && o.params?.stage_db === params.stage_db)
      return hit(o, `La quarantena ${params.stage_db} è già in promozione (avviata ${who(o)}).`);
    if (type === 'restore_promote' && o.type === 'restore_object' && params?.stage_db && o.params?.stage_db === params.stage_db)
      return hit(o, `La quarantena ${params.stage_db} è ancora in costruzione (${it(o.type)} avviato ${who(o)}).`);
    if (type === 'restore_object' && params?.stage_db && ['restore_object', 'restore_promote'].includes(o.type) && o.params?.stage_db === params.stage_db)
      return hit(o, `La quarantena ${params.stage_db} è già usata da ${it(o.type)} (avviato ${who(o)}): scegli un altro nome.`);
    if (type === 'restore_database' && o.type === 'restore_database' && params?.new_name && o.params?.new_name === params.new_name)
      return hit(o, `Un altro ripristino sta già creando il database ${params.new_name} (avviato ${who(o)}).`);
    if (HA_DISRUPTIVE.includes(type) && DATA_WORK.includes(o.type) && o.status !== 'queued' && !params?.force)
      return hit(o, `Sul cluster è in corso ${it(o.type)} (avviato ${who(o)}): ${it(type)} lo interromperebbe. Attendi che finisca, oppure conferma che vuoi procedere comunque.`, true);
    if (DATA_WORK.includes(type) && HA_DISRUPTIVE.includes(o.type))
      return hit(o, `È in coda o in corso ${it(o.type)} (avviato ${who(o)}): il cluster cambierà primario o verrà riavviato. Avvia ${it(type)} dopo.`);
  }
  return null;
}

/** What is running or waiting on a cluster, for the "who is doing what" strip of the cluster page. */
export function activityOf(operations: Operation[], clusterId: string) {
  return operations.filter(o => o.clusterId === clusterId && ACTIVE.has(o.status) && !(o.params as any)?.background)
    .map(o => ({ id: o.id, type: o.type, what: it(o.type), status: o.status, createdBy: o.createdBy, createdAt: o.createdAt, progress: o.progress?.phase || null, nodeId: o.nodeId }));
}
