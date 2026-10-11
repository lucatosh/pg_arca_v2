// First run from the network: the administrator can only be created with the one-time code printed in the console's log (takeover protection).
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { MiniApp } from './mini-express';
import { Store } from '../../server/store';
import { mountAuthRoutes, initSetupCode } from '../../server/auth';
(async () => {
  process.env.PG_ARCA_SETUP_CODE = 'on';
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'))); const app = new MiniApp(); mountAuthRoutes(app, store);
  const code = initSetupCode(store)!;
  assert(code && fs.readFileSync(path.join(store.dir, 'setup-code'), 'utf8').trim() === code);
  assert.strictEqual((await app.call('GET', '/api/auth/status')).body.setupCodeRequired, true);
  const body = { username: 'admin', password: 'correct-horse-battery' };
  assert.strictEqual((await app.call('POST', '/api/auth/setup', { body })).status, 403, 'no code from the network');
  assert.strictEqual((await app.call('POST', '/api/auth/setup', { body: { ...body, setupCode: 'wrong-code-x' } })).status, 403);
  const ok = await app.call('POST', '/api/auth/setup', { body: { ...body, setupCode: code } });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert(!fs.existsSync(path.join(store.dir, 'setup-code')), 'spent');
  assert.strictEqual((await app.call('GET', '/api/auth/status')).body.setupCodeRequired, false);
  process.env.PG_ARCA_SETUP_CODE = 'off';
  console.log('setup code tests OK');
})().catch(e => { console.error(e); process.exit(1); });
