// WAL archiving switched on from the console on a standalone server, then the restart it needs from the same card: the restart plan comes back
// from the agent LATER (as on a real server) and the typed confirmation must still open. Run against a FRESH devserver started with ARCHIVE_OFF=1:
//   ARCHIVE_OFF=1 tsx tests/ui/devserver.ts 5188 <static>;  NODE_PATH=/opt/npm-tools/node_modules node tests/ui/archive.cjs [outDir]
const { chromium } = require('playwright');
const out = process.argv[2] || '/tmp/claude-0/ui/shots'; require('fs').mkdirSync(out, { recursive: true });
const base = process.env.BASE || 'http://localhost:5188';
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM === 'bundled' ? {} : { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1360, height: 860 } })).newPage(); global.__p = p; const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await p.goto(base); await p.waitForSelector('text=Sign in');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
  await p.waitForSelector('a:has-text("prodpg")'); await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Data protection');
  await p.click('.gnav >> role=tab[name="Protection"]'); await p.click('.clusternav .tabs >> role=tab[name=/Backup/]');
  await p.waitForSelector('button:has-text("Enable WAL archiving")', { timeout: 15000 });
  if (await p.locator('text=through the Patroni configuration').count()) throw new Error('a standalone server is described as Patroni');
  await p.click('button:has-text("Enable WAL archiving")'); await p.click('.modal button:has-text("Enable")');
  await p.waitForSelector('text=a restart is needed', { timeout: 15000 });
  if (await p.locator('text=replicas first').count()) throw new Error('Patroni restart instructions on a standalone server');
  await p.screenshot({ path: `${out}/arch-1-restart-needed.png` });
  await p.click('button:has-text("Restart now")');
  await p.waitForSelector('.modal:has-text("Restart PostgreSQL?")', { timeout: 15000 });          // opens when the plan has ANSWERED (1.5 s later)
  await p.waitForSelector('.modal code:has-text("postgresql@16-main.service")');
  await p.fill('.modal input', 'RESTART'); await p.click('.modal button:has-text("Restart")');
  await p.waitForSelector('text=PostgreSQL restarted', { timeout: 15000 });
  await p.waitForSelector('text=Enable WAL archiving', { state: 'detached', timeout: 20000 });      // the card goes away once the server reports archiving on
  await p.screenshot({ path: `${out}/arch-2-done.png` });
  if (errs.length) throw new Error(errs.join(' | '));
  console.log('archive UI OK'); await b.close();
})().catch(async e => { console.error('FAIL', e.message); try { await global.__p.screenshot({ path: `${out}/fail.png`, fullPage: true }); } catch { /* */ } process.exit(1); });
