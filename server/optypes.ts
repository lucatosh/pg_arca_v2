/**
 * Whitelist of operations an operator may request. Anything not listed is rejected, and every
 * parameter is validated server-side (the agent validates again — never trust one side).
 */
export interface OpSpec {
  mutating: boolean;
  target: 'primary' | 'any_node' | 'node' | 'patroni_node';  // where it must run
  needsPatroni?: boolean;
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

export function validateOp(type: string, params: Record<string, any>): string | null {
  const spec = OP_SPECS[type];
  if (!spec) return `unsupported operation '${type}'`;
  return spec.validate(params || {});
}
