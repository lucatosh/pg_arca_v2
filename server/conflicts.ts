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
const DATA_WORK = ['backup_run', 'backup_expire', 'destination_migrate', 'destination_drop_old', 'restore_instance', 'restore_database', 'restore_object', 'restore_promote', 'restore_drill', 'restore_apply_rows', 'archive_enable', 'restore_db_swap', 'restore_kept_drop'];
const HA_DISRUPTIVE = ['pg_restart', 'patroni_switchover', 'patroni_failover', 'patroni_restart', 'patroni_reinit', 'geo_promote', 'geo_demote'];
/** at most one of each, queued or running, per cluster */
/** operations that rewrite the same thing (pg_hba: the file or the DCS list): never two at once on a cluster, whatever their exact type */
const GROUPS: string[][] = [['hba_apply', 'hba_restore', 'hba_expire', 'hba_rollback'], ['geo_archive_fallback', 'geo_promote', 'geo_demote']];
const SINGLETON = ['pg_restart', 'backup_run', 'backup_expire', 'destination_migrate', 'destination_drop_old', 'backup_verify', 'archive_enable', 'restore_instance', 'restore_drill', 'patroni_switchover', 'patroni_failover', 'patroni_pause', 'patroni_config_patch', 'hba_apply', 'ephemeral_install', 'geo_promote', 'geo_demote'];

export const OP_IT: Record<string, string> = {
  wal_retire_branch: 'the retirement of a dead WAL branch', backup_run: 'a backup', backup_expire: 'the cleanup of expired backups', destination_migrate: 'the migration of the backups to the new destination', destination_drop_old: 'the deletion of the previous backup location', backup_verify: 'a backup verification', archive_enable: 'enabling WAL archiving',
  restore_instance: 'an instance restore', restore_database: 'a database restore', restore_object: 'an object restore', restore_promote: 'a promotion from quarantine', restore_db_swap: 'swapping a database with the restored one', restore_kept_drop: 'deleting data kept from a replacement',
  restore_drill: 'a restore drill', restore_apply_rows: 'a row recovery', patroni_switchover: 'a switchover', patroni_failover: 'a failover', patroni_restart: 'a restart', pg_restart: 'a PostgreSQL restart',
  patroni_reinit: 'a replica reinitialization', patroni_pause: 'pausing Patroni', patroni_config_patch: 'a Patroni configuration change', hba_apply: 'a pg_hba change', hba_restore: 'restoring a pg_hba version', hba_expire: 'removing expired pg_hba rules', hba_rollback: 'rolling back to the previous pg_hba', geo_archive_fallback: 'configuring the archive fallback',
  ephemeral_install: 'a PostgreSQL installation', restored_stop: 'stopping a restored copy', restored_start: 'starting a restored copy', restored_resume: 'finishing a copy’s recovery', restored_drop: 'deleting a restored copy', geo_promote: 'the site promotion', geo_demote: 'the site demotion to standby', restore_plan: 'checking a restore plan', backup_catalog: 'reading the catalog',
};
const it = (t: string) => OP_IT[t] || t;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface Conflict { error: 'conflict'; message: string; with: { id: string; type: string; status: string; createdBy: string; createdAt: string }; overridable: boolean }

export function conflictFor(operations: Operation[], clusterId: string, type: string, params: any, actor?: string): Conflict | null {
  if (type === 'pg_restart' && params?.dry_run) return null;              // a look at how it would be done: changes nothing
  const active = operations.filter(o => o.clusterId === clusterId && ACTIVE.has(o.status) && !(o.type === 'pg_restart' && o.params?.dry_run));
  const hit = (o: Operation, message: string, overridable = false): Conflict => ({ error: 'conflict', message, overridable,
    with: { id: o.id, type: o.type, status: o.status, createdBy: o.createdBy, createdAt: o.createdAt } });
  const who = (o: Operation) => (o.createdBy === actor ? 'by you' : `by ${o.createdBy}`);
  const state = (o: Operation) => (o.status === 'queued' ? 'is already queued' : 'is already running');
  for (const o of active) {
    const grp = GROUPS.find(g => g.includes(type));
    if (grp && grp.includes(o.type) && o.type !== type) return hit(o, `${cap(it(o.type))} ${state(o)} on this cluster (started ${who(o)}): ${it(type)} touches the same configuration. Wait until it finishes.`);
    if ((SINGLETON.includes(type) || grp) && o.type === type) return hit(o, `${cap(it(type))} ${state(o)} on this cluster (started ${who(o)}). Wait until it finishes or cancel it.`);
    if ((type === 'destination_migrate' && o.type === 'backup_expire') || (type === 'backup_expire' && o.type === 'destination_migrate' && !o.params?.dry_run))
      return hit(o, `${cap(it(o.type))} ${state(o)} (started ${who(o)}): cleanup and migration work on the same backups. Wait until it finishes.`);
    if (type === 'backup_expire' && BACKUP_SETS_READERS.includes(o.type) && o.type !== 'restore_plan' && o.type !== 'backup_catalog')
      return hit(o, `The cleanup of expired backups could delete the backup that ${it(o.type)} is using (started ${who(o)}): try again when it has finished.`);
    if (BACKUP_SETS_READERS.includes(type) && o.type === 'backup_expire' && type !== 'restore_plan' && type !== 'backup_catalog')
      return hit(o, `The cleanup of expired backups is queued (started ${who(o)}): it could delete the backup you would start from. Wait until it finishes.`);
    if (type === 'restore_promote' && o.type === 'restore_promote' && params?.stage_db && o.params?.stage_db === params.stage_db)
      return hit(o, `Quarantine database ${params.stage_db} is already being promoted (started ${who(o)}).`);
    if (type === 'restore_promote' && o.type === 'restore_object' && params?.stage_db && o.params?.stage_db === params.stage_db)
      return hit(o, `Quarantine database ${params.stage_db} is still being built (${it(o.type)} started ${who(o)}).`);
    if (type === 'restore_object' && params?.stage_db && ['restore_object', 'restore_promote'].includes(o.type) && o.params?.stage_db === params.stage_db)
      return hit(o, `Quarantine database ${params.stage_db} is already used by ${it(o.type)} (started ${who(o)}): choose another name.`);
    if (type === 'restore_database' && o.type === 'restore_database' && params?.new_name && o.params?.new_name === params.new_name)
      return hit(o, `Another restore is already creating database ${params.new_name} (started ${who(o)}).`);
    if (HA_DISRUPTIVE.includes(type) && DATA_WORK.includes(o.type) && o.status !== 'queued' && !params?.force)
      return hit(o, `${cap(it(o.type))} is running on the cluster (started ${who(o)}): ${it(type)} would interrupt it. Wait until it finishes, or confirm that you want to proceed anyway.`, true);
    if (DATA_WORK.includes(type) && HA_DISRUPTIVE.includes(o.type))
      return hit(o, `${cap(it(o.type))} is queued or running (started ${who(o)}): the cluster will change primary or be restarted. Start ${it(type)} afterwards.`);
  }
  return null;
}

/** What is running or waiting on a cluster, for the "who is doing what" strip of the cluster page. */
export function activityOf(operations: Operation[], clusterId: string) {
  return operations.filter(o => o.clusterId === clusterId && ACTIVE.has(o.status) && !(o.params as any)?.background)
    .map(o => ({ id: o.id, type: o.type, what: it(o.type), status: o.status, createdBy: o.createdBy, createdAt: o.createdAt, progress: o.progress?.phase || null, nodeId: o.nodeId }));
}
