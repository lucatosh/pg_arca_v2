// Lab helper: add (or reset) a console user directly in state.json. STOP the console first (it rewrites the file).
//   sudo systemctl stop pg-arca-console && npx tsx tools/lab/mkuser.ts claude-test 'a-long-password' admin && sudo systemctl start pg-arca-console
import { readFileSync, writeFileSync } from 'fs';
import { hashPassword } from '../../server/auth';
const [user, pw, role = 'admin'] = process.argv.slice(2);
const f = process.env.PG_ARCA_STATE || 'data/state.json';
const s = JSON.parse(readFileSync(f, 'utf8'));
(s.settings.users ||= {})[user] = { user, ...hashPassword(pw), role, createdAt: new Date().toISOString() };
writeFileSync(f, JSON.stringify(s, null, 2)); console.log('ok', user, role);
