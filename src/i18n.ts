/* Agent messages (check results, warnings, fixes) are written in English by the agent and shown as they are.
 * These two hooks stay as the single place where the console could reword them; today they pass the text through unchanged.
 * Covered by tests/ui/i18n.test.ts, which also guards the UI sources against untranslated (Italian) text. */
export const itCheck = (s?: string | null) => (s ? String(s) : s || '');
export const itFix = (s?: string | null) => (s ? String(s) : s || '');
