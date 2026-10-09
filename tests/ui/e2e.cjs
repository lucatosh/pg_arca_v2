// Browser test: drives the built console against devserver.ts. Run: NODE_PATH=/opt/npm-tools/node_modules node tests/ui/e2e.cjs [outDir]
const { chromium } = require('playwright'); const assert = require('assert');
const out = process.argv[2] || '/tmp/claude-0/ui/shots'; require('fs').mkdirSync(out, { recursive: true });
const base = process.env.BASE || 'http://localhost:5188';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); const ctx = await b.newContext({ viewport: { width: 1360, height: 860 } });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/401|428|Failed to load resource|WebSocket/.test(m.text())) errs.push('console: ' + m.text()); });
  const shot = n => p.screenshot({ path: `${out}/${n}.png` });
  await p.goto(base); await p.waitForSelector('text=Accedi'); await shot('01-login');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'wrong-password-1'); await p.click('button[type=submit]');
  await p.waitForSelector('text=non corretti'); await p.waitForTimeout(1300);
  await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
  await p.waitForSelector('text=Cluster collegati'); await p.waitForSelector('text=prodpg'); await shot('02-clusters');
  assert(await p.locator('text=Cluster demo').count() >= 1, 'demo present');
  await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Protezione dei dati'); await shot('03-overview');
  // backup tab
  await p.click('role=tab[name=/Backup/]'); await p.waitForSelector('text=Esegui un backup'); await shot('04-backup');
  await p.click('button:has-text("Avvia backup")'); await p.waitForSelector('text=Copia dei dati'); await shot('05-backup-running');
  await p.waitForSelector('text=/Backup .* completato/', { timeout: 15000 }); await shot('06-backup-done');
  // restore wizard: database
  await p.click('role=tab[name=/Ripristino/]'); await p.waitForSelector('text=Cosa vuoi ripristinare');
  await p.waitForSelector('.card select option:has-text("appdb")', { state: 'attached', timeout: 10000 });
  await p.selectOption('.card select', 'appdb'); await shot('07-restore-what'); await p.click('button:has-text("Avanti")');
  await p.waitForSelector('[role=slider]'); await shot('08-timeline');
  const tr = await p.locator('.rt .track').boundingBox();
  await p.mouse.click(tr.x + tr.width * 0.55, tr.y + 30); await p.waitForTimeout(200); await shot('09-timeline-picked');
  await p.click('summary:has-text("Hai cancellato")'); await p.click('button:has-text("Cerca eventi distruttivi")'); await p.waitForSelector('text=appdb.public.orders', { timeout: 10000 }); await shot('10-forensics');
  await p.click('button:has-text("Avanti")'); await p.waitForSelector('text=Nome del nuovo database');
  await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('text=Ripristino possibile', { timeout: 10000 }); await shot('11-plan');
  await p.click('button:has-text("Avvia ripristino")'); await p.click('.modal button:has-text("Avvia")');
  await p.waitForSelector('text=Ripristino completato', { timeout: 15000 }); await shot('12-restore-done');
  // restore one table, then promote it back
  await p.click('button:has-text("Nuovo ripristino")'); await p.click('button.choice:has-text("Una tabella")');
  await p.waitForSelector('.card select option:has-text("appdb")', { state: 'attached', timeout: 10000 }); await p.selectOption('.card select', 'appdb');
  await p.click('.tree button:has-text("orders")'); await p.click('button:has-text("Avanti")'); await p.waitForSelector('[role=slider]'); await p.click('button:has-text("Avanti")');
  await p.waitForSelector('text=Quarantena'); await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('text=Ripristino possibile', { timeout: 10000 });
  await p.click('button:has-text("Avvia ripristino")'); await p.click('.modal button:has-text("Avvia")');
  await p.waitForSelector('text=Riporta la tabella nel database', { timeout: 15000 }); await shot('12b-promote');
  await p.click('button:has-text("Riporta la tabella")'); await p.click('.modal button:has-text("Riporta")'); await p.waitForSelector('text=Tabella riportata', { timeout: 10000 }); await shot('12c-promoted');
  // ops tab, logs tab, preview tab
  await p.click('role=tab[name=/Operazioni/]'); await p.waitForSelector('text=Registro operazioni'); await shot('13-ops');
  await p.click('role=tab[name=/Log/]'); await p.waitForSelector('text=Log in tempo reale');
  await p.click('role=tab[name=/Accessi/]'); await p.waitForSelector('text=Regole gestite dalla console'); await p.waitForSelector('text=Repliche attive senza'); await shot('14-hba');
  await p.click('role=tab[name=/Tuning/]'); await p.waitForSelector('text=16.0 GB di RAM'); await p.waitForSelector('tr:has-text("shared_buffers") >> text=4GB'); await shot('14e-tuning');
  await p.click('tr:has-text("work_mem") button:has-text("Applica")'); await p.click('.modal button:has-text("Applica")'); await p.waitForSelector('text=Completata', { timeout: 10000 });
  await p.click('role=tab[name=/Accessi/]'); await p.waitForSelector('text=Regole gestite dalla console');
  // HBA assistant: suggestion, duplicate refusal, shadow warning, plan, apply
  await p.click('.banner.warn button:has-text("Aggiungi")'); await p.waitForSelector('text=Replica da 10.0.2.7');
  await p.click('button:has-text("Aggiungi una regola")');
  await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/33'); await p.waitForSelector('text=formato CIDR');
  await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/24'); await p.waitForSelector('text=può usare ogni database dalla rete 10.0.20.0/24');
  await p.click('button:has-text("Aggiungi alla lista")'); await p.waitForSelector('td:has-text("dalla rete 10.0.20.0/24")');
  await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.0.20.0/24');
  await p.waitForSelector('text=Duplicata'); assert(await p.locator('button:has-text("Aggiungi alla lista")').isDisabled(), 'duplicate refused'); await shot('14b-hba-dup');
  await p.click('button[aria-label=Chiudi]');
  await p.selectOption('#hba-order', 'wide');
  await p.click('button:has-text("Verifica effetto")'); await p.waitForSelector('text=Connessione simulata'); await shot('14c-hba-plan');
  await p.selectOption('#hba-order', 'specific');
  await p.click('button:has-text("Verifica effetto")'); await p.waitForSelector('text=Connessione simulata');
  await p.click('button:has-text("Applica"):not([disabled]) >> nth=0'); await p.click('.modal button:has-text("Applica")');
  await p.waitForSelector('text=applicato e verificato', { timeout: 15000 }); await shot('14d-hba-applied');
  // palette
  await p.keyboard.press('Control+k'); await p.waitForSelector('[role=dialog][aria-label="Ricerca rapida"]'); await p.keyboard.type('registro'); await p.keyboard.press('Enter');
  await p.waitForSelector('text=Registro attività'); await shot('15-audit');
  // discovery
  await p.goto(base + '/#/discovery'); await p.waitForSelector('text=Differenze di configurazione tra i nodi'); await p.waitForSelector('text=Da sistemare'); await shot('15a-discovery');
  // strategies
  await p.goto(base + '/#/strategy'); await p.waitForSelector('text=cluster senza backup automatico'); await shot('15b-strategy');
  await p.click('button:has-text("Applica i consigliati per ambiente")'); await p.waitForSelector('text=Tutti i cluster hanno una strategia attiva'); await shot('15c-strategy-applied');
  await p.click('tr:has-text("prodpg") button:has-text("Assegna")'); await p.click('label.opt:has-text("Conservazione lunga")'); await p.click('.modal button:has-text("Salva")');
  await p.waitForSelector('tr:has-text("prodpg"):has-text("Assegnata a questo cluster")');
  await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Strategia di backup'); await p.waitForSelector('.card .badge:has-text("Conservazione lunga")'); await shot('15d-backup-strategy');
  // attach wizard
  await p.click('button:has-text("Cluster") >> nth=0'); await p.click('button:has-text("Collega cluster") >> nth=0'); await p.waitForSelector('text=Con agent (consigliato)'); await p.click('text=Con agent (consigliato)');
  await p.click('button:has-text("Genera comando")'); await p.waitForSelector('text=PG_ARCA_ENROLL_TOKEN'); await shot('16-attach');
  // mobile
  await p.setViewportSize({ width: 390, height: 800 }); await shot('17-mobile');
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors'); assert.strictEqual(errs.length, 0);
  await b.close(); console.log('UI e2e OK');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
