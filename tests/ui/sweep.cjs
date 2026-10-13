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
    await p.goto(base); await p.waitForSelector('text=Accedi');
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
  }
  console.log(problems.length ? problems.join('\n') : 'sweep OK'); await b.close(); process.exit(problems.length ? 1 : 0);
})();
