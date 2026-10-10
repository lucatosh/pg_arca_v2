/**
 * Whitelist of operations an operator may request. Anything not listed is rejected, and every
 * parameter is validated server-side (the agent validates again — never trust one side).
 */
export interface OpSpec {
  mutating: boolean;
  target: 'primary' | 'any_node' | 'node' | 'patroni_node';  // where it must run
  needsPatroni?: boolean;
  lane?: 'control' | 'data';                                   // control ops (HA/params) never wait behind hours-long backups
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
  patroni_reload:   { mutating: true, target: 'patroni_node', needsPatroni: true, validate: () => null },
  patroni_pause:    { mutating: true, target: 'patroni_node', needsPatroni: true, validate: p => typeof p.enable === 'boolean' ? null : 'enable boolean required' },
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
      return null;
    },
  },
};


const isoUtcOffset = /([+-]\d{2}(:?\d{2})?|Z|UTC)\s*$/;
const setId = /^[0-9]{8}-[0-9]{6}[FDI](_[0-9]{8}-[0-9]{6}[FDI])?$/;
const lsn = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;
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
const stageErr = (p: any) => !/^(pgarca_)?stage_[A-Za-z0-9_$]{1,50}$/.test(String(p.stage_db ?? '')) ? 'stage_db must be a pg_arca quarantine database' : (!/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(String(p.object ?? '')) ? 'object must be database.schema.name' : null);
const keysErr = (p: any) => {
  for (const f of ['restore_keys', 'delete_keys']) {
    const v = p[f]; if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 50000 || v.some((k: any) => typeof k !== 'string' || k.length > 2000 || !k.startsWith('['))) return f + ' must be a list of JSON-array primary keys (max 50000)';
  }
  return (p.restore_keys?.length || p.delete_keys?.length) ? null : 'select at least one row';
};
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
                                    (p.archive_timeout !== undefined && !(Number(p.archive_timeout) >= 10 && Number(p.archive_timeout) <= 3600) ? 'archive_timeout 10..3600' : null) },
  backup_info:   { mutating: false, target: 'any_node', lane: 'control', validate: () => null },
  backup_verify: { ...dataOp, mutating: false, validate: (p: any) => p.restore_test && p.set && !setId.test(String(p.set)) ? 'invalid backup set id' : null },
  backup_expire: { ...dataOp, cancellable: false, validate: (p: any) => p.retention_full !== undefined && !(Number(p.retention_full) >= 1 && Number(p.retention_full) <= 365) ? 'retention_full 1..365' : null },
  backup_catalog: { mutating: false, target: 'any_node', lane: 'control', validate: (p: any) => (p.set && p.set !== 'latest' && !setId.test(String(p.set))) ? 'invalid backup set id' : (p.database && !pgName(p.database) ? 'invalid database' : null) },
  restore_plan:  { mutating: false, target: 'any_node', lane: 'control', validate: (p: any) => ['instance', 'database', 'object'].includes(p.scope) ? targetErr(p) : 'scope must be instance|database|object' },
  restore_instance: { ...dataOp, validate: (p: any) => !p.destination || !String(p.destination).startsWith('/') || !noCtl(String(p.destination)) ? 'destination must be an absolute path'
                                                       : (targetErr(p) || (p.action && !['promote', 'pause'].includes(p.action) ? 'action must be promote|pause' : null)) },
  restore_database: { ...dataOp, validate: (p: any) => !pgName(p.database) ? 'database required' : (p.new_name && !dbName.test(String(p.new_name)) ? 'invalid new_name' : (targetErr(p) || intoErr(p))) },
  restore_object:   { ...dataOp, validate: (p: any) => !/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(String(p.object ?? '')) ? 'object must be database.schema.name' :
                                                       (p.stage_db && !dbName.test(String(p.stage_db)) ? 'invalid stage_db' : (targetErr(p) || intoErr(p))) },
  hba_read:     { mutating: false, target: 'node', lane: 'control', validate: () => null },
  hba_plan:     { mutating: false, target: 'node', lane: 'control', validate: (p: any) => hbaRulesErr(p) },
  hba_apply:    { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => hbaRulesErr(p) || (p.base_rev && !/^[0-9a-f]{16}$/.test(String(p.base_rev)) ? 'invalid base_rev' : null) },
  agent_config_get: { mutating: false, target: 'node', lane: 'control', validate: () => null },
  agent_config_set: { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => cfgErr(p) },
  hba_expire:   { mutating: true,  target: 'node', lane: 'control', validate: () => null },
  hba_rollback: { mutating: true,  target: 'node', lane: 'control', validate: (p: any) => (p.backup && !/^[\w.\-]{1,100}$/.test(String(p.backup)) ? 'invalid backup name' : null) },
  restore_promote:  { ...dataOp, cancellable: false, validate: (p: any) => !/^(pgarca_)?stage_[A-Za-z0-9_$]{1,50}$/.test(String(p.stage_db ?? '')) ? 'stage_db must be a pg_arca quarantine database' : (!/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(String(p.object ?? '')) ? 'object must be database.schema.name' : (p.mode && !['as_new', 'replace'].includes(p.mode) ? 'mode must be as_new|replace' : intoErr(p))) },
  restore_drill:    { ...dataOp, mutating: false, validate: (p: any) => (p.set && !setId.test(String(p.set)) ? 'invalid backup set id' : null) },
  restore_diff:     { ...dataOp, mutating: false, cancellable: false, validate: (p: any) => stageErr(p) || intoErr(p) },
  restore_apply_rows: { ...dataOp, cancellable: false, validate: (p: any) => stageErr(p) || keysErr(p) || intoErr(p) },
  wal_forensics:    { ...dataOp, mutating: false, validate: () => null },
} as Record<string, OpSpec>);

/** Lane of an operation type: 'data' ops (backup/restore) run in parallel to 'control' ops (HA, parameters). */
export const laneOf = (type: string): 'control' | 'data' => OP_SPECS[type]?.lane || 'control';

export function validateOp(type: string, params: Record<string, any>): string | null {
  const spec = OP_SPECS[type];
  if (!spec) return `unsupported operation '${type}'`;
  return spec.validate(params || {});
}
