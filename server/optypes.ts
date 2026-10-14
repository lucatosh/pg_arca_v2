/** Typed confirmation words. The console asks for the English word; the Italian one of earlier versions is still accepted (scripts, old tabs). */
const LEGACY_CONFIRM: Record<string, string> = { REPLACE: 'SOSTITUISCI', DELETE: 'ELIMINA', RESTART: 'RIAVVIA', PROMOTE: 'PROMUOVI', DEMOTE: 'DECLASSA' };
export const confirmed = (v: any, word: string) => v === word || (LEGACY_CONFIRM[word] !== undefined && v === LEGACY_CONFIRM[word]);
/**
 * Whitelist of operations an operator may request. Anything not listed is rejected, and every
 * parameter is validated server-side (the agent validates again — never trust one side).
 */
export interface OpSpec {
  mutating: boolean;
  target: 'primary' | 'any_node' | 'node' | 'patroni_node';  // where it must run
  needsPatroni?: boolean;
  lane?: 'control' | 'data';                                   // control ops (HA/params) never wait behind hours-long backups
  laneKey?: string;                                            // own queue inside the lane: read-only analyses (WAL forensics) do not hold up a backup or a restore, and vice versa
  cancellable?: boolean;
  validate: (p: Record<string, any>) => string | null;       // null = ok, else error message
}

const ident = /^[A-Za-z_][A-Za-z0-9_.]{0,62}$/;
const paramName = /^[a-z_][a-z0-9_.]{0,62}$/;
const noCtl = (v: string) => !/[\u0000-\u001f]/.test(v) && v.length <= 4096;

/** GUCs whose value is executed or loaded by the server (or relocates its files): an operator must not be able to set these through the console. */
export const DANGEROUS_GUCS = new Set(['archive_command', 'archive_cleanup_command', 'restore_command', 'recovery_end_command', 'ssl_passphrase_command', 'shared_preload_libraries',
  'local_preload_libraries', 'session_preload_libraries', 'dynamic_library_path', 'hba_file', 'ident_file', 'data_directory', 'config_file', 'external_pid_file', 'unix_socket_directories',
  'log_directory', 'krb_server_keyfile', 'ssl_cert_file', 'ssl_key_file', 'ssl_ca_file', 'ssl_crl_file', 'stats_temp_directory']);
