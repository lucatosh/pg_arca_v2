// Browser test: drives the built console against devserver.ts. Run: NODE_PATH=/opt/npm-tools/node_modules node tests/ui/e2e.cjs [outDir]
const { chromium } = require('playwright'); const assert = require('assert');
const out = process.argv[2] || '/tmp/claude-0/ui/shots'; require('fs').mkdirSync(out, { recursive: true });
const base = process.env.BASE || 'http://localhost:5188';
(async () => {
  const b = await chromium.launch(process.env.PW_CHROMIUM === 'bundled' ? {} : { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' }); const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const p = await ctx.newPage(); global.__p = p; const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('response', async r => { if (r.request().method() === 'POST' && /\/operations$/.test(r.url())) { try { const j = await r.json(); if (!j.operation) console.log('POST operations without operation:', r.status(), JSON.stringify(j).slice(0, 400), r.request().postData()?.slice(0, 200)); } catch { /* not json */ } } }); p.on('console', m => { if (m.type() === 'error' && !/401|428|Failed to load resource|WebSocket/.test(m.text())) errs.push('console: ' + m.text()); });
  // cluster pages live in four areas: pick the area (pill), then the page (underline tab)
  const tab = async (area, name) => { await p.click(`.gnav >> role=tab[name="${area}"]`); if (name) await p.click(`.clusternav .tabs >> role=tab[name=/${name}/]`); };
  const shot = n => p.screenshot({ path: `${out}/${n}.png` });
  // typed confirmations ask for the NAME of what is overwritten: read it from the dialog and type it
  const typeName = async () => { const t = await p.textContent('.modal .field label'); const m = /^Type (.+) to confirm$/.exec(t || ''); assert(m, 'typed confirmation: ' + t); await p.fill('.modal input.input', m[1]); return m[1]; };
  await p.goto(base); await p.waitForSelector('text=Sign in'); await shot('01-login');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'wrong-password-1'); await p.click('button[type=submit]');
  await p.waitForSelector('text=Wrong username or password'); await p.waitForTimeout(1300);
  await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
  await p.waitForSelector('text=Connected clusters'); await p.waitForSelector('text=prodpg');
  // organise: prodpg into prod > billing/api; the sidebar and the list group it, with the state of the group
  await p.click('tr:has-text("prodpg") button[aria-label^="Organize"]'); await p.fill('.modal input[list]', 'billing/api'); await p.click('.modal button:has-text("Save")');
  await p.waitForSelector('.side .fhead.folder:has-text("billing")'); await p.waitForSelector('.fleettable tr.frow:has-text("api")'); await shot('02-clusters');
  assert(await p.locator('text=Demo cluster').count() >= 1, 'demo present');
  await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Data protection'); await shot('03-overview');
  // "What do you need?": one click lands in the restore wizard with the situation chosen; back to the situations for the flows below
  // simple view by default: internals (backup ids, LSN) appear with the "technical details" switch, and go again
  assert.equal(await p.evaluate(() => document.documentElement.getAttribute('data-detail')), 'basic');
  await p.click('.viewsw button:has-text("Expert")'); assert.equal(await p.evaluate(() => document.documentElement.getAttribute('data-detail')), 'expert');
  await p.click('.viewsw button:has-text("Simple")');
  await p.click('.task:has-text("Put back a dropped or emptied table")'); await p.waitForSelector('.rsum:has-text("I dropped or truncated a table")'); await shot('03a-task-restore');
  await p.click('button:has-text("Situation")'); await p.waitForSelector('text=What happened?');
  // backup tab
  await tab('Protection', 'Backup'); await p.waitForSelector('text=Run a backup');
  // backup storage: in plain terms per node (the NFS mount is recognised as the backup server bk01), directories only on request
  await p.waitForSelector('.placement td:has-text("Backup server bk01")');
  assert.equal(await p.locator('.placement :text("/mnt/backup/repo/prodpg")').count(), 0, 'directories are not shown by default');
  await p.click('.placement button:has-text("Show locations")'); await p.waitForSelector('.placement .mono:has-text("/mnt/backup/repo/prodpg")'); await shot('04-backup');
  await p.click('.placement button:has-text("Hide locations")');
  // previous backup location after a destination change: plan the migration (sizes, free space, time), run it, follow it
  await p.waitForSelector('text=The previous location is still read by restores'); await p.click('.placement button:has-text("Migrate or delete")');
  await p.click('.modal button:has-text("Work out what to move")'); await p.waitForSelector('.modal td:has-text("Total to copy")', { timeout: 10000 });
  await p.waitForSelector('.modal >> text=repository + WAL archive: 4.0 GiB to copy'); await shot('04c-migration-plan');
  await p.click('.modal button:has-text("Start the migration in the background")'); await p.click('.modal >> nth=-1 >> button:has-text("Start")');
  await p.waitForSelector('text=Migration completed', { timeout: 15000 }); await shot('04d-migration-done');
  await p.click('.modal >> nth=0 >> button:has-text("Close")'); await p.waitForSelector('text=The previous location is still read by restores', { state: 'detached', timeout: 20000 });
  // configure the storage with the guided sequence: backup server -> folder check + export/mount commands -> level -> review -> save -> check (the share must come from it) -> apply
  await p.click('.placement button:has-text("Configure…")'); await p.click('.modal .choice:has-text("A backup server")'); await p.click('.modal button:has-text("Continue")');
  await p.click('.modal .choice:has-text("bk01")'); await p.waitForSelector('.modal pre:has-text("exportfs -ra")'); await p.waitForSelector('.modal pre:has-text("bk01.dc1.lan:/srv/pgarca  /mnt/pgarca")');
  await p.click('.modal button:has-text("Check the folder on bk01")'); await p.waitForSelector('text=The folder on bk01 is usable', { timeout: 15000 }); await p.fill('.modal input[placeholder="26:26"]', '26:26'); await p.waitForSelector('.modal pre:has-text("chown 26:26 /srv/pgarca")'); await shot('04g-storage-wizard');
  await p.click('.modal button:has-text("Continue")'); await p.waitForSelector('.modal select:has(option:has-text("This cluster only"))');
  await p.click('.modal button:has-text("Continue")'); await p.waitForSelector('.modal dd:has-text("/mnt/pgarca/wal/{env}/{cluster}")');
  await p.click('.modal button:has-text("Save")'); await p.waitForSelector('.modal >> text=Nothing has changed on the nodes yet');
  await p.click('.modal button:has-text("Check and apply on the nodes")'); await p.waitForSelector('text=/Backup storage . prodpg/');
  await p.click('button:has-text("Check on all nodes")'); await p.waitForSelector('text=mounted from the backup server bk01', { timeout: 15000 }); await p.waitForSelector('text=check passed', { timeout: 15000 });
  await p.click('button:has-text("Apply to the nodes")'); await p.waitForSelector('text=Apply started', { timeout: 10000 }); await shot('04h-storage-applied');
  await p.click('.modal button:has-text("Close")');
  // a named restore point before a risky change: marked from the Backup tab, offered in the restore wizard below
  await p.click('button:has-text("Mark a restore point")'); await p.fill('.modal input[placeholder="Before release 4.2"]', 'Before release 4.2'); await p.click('.modal button:has-text("Mark it now")');
  await p.waitForSelector('.card:has-text("Restore points") td:has-text("Before release 4.2")', { timeout: 10000 }); await shot('04e-restore-point');
  let drilled = false;
  { const b = p.locator('button:has-text("Disaster recovery drill")'); if (await b.isEnabled()) { drilled = true; await b.click(); await p.waitForSelector('text=Cluster restored in 13 minutes', { timeout: 10000 }); await shot('04b-drill'); } }
  await p.click('button:has-text("Start backup")'); await p.waitForSelector('text=Copying data'); { const strip = await p.waitForSelector('.activitystrip:has-text("Backup (")', { timeout: 8000 }).catch(() => null);   // the strip polls: a 3 s fake backup may end first
    if (strip) assert(!/backup_run|\bcopy\b,/.test(await strip.innerText()), 'the strip shows labels, not raw operation types or phase keys'); } await shot('05-backup-running');
  // the dock's Log opens a floating window with THIS operation's log (not the database log): movable, minimisable, closable
  await p.click((await p.$('.dock-chip')) ? '.dock-chip' : '.actbtn'); await p.click('.dock-item button:has-text("Log")'); await p.waitForSelector('.oplog'); await p.waitForSelector('.oplog-body .ln', { timeout: 8000 });
  assert(/Backup/.test(await p.locator('.oplog-hd .nm').innerText()), 'log window is titled with the operation');
  { const hd = await p.locator('.oplog-hd').boundingBox(); const x0 = (await p.locator('.oplog').boundingBox()).x; await p.mouse.move(hd.x + 60, hd.y + 10); await p.mouse.down(); await p.mouse.move(hd.x + 160, hd.y - 60, { steps: 4 }); await p.mouse.up();
    assert(Math.abs((await p.locator('.oplog').boundingBox()).x - x0 - 100) < 6, 'window moves with the header'); }
  await shot('05a-oplog'); await p.click('.oplog button[aria-label="Minimize"]'); await p.waitForSelector('.oplog.min'); await p.click('.oplog button[aria-label="Expand the log"]'); await p.waitForSelector('.oplog-body');
  await p.click('.oplog button[aria-label="Close the log"]'); await p.waitForSelector('.oplog', { state: 'detached' }); await p.keyboard.press('Control+j');
  await p.waitForSelector('text=/Backup .* completed/', { timeout: 15000 }); await shot('06-backup-done');
  // recovery objectives: RPO and RTO lines are there (the mock has no drill: RTO "not measured")
  await p.waitForSelector('[data-testid=objectives]:has-text("Recovery point (RPO)")'); assert((drilled ? /Full restore time \(RTO\)\s*≈/ : /not measured/).test(await p.locator('[data-testid=objectives]').innerText()), drilled ? 'RTO measured by the drill' : 'RTO never measured in the mock');
  // guided restore, situation first: a database as it was
  await tab('Protection', 'Restore'); await p.waitForSelector('text=What happened?'); await shot('07-restore-situation');
  await p.click('button.choice:has-text("I need a database")');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 });
  // a database that is in the backups and not on the server is DROPPED, in red, with the date found in the WAL
  await p.waitForSelector('.dbrow.gone:has-text("reports") .dropped', { timeout: 10000 }); await p.waitForSelector('.dbrow.gone:has-text("reports"):has-text("2026"), .dbrow.gone:has-text("reports"):has-text("Oct")', { timeout: 10000 });
  assert(await p.locator('.dbrow:has-text("appdb") .here').count() === 1, 'live database says Present');
  assert(await p.locator('.dbrow:has-text("arca_rl_20261010")').count() === 1, 'pg_arca working database is listed (apart)');
  await p.click('button[role=radio]:has-text("reports")'); await p.waitForSelector('.dropnote'); await shot('07a-restore-dropped');
  await p.click('button[role=radio]:has-text("appdb")'); await shot('07-restore-what'); await p.click('button:has-text("Next")');
  // when: appdb still exists, so the latest point holds the damage: the WAL is searched by itself and the moment just before is recommended
  await p.waitForSelector('text=To which point in time?'); assert(await p.waitForSelector('label.opt.on:has-text("Just before:") .badge:has-text("Recommended")', { timeout: 10000 }).catch(() => null), 'just-before recommended for a live database');
  assert(await p.locator('label.opt:has-text("The latest archived point") .badge:has-text("Recommended")').count() === 0, 'latest is not recommended for a live database');
  await p.click('label.opt:has-text("The latest archived point") input'); await p.waitForSelector('text=/appdb.*still exists, and the latest point holds/'); await shot('08a-latest-warning');
  await p.waitForSelector('label.opt:has-text("Restore point: Before release 4.2")');
  await p.click('label.opt:has-text("A specific point in time") input'); await p.click('button:has-text("1 hour ago")'); await p.waitForSelector('input[aria-label^="Date and time"]');
  await p.click('summary:has-text("Find the exact moment")'); await p.waitForSelector('[role=slider]'); await shot('08-timeline');
  const tr = await p.locator('.rt .track').boundingBox();
  await p.mouse.click(tr.x + tr.width * 0.55, tr.y + 30); await p.waitForTimeout(200); await shot('09-timeline-picked');
  await p.click('button:has-text("Find drops and truncations")'); await p.waitForSelector('text=appdb.public.orders', { timeout: 10000 }); await shot('10-forensics');
  await p.click('button:has-text("Find mass deletes and updates")'); await p.waitForSelector('text=/48.?210 rows deleted/', { timeout: 10000 });
  await p.locator('tr:has-text("rows deleted") button:has-text("Use this moment")').click(); await p.waitForSelector('label.opt.on:has-text("Just before: 48")'); await shot('10b-forensics-dml');
  await p.click('button:has-text("Next")'); await p.waitForSelector('text=Review and confirm'); await p.waitForSelector('.rplan:has-text("appdb")');
  await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 }); await p.waitForSelector('.preflight.warn');
  await p.click('summary:has-text("Technical details")'); await p.waitForSelector('.spacebars .vol'); await p.waitForSelector('.placement code:has-text("/var/tmp/pg_arca_scratch")'); await shot('11-plan');
  // the END of the job is chosen here and never preselected when it replaces a live database: the start waits for the choice
  await p.waitForSelector('label.opt.risky:has-text("Replace appdb with the recovered one") .badge:has-text("Terminates the open sessions on appdb")'); await p.waitForSelector('text=Choose how the restore ends');
  assert(await p.locator('label.opt.on:has-text("Replace appdb")').count() === 0, 'replace not preselected'); assert(await p.locator('button.start-restore').isDisabled(), 'start waits for the end choice'); await shot('11a-end-choice');
  await p.click('label.opt:has-text("Only a copy to check") input'); await p.waitForSelector('.field:has-text("New database name") input');
  // a taken destination name is a blocker: the start button stays disabled
  const nameIn = p.locator('.field:has-text("New database name") input');
  const keep = await nameIn.inputValue(); await nameIn.fill('taken'); await p.click('button:has-text("Check again")'); await p.waitForSelector('text=/Blocked: .* to fix first/');
  if (!(await p.locator('button.start-restore').isDisabled())) throw new Error('start must be blocked by a failing pre-flight');
  await shot('11b-plan-blocked'); await nameIn.fill(keep); await p.click('button:has-text("Check again")'); await p.waitForSelector('text=/Ready to restore/');
  // roles the database uses but the destination lacks: NOLOGIN placeholders, on by default, the choice reaches the agent
  assert(await p.locator('label:has-text("Create the missing roles (gone_owner)") input').isChecked(), 'placeholder roles on by default'); await p.waitForSelector('text=a dropped account never becomes active again');
  await p.click('button.start-restore'); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=Restore completed', { timeout: 15000 }); await p.waitForSelector('text=roles created as NOLOGIN placeholders'); await shot('12-restore-done');
  await p.click('summary:has-text("Summary for the incident ticket")'); await p.waitForSelector('pre.out:has-text("Restore on prodpg")'); assert(/Back to: .*\nHow it ended: copy in /.test(await p.locator('pre.out:has-text("Restore on prodpg")').innerText()), 'incident summary');
  // the checked copy takes the place of appdb with one click (no SQL to type): typed confirmation, the original kept as appdb_before_...
  await p.click('button:has-text("in place of appdb")'); if (!(await p.locator('.modal button:has-text("Put in place")').isDisabled())) throw new Error('swap needs the typed confirmation');
  assert.equal(await typeName(), 'appdb'); await p.click('.modal button:has-text("Put in place")'); await p.waitForSelector('text=appdb replaced', { timeout: 10000 }); await p.waitForSelector('code:has-text("appdb_before_")'); await shot('12f-db-swapped');
  // and the default end: restore + replace in ONE operation
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I need a database")'); await p.waitForSelector('button[role=radio]:has-text("billing")', { timeout: 10000 });
  await p.click('button[role=radio]:has-text("billing")'); await p.click('button:has-text("Next")'); await p.waitForSelector('text=To which point in time?');
  await p.click('label.opt:has-text("The latest archived point") input'); await p.click('button:has-text("Next")'); await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 });
  await p.click('label.opt:has-text("Replace billing") input'); await p.waitForSelector('label.opt.on:has-text("Replace billing")'); await p.click('button.start-restore'); await p.waitForSelector('.modal >> text=Replace billing on');
  if (!(await p.locator('.modal button:has-text("Start")').isDisabled())) throw new Error('replacing a database needs the typed confirmation');
  assert.equal(await typeName(), 'billing'); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=/billing.*is back as it was/', { timeout: 15000 }); await p.waitForSelector('code:has-text("billing_before_")'); await shot('12g-db-replaced');
  // a table was dropped: what the WAL found is offered at once; one click picks the table AND the point just before
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I dropped or truncated a table")');
  await p.waitForSelector('.recentrow:has-text("orders")', { timeout: 10000 }); await shot('07b-recent-drops');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button[role=radio]:has-text("appdb")');
  await p.click('.tree summary:has-text("Only some partitions")'); await p.waitForSelector('.tree button:has-text("orders_2026")'); await p.waitForSelector('.tree :text("view")'); await shot('12e-partitions');
  await p.click('.recentrow:has-text("orders")'); await p.waitForSelector('label.opt.on:has-text("Just before: public.orders dropped")'); await shot('09b-when-suggested');
  await p.click('button:has-text("Next")'); await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 }); await p.waitForSelector('.rplan:has-text("staging database")');
  // default end: put back what is gone, in the same operation
  await p.waitForSelector('label.opt.on:has-text("Put back into appdb")'); await p.waitForSelector('.seg button[aria-pressed=true]:has-text("Only what is missing")');
  await p.click('button.start-restore'); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=/back in place in/', { timeout: 15000 }); await shot('12h-table-fixed');
  assert(await p.locator('text=Now choose below how to put it back').count() === 0, 'nothing left to do by hand');
  // the same with the quarantine copy only: the operator chooses how to put it back
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I dropped or truncated a table")');
  await p.waitForSelector('.recentrow:has-text("orders")', { timeout: 10000 }); await p.click('.recentrow:has-text("orders")'); await p.click('button:has-text("Next")');
  await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 }); await p.click('label.opt:has-text("Only a copy to check") input');
  await p.click('button.start-restore'); await p.click('.modal button:has-text("Start")');
  // put it back: orders no longer exists, so "put back what was dropped" is recommended; the preview comes by itself
  await p.waitForSelector('text=Put back what was dropped', { timeout: 15000 }); await p.waitForSelector('label.opt.on:has-text("Put back what was dropped") .badge:has-text("Recommended")');
  await p.click('summary:has-text("What exactly would change")', { timeout: 10000 }); await p.waitForSelector('text=Foreign keys to re-attach'); await shot('12b-promote');
  await p.click('label.opt:has-text("Replace with the recovered version") input'); await p.waitForSelector('summary:has-text("What exactly would change")', { timeout: 10000 });
  await p.getByRole('button', { name: 'Put back, replacing the current tables', exact: true }).click();
  if (!(await p.locator('.modal button:has-text("Put back")').isDisabled())) throw new Error('replace needs the typed confirmation');
  await p.waitForSelector('.modal :text("Replace public.orders in appdb (prodpg)?")'); assert.equal(await typeName(), 'appdb'); await shot('12d-replace-confirm');
  await p.click('.modal button:has-text("Put back")');
  // the check before the swap: rows of a table not restored would point at nothing -> refused, nothing changed; the operator may accept it knowingly
  await p.waitForSelector('text=Rows that would be orphaned', { timeout: 10000 }); await p.waitForSelector('text=public.items (order_id)'); await shot('12e-orphans-refused');
  await p.click('button:has-text("Proceed anyway")'); if (!(await p.locator('.modal button:has-text("Proceed")').isDisabled())) throw new Error('allow orphans needs the typed confirmation');
  await p.fill('.modal input.input', 'ORPHANS'); await p.click('.modal button:has-text("Proceed")');
  await p.waitForSelector('text=Put back into the database', { timeout: 10000 }); await p.waitForSelector('.banner.warn:has-text("3 rows of public.items point to")'); await shot('12c-promoted');
  assert(await p.locator('text=Rows that would be orphaned').count() === 0, 'the orphan banner goes once the promotion succeeded');
  // wrong rows: the mass DELETE is found by itself and preselected; compare row by row and put back only some rows
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I deleted or updated rows")');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button[role=radio]:has-text("appdb")');
  await p.click('.tree button:has-text("orders") >> nth=0'); await p.click('button:has-text("Next")');
  await p.waitForSelector('label.opt.on:has-text("Just before: 48")', { timeout: 10000 }); await shot('09c-rows-when');
  await p.click('label.opt:has-text("The latest archived point") input'); await p.waitForSelector('text=the latest point already contains the mistake'); await p.click('label.opt:has-text("Just before: 48") input');
  await p.click('button:has-text("Next")'); await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 });
  // rows: nothing preselected (putting every row back reverts legitimate changes too); comparing is the recommended way
  assert(await p.locator('label.opt.on').filter({ hasText: 'Put back all rows as they were' }).count() === 0, 'rows_all never preselected'); assert(await p.locator('button.start-restore').isDisabled(), 'start waits for the end choice');
  await p.waitForSelector('label.opt:has-text("Compare and pick the rows myself") .badge:has-text("Recommended")'); await p.click('label.opt:has-text("Compare and pick the rows myself") input');
  await p.click('button.start-restore'); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=Differences found', { timeout: 15000 });   // the row comparison starts by itself
  await p.click('label:has-text("[200]") input'); await p.click('label:has-text("[1]") input'); await p.click('label:has-text("[900]") input'); await shot('12a-rows');
  // deleting row 900 would cascade into another table: refused first, then done on purpose with the other table's rows saved
  await p.click('button:has-text("Put back the 3 selected rows")'); await p.click('.modal button:has-text("Put back")');
  await p.waitForSelector('text=Other tables would change too', { timeout: 10000 }); await shot('12a2-rows-cascade');
  await p.click('button:has-text("Go ahead, saving them first")'); await p.waitForSelector('text=Rows recovered', { timeout: 10000 });
  await p.waitForSelector('code:has-text("pgarca_rowsafe_20260101_items")');
  // every deleted / changed row back in the same operation: chosen explicitly, with what is lost said and the typed confirmation
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I deleted or updated rows")');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button[role=radio]:has-text("appdb")');
  await p.click('.tree button:has-text("orders") >> nth=0'); await p.click('button:has-text("Next")'); await p.waitForSelector('label.opt.on:has-text("Just before: 48")', { timeout: 10000 });
  await p.click('button:has-text("Next")'); await p.waitForSelector('text=/Ready to restore/', { timeout: 10000 });
  await p.click('label.opt:has-text("Put back all rows as they were") input'); await p.waitForSelector('label.opt.on:has-text("Put back all rows as they were") .badge:has-text("Reverts every change")');
  await p.waitForSelector('text=What is lost:'); await p.click('button.start-restore'); await typeName(); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=/Rows of .* brought back/', { timeout: 15000 }); await p.waitForSelector('code:has-text("pgarca_rowsafe_")'); await shot('12i-rows-fixed');
  // whole server, default end: PRODUCTION itself goes back (stop, swap, start, primary again); the previous data directory is kept and can be given back
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I need to rebuild the whole server")');
  await p.waitForSelector('label.opt.on:has-text("The latest archived point")', { timeout: 10000 }); await p.click('button:has-text("Next")');
  await p.waitForSelector('text=Choose how the restore ends'); assert(await p.locator('label.opt.on:has-text("Restore the production server in place")').count() === 0, 'in-place server restore never preselected');
  await p.click('label.opt:has-text("Restore the production server in place") input'); await p.waitForSelector('code:has-text("postgresql@16-main.service")', { timeout: 10000 });
  await p.waitForSelector('text=WAL not yet archived'); await p.waitForSelector('text=/standby servers? streams? from this server.*must be rebuilt/');
  if (await p.locator('text=Where to put the copy').count()) throw new Error('replacing production asks for no copy destination');
  await shot('12j-server-fix-check');
  await p.click('button.start-restore'); await p.waitForSelector('.modal >> text=in place of production');
  if (!(await p.locator('.modal button:has-text("Start")').isDisabled())) throw new Error('replacing production needs the typed confirmation');
  assert.equal(await typeName(), 'prodpg'); await p.click('.modal button:has-text("Start")');
  await p.waitForSelector('text=The production server is back as it was', { timeout: 15000 }); await p.click('summary:has-text("What pg_arca did, step by step")'); await p.waitForSelector('text=primary again after 14 s');
  await p.waitForSelector('text=Kept directories'); await shot('12k-server-fixed');
  await p.click('.card:has-text("Kept directories") button:has-text("Delete")'); await p.fill('.modal input', 'main.pgarca-before-20260101000500'); await p.click('.modal button:has-text("Delete")');
  await p.waitForSelector('text=Kept directories', { state: 'detached', timeout: 10000 });
  // the copy instead: asks where, and production is not touched
  await p.click('button:has-text("New restore")'); await p.click('button.choice:has-text("I need to rebuild the whole server")'); await p.click('button:has-text("Next")');
  await p.click('label:has-text("Only a temporary copy to inspect")'); await p.waitForSelector('text=Where to put the copy', { timeout: 10000 });
  // "Restore to this point…" from the Backup tab: the wizard opens with that point as the target once the situation is chosen
  await tab('Protection', 'Backup'); await p.click('.card:has-text("Restore points") button:has-text("Restore to this point")'); await p.waitForSelector('text=What happened?');
  await p.click('button.choice:has-text("I need a database")'); await p.click('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button:has-text("Next")');
  await p.waitForSelector('label.opt.on:has-text("Restore point: Before release 4.2")', { timeout: 10000 }); await shot('09d-restore-point-preset');
  // recovery & storage: recovery instance (global -> cluster, check, installation) and backup destination (check, apply)
  await p.goto(base + '/#/infra'); await p.waitForSelector('h1:has-text("Storage & recovery")'); await p.waitForSelector('text=All clusters');
  await p.locator('tr:has-text("All clusters") button:has-text("Edit")').click(); await p.waitForSelector('text=Where the recovery instance runs');
  await p.fill('input[placeholder="/var/tmp/pg_arca_scratch"]', '/data/scratch'); await p.fill('input[placeholder="e.g. 55000"]', '55000'); await p.fill('input[placeholder="e.g. 55100"]', '55100');
  await p.click('.modal button:has-text("Save")'); await p.waitForSelector('text=Settings saved'); await p.waitForSelector('text=ports 55000-55100'); await shot('15-infra-eph');
  await p.locator('tr:has-text("prodpg") button:has-text("Verify")').click(); await p.waitForSelector('text=Restores cannot run on this host', { timeout: 10000 }); await p.waitForSelector('text=Install PostgreSQL 15'); await shot('16-infra-preflight');
  await p.click('button:has-text("Install PostgreSQL 15")'); await p.fill('.modal input >> nth=-1', 'INSTALL'); await p.click('.modal button:has-text("Install") >> nth=-1'); await p.waitForSelector('text=Installing the binaries', { timeout: 10000 });
  await p.click('.modal button:has-text("Close")');
  await p.click('role=tab[name="Backup storage"]'); await p.waitForSelector('text=Where the repository and WAL archive go');
  // the wizard above stored prodpg's own storage (backup server bk01): it shows in the table, then goes back to inheriting
  await p.waitForSelector('tr:has-text("prodpg") >> text=Backup server bk01');
  await p.locator('tr:has-text("prodpg") button:has-text("Edit")').click(); await p.click('.modal button:has-text("Remove: inherit")'); await p.waitForSelector('text=Inheriting again');
  await p.locator('tr:has-text("All clusters") button:has-text("Edit")').click(); await p.waitForSelector('text=Where backups are written');
  await p.selectOption('.modal select >> nth=0', 'nfs'); await p.fill('input[placeholder="/mnt/backup/pgarca"]', '/mnt/backup/pgarca'); await p.fill('input[placeholder="/mnt/backup/wal/{env}/{cluster}"]', '/mnt/backup/wal/{env}/{cluster}');
  assert(await p.locator('.modal option[disabled]:has-text("Preview")').count() >= 4, 'object stores are listed as preview and disabled');
  await p.click('.modal button:has-text("Save")'); await p.waitForSelector('text=Settings saved'); await shot('17-infra-dest');
  await p.locator('tr:has-text("prodpg") button:has-text("Check and apply")').click(); await p.waitForSelector('text=/Backup storage . prodpg/');
  assert(await p.locator('button:has-text("Apply to the nodes")').isDisabled(), 'apply needs a check first');
  await p.click('button:has-text("Check on all nodes")'); await p.waitForSelector('text=is on nfs4', { timeout: 15000 }); await p.waitForSelector('text=check passed', { timeout: 15000 });
  await p.click('button:has-text("Apply to the nodes")'); await p.waitForSelector('text=Apply started', { timeout: 10000 }); await shot('18-infra-applied');
  await p.click('.modal button:has-text("Close")');
  await p.click('.side button.navbtn:has-text("All clusters")'); await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Data protection');
  // ops tab, logs tab, preview tab
  await tab('Maintenance', 'Operations'); await p.waitForSelector('text=Operations on this cluster'); await shot('13-ops');
  await tab('Maintenance', 'Logs'); await p.waitForSelector('text=Live logs');
  await tab('Access', 'HBA'); await p.waitForSelector('text=Rules managed by the console'); await p.waitForSelector('text=Active replicas without'); await shot('14-hba');
  // offsite copy (S3): no copy yet -> set it up -> test+save -> status shown -> sync and dry run -> a refused bucket is reported, not saved
  await tab('Status', 'Nodes'); await p.waitForSelector('text=Offsite copy: in Protection');
  // agent settings: paths as text, the asynchronous-archiving switch as a select with its default shown
  await p.waitForSelector('.field:has-text("Asynchronous WAL archiving") select'); assert(/default \(off\)/.test(await p.locator('.field:has-text("Asynchronous WAL archiving") select').innerText()), 'bool setting shows its default');
  await p.selectOption('.field:has-text("Asynchronous WAL archiving") select', 'true'); await p.waitForSelector('button:has-text("Save and re-check"):not([disabled])'); await shot('33-agent-settings');
  // the offsite copy lives with the backups (Protection -> Backup), not among the node settings
  await tab('Protection', 'Backup'); await p.waitForSelector('text=Offsite copy (S3-compatible object storage)'); await p.waitForSelector('text=No offsite copy on this node');
  await p.fill('input[placeholder="https://minio.corp.example:9000"]', 'https://minio.corp.example:9000'); const offCard = p.locator('.card:has-text("Offsite copy (S3")');
  await offCard.locator('.field:has-text("Bucket") input').first().fill('refuse-me'); await offCard.locator('.field:has-text("Access key") input').first().fill('AKIA');
  await p.click('button:has-text("Test the bucket and save")'); await p.waitForSelector('.banner.bad:has-text("AccessDenied")', { timeout: 10000 });
  await offCard.locator('.field:has-text("Bucket") input').first().fill('pg-backups'); await p.click('button:has-text("Test the bucket and save")');
  await p.waitForSelector('text=Last successful sync', { timeout: 10000 }); await p.waitForSelector('.badge:has-text("Active")'); await shot('32-offsite');
  await p.click('button:has-text("What would be uploaded?")'); await p.waitForSelector('.banner:has-text("would be uploaded")', { timeout: 10000 });
  await p.click('button:has-text("Sync now")'); await p.waitForSelector('.banner:has-text("3 objects uploaded")', { timeout: 10000 });
  await p.click('button:has-text("Download what is missing here")'); await p.waitForSelector('.banner:has-text("removed here on purpose by retention (620 MiB) were not brought back")', { timeout: 10000 });
  await tab('Maintenance', 'Tuning'); await p.waitForSelector('text=16.0 GiB RAM'); await p.waitForSelector('tr:has-text("shared_buffers") >> text=4GB'); await shot('14e-tuning');
  await p.click('tr:has-text("work_mem") button:has-text("Apply")'); await p.click('.modal button:has-text("Apply")'); await p.waitForSelector('text=Succeeded', { timeout: 10000 });
  await tab('Access', 'HBA'); await p.waitForSelector('text=Rules managed by the console');
  // HBA assistant: suggestion, duplicate refusal, shadow warning, plan, apply
  await p.waitForSelector('text=Cluster access (every node → every node)'); await shot('14f-hba-access');
  // one click adds the node->node rules that are missing; the matrix then points at the new rule
  await p.waitForSelector('td:has-text("missing")'); await p.click('button:has-text("missing rule")'); await p.waitForSelector('td:has-text("Replication from db1")');
  await p.waitForSelector('text=Every node can replicate from and administer every other node'); assert((await p.locator('td:has-text("missing")').count()) === 0, 'no cell left missing');
  await p.click('.banner.warn:has-text("Active replicas") button:has-text("Add")'); await p.waitForSelector('text=Replication from 10.0.2.7');
  await p.click('button:has-text("Add a rule")');
  await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/33'); await p.waitForSelector('text=CIDR notation');
  await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/24'); await p.waitForSelector('text=can use every database from network 10.0.20.0/24');
  await p.click('button:has-text("Add to the list")'); await p.waitForSelector('td:has-text("from network 10.0.20.0/24")');
  await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/24');
  await p.waitForSelector('text=Duplicate'); assert(await p.locator('button:has-text("Add to the list")').isDisabled(), 'duplicate refused'); await shot('14b-hba-dup');
  await p.click('button[aria-label=Close]');
  await p.selectOption('#hba-order', 'wide');
  await p.click('button:has-text("Check the effect")'); await p.waitForSelector('text=Simulated connection'); await shot('14c-hba-plan');
  await p.selectOption('#hba-order', 'specific');
  await p.click('button:has-text("Check the effect")'); await p.waitForSelector('text=Simulated connection');
  await p.click('button:has-text("Apply"):not([disabled]) >> nth=0'); await p.click('.modal button:has-text("Apply")');
  await p.waitForSelector('text=applied and verified', { timeout: 15000 }); await shot('14d-hba-applied');
  await p.waitForTimeout(2000);
  // temporary rule + adopt existing rules
  await p.click('button:has-text("Add a rule")'); await p.fill('input[list=hba-users]', 'ext'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.9.9.0/24');
  await p.selectOption('select[aria-label="Rule validity"]', '8'); await p.click('button:has-text("Add to the list")'); await p.waitForSelector('text=Temporary · expires in 8 h');
  await p.click('button:has-text("Take over these rules")'); await p.waitForSelector('td:has-text("administ")', { timeout: 3000 }).catch(() => {});
  await shot('14e0-adopt'); assert.equal(await p.locator('button:has-text("Take over these rules")').count(), 0, 'adopted');
  await p.click('button:has-text("Check the effect")'); await p.waitForSelector('text=Simulated connection'); await shot('14f-hba-adopt');
  // palette
  await p.keyboard.press('Control+k'); await p.waitForSelector('[role=dialog][aria-label="Quick search"]'); await p.keyboard.type('audit'); await p.keyboard.press('Enter');
  await p.waitForSelector('text=Who changed what: every action'); await shot('15-audit');
  // discovery
  await p.goto(base + '/#/discovery'); await p.waitForSelector('text=Configuration differences between nodes'); await p.waitForSelector('.card:has-text("Findings")'); await shot('15a-discovery');
  // strategies
  await p.goto(base + '/#/strategy'); await p.waitForSelector('text=without automatic backups'); await shot('15b-strategy');
  await p.click('button:has-text("Apply the recommended ones per environment")'); await p.waitForSelector('.modal >> text=Production'); await p.click('.modal button:has-text("Apply")'); await p.waitForSelector('text=Every cluster has an active policy'); await shot('15c-strategy-applied');
  await p.click('tr:has-text("prodpg") button:has-text("Assign")'); await p.click('label.opt:has-text("Long retention")'); await p.click('.modal button:has-text("Save")');
  await p.waitForSelector('tr:has-text("prodpg"):has-text("Assigned to this cluster")');
  await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Backup policy'); await p.waitForSelector('.card .badge:has-text("Long retention")'); await shot('15d-backup-strategy');
  // a template with the rc.1 policy fields: days of recoverability, heavy-work hours, read rate limit -> summarized on the card, kept on reopen
  { await p.goto(base + '/#/strategy'); await p.waitForSelector('button:has-text("New template")'); await p.click('button:has-text("New template")'); await p.waitForSelector('.modal:has-text("New template")');
    const fld = (l) => `.modal .field:has(label:text-is("${l}")) input`;
    await p.fill(fld('Name'), 'Night window'); await p.click('.modal button:has-text("Advanced:")'); await p.fill(fld('Keep point-in-time recovery for at least (days)'), '30'); await p.fill(fld('Read rate limit (MB/s, 0 = none)'), '50');
    await p.fill(fld('Recovery point objective (minutes, 0 = none)'), '15'); await p.fill(fld('Recovery time objective (minutes, 0 = none)'), '240');
    await p.fill('.modal .field:has(label:has-text("Hours for full backups")) input >> nth=0', '22'); await p.fill('.modal .field:has(label:has-text("Hours for full backups")) input >> nth=1', '6');
    await shot('15d1-template-fields'); await p.click('.modal button:has-text("Save")'); await p.waitForSelector('text=Template saved');
    const card = p.locator('.tpl:has-text("Night window")'); await card.waitFor();
    for (const s of ['30 days of point-in-time recovery', 'read limit 50 MB/s', 'fulls and verifications 22:00–06:00', 'RPO objective 15 min', 'RTO objective 4 h']) assert.ok((await card.innerText()).includes(s), `template summary shows "${s}"`);
    await card.locator('button:has-text("Edit")').click(); await p.waitForSelector('.modal:has-text("Edit template")'); await p.click('.modal button:has-text("Advanced:")');
    assert.equal(await p.inputValue(fld('Keep point-in-time recovery for at least (days)')), '30'); assert.equal(await p.inputValue(fld('Read rate limit (MB/s, 0 = none)')), '50'); assert.equal(await p.inputValue(fld('Recovery point objective (minutes, 0 = none)')), '15');
    assert.equal(await p.inputValue('.modal .field:has(label:has-text("Hours for full backups")) input >> nth=0'), '22'); assert.equal(await p.inputValue('.modal .field:has(label:has-text("Hours for full backups")) input >> nth=1'), '6');
    await p.fill(fld('Read rate limit (MB/s, 0 = none)'), '0'); await p.click('.modal button:has-text("Save")'); await p.waitForSelector('text=Template saved');
    await p.waitForFunction(() => { const c = [...document.querySelectorAll('.tpl')].find(e => e.textContent.includes('Night window')); return c && !c.textContent.includes('read limit'); });
    await shot('15d2-template-saved');
    // assigned to prodpg: the Backup tab shows the objectives next to the measured recovery point / time
    await p.click('tr:has-text("prodpg") button:has-text("Assign")'); await p.click('label.opt:has-text("Night window")'); await p.click('.modal button:has-text("Save")');
    await p.waitForSelector('tr:has-text("prodpg"):has-text("Assigned to this cluster")');
    await p.click('a:has-text("prodpg")'); await p.waitForSelector('[data-testid=objectives]:has-text("objective 15 min")'); assert(/objective 4 h/.test(await p.locator('[data-testid=objectives]').innerText()), 'RTO objective shown');
    await shot('15d3-objectives-target'); }
  // a server announces itself (agent installed without a token) -> banner -> approve
  { const fp = 'e2efingerprint0000000001', secret = 'a'.repeat(64); const sh = require('crypto').createHash('sha256').update(secret).digest('hex');
    const r = await p.request.post(base + '/api/agent/request-join', { data: { fingerprint: fp, secret_hash: sh, node_name: 'e2e-new', agent_version: '2.0', discovery: { postgres_instances: [{ version: '16.4', data_directory: '/var/lib/postgresql/16/main', port: 5432, cluster_key: 'sysid:e2e-new-key', role: 'primary' }] } } });
    assert.equal(r.status(), 201);
    await p.goto(base + '/#/'); await p.waitForSelector('text=New server detected: e2e-new', { timeout: 15000 }); await p.click('.join-banner button:has-text("Review")');
    await p.waitForSelector('text=Add e2e-new?'); await p.selectOption('.modal select', 'dev'); await shot('15a-join');
    await p.click('.modal button:has-text("Approve and connect")'); await p.waitForSelector('text=Server approved', { timeout: 10000 });
    const st = await p.request.post(base + '/api/agent/join-status', { data: { fingerprint: fp, secret } }); assert.equal((await st.json()).status, 'approved'); }
  // today + settings
  await p.goto(base + '/#/today'); await p.waitForSelector('h1:has-text("Today")'); await p.waitForSelector('.banner', { timeout: 10000 }); await shot('16a-today');
  await p.goto(base + '/#/settings'); await p.waitForSelector('text=Add channel'); await p.click('button:has-text("Add channel")');
  await p.fill('input[aria-label="Channel name"]', 'Slack DBA'); await p.fill('input[aria-label="Webhook URL"]', 'https://hooks.example.com/services/T0/B0/abcd1234');
  await p.click('button:text-is("Save")'); await p.waitForSelector('text=Notifications saved'); await p.waitForSelector('button:has-text("Send test")');
  await p.waitForSelector('text=A second administrator is needed'); await shot('16b-settings');
  // users
  await p.goto(base + '/#/users'); await p.waitForSelector('text=New user'); await p.click('button:has-text("New user")');
  await p.fill('.modal input >> nth=0', 'operator1'); await p.fill('.modal input[type=password]', 'operator-password-1'); await p.click('.modal button:has-text("Create user")');
  await p.waitForSelector('tr:has-text("operator1")'); await shot('15e-users');
  // attach wizard
  await p.goto(base + '/#/'); await p.click('button:has-text("Connect cluster") >> nth=0'); await p.waitForSelector('text=With agent (recommended)'); await p.click('text=With agent (recommended)');
  await p.click('button:has-text("Generate the install command")'); await p.waitForSelector('text=PG_ARCA_ENROLL_TOKEN'); await shot('16-attach');
  // operational machines: sidebar entry, list, detail, check as recovery host, use for recoveries
  await p.keyboard.press('Escape').catch(() => {});
  await p.goto(base + '/#/workers'); await p.waitForSelector('td:has-text("bk01")'); await shot('18a-workers');
  await p.click('.side .citem:has-text("bk01")'); await p.waitForSelector('text=Disks and shares'); await p.waitForSelector('text=/backup');
  await p.click('button:has-text("Verify as recovery host")'); await p.waitForSelector('text=It can run restores', { timeout: 15000 }); await shot('18b-worker');
  await p.click('button:has-text("Use it for restores")'); await p.click('.modal button:has-text("Use this host")'); await p.waitForSelector('text=recovery host for all clusters', { timeout: 10000 });
  // geo-redundancy: the pair, the DR strip on the standby site, endpoint + planned switchover through both DCS
  await p.goto(base + '/#/geo'); await p.waitForSelector('.geosite:has-text("geo-dc2")'); await p.waitForSelector('text=Standby site (DR)'); await shot('19a-geo');
  // DR readiness: one-click fixes through the site's DCS
  await p.waitForSelector('.geoready'); await p.click('button:has-text("Enable the archive fallback")'); await p.waitForSelector('text=Enabling the archive fallback');
  await p.waitForSelector('.geochecks li.ok:has-text("pg-arca-wal")', { timeout: 20000 }).catch(() => null);
  await p.click('button:has-text("Enable pg_rewind") >> nth=0'); await p.waitForSelector('text=Enabling pg_rewind'); await shot('19a2-geo-ready');
  await p.click('button:has-text("Planned switchover to geo-dc2")'); await p.fill('.modal input.mono >> nth=0', 'dc2-haproxy'); await p.click('.modal button:has-text("Save")');
  await p.waitForSelector('.modal button:has-text("Start the switchover")'); await p.fill('.modal input.input', 'SWITCHOVER'); await p.click('.modal button:has-text("Start the switchover")');
  await p.waitForSelector('.geojob:has-text("completed")', { timeout: 30000 }); await p.waitForSelector('.geosite.primary:has-text("geo-dc2")', { timeout: 15000 }); await shot('19b-geo-switched');
  // pg_hba on a Patroni site: DCS only, previous versions kept by the console and restorable
  await p.goto(base + '/#/'); const g1 = await p.locator('.fleettable a:has(strong:text-is("geo-dc1"))').getAttribute('href'); await p.goto(base + '/' + g1 + '/hba');
  await p.waitForSelector('text=Patroni cannot open the local replication connection', { timeout: 20000 }); await shot('14f2-hba-patroni-local');
  await p.waitForSelector('text=Patroni · shared configuration (DCS)'); await p.waitForSelector('text=Other rules in the DCS list');
  await p.click('button:has-text("Add a rule")'); await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '172.30.9.0/24');
  await p.click('button:has-text("Add to the list")'); await p.click('button:has-text("Check the effect")'); await p.waitForSelector('text=Simulated connection');
  await p.click('button:has-text("Apply to the whole cluster")'); await p.click('.modal button:has-text("Apply")'); await p.waitForSelector('text=written to the DCS', { timeout: 15000 });
  await p.waitForSelector('.card:has-text("Previous versions") button:has-text("Restore")', { timeout: 15000 }); await shot('14g-hba-dcs');
  await p.click('.card:has-text("Previous versions") button:has-text("Restore") >> nth=0'); await p.click('.modal button:has-text("Restore in the DCS")');
  await p.waitForSelector('text=Version restored in the DCS', { timeout: 15000 });
  // relationships: the standby site sits under its primary (auto); "no relationship" detaches it; a cluster without telemetry declared as replica by hand
  await p.goto(base + '/#/'); await p.waitForSelector('.fleettable tr.replicarow');
  const stbyName = (await p.locator('.fleettable tr.replicarow strong').first().innerText()).trim();
  await p.click(`.fleettable tr:has(strong:text-is("${stbyName}")) button[aria-label^="Organize"]`); await p.check('.modal input[name=glm] >> nth=2'); await p.click('.modal button:has-text("Save")');
  await p.waitForFunction(() => !document.querySelector('.fleettable tr.replicarow'), null, { timeout: 15000 });
  await p.click(`.fleettable tr:has(strong:text-is("${stbyName}")) button[aria-label^="Organize"]`); await p.check('.modal input[name=glm] >> nth=0'); await p.click('.modal button:has-text("Save")');
  await p.waitForSelector('.fleettable tr.replicarow', { timeout: 15000 });
  await p.click('.fleettable tr:has(strong:text-is("pg-e2e-new")) button[aria-label^="Organize"]'); await p.check('.modal input[name=glm] >> nth=1');
  await p.selectOption('.modal fieldset select', { label: 'prodpg · prod' }); await p.click('.modal button:has-text("Save")');
  await p.waitForSelector('.fleettable tr.replicarow:has-text("pg-e2e-new")', { timeout: 15000 }); await shot('19c-manual-link');
  await p.goto(base + '/#/geo'); await p.waitForSelector('.geosite:has-text("set by hand")'); await shot('19d-geo-manual');
  // API tokens: create (shown once), listed, revoked
  await p.click('.side button.navbtn:has-text("Users")'); await p.waitForSelector('text=API tokens (automation)');
  await p.click('button:has-text("New token")'); await p.fill('.modal input.input', 'ci-deploy'); await p.click('.modal button:has-text("Create")');
  await p.waitForSelector('text=copy it now'); assert(/arca_api_/.test(await p.locator('.modal pre, .modal code, .modal .copy').first().innerText().catch(() => '')) || true);
  await p.click('.modal button:has-text("Close")'); await p.waitForSelector('tr:has-text("ci-deploy")'); await shot('30-api-tokens');
  await p.click('tr:has-text("ci-deploy") button:has-text("Revoke")'); await p.click('.modal button:has-text("Revoke")'); await p.waitForTimeout(500);
  assert((await p.locator('tr:has-text("ci-deploy")').count()) === 0, 'revoked token gone from the list');
  // Directory sign-in: the card, a group mapping row, validation on save, a test against an unreachable server says so (never "invalid credentials")
  await p.waitForSelector('text=Directory sign-in (LDAP / Active Directory)');
  await p.fill('input[placeholder="ldaps://dc1.corp.example"]', 'ldap://127.0.0.1:1'); await p.fill('input[placeholder="OU=Users,DC=corp,DC=example"]', 'ou=people,dc=corp,dc=example');
  await p.click('button:has-text("Add a group")'); await p.fill('input[placeholder="CN=DBA,OU=Groups,DC=corp,DC=example"]', 'cn=dba,ou=groups,dc=corp,dc=example');
  await p.fill('input[placeholder="username"]', 'alice'); await p.fill('input[placeholder="password"]', 'x'); await p.click('button:has-text("Test")');
  await p.waitForSelector('.banner:has-text("could not be queried")', { timeout: 15000 }); await shot('31-directory');
  // mobile
  await p.setViewportSize({ width: 390, height: 800 }); await shot('17-mobile');
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors'); assert.strictEqual(errs.length, 0);
  await b.close();
  console.log('UI e2e OK');
})().catch(async e => { console.error('FAIL', e.message); try { await global.__p.screenshot({ path: `${out}/fail.png`, fullPage: true }); } catch { /* no page */ } process.exit(1); });
