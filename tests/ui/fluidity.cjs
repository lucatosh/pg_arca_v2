// Fluidity: what was typed or chosen survives leaving the page (tab switch, a setting opened from inside a form, Back) and modals with typed data
// do not vanish on a stray click. Run against a FRESH devserver: NODE_PATH=/opt/npm-tools/node_modules node tests/ui/fluidity.cjs [outDir]
const { chromium } = require('playwright'); const assert = require('assert');
const out = process.argv[2] || '/tmp/claude-0/ui/shots'; require('fs').mkdirSync(out, { recursive: true });
const base = process.env.BASE || 'http://localhost:5188';
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM === 'bundled' ? {} : { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
  const p = await (await b.newContext({ viewport: { width: 1360, height: 860 } })).newPage(); global.__p = p; const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/401|428|Failed to load resource|WebSocket/.test(m.text())) errs.push('console: ' + m.text()); });
  const tab = async (area, name) => { await p.click(`.gnav >> role=tab[name="${area}"]`); if (name) await p.click(`.clusternav .tabs >> role=tab[name=/${name}/]`); };
  const shot = n => p.screenshot({ path: `${out}/${n}.png` });
  await p.goto(base); await p.waitForSelector('text=Sign in');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
  await p.waitForSelector('a:has-text("prodpg")'); await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Data protection');

  // 1. restore wizard: choices survive a tab switch
  await tab('Protection', 'Restore'); await p.click('button.choice:has-text("I need a database")');
  await p.click('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button:has-text("Next")'); await p.waitForSelector('text=To which point in time?');
  await p.click('label.opt:has-text("A specific point in time") input'); await p.click('button:has-text("4 hours ago")'); const when = await p.locator('input[type=datetime-local]').inputValue();
  await tab('Protection', 'Backup'); await p.waitForSelector('text=Run a backup');
  await tab('Protection', 'Restore'); await p.waitForSelector('text=To which point in time?', { timeout: 5000 });
  assert.equal(await p.locator('input[type=datetime-local]').inputValue(), when, 'the chosen time is still there');
  assert(await p.locator('.rsum:has-text("appdb")').count() === 1, 'the chosen database is still there');
  // 2. from the check step open a general setting, then Back: same step, same name, details still open
  await p.click('button:has-text("Next")'); await p.waitForSelector('text=Review and confirm');
  await p.click('label.opt:has-text("Only a copy to check") input');          // the end chosen here must survive the round trip too
  await p.waitForSelector('text=/Ready to restore/'); await p.waitForSelector('.stale', { state: 'detached' });
  const nameIn = p.locator('.field:has-text("New database name") input'); await nameIn.fill('appdb_yesterday');
  await p.click('summary:has-text("Technical details")'); await p.click('button:has-text("General settings")'); await p.waitForSelector('h1:has-text("Storage & recovery")');
  await p.goBack(); await p.waitForSelector('text=Review and confirm', { timeout: 5000 });
  assert.equal(await nameIn.inputValue(), 'appdb_yesterday', 'the typed name survived the round trip');
  assert(await p.locator('label.opt.on:has-text("Only a copy to check")').count() === 1, 'the chosen end survived the round trip');
  await p.waitForSelector('details summary:has-text("Technical details")', { timeout: 8000 }).catch(() => null);   // the plan is checked again after the round trip
  { const open = await p.evaluate(() => [...document.querySelectorAll('details')].map(d => `${d.open ? 'OPEN' : 'closed'}:${d.querySelector('summary')?.textContent}`));
    assert(await p.locator('details[open] summary:has-text("Technical details")').count() === 1, 'technical details still open: ' + JSON.stringify(open)); }
  await shot('f1-restore-back');
  // 3. the area pills remember the sub-tab: Protezione > Ripristino, go to Stato, back to Protezione = Ripristino
  await p.click('.gnav >> role=tab[name="Status"]'); await p.click('.gnav >> role=tab[name="Protection"]'); await p.waitForSelector('text=Review and confirm', { timeout: 5000 });
  // 4. a parameter being typed survives leaving the tab
  await tab('Maintenance', 'Parameters'); await p.fill('input[list=pgparams]', 'work_mem'); await p.fill('input[placeholder="64MB"]', '128MB');
  await tab('Status'); await tab('Maintenance', 'Parameters');
  assert.equal(await p.locator('input[placeholder="64MB"]').inputValue(), '128MB', 'parameter value kept');
  // 5. pg_hba: a rule half-typed in the add form AND a rule added but not applied both survive leaving the tab
  await tab('Access', 'HBA'); await p.waitForSelector('text=Rules managed by the console', { timeout: 15000 });
  await p.click('button:has-text("Add a rule")'); await p.fill('input[list=hba-users]', 'reporting'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.1.2.0/24');
  await p.click('button:has-text("Add to the list")'); await p.waitForSelector('text=You have unapplied changes');
  await p.click('button:has-text("Add a rule")').catch(() => {}); await p.fill('input[list=hba-users]', 'halfway');
  await tab('Status'); await tab('Access', 'HBA'); await p.waitForSelector('text=You have unapplied changes', { timeout: 15000 });
  assert(await p.locator('td:has-text("from network 10.1.2.0/24")').count() >= 1, 'the added rule is still in the list');
  assert.equal(await p.locator('input[list=hba-users]').inputValue(), 'halfway', 'the half-typed rule is still in the form'); await shot('f2-hba-kept');
  await p.click('button:has-text("Discard changes")'); await p.waitForSelector('text=No changes compared');
  // 6. a modal with typed data does not vanish on a stray click outside; Esc asks; X closes
  await p.goto(base + '/#/'); await p.click('tr:has-text("prodpg") button:has-text("Organize")'); await p.fill('.modal input[list]', 'new/folder');
  await p.mouse.click(5, 5); await p.waitForSelector('.modal-ask'); assert(await p.locator('.modal input[list]').inputValue() === 'new/folder', 'typed data still there');
  await p.click('.modal-ask button:has-text("Keep editing")'); await p.keyboard.press('Escape'); await p.waitForSelector('.modal-ask'); await shot('f3-modal-ask');
  await p.click('.modal-ask button:has-text("Close")'); await p.waitForSelector('.modal', { state: 'detached' });
  // ...and a modal without changes closes on a click outside as before
  await p.click('tr:has-text("prodpg") button:has-text("Organize")'); await p.mouse.click(5, 5); await p.waitForSelector('.modal', { state: 'detached' });
  // 7. Back restores the scroll position of a long page
  await p.goto(base + '/#/history'); await p.waitForTimeout(800);
  const pg = p.locator('main.page'); await pg.evaluate(e => e.scrollTo({ top: 400 })); await p.waitForTimeout(200); const y = await pg.evaluate(e => e.scrollTop);
  await p.click('.navbtn:has-text("Today")'); await p.waitForTimeout(300); await p.goBack(); await p.waitForTimeout(600);
  if (y > 0) assert(Math.abs((await pg.evaluate(e => e.scrollTop)) - y) < 30, `scroll position restored (${y})`);
  // 8. logout forgets every draft (another person may sign in on this browser)
  await p.goto(base + '/#/'); await p.click('button[aria-label="Sign out"]'); await p.waitForSelector('text=Sign in');
  await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]'); await p.waitForSelector('a:has-text("prodpg")');
  await p.click('a:has-text("prodpg")'); await tab('Maintenance', 'Parameters');
  assert.equal(await p.locator('input[placeholder="64MB"]').inputValue(), '', 'drafts cleared at logout');
  const left = await p.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('pgarca.draft.') && /128MB|appdb_yesterday|reporting/.test(sessionStorage.getItem(k) || ''))); assert.deepEqual(left, [], 'nothing typed before the logout is left in sessionStorage: ' + JSON.stringify(left));
  if (errs.length) throw new Error(errs.join('\n'));
  console.log('fluidity OK'); await b.close();
})().catch(async e => { console.error('FAIL', e.message); try { await global.__p.screenshot({ path: `${out}/fail.png` }); } catch { /* */ } process.exit(1); });