const CFG_KEYS = ['pg_data', 'pg_bin_dir', 'pg_port', 'pg_host', 'pg_user', 'repo_path', 'wal_archive_dir', 'scratch_dir', 'patroni_url'];
function cfgErr(p: any): string | null {
  const c = p?.set; if (!c || typeof c !== 'object' || Array.isArray(c)) return 'set must be an object';
  const ks = Object.keys(c); if (!ks.length || ks.length > CFG_KEYS.length) return 'nothing to change';
  for (const k of ks) {
    if (!CFG_KEYS.includes(k)) return `setting not editable: ${k}`;
    const v = c[k]; if (v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') return `invalid value for ${k}`;
    if (typeof v === 'string' && !noCtl(v)) return `invalid value for ${k}`;
  }
  return null;
}
export const OP_SPECS: Record<string, OpSpec> = {
  pg_reload:        { mutating: true,  target: 'node', validate: () => null },
  wal_switch:       { mutating: true,  target: 'primary', validate: () => null },
  checkpoint:       { mutating: true,  target: 'primary', validate: () => null },
  discovery_scan:   { mutating: false, target: 'node', validate: () => null },
  compat_check:     { mutating: false, target: 'node', validate: () => null },
  list_objects:     { mutating: false, target: 'primary', validate: p => ident.test(String(p.database ?? '')) || /^[\w .-]{1,63}$/.test(String(p.database ?? '')) ? null : 'database required' },
  pg_set_param: {
    mutating: true, target: 'node',
    validate: p => {
      if (!paramName.test(String(p.name ?? ''))) return 'invalid parameter name';
      if (DANGEROUS_GUCS.has(String(p.name))) return `${p.name} cannot be changed from the console (it runs commands or relocates files): edit it on the server`;
      if (p.value !== null && (typeof p.value !== 'string' && typeof p.value !== 'number' && typeof p.value !== 'boolean')) return 'value must be scalar or null (reset)';
      if (p.value !== null && !noCtl(String(p.value))) return 'invalid value';
      return null;
    },
  },
  patroni_switchover: {
    mutating: true, target: 'patroni_node', needsPatroni: true,
    validate: p => !p.leader ? 'expected current leader (stale-view protection)' :
      (p.candidate && p.candidate === p.leader ? 'candidate must differ from leader' : null),
  },
  patroni_failover: {
    mutating: true, target: 'patroni_node', needsPatroni: true,
    validate: p => !p.candidate ? 'candidate required' : (p.confirm !== 'FAILOVER' ? 'type FAILOVER to confirm' : null),
  },
  patroni_restart:  { mutating: true, target: 'patroni_node', needsPatroni: true, validate: p => (p.member && !ident.test(String(p.member).replace(/-/g, '_'))) ? 'invalid member' : null },
  // restart of a STANDALONE PostgreSQL (no Patroni: patroni_restart) the way that server is managed (systemd unit / pg_ctl); typed confirmation
  pg_restart:       { mutating: true, target: 'any_node', validate: p => (p.dry_run ? null : !confirmed(p.confirm, 'RESTART') ? 'restart needs confirm="RESTART" (every connection is closed)' : null) },
  archive_enable:   { mutating: true, target: 'primary', validate: p => (p.archive_timeout !== undefined && !(Number(p.archive_timeout) >= 10 && Number(p.archive_timeout) <= 3600)) ? 'archive_timeout 10..3600' : null },
  patroni_reinit:   { mutating: true, target: 'patroni_node', needsPatroni: true, validate: p => (p.member && ident.test(String(p.member).replace(/-/g, '_'))) ? null : 'member required' },
  patroni_reload:   { mutating: true, target: 'patroni_node', needsPatroni: true, validate: () => null },
  patroni_pause:    { mutating: true, target: 'patroni_node', needsPatroni: true, validate: p => typeof p.enable === 'boolean' ? null : 'enable boolean required' },
  // geo-redundancy: a Patroni standby cluster becomes writable / a cluster becomes the standby of another site. Through the DCS only (PATCH /config).
  geo_promote: { mutating: true, target: 'patroni_node', needsPatroni: true, cancellable: false,
    validate: p => !confirmed(p.confirm, 'PROMOTE') ? 'confirm="PROMOTE" required (the site becomes writable: if the other site still accepts writes the data diverges)' : (p.slot_for_peer !== undefined && !/^[a-z0-9_]{1,63}$/.test(String(p.slot_for_peer)) ? 'invalid slot_for_peer' : null) },
  geo_archive_fallback: { mutating: true, target: 'patroni_node', needsPatroni: true, validate: p => typeof p.enable !== 'boolean' ? 'enable (true|false) required' : null },
  // timeline + its history file (ancestors, switch points): two servers on the same timeline NUMBER with different histories have diverged
  pg_timeline: { mutating: false, target: 'any_node', lane: 'control', validate: () => null },
  // divergent WAL copies the archive refused (conflicts/): listed, or marked as reviewed (kept, no more alarm)
  wal_retire_branch: { mutating: true, target: 'any_node', lane: 'control', validate: (p: any) => !Number.isInteger(Number(p.timeline)) || Number(p.timeline) < 1 ? 'timeline (number) required'
                        : (!p.dry_run && !confirmed(p.confirm, 'RETIRE')) ? 'retiring a branch needs confirm="RETIRE" (the stored copies of that timeline that diverge from the current primary are set aside)' : null },
  wal_conflicts: { mutating: true, target: 'any_node', lane: 'control', validate: (p: any) => p.files !== undefined && (!Array.isArray(p.files) || p.files.some((f: any) => typeof f !== 'string' || !/^[0-9A-Za-z._-]{1,120}$/.test(f))) ? 'files must be names of quarantined copies' : null },
  geo_demote: { mutating: true, target: 'patroni_node', needsPatroni: true, cancellable: false,
    validate: p => !confirmed(p.confirm, 'DEMOTE') ? 'confirm="DEMOTE" required (writes on this site stop at once)' : (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(String(p.host || '')) ? 'host of the other site required' : (!(Number(p.port) >= 1 && Number(p.port) <= 65535) ? 'port required' : (p.primary_slot_name !== undefined && !/^[a-z0-9_]{1,63}$/.test(String(p.primary_slot_name)) ? 'invalid primary_slot_name' : (p.drop_slots !== undefined && (!Array.isArray(p.drop_slots) || p.drop_slots.some((x: any) => !/^[a-z0-9_]{1,63}$/.test(String(x)))) ? 'invalid drop_slots' : (p.force_rewind !== undefined && typeof p.force_rewind !== 'boolean' ? 'force_rewind must be boolean' : null))))) },
  patroni_config_patch: {
    mutating: true, target: 'patroni_node', needsPatroni: true,
    validate: p => {
      if (!(p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch))) return 'patch object required';
      const pg = p.patch.postgresql;
      if (pg && typeof pg === 'object') {
        for (const k of ['authentication', 'pg_hba', 'pg_ident', 'bin_dir', 'data_dir', 'config_dir', 'listen', 'connect_address', 'custom_conf', 'pgpass', 'callbacks', 'create_replica_methods', 'basebackup']) if (k in pg) return `postgresql.${k} cannot be changed from the console`;
        for (const k of Object.keys(pg.parameters || {})) if (DANGEROUS_GUCS.has(k)) return `${k} cannot be changed from the console (it runs commands or relocates files)`;
      }
      for (const k of ['restapi', 'etcd', 'etcd3', 'consul', 'zookeeper', 'kubernetes', 'ctl', 'scope', 'name', 'namespace', 'watchdog', 'bootstrap']) if (k in p.patch) return `${k} cannot be changed from the console`;
      // standby_cluster carries shell commands (restore_command, archive_cleanup_command) and decides which site writes: only through the geo operations
      if ('standby_cluster' in p.patch) return 'standby_cluster is changed only through the geo-redundancy operations (switchover, promotion, archive fallback)';
      if (pg && typeof pg === 'object' && 'recovery_conf' in pg) return 'postgresql.recovery_conf cannot be changed from the console (it runs commands)';
      return null;
    },
  },
};


