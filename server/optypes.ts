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
    validate: p => (p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch)) ? null : 'patch object required',
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
  restore_plan:  { mutating: false, target: 'any_node', lane: 'control', validate: (p: any) => ['instance', 'database', 'object'].includes(p.scope) ? targetErr(p) : 'scope must be instance|database|object' },
  restore_instance: { ...dataOp, validate: (p: any) => !p.destination || !String(p.destination).startsWith('/') || !noCtl(String(p.destination)) ? 'destination must be an absolute path'
                                                       : (targetErr(p) || (p.action && !['promote', 'pause'].includes(p.action) ? 'action must be promote|pause' : null)) },
  restore_database: { ...dataOp, validate: (p: any) => !pgName(p.database) ? 'database required' : (p.new_name && !dbName.test(String(p.new_name)) ? 'invalid new_name' : (targetErr(p) || intoErr(p))) },
  restore_object:   { ...dataOp, validate: (p: any) => !/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(String(p.object ?? '')) ? 'object must be database.schema.name' :
                                                       (p.stage_db && !dbName.test(String(p.stage_db)) ? 'invalid stage_db' : (targetErr(p) || intoErr(p))) },
  wal_forensics:    { ...dataOp, mutating: false, validate: () => null },
} as Record<string, OpSpec>);

/** Lane of an operation type: 'data' ops (backup/restore) run in parallel to 'control' ops (HA, parameters). */
export const laneOf = (type: string): 'control' | 'data' => OP_SPECS[type]?.lane || 'control';

export function validateOp(type: string, params: Record<string, any>): string | null {
  const spec = OP_SPECS[type];
  if (!spec) return `unsupported operation '${type}'`;
  return spec.validate(params || {});
}
