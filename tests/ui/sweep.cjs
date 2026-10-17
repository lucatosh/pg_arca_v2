// Sweep: every page and cluster tab at desktop and phone width. Fails on page errors, horizontal overflow of the page, and clipped button/badge text.
// NODE_PATH=/opt/npm-tools/node_modules node tests/ui/sweep.cjs [outDir]   (fresh devserver)
const { chromium } = require('playwright');
const out = process.argv[2] || '/tmp/claude-0/ui/sweep'; require('fs').mkdirSync(out, { recursive: true });
const base = process.env.BASE || 'http://localhost:5188';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' }); const problems = [];
  for (const [vw, vh, tag] of [[1360, 860, 'd'], [390, 844, 'm']]) {
    const p = await (await b.newContext({ viewport: { width: vw, height: vh } })).newPage();
    p.on('pageerror', e => problems.push(`${tag} pageerror ${e.message}`));
    await p.goto(base); await p.waitForSelector('text=Sign in');
    await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
    await p.waitForTimeout(1500);
    const cid = await p.evaluate(async () => { const r = await fetch('/api/clusters'); const j = await r.json(); return (j.clusters.find(c => c.name === 'prodpg') || {}).id; });
    const routes = ['', 'today', 'strategy', 'infra/ephemeral', 'infra/destination', 'geo', 'discovery', 'settings', 'users', 'history', 'audit', 'workers',
      ...['overview', 'nodes', 'ha', 'backup', 'restore', 'params', 'tuning', 'operations', 'logs', 'hba'].map(t => `c/${encodeURIComponent(cid)}/${t}`)];
    for (const r of routes) {
      await p.goto(`${base}/#/${r}`); await p.waitForTimeout(1300);
      const res = await p.evaluate(() => {
        const out = []; const W = window.innerWidth;
        if (document.documentElement.scrollWidth > W + 1) out.push(`page wider than the window (${document.documentElement.scrollWidth} > ${W})`);
        const main = document.querySelector('main.page'); if (main && main.scrollWidth > main.clientWidth + 1) out.push(`content wider than its area (${main.scrollWidth} > ${main.clientWidth})`);
        for (const el of document.querySelectorAll('button, .badge, .steps .s')) { const cs = getComputedStyle(el); if (el.offsetParent && el.scrollWidth > el.clientWidth + 2 && cs.overflow !== 'visible' && !el.closest('.tablewrap')) out.push(`clipped: "${(el.textContent || '').trim().slice(0, 40)}"`); }
        for (const el of document.querySelectorAll('main.page *')) { const r = el.getBoundingClientRect(); const scroller = (() => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; })();
          if (r.width > 0 && r.right > W + 2 && !scroller && !el.closest('.tablewrap, pre, .logbox, .out, .rt')) { out.push(`sticks out on the right: <${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent || '').trim().slice(0, 40)}"`); break; } }
        return out;
      });
      for (const x of res) problems.push(`${tag} /${r}: ${x}`);
      await p.screenshot({ path: `${out}/${tag}-${r.replace(/[^a-z0-9]+/gi, '_') || 'home'}.png` });
    }
    // the storage wizard (a wide modal with choices, fields and command blocks) at this width: nothing sticks out of the dialog
    await p.goto(`${base}/#/c/${encodeURIComponent(cid)}/backup`); await p.waitForSelector('.placement button:has-text("Configure")', { timeout: 15000 });
    await p.click('.placement button:has-text("Configure")'); await p.click('.modal .choice:has-text("A backup server")'); await p.click('.modal button:has-text("Continue")');
    await p.click('.modal .choice:has-text("bk01")'); await p.waitForTimeout(500);
    const wz = await p.evaluate(() => { const m = document.querySelector('.modal'); const o = []; if (!m) return ['no dialog'];
      const R = m.getBoundingClientRect(); if (R.right > window.innerWidth + 1) o.push(`dialog wider than the window (${Math.round(R.right)} > ${window.innerWidth})`);
      for (const el of m.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > R.right + 2 && !el.closest('pre, .out, .tablewrap')) { o.push(`sticks out of the dialog: <${el.tagName.toLowerCase()} class="${el.className}"> "${(el.textContent || '').trim().slice(0, 40)}"`); break; } }
      return o; });
    for (const x of wz) problems.push(`${tag} storage wizard: ${x}`);
    await p.screenshot({ path: `${out}/${tag}-storage-wizard.png` });
    await p.keyboard.press('Escape');
  }
  // the same pages as an OBSERVER: every backup location masked in the answers ("(hidden)") must not break a screen, and none may show in plain view
  {
    const p = await (await b.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
    p.on('pageerror', e => problems.push(`viewer pageerror ${e.message}`));
    await p.goto(base); await p.waitForSelector('text=Sign in');
    await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]'); await p.waitForTimeout(1200);
    const mk = await p.evaluate(async () => (await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pg-arca': '1' }, body: JSON.stringify({ username: 'sweep-viewer', password: 'viewer-password-123', role: 'viewer' }) })).status);
    if (![200, 201, 409].includes(mk)) problems.push(`viewer: cannot create the observer (${mk})`);
    await p.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-pg-arca': '1' } }); });
    await p.goto(base); await p.waitForSelector('text=Sign in');
    await p.fill('input[autocomplete=username]', 'sweep-viewer'); await p.fill('input[type=password]', 'viewer-password-123'); await p.click('button[type=submit]'); await p.waitForTimeout(1500);
    const cid = await p.evaluate(async () => { const r = await fetch('/api/clusters'); const j = await r.json(); return (j.clusters.find(c => c.name === 'prodpg') || {}).id; });
    const wid = await p.evaluate(async () => { const r = await fetch('/api/workers'); const j = await r.json(); return ((j.workers || [])[0] || {}).id; });
    for (const r of ['infra/destination', 'workers', ...(wid ? [`w/${encodeURIComponent(wid)}`] : []), ...['backup', 'nodes', 'overview'].map(t => `c/${encodeURIComponent(cid)}/${t}`)]) {
      await p.goto(`${base}/#/${r}`); await p.waitForTimeout(1500);
      const txt = await p.evaluate(() => document.querySelector('main.page')?.innerText || '');
      if (/\/mnt\/backup|\/var\/lib\/pgarca\/(repo|wal)|\/backup\/pgarca/.test(txt)) problems.push(`viewer /${r}: a backup location is visible`);
      await p.screenshot({ path: `${out}/viewer-${r.replace(/[^a-z0-9]+/gi, '_')}.png` });
    }
  }
  console.log(problems.length ? problems.join('\n') : 'sweep OK'); await b.close(); process.exit(problems.length ? 1 : 0);
})();