const isoUtcOffset = /([+-]\d{2}(:?\d{2})?|Z|UTC)\s*$/;
const setId = /^[0-9]{8}-[0-9]{6}[FDI](_[0-9]{8}-[0-9]{6}[FDI])?$/;
const lsn = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
/** restore_object: `object` = database.schema.name | database.schema, or `objects` = a list of them (all in the same database). */
/** `db.schema[.name]` split into its parts; a part with a dot or a quote is double-quoted (db."sales.eu".orders). Names may contain spaces and any
 *  character PostgreSQL accepts (quoted identifiers): only control characters and parts longer than 63 bytes are refused. null = malformed. */
export function splitSpec(text: string): string[] | null {
  const out: string[] = []; let cur = ''; let quoted = false; let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && !cur && !quoted) {
      let j = i + 1; let buf = '';
      for (;;) { if (j >= text.length) return null; if (text[j] === '"') { if (text[j + 1] === '"') { buf += '"'; j += 2; continue; } break; } buf += text[j++]; }
      cur = buf; quoted = true; i = j + 1; if (i < text.length && text[i] !== '.') return null; continue;
    }
    if (ch === '.') { out.push(cur); cur = ''; quoted = false; i++; continue; }
    if (quoted) return null;
    cur += ch; i++;
  }
  out.push(cur);
  return out.every(x => x.length > 0 && Buffer.byteLength(x) <= 63 && !/[\u0000-\u001f\u007f]/.test(x)) ? out : null;
}
const specOk = (o: string, n: number[]) => { const p = splitSpec(o); return !!p && n.includes(p.length); };
const objectsErr = (p: any): string | null => {
  const list: string[] = Array.isArray(p.objects) ? p.objects.map(String) : (p.object ? [String(p.object)] : []);
  if (!list.length) return 'object (database.schema.name or database.schema) or objects[] required';
  if (list.length > 200) return 'at most 200 objects per restore';
  if (!list.every(o => specOk(o, [2, 3]))) return 'every object must be database.schema.name or database.schema (quote a name that contains a dot)';
  if (new Set(list.map(o => splitSpec(o)![0])).size > 1) return 'all objects must belong to the same database';
  return null;
};
const dbName = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const pgName = (v: any) => typeof v === 'string' && v.length > 0 && v.length <= 63 && noCtl(v);

function targetErr(p: Record<string, any>): string | null {
  const n = ['target_time', 'target_lsn', 'target_xid', 'target_name'].filter(k => p[k] !== undefined && p[k] !== null && p[k] !== '').length;
  if (n > 1) return 'only one recovery target is allowed (time, lsn, xid or name)';
  if (p.target_time && !isoUtcOffset.test(String(p.target_time))) return 'target_time must include a UTC offset (e.g. 2026-07-26 18:34:11+02 or ...Z)';
  if (p.target_lsn && !lsn.test(String(p.target_lsn))) return 'invalid target_lsn';
  if (p.target_xid && !/^\d{1,12}$/.test(String(p.target_xid))) return 'invalid target_xid';
  if (p.target_name && !/^[\w.-]{1,63}$/.test(String(p.target_name))) return 'invalid target_name';
  if (p.set && p.set !== 'latest' && !setId.test(String(p.set))) return 'invalid backup set id';
  return null;
}
const hbaRulesErr = (p: Record<string, any>): string | null => (!Array.isArray(p.rules) || p.rules.length > 200 || p.rules.some((r: any) => !r || typeof r !== 'object')) ? 'rules must be a list of at most 200 objects' : null;
const stageErr = (p: any) => !/^pgarca_stage_[A-Za-z0-9_$]{1,50}$/.test(String(p.stage_db ?? '')) ? 'stage_db must be a pg_arca quarantine database' : (!specOk(String(p.object ?? ''), [3]) ? 'object must be database.schema.name' : null);
const keysErr = (p: any) => {
  for (const f of ['restore_keys', 'delete_keys']) {
    const v = p[f]; if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 50000 || v.some((k: any) => typeof k !== 'string' || k.length > 2000 || !k.startsWith('['))) return f + ' must be a list of JSON-array primary keys (max 50000)';
  }
  if (p.restore_all !== undefined && !(Array.isArray(p.restore_all) && p.restore_all.every((x: any) => ['missing', 'changed'].includes(x)))) return 'restore_all must list missing and/or changed';
  if (p.delete_all_added !== undefined && typeof p.delete_all_added !== 'boolean') return 'delete_all_added must be boolean';
  // a whole category ("every deleted row") is computed by the agent: thousands of rows need no key list
  return (p.restore_keys?.length || p.delete_keys?.length || p.restore_all?.length || p.delete_all_added) ? null : 'select at least one row';
};
const rstId = (p: Record<string, any>) => (/^rst-[0-9a-f]{8}$/.test(String(p.id ?? '')) ? null : 'id must be a restored instance id (rst-xxxxxxxx)');
const dataOp = { mutating: true, target: 'any_node' as const, lane: 'data' as const, cancellable: true };
const intoErr = (p: Record<string, any>) => {
  if (p.into === undefined || p.into === null) return null;
  const i = p.into;
  if (typeof i !== 'object' || Array.isArray(i)) return 'into must be an object';
  if (i.host && !noCtl(String(i.host))) return 'invalid into.host';
  if (i.port && !(Number(i.port) > 0 && Number(i.port) < 65536)) return 'invalid into.port';
  if (i.user && !pgName(i.user)) return 'invalid into.user';
  return null;
};

