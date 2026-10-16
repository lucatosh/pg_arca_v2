/* Agent messages (check results, warnings, fixes) are written in English by the agent and shown as they are, with one rewording: the
 * "N thing(s)" plurals of older agent texts become "1 thing" / "N things" (agents in the field are not all upgraded at once).
 * Covered by tests/ui/i18n.test.ts, which also guards the UI sources against untranslated (Italian) text. */
const plurals = (t: string) => t.replace(/\b(\d+) ((?:[A-Za-z-]+ ){0,2}[A-Za-z-]+)\(s\)/g, (_m, n, w) => `${n} ${n === '1' ? w : w + 's'}`).replace(/\b([A-Za-z-]+)\(s\)/g, '$1s');
export const itCheck = (s?: string | null) => (s ? plurals(String(s)) : s || '');
export const itFix = (s?: string | null) => (s ? plurals(String(s)) : s || '');
