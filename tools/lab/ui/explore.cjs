// Lab: walk the REAL console like a user, every general page and every tab of every real cluster, and report what a user would trip on:
// page errors, console errors, API calls that fail or are slow, Italian text left on screen, "undefined"/"NaN"/"[object Object]" on screen, skeletons that
// never resolve, pages wider than the window. Saves a screenshot and the visible text of each page (for reading the wording afterwards).
//   NODE_PATH=~/uitest/node_modules node tools/lab/ui/explore.cjs [outDir] [phone]
const { chromium } = require('playwright-core'); const fs = require('fs'); const path = require('path'); const os = require('os');
const out = process.argv[2] || '/tmp/explore'; const phone = process.argv[3] === 'phone'; fs.mkdirSync(out, { recursive: true });
const base = process.env.PG_ARCA_URL || 'http://localhost:3000';
const exe = process.env.PW_CHROMIUM || (() => { const d = path.join(os.homedir(), '.cache/ms-playwright'); const h = fs.readdirSync(d).find(x => x.startsWith('chromium_headless_shell')); return path.join(d, h, 'chrome-linux/headless_shell'); })();
// Italian left on screen: words that only appear in Italian sentences (the console speaks English; names and commands are fine)
const EN = /[àèéìòù]|\b(della|delle|degli|nella|nelle|questo|questa|quando|perché|sono|vengono|viene|cartella|ripristino|nessun|nessuna|impostazioni|annulla|chiudi|salva|elimina|riprova|aggiorna|indietro|avanti|utente|errore|non è|il cluster|i backup|dei|del|per il|con il)\b/i;
(async () => {
  const b = await chromium.launch({ executablePath: exe });
  const ctx = await b.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 } }); const p = await ctx.newPage();
  const report = []; let cur = null; const t0s = new Map();
  p.on('pageerror', e => cur && cur.issues.push('pageerror: ' + e.message.slice(0, 300)));
  p.on('console', m => { if (cur && m.type() === 'error' && !/401|Failed to load resource|WebSocket/.test(m.text())) cur.issues.push('console: ' + m.text().slice(0, 300)); });
  p.on('request', r => { if (r.url().includes('/api/')) t0s.set(r, Date.now()); });
  p.on('response', async r => {
    if (!cur || !r.url().includes('/api/')) return; const ms = Date.now() - (t0s.get(r.request()) || Date.now()); const u = r.url().replace(base, '');
    if (r.status() >= 400 && r.status() !== 401) { let body = ''; try { body = (await r.text()).slice(0, 200); } catch { /* */ } cur.issues.push(`api ${r.status()} ${r.request().method()} ${u} ${body}`); }
    if (ms > 3000) cur.issues.push(`slow api ${ms} ms ${r.request().method()} ${u}`);
  });
  await p.goto(base); await p.waitForSelector('text=Sign in');
  await p.fill('input[autocomplete=username]', process.env.ARCA_USER || 'claude-test'); await p.fill('input[type=password]', process.env.ARCA_PASS || 'claude-lab-test-pass-1');
  await p.click('button[type=submit]'); await p.waitForSelector('button:has-text("Connect cluster")');
  const clusters = await p.evaluate(async () => (await (await fetch('/api/clusters')).json()).clusters.filter(c => !c.isSandbox).map(c => ({ id: c.id, name: c.name })));
  const general = ['', 'today', 'strategy', 'infra/ephemeral', 'infra/destination', 'geo', 'discovery', 'settings', 'users', 'history', 'audit', 'workers'];
  const tabs = ['overview', 'nodes', 'ha', 'backup', 'restore', 'params', 'tuning', 'operations', 'logs', 'hba'];
  const pages = [...general.map(r => ({ r, label: r || 'home' })), ...clusters.flatMap(c => tabs.map(t => ({ r: `c/${encodeURIComponent(c.id)}/${t}`, label: `${c.name}/${t}` })))];
  for (const pg of pages) {
    cur = { page: pg.label, issues: [] }; const t = Date.now();
    await p.goto(`${base}/#/${pg.r}`).catch(e => cur.issues.push('goto ' + e.message));
    // ready = no skeleton left (or 20 s)
    let ready = false; for (let i = 0; i < 40; i++) { await p.waitForTimeout(500); if (!(await p.locator('.skeleton, .sk').count())) { ready = true; break; } }
    cur.ms = Date.now() - t; if (!ready) cur.issues.push('still loading after 20 s');
    await p.waitForTimeout(800);
    const info = await p.evaluate(EN_SRC => {
      const EN = new RegExp(EN_SRC, 'i'); const o = { en: [], bad: [], wide: false };
      const main = document.querySelector('main') || document.body; const text = main.innerText || '';
      for (const line of text.split('\n')) { const l = line.trim(); if (l.length > 15 && EN.test(l) && !/^(\$|sudo|curl|pg_|psql|SELECT|ALTER|systemctl|patronictl)/.test(l)) o.en.push(l.slice(0, 200)); if (/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b(?!\s*\))/.test(l)) o.bad.push(l.slice(0, 200)); }
      o.wide = document.documentElement.scrollWidth > window.innerWidth + 1; o.text = text; return o;
    }, EN.source);
    for (const l of [...new Set(info.en)].slice(0, 12)) cur.issues.push('italian: ' + l);
    for (const l of [...new Set(info.bad)].slice(0, 6)) cur.issues.push('bad value: ' + l);
    if (info.wide) cur.issues.push('page wider than the window');
    const f = pg.label.replace(/[^a-z0-9]+/gi, '_');
    fs.writeFileSync(path.join(out, f + '.txt'), info.text);
    await p.screenshot({ path: path.join(out, f + '.png'), fullPage: true }).catch(() => {});
    report.push(cur); console.log(`${cur.page} ${cur.ms} ms ${cur.issues.length ? '\n   ' + cur.issues.join('\n   ') : 'ok'}`);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`EXPLORE ${report.length} pages, ${report.filter(r => r.issues.length).length} with issues`); await b.close();
})().catch(e => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });
