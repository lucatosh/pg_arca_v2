import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { OP_SPECS } from '../../server/optypes';

// One vocabulary (independent UX review, 15/10): every operation the console can run has a plain-language label, so no raw type
// ("agent_config_set", "offsite_get") ever reaches the activity dock, the toasts, the cluster strip or the activity log.
const here = path.dirname(new URL(import.meta.url).pathname);
const shared = fs.readFileSync(path.join(here, '../../src/pages/shared.tsx'), 'utf8');
const block = shared.slice(shared.indexOf('export const OP_LABEL'), shared.indexOf('};', shared.indexOf('export const OP_LABEL')));
const labelled = new Set([...block.matchAll(/\b([a-z][a-z0-9_]+):\s*'/g)].map(m => m[1]));
const missing = Object.keys(OP_SPECS).filter(t => !labelled.has(t));
assert.deepStrictEqual(missing, [], `operation types without a label in src/pages/shared.tsx OP_LABEL: ${missing.join(', ')}`);

// retired words stay retired: the names a person meets are the single terms of the glossary
const RETIRED: [RegExp, string][] = [[/quarantine database/i, 'staging database'], [/Repository health/, 'Backup storage'], [/Where backups go/, 'Destination'],
  [/Ready with reservations/, 'Can take over, with N things to fix'], [/Instance restore'|Database restore'|Object restore'/, 'Restore server / database / tables'],
  [/Operation history'|'Audit log'/, 'Activity log'], [/Recovery &(amp;)? storage/, 'Storage & recovery']];
const files: string[] = [];
const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
walk(path.join(here, '../../src'));
const hits: string[] = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  for (const [re, use] of RETIRED) if (re.test(src)) hits.push(`${path.relative(path.join(here, '../..'), f)}: ${re} -> use "${use}"`);
}
assert.deepStrictEqual(hits, [], hits.join('\n'));
console.log('labels/vocabulary tests OK');