Object.assign(OP_SPECS, {
  backup_run:    { ...dataOp, target: 'any_node', validate: (p: any) => (['full', 'diff', 'incr'].includes(p.type ?? 'incr') ? null : 'type must be full|diff|incr') ||
                                    (p.archive_timeout !== undefined && !(Number(p.archive_timeout) >= 10 && Number(p.archive_timeout) <= 3600) ? 'archive_timeout 10..3600' : null) ||
                                    (p.start_fast !== undefined && typeof p.start_fast !== 'boolean' ? 'start_fast must be boolean' : null) },
  backup_info:   { mutating: false, target: 'any_node', lane: 'control', validate: () => null },
  backup_verify: { ...dataOp, mutating: false, validate: (p: any) => p.restore_test && p.set && !setId.test(String(p.set)) ? 'invalid backup set id' : null },
  destination_migrate: { ...dataOp, target: 'primary', validate: (p: any) => {
    for (const k of ['source_repo', 'source_wal']) if (p[k] !== undefined && !(typeof p[k] === 'string' && p[k].startsWith('/') && !p[k].split('/').includes('..'))) return `${k}: absolute path`;
    if (p.throttle_mb_s !== undefined && !(Number(p.throttle_mb_s) >= 0 && Number(p.throttle_mb_s) <= 100000)) return 'throttle_mb_s 0..100000';
    return null; } },
  destination_drop_old: { ...dataOp, target: 'primary', cancellable: false, validate: (p: any) => {
    if (!confirmed(p.confirm, 'DELETE')) return 'confirm must be DELETE';
    if (!p.source_repo && !p.source_wal) return 'source_repo or source_wal required';
    for (const k of ['source_repo', 'source_wal']) if (p[k] !== undefined && !(typeof p[k] === 'string' && p[k].startsWith('/') && !p[k].split('/').includes('..'))) return `${k}: absolute path`;
    return null; } },
  backup_expire: { ...dataOp, cancellable: false, validate: (p: any) => p.retention_full !== undefined && !(Number(p.retention_full) >= 1 && Number(p.retention_full) <= 365) ? 'retention_full 1..365' : null },
  backup_catalog: { mutating: false, target: 'any_node', lane: 'control', validate: (p: any) => (p.set && p.set !== 'latest' && p.set !== 'all' && !setId.test(String(p.set))) ? 'invalid backup set id' : (p.database && !pgName(p.database) ? 'invalid database' : null) },
  restore_plan:  { mutating: false, target: 'any_node', lane: 'control', validate: (p: any) => ['instance', 'database', 'object'].includes(p.scope) ? targetErr(p) : 'scope must be instance|database|object' },
  // destination optional: the agent proposes one (a volume with room, never production's) and uses it when none is given
  restore_instance: { ...dataOp, validate: (p: any) => p.destination && (!String(p.destination).startsWith('/') || !noCtl(String(p.destination)) || String(p.destination).split('/').includes('..')) ? 'destination must be an absolute path'
                                                       : (targetErr(p) || (p.action && !['promote', 'pause'].includes(p.action) ? 'action must be promote|pause'
                                                       : (p.label !== undefined && !(typeof p.label === 'string' && p.label.length <= 60 && noCtl(p.label)) ? 'label: up to 60 characters'
                                                       : p.start !== undefined && typeof p.start !== 'boolean' ? 'start must be boolean'
                                                       : (p.ttl_hours !== undefined && p.ttl_hours !== null && !(Number(p.ttl_hours) >= 0 && Number(p.ttl_hours) <= 8760) ? 'ttl_hours 0..8760 (0 = keep)' : null))))
                                                       // replace_production: production ITSELF goes back to the target (rebuilt next to PGDATA, stop, swap, start); no destination, no copy options
                                                       || (p.replace_production !== undefined && typeof p.replace_production !== 'boolean' ? 'replace_production must be boolean'
                                                       : p.replace_production === true && (p.destination || p.keep_archiving || p.delta || p.resume || (p.action && p.action !== 'promote')) ? 'replace_production takes no destination / keep_archiving / delta / resume, and always promotes'
                                                       : p.replace_production === true && !p.dry_run && !confirmed(p.confirm, 'REPLACE') ? 'replace_production needs confirm="REPLACE" (PostgreSQL is stopped and its data directory replaced; the previous one is kept)' : null) },
  // data directories kept by a production replacement (<pgdata>.pgarca-before-<ts>): listed and removed on the node that holds them
  restore_kept_list: { mutating: false, target: 'any_node', lane: 'control', validate: () => null },
  restore_kept_drop: { mutating: true, target: 'any_node', lane: 'data', laneKey: 'restored', cancellable: false, validate: (p: any) => typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.split('/').includes('..') || !/\.pgarca-(before|failed|new)-\d{14}$/.test(p.path) ? 'path must be a data directory kept by a replacement'
                        : (p.confirm !== p.path.split('/').pop() ? 'confirm must be the directory name' : null) },
  // restored copies (whole-instance restores the agent started and keeps track of): listed, stopped, started, resumed, kept or deleted on the node that holds them
  restored_list:   { mutating: false, target: 'node', lane: 'control', validate: () => null },
  restored_stop:   { mutating: true, target: 'node', lane: 'data', laneKey: 'restored', cancellable: false, validate: (p: any) => rstId(p) },
  restored_start:  { mutating: true, target: 'node', lane: 'data', laneKey: 'restored', cancellable: true, validate: (p: any) => rstId(p) },
  restored_resume: { mutating: true, target: 'node', lane: 'data', laneKey: 'restored', cancellable: false, validate: (p: any) => rstId(p) },
  restored_keep:   { mutating: true, target: 'node', lane: 'control', validate: (p: any) => rstId(p) || (p.hours !== undefined && p.hours !== null && !(Number(p.hours) >= 0 && Number(p.hours) <= 8760) ? 'hours 0..8760 (0 = keep until deleted)' : null) },
  restored_drop:   { mutating: true, target: 'node', lane: 'data', laneKey: 'restored', cancellable: false, validate: (p: any) => rstId(p) || (typeof p.confirm !== 'string' || !p.confirm ? 'confirm must be the name of the copy' : null) },
  restore_database: { ...dataOp, validate: (p: any) => !pgName(p.database) ? 'database required' : (p.new_name && !dbName.test(String(p.new_name)) ? 'invalid new_name' : (targetErr(p) || intoErr(p)
                        || (p.replace_original !== undefined && typeof p.replace_original !== 'boolean' ? 'replace_original must be boolean' : null)
                        || (p.replace_original === true && !confirmed(p.confirm, 'REPLACE') ? 'replace_original needs confirm="REPLACE" (the original is renamed and kept, its sessions are ended)' : null))) },
  // finish: the recovered objects go back into the ORIGINAL database at the end of the same operation (promote with the chosen mode, or every row back)
  restore_object:   { ...dataOp, validate: (p: any) => objectsErr(p) || (p.stage_db && !dbName.test(String(p.stage_db)) ? 'invalid stage_db' : (targetErr(p) || intoErr(p)
                        || (p.finish !== undefined && !['promote', 'rows_all'].includes(p.finish) ? 'finish must be promote|rows_all' : null)
                        || (p.promote_mode !== undefined && !['as_new', 'replace', 'missing_only'].includes(p.promote_mode) ? 'promote_mode must be as_new|replace|missing_only' : null)
                        || (p.finish === 'promote' && p.promote_mode === 'replace' && !confirmed(p.confirm, 'REPLACE') ? 'replace needs confirm="REPLACE"' : null)
                        || (p.finish === 'rows_all' && !(Array.isArray(p.objects) ? p.objects.length === 1 : true) ? 'rows_all works on one table' : null))) },
  restore_db_swap:  { ...dataOp, target: 'primary', cancellable: false, validate: (p: any) => !dbName.test(String(p.restored ?? '')) || !pgName(p.original) ? 'restored and original database names required'
                        : (p.restored === p.original ? 'restored and original must differ' : (String(p.restored).startsWith('pgarca_stage_') ? 'a quarantine database cannot replace a database' : (!p.dry_run && !confirmed(p.confirm, 'REPLACE') ? 'confirm="REPLACE" required' : intoErr(p)))) },
  hba_read:     { mutating: false, target: 'node', lane: 'control', validate: () => null },
  hba_plan:     { mutating: false, target: 'node', lane: 'control', validate: (p: any) => hbaRulesErr(p) },
  hba_apply:    { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => hbaRulesErr(p) || (p.base_rev && !/^[0-9a-f]{16}$/.test(String(p.base_rev)) ? 'invalid base_rev' : null) },
  agent_config_get: { mutating: false, target: 'node', lane: 'control', validate: () => null },
  agent_config_set: { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => cfgErr(p) },
  hba_expire:   { mutating: true,  target: 'node', lane: 'control', validate: () => null },
  hba_restore:  { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => (!Array.isArray(p.list) || !p.list.length || p.list.length > 600 || p.list.some((x: any) => typeof x !== 'string' || x.length > 600 || /[\r\n]/.test(x)) ? 'list must be pg_hba lines' : p.base_rev && !/^[0-9a-f]{16}$/.test(String(p.base_rev)) ? 'invalid base_rev' : null) },
  hba_rollback: { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => (p.backup && !/^[\w.\-]{1,100}$/.test(String(p.backup)) ? 'invalid backup name' : null) },
  restore_promote:  { ...dataOp, cancellable: false, validate: (p: any) => !/^pgarca_stage_[A-Za-z0-9_$]{1,50}$/.test(String(p.stage_db ?? '')) ? 'stage_db must be a pg_arca quarantine database' : (p.object && !specOk(String(p.object), [2, 3]) ? 'object must be database.schema or database.schema.name' : (p.mode && !['as_new', 'replace', 'missing_only'].includes(p.mode) ? 'mode must be as_new|replace|missing_only' : (p.mode === 'replace' && !p.dry_run && !confirmed(p.confirm, 'REPLACE') ? 'replace needs confirm="REPLACE" (the originals are renamed, never dropped, but the swap is visible to every client)' : (p.target_schema !== undefined && p.target_schema !== null && p.target_schema !== '' && (p.mode !== 'as_new' || !/^[a-z_][a-z0-9_]{0,62}$/.test(String(p.target_schema)) || /^pg_/.test(String(p.target_schema))) ? 'target_schema: only with mode as_new, lowercase letters, digits and _' : intoErr(p))))) },
  restore_drill:    { ...dataOp, mutating: false, validate: (p: any) => (p.set && !setId.test(String(p.set)) ? 'invalid backup set id' : null) },
  restore_diff:     { ...dataOp, mutating: false, cancellable: false, validate: (p: any) => stageErr(p) || intoErr(p) },
  restore_apply_rows: { ...dataOp, cancellable: false, validate: (p: any) => stageErr(p) || keysErr(p) || intoErr(p) },
  wal_forensics:    { ...dataOp, mutating: false, laneKey: 'analysis', validate: (p: any) => (p.mode !== undefined && !['events', 'databases', 'dml'].includes(p.mode) ? 'mode must be events|databases|dml' : p.min_rows !== undefined && !(Number.isInteger(Number(p.min_rows)) && Number(p.min_rows) >= 1) ? 'min_rows must be a positive integer'
                      : (p.hours !== undefined && !(Number(p.hours) >= 0 && Number(p.hours) <= 87600) ? 'hours must be 0 (whole archive) to 87600'
                      : (p.limit !== undefined && !(Number.isInteger(Number(p.limit)) && Number(p.limit) >= 1 && Number(p.limit) <= 200) ? 'limit must be 1-200'
                      : (p.budget_sec !== undefined && !(Number(p.budget_sec) >= 30 && Number(p.budget_sec) <= 7200) ? 'budget_sec must be 30-7200'
                      : (p.since_iso !== undefined && !(typeof p.since_iso === 'string' && p.since_iso.length <= 40 && !isNaN(Date.parse(p.since_iso))) ? 'since_iso must be a date' : null))))) },
  destination_check:   { mutating: false, target: 'node', lane: 'control', validate: (p: any) => !['local', 'nfs', 'smb'].includes(p.type ?? 'local') ? 'type must be local|nfs|smb (object storage is not supported by the engine yet)'
                                : (!p.repo_path && !p.wal_path ? 'repo_path and/or wal_path required' : ([p.repo_path, p.wal_path].some((x: any) => x !== undefined && x !== null && (typeof x !== 'string' || !x.startsWith('/') || !noCtl(x) || x.split('/').includes('..'))) ? 'paths must be absolute, without ..' : null)) },
  ephemeral_preflight: { mutating: false, target: 'node', lane: 'control', validate: (p: any) => (p.major !== undefined && !(Number.isInteger(Number(p.major)) && Number(p.major) >= 10 && Number(p.major) <= 40) ? 'major must be a PostgreSQL major version' : (p.need_bytes !== undefined && !(Number(p.need_bytes) >= 0) ? 'need_bytes must be a number' : intoErr(p))) },
  ephemeral_install:   { mutating: true, target: 'node', lane: 'data', cancellable: false, validate: (p: any) => !(Number.isInteger(Number(p.major)) && Number(p.major) >= 10 && Number(p.major) <= 40) ? 'major (PostgreSQL major version) required' : (p.mode && !['private', 'system'].includes(p.mode) ? 'mode must be private|system' : (p.confirm !== 'INSTALL' ? 'type INSTALL to confirm' : null)) },
} as Record<string, OpSpec>);

/** Lane of an operation type: 'data' ops (backup/restore) run in parallel to 'control' ops (HA, parameters). */
export const laneOf = (type: string): string => OP_SPECS[type]?.laneKey || OP_SPECS[type]?.lane || 'control';

export function validateOp(type: string, params: Record<string, any>): string | null {
  const spec = OP_SPECS[type];
  if (!spec) return `unsupported operation '${type}'`;
  return spec.validate(params || {});
}
