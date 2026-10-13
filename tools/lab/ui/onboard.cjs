// Lab: onboard servers through the REAL console UI, as a user would. Prints the install command the UI shows (the operator runs it on the servers),
// then waits for them to join and screenshots each step. Run on the lab VM (playwright-core in ~/uitest):
//   NODE_PATH=~/uitest/node_modules node tools/lab/ui/onboard.cjs <environment> <servers> [label] [outDir]
const { chromium } = require('playwright-core'); const fs = require('fs'); const path = require('path'); const os = require('os');
const [env = 'test', n = '1', label = 'nodo', out = '/tmp/onboard'] = process.argv.slice(2);
const base = process.env.PG_ARCA_URL || 'http://localhost:3000';
const exe = process.env.PW_CHROMIUM || (() => { const d = path.join(os.homedir(), '.cache/ms-playwright'); const h = fs.readdirSync(d).find(x => x.startsWith('chromium_headless_shell')); return path.join(d, h, 'chrome-linux/headless_shell'); })();
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch({ executablePath: exe }); const p = await (await b.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const shot = async name => p.screenshot({ path: `${out}/${name}.png` });
  await p.goto(base); await p.waitForSelector('text=Accedi');
  await p.fill('input[autocomplete=username]', process.env.ARCA_USER || 'claude-test'); await p.fill('input[type=password]', process.env.ARCA_PASS || 'claude-lab-test-pass-1');
  await p.click('button[type=submit]'); await p.waitForSelector('button:has-text("Collega cluster")');
  await p.click('button:has-text("Collega cluster") >> nth=0'); await p.click('text=Con agent (consigliato)'); await shot('01-agent-form');
  await p.selectOption('.modal select', env); await p.fill('.modal input[placeholder="es. pg-prod-01"]', label); await p.fill('.modal input[type=number]', String(n));
  await p.click('button:has-text("Genera comando di installazione")'); await p.waitForSelector('.modal pre, .modal code'); await shot('02-command');
  const cmd = (await p.locator('.modal pre, .modal .copyblock').first().innerText()).trim().split('\n')[0];
  fs.writeFileSync(`${out}/command.txt`, cmd + '\n'); console.log('COMMAND ' + cmd);
  // the operator now runs the command on each server; the dialog follows the joins by itself
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < 15 * 60e3) {
    const txt = await p.locator('.modal').innerText().catch(() => '');
    const s = (txt.match(/Collegati \d+ di \d+[^\n]*|server collegati|Nodo .* collegato/) || [''])[0]; if (s && s !== last) { console.log('STATUS ' + s); last = s; }
    if (/server collegati|Nodo .* collegato/.test(txt)) break;
    await p.waitForTimeout(3000);
  }
  await shot('03-joined'); console.log('FINAL ' + (await p.locator('.modal').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600));
  if (await p.locator('button:has-text("Apri il cluster")').count()) { await p.click('button:has-text("Apri il cluster")'); await p.waitForTimeout(4000); await shot('04-cluster'); console.log('CLUSTER ' + (await p.locator('main.page').innerText()).replace(/\s+/g, ' ').slice(0, 1500)); }
  if (errs.length) console.log('PAGE ERRORS ' + errs.join(' | '));
  await b.close();
})().catch(e => { console.error('FAIL ' + e.message); process.exit(1); });
