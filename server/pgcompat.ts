/**
 * PostgreSQL version classification for the console (mirror of unix-agent/pg_arca/pgcompat.py: same tiers, same end-of-life rule).
 * Pure: takes a version string ('16.15 (Ubuntu ...)', '9.6.24', '17beta1', '18devel') and says how well the product handles it.
 */
export const MIN_LEGACY = 10;
export const MIN_SUPPORTED = 12;
export const NEWEST_KNOWN = 18;
export type Tier = 'unsupported' | 'legacy' | 'supported' | 'newer';
export interface Compat {
  label: string; major: number; tier: Tier; eolDate: string; eol: boolean;
  problems: { severity: 'critical' | 'warning' | 'info'; code: 'unsupported' | 'legacy' | 'newer' | 'eol'; text: string }[];
}

function secondThursdayNov(year: number): string {
  const d = new Date(Date.UTC(year, 10, 1));
  const first = 1 + ((4 - d.getUTCDay() + 7) % 7);           // Thursday = 4
  return new Date(Date.UTC(year, 10, first + 7)).toISOString().slice(0, 10);
}
export function eolDate(major: number): string { return major < 10 ? '2021-11-11' : secondThursdayNov(2012 + Math.floor(major)); }

export function classify(version: string | undefined | null, now = Date.now()): Compat | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
  if (!m) return null;
  const a = parseInt(m[1], 10), b = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const major = a >= 10 ? a : a + b / 10;
  const label = a >= 10 ? String(a) : `${a}.${b}`;
  const tier: Tier = a < MIN_LEGACY ? 'unsupported' : a < MIN_SUPPORTED ? 'legacy' : a > NEWEST_KNOWN ? 'newer' : 'supported';
  const eol = eolDate(major);
  const isEol = now > Date.parse(eol + 'T23:59:59Z');
  const problems: Compat['problems'] = [];
  if (tier === 'unsupported') problems.push({ severity: 'critical', code: 'unsupported', text: `PostgreSQL ${label} is not supported (minimum ${MIN_LEGACY}): backup and restore refuse to start.` });
  else if (tier === 'legacy') problems.push({ severity: 'warning', code: 'legacy', text: `PostgreSQL ${label} is handled in legacy mode: it is catered for (recovery.conf, older views) but it is not part of the test matrix.` });
  else if (tier === 'newer') problems.push({ severity: 'info', code: 'newer', text: `PostgreSQL ${label} is newer than the latest version reviewed (${NEWEST_KNOWN}): it should work, but verify a restore before relying on it.` });
  if (tier !== 'unsupported' && isEol) problems.push({ severity: 'warning', code: 'eol', text: `PostgreSQL ${label} has been end-of-life since ${eol}: it no longer receives security fixes. Plan the upgrade.` });
  return { label, major, tier, eolDate: eol, eol: isEol, problems };
}
