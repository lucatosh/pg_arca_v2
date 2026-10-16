/** Credentials that PostgreSQL / tool settings carry inside ordinary strings (primary_conninfo password=, PGPASSWORD= in an archive_command,
 *  cloud keys of wal-g / pgBackRest, user:password@ in URLs). Discovery reports these settings as they are on the host; the console never stores
 *  or shows the secret part (independent security review: any viewer read the replication password from /api/discovery/results). */
const PATTERNS: [RegExp, string][] = [
  [/\b(password|passwd|pwd|sslpassword)\s*=\s*('(?:[^'\\]|\\.)*'|"[^"]*"|\S+)/gi, '$1=•••'],
  [/\b(PGPASSWORD|[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|ACCESS_KEY)[A-Z0-9_]*)=(\S+)/g, '$1=•••'],
  [/(--(?:password|secret|token|key)[\w-]*[= ])(\S+)/gi, '$1•••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:•••@'],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function scrubSecrets<T>(v: T, depth = 0): T {
  if (depth > 40) return v;
  if (typeof v === 'string') return scrubString(v) as any;
  if (Array.isArray(v)) return v.map(x => scrubSecrets(x, depth + 1)) as any;
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const [k, x] of Object.entries(v as any)) o[k] = /^(password|passwd|secret|token|api_key|access_key|secret_key)$/i.test(k) && typeof x === 'string' && x ? '•••' : scrubSecrets(x, depth + 1);
    return o;
  }
  return v;
}
