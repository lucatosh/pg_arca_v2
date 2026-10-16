import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { itCheck, itFix } from '../../src/i18n';

// agent messages are English and pass through unchanged
assert.strictEqual(itCheck('/var/tmp/pg_arca_scratch: 26.5 GiB free, about 16.1 GiB needed'), '/var/tmp/pg_arca_scratch: 26.5 GiB free, about 16.1 GiB needed');
assert.strictEqual(itFix('make sure it has about 3 GiB free'), 'make sure it has about 3 GiB free');
assert.strictEqual(itCheck(null), '');
// older agents' "N thing(s)" plurals read as people write them
assert.strictEqual(itCheck('WAL archive is missing 1 segment(s) required (first: X)'), 'WAL archive is missing 1 segment required (first: X)');
assert.strictEqual(itCheck('3 backup set(s) and 1 WAL file(s) of this cluster'), '3 backup sets and 1 WAL file of this cluster');
assert.strictEqual(itCheck('WAL segment(s) not archived'), 'WAL segments not archived');
assert.strictEqual(itFix(undefined), '');

// the UI is English: no Italian left in the string literals / JSX text of src/ (comments are ignored)
const IT = /[àèéìòù]|\b(della|delle|degli|dello|nella|nelle|questo|questa|quando|perché|sono|vengono|viene|cartella|ripristino|ripristina|nessun|nessuna|impostazioni|scegli|annulla|chiudi|salva|elimina|eliminat[oaie]|modello|modelli|attiva|riprova|aggiorna|indietro|avanti|utente|errore|fallita|completato|in corso|non è|tuo|tua|tuoi|nuovo|nuova|pronto|spento|acceso|sì|oggi|nodo|nodi|primario|sito|siti|ruolo|ruoli|cartelle|righe|tabelle|backup completo|sola|lettura|operatore|operatori|macchin\w*|operativ\w*|valori|predefinit\w*|vedi|ultimo|ultima|giorni|obiettivo|minuscolo|diverso|durato|secondo|anche|ancora|dove|senza|dopo|ogni|tutti|tutte|sempre|deve|devono|puoi|devi|gli|una|che|\w+zione|\w+zioni)\b/i;
const files: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
const here = path.dirname(new URL(import.meta.url).pathname);
walk(path.join(here, '../../src')); walk(path.join(here, '../../server')); files.push(path.join(here, '../../server.ts'));
const bad: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  src.split('\n').forEach((line, i) => {
    if (line.includes('LEGACY_CONFIRM')) return; // the Italian confirm words of earlier versions, accepted on purpose
    const texts = [...line.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`|>([^<>{}\n]+)</g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
    for (const t of texts) if (IT.test(t)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${t.slice(0, 100)}`);
  });
}
assert.deepStrictEqual(bad, [], 'Italian text left in the UI or in server messages:\n' + bad.join('\n'));
console.log('i18n OK');
