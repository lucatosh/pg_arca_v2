// Lab: every restore procedure driven through the REAL web console, as an operator would, on a real cluster of the lab.
// For each scenario: damage done in SQL (drop a table, delete/update rows, drop a database), then the guided restore in the browser from the first click to
// the data back in place, then the result checked in SQL. Screenshots of every step, timings, page errors. A failing scenario does not stop the others.
//   NODE_PATH=~/uitest/node_modules node tools/lab/ui/restore-ui.cjs "<cluster name>" [table,rows,database,instance] [outDir]
// Needs tools/lab/ui/sql.sh (SQL on the cluster's primary) and the console on PG_ARCA_URL (default http://localhost:3000).
const { chromium } = require('playwright-core'); const fs = require('fs'); const path = require('path'); const os = require('os'); const { execFileSync } = require('child_process');
const [cluster, which = 'table,rows,database,instance', outRoot = '/tmp/restore-ui'] = process.argv.slice(2);
if (!cluster) { console.error('usage: restore-ui.cjs "<cluster name>" [scenarios] [outDir]'); process.exit(2); }
const base = process.env.PG_ARCA_URL || 'http://localhost:3000';
const exe = process.env.PW_CHROMIUM || (() => { const d = path.join(os.homedir(), '.cache/ms-playwright'); const h = fs.readdirSync(d).find(x => x.startsWith('chromium_headless_shell')); return path.join(d, h, 'chrome-linux/headless_shell'); })();
const LAB = path.resolve(__dirname, '..'); const SQL = path.join(__dirname, 'sql.sh');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12); const out = path.join(outRoot, cluster.replace(/\W+/g, '_') + '-' + stamp); fs.mkdirSync(out, { recursive: true });
const DB = 'uit_' + stamp, DBX = 'uitx_' + stamp;
const sql = (db, q, env = {}) => execFileSync(SQL, [cluster, db, q], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sqlOn = (node, port, sock, db, q) => execFileSync(SQL, [cluster, '--on', node, String(port), db, q], { env: { ...process.env, SOCK: sock }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const api = (m, p) => JSON.parse(execFileSync(path.join(LAB, 'api.sh'), [m, p], { encoding: 'utf8' }));
const results = []; const t0all = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const cl = api('GET', '/api/clusters').clusters.find(c => c.name === cluster); if (!cl) throw new Error('no cluster ' + cluster);
  const [node] = execFileSync(SQL, [cluster, '--node'], { encoding: 'utf8' }).trim().split(' ');
  log(`cluster ${cluster} (${cl.id}), primary ${node}, PostgreSQL ${cl.pgVersion}`);
  const b = await chromium.launch({ executablePath: exe }); const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/401|428|Failed to load resource|WebSocket/.test(m.text())) errs.push('console: ' + m.text()); });
  let n = 0; const shot = async name => p.screenshot({ path: `${out}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
  const T = { verdict: 180e3, restore: 30 * 60e3, wal: 180e3 };
  const opText = async () => (await p.locator('.oppanel').allInnerTexts().catch(() => [])).join(' | ').replace(/\s+/g, ' ').slice(0, 900);
  const verdictOk = async () => {
    await until('/Tutto pronto|Pronto: leggi|Prima va sistemato|non risponde/', T.verdict);
    if (await p.locator('text=/Prima va sistemato|non risponde/').count()) throw new Error('check step refused: ' + (await p.locator('.card').last().innerText()).replace(/\s+/g, ' ').slice(0, 900));
  };
  const start = async () => { await p.click('button:has-text("Avvia il ripristino")'); await p.click('.modal button:has-text("Avvia")'); };
  const fresh = async () => { await p.goto(`${base}/#/c/${encodeURIComponent(cl.id)}/restore`); await p.evaluate(() => { for (const k of Object.keys(sessionStorage)) if (k.startsWith('pgarca.draft.restore') || k.startsWith('pgarca.draft.op:restore') || k.startsWith('pgarca.draft.rows')) sessionStorage.removeItem(k); }); await p.reload(); await p.waitForSelector('text=Cosa è successo?', { timeout: 60e3 }); };
  const failWatch = async () => { if (await p.locator('.oppanel .banner.bad, .oppanel:has-text("Scaduta")').count()) throw new Error('operation failed: ' + await opText()); };
  // the expected text, or the failure of an operation on the page (each operation panel says Fallita / Scaduta with the reason)
  const until = async (ok, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await p.locator(`text=${ok}`).count()) return; await failWatch(); await p.waitForTimeout(1000); } throw new Error('timeout waiting for ' + ok + ': ' + await opText()); };
  async function scenario(name, fn) {
    const t = Date.now(); const marks = []; const mark = m => marks.push(`${m} ${((Date.now() - t) / 1000).toFixed(0)}s`);
    log(`== ${name}`);
    try { await fn(mark); results.push({ name, ok: true, sec: Math.round((Date.now() - t) / 1000), marks }); log(`OK ${name} in ${Math.round((Date.now() - t) / 1000)} s: ${marks.join(', ')}`); }
    catch (e) { await shot(`FAIL-${name}`); const op = await opText(); results.push({ name, ok: false, sec: Math.round((Date.now() - t) / 1000), marks, error: String(e.message || e).slice(0, 1500), op }); log(`FAIL ${name}: ${String(e.message || e).slice(0, 600)}\n   op: ${op}`); }
  }

  // ---- login and data
  await p.goto(base); await p.waitForSelector('text=Accedi');
  await p.fill('input[autocomplete=username]', process.env.ARCA_USER || 'claude-test'); await p.fill('input[type=password]', process.env.ARCA_PASS || 'claude-lab-test-pass-1');
  await p.click('button[type=submit]'); await p.waitForSelector('button:has-text("Collega cluster")');
  log('creating test data', DB, DBX);
  sql('postgres', `CREATE DATABASE ${DB}`); sql('postgres', `CREATE DATABASE ${DBX}`);
  sql(DB, `CREATE TABLE t_orders(id int PRIMARY KEY, v text); INSERT INTO t_orders SELECT g, 'o' || g FROM generate_series(1, 500) g;
           CREATE TABLE t_items(id int PRIMARY KEY, order_id int REFERENCES t_orders(id), q int); INSERT INTO t_items SELECT g, 1 + g % 500, g % 9 FROM generate_series(1, 800) g;
           CREATE TABLE t_rows(id int PRIMARY KEY, v text, n int); INSERT INTO t_rows SELECT g, 'r' || g, g FROM generate_series(1, 3000) g;`);
  sql(DBX, `CREATE TABLE t(id int PRIMARY KEY, v text); INSERT INTO t SELECT g, md5(g::text) FROM generate_series(1, 1234) g;`);

  await scenario('backup', async mark => {
    await p.goto(`${base}/#/c/${encodeURIComponent(cl.id)}/backup`); await p.waitForSelector('text=Esegui un backup', { timeout: 60e3 }); await shot('backup');
    await p.click('button:has-text("Avvia backup")'); mark('started');
    await p.waitForSelector('text=/Backup .* completato/', { timeout: T.restore }); mark('done'); await shot('backup-done');
  });
  await new Promise(r => setTimeout(r, 3000));
  const flush = () => { try { sql('postgres', 'SELECT pg_switch_wal()'); } catch { /* replica or nothing to switch */ } };

  if (which.includes('table')) await scenario('table', async mark => {
    sql(DB, 'DROP TABLE t_items'); flush(); mark('dropped');
    await fresh(); await p.click('button.choice:has-text("Ho eliminato o svuotato una tabella")');
    await p.waitForSelector('.recentrow:has-text("t_items")', { timeout: T.wal }); mark('found in WAL'); await shot('table-found');
    await p.click('.recentrow:has-text("t_items")'); await p.waitForSelector('label.opt.on:has-text("Subito prima")');
    await p.click('button:has-text("Avanti")'); await verdictOk(); mark('checked'); await shot('table-check');
    await start(); await until('/Rimetti a posto/', T.restore); mark('restored in quarantine'); await shot('table-quarantine');
    if (!await p.locator('label.opt.on:has-text("Rimetti al suo posto ciò che è stato eliminato")').count()) throw new Error('missing_only not preselected for a dropped table');
    await p.getByRole('button', { name: 'Riporta', exact: true }).click(); await p.click('.modal button:has-text("Riporta")');
    await until('/Riportato nel database/', T.restore); mark('put back'); await shot('table-done');
    const c = sql(DB, 'SELECT count(*) FROM t_items'); if (c !== '800') throw new Error('t_items has ' + c + ' rows, expected 800');
  });

  if (which.includes('rows')) await scenario('rows', async mark => {
    sql(DB, "DELETE FROM t_rows WHERE id % 7 = 0"); await new Promise(r => setTimeout(r, 1500));
    sql(DB, "UPDATE t_rows SET v = 'bad' WHERE id % 11 = 0 AND id % 7 <> 0"); flush(); mark('damaged');
    await fresh(); await p.click('button.choice:has-text("Ho cancellato o modificato righe")');
    await p.waitForSelector(`button[role=radio]:has-text("${DB}")`, { timeout: 120e3 }); await p.click(`button[role=radio]:has-text("${DB}")`);
    await p.click('.tree button:has-text("t_rows") >> nth=0'); await shot('rows-what'); await p.click('button:has-text("Avanti")');
    await p.waitForSelector('label.opt:has-text("righe eliminate in")', { timeout: T.wal }); mark('found in WAL');
    await p.click('label.opt:has-text("righe eliminate in") input'); await shot('rows-when');
    await p.click('button:has-text("Avanti")'); await verdictOk(); mark('checked');
    await start(); await until('/Differenze trovate|Le tabelle coincidono/', T.restore); mark('compared'); await shot('rows-diff');
    await p.click('button:has-text("Riporta tutte le righe com’erano")'); await p.click('.modal button:has-text("Riporta")');
    await until('/Righe recuperate/', T.restore); mark('applied'); await shot('rows-done');
    const c = sql(DB, "SELECT count(*), count(*) FILTER (WHERE v = 'bad') FROM t_rows"); if (c !== '3000|0') throw new Error('t_rows after recovery: ' + c + ' (expected 3000|0)');
  });

  if (which.includes('database')) await scenario('database', async mark => {
    sql('postgres', `DROP DATABASE ${DBX}`); flush(); mark('dropped');
    await fresh(); await p.click('button.choice:has-text("Mi serve un database")');
    await p.waitForSelector(`.dbrow.gone:has-text("${DBX}")`, { timeout: 120e3 }); await p.click(`button[role=radio]:has-text("${DBX}")`); await shot('db-what');
    await p.click('button:has-text("Avanti")'); await p.waitForSelector('label.opt.on:has-text("Subito prima che venisse eliminato")', { timeout: 30e3 });
    await p.click('button:has-text("Avanti")'); await verdictOk(); mark('checked'); await shot('db-check');
    await start(); await until('/Ripristino completato/', T.restore); mark('restored'); await shot('db-done');
    const c = sql(`${DBX}_restored`, 'SELECT count(*) FROM t'); if (c !== '1234') throw new Error(`${DBX}_restored.t has ${c} rows, expected 1234`);
    sql('postgres', `DROP DATABASE ${DBX}_restored`);
  });

  if (which.includes('instance')) await scenario('instance', async mark => {
    await fresh(); await p.click('button.choice:has-text("Devo ricostruire tutto il server")');
    await p.waitForSelector('label.opt.on:has-text("L’ultimo istante salvato")'); await p.click('button:has-text("Avanti")');
    await p.waitForSelector('.opt.dest', { timeout: T.verdict }); await verdictOk(); mark('destinations proposed');
    const cands = (await p.locator('.opt.dest').allInnerTexts()).map(x => x.replace(/\s+/g, ' ').slice(0, 200)); log('   destinations:', JSON.stringify(cands));
    if (!await p.locator('.opt.dest.on .badge:has-text("Consigliato")').count()) throw new Error('the recommended destination is not preselected');
    await p.click('.seg button:has-text("4 ore")'); await shot('instance-check');
    await start(); await until('/Ripristino completato/', T.restore); mark('restored and started');
    await p.waitForSelector('.restored:has-text("In esecuzione")', { timeout: 60e3 }); await shot('instance-running');
    const card = (await p.locator('.card:has-text("Ripristino") .restored').first().innerText());
    const port = (card.match(/porta (\d+)/) || [])[1]; const dir = (card.match(/Cartella\s+(\S+)/) || [])[1];
    await p.click('.card:has-text("Ripristino") .restored summary:has-text("Dal server stesso")');
    const local = await p.locator('.card:has-text("Ripristino") .restored pre, .card:has-text("Ripristino") .restored .copyblock').allInnerTexts();
    const sock = ((local.join(' ').match(/psql -h (\S+) -p/) || [])[1]);
    log(`   copy on port ${port}, dir ${dir}, socket ${sock}`);
    const c = sqlOn(node, port, sock, DB, 'SELECT count(*) FROM t_orders'); if (c !== '500') throw new Error('the copy has ' + c + ' rows in t_orders, expected 500');
    mark('copy answers');
    await p.click('.card:has-text("Ripristino") .restored button:has-text("Elimina")');
    const nm = await p.locator('.modal').innerText(); const name = (nm.match(/scrivi (\S+)/) || [])[1];
    await p.fill('.modal input.input', name); await p.click('.modal button:has-text("Elimina")');
    await p.waitForSelector('.card:has-text("Ripristino") .restored .oppanel:has-text("Completata")', { timeout: 300e3 }); mark('deleted');
    try { execFileSync('docker', ['exec', node, 'test', '-e', dir]); throw new Error('directory still there: ' + dir); } catch (e) { if (/still there/.test(e.message)) throw e; }
    await shot('instance-deleted');
  });

  try { sql('postgres', `DROP DATABASE IF EXISTS ${DB}`); sql('postgres', `DROP DATABASE IF EXISTS ${DBX}`); } catch (e) { log('cleanup: ' + e.message.slice(0, 200)); }
  if (errs.length) log('PAGE ERRORS', errs.slice(0, 10).join(' | '));
  const sum = { cluster, pg: cl.pgVersion, total_sec: Math.round((Date.now() - t0all) / 1000), results, page_errors: errs.slice(0, 20), shots: out };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(sum, null, 1));
  console.log('RESULT ' + JSON.stringify({ cluster, ok: results.filter(r => r.ok).map(r => r.name), failed: results.filter(r => !r.ok).map(r => r.name), total_sec: sum.total_sec }));
  await b.close(); process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });
