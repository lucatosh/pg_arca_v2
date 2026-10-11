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
  await p.goto(base); await p.waitForSelector('text=Accedi'); await shot('01-login');
  await p.fill('input[autocomplete=username]', 'admin'); await p.fill('input[type=password]', 'wrong-password-1'); await p.click('button[type=submit]');
  await p.waitForSelector('text=non corretti'); await p.waitForTimeout(1300);
  await p.fill('input[type=password]', 'correct-horse-battery'); await p.click('button[type=submit]');
  await p.waitForSelector('text=Cluster collegati'); await p.waitForSelector('text=prodpg');
  // organise: prodpg into prod > fatturazione/api; the sidebar and the list group it, with the state of the group
  await p.click('tr:has-text("prodpg") button:has-text("Organizza")'); await p.fill('.modal input[list]', 'fatturazione/api'); await p.click('.modal button:has-text("Salva")');
  await p.waitForSelector('.side .fhead.folder:has-text("fatturazione")'); await p.waitForSelector('.fleettable tr.frow:has-text("api")'); await shot('02-clusters');
  assert(await p.locator('text=Cluster demo').count() >= 1, 'demo present');
  await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Protezione dei dati'); await shot('03-overview');
  // backup tab
  await tab('Protezione', 'Backup'); await p.waitForSelector('text=Esegui un backup'); await p.waitForSelector('.placement code:has-text("/mnt/backup/repo/prodpg")'); await shot('04-backup');
  { const b = p.locator('button:has-text("Prova di disaster recovery")'); if (await b.isEnabled()) { await b.click(); await p.waitForSelector('text=Cluster ripristinato in 13 minuti', { timeout: 10000 }); await shot('04b-drill'); } }
  await p.click('button:has-text("Avvia backup")'); await p.waitForSelector('text=Copia dei dati'); await p.waitForSelector('.activitystrip:has-text("un backup")', { timeout: 8000 }); await shot('05-backup-running');
  // the dock's Log opens a floating window with THIS operation's log (not the database log): movable, minimisable, closable
  await p.click('.dock-chip'); await p.click('.dock-item button:has-text("Log")'); await p.waitForSelector('.oplog'); await p.waitForSelector('.oplog-body .ln', { timeout: 8000 });
  assert(/Backup/.test(await p.locator('.oplog-hd .nm').innerText()), 'log window is titled with the operation');
  { const hd = await p.locator('.oplog-hd').boundingBox(); const x0 = (await p.locator('.oplog').boundingBox()).x; await p.mouse.move(hd.x + 60, hd.y + 10); await p.mouse.down(); await p.mouse.move(hd.x + 160, hd.y - 60, { steps: 4 }); await p.mouse.up();
    assert(Math.abs((await p.locator('.oplog').boundingBox()).x - x0 - 100) < 6, 'window moves with the header'); }
  await shot('05a-oplog'); await p.click('.oplog button[aria-label="Riduci a icona"]'); await p.waitForSelector('.oplog.min'); await p.click('.oplog button[aria-label="Espandi il log"]'); await p.waitForSelector('.oplog-body');
  await p.click('.oplog button[aria-label="Chiudi il log"]'); await p.waitForSelector('.oplog', { state: 'detached' }); await p.keyboard.press('Control+j');
  await p.waitForSelector('text=/Backup .* completato/', { timeout: 15000 }); await shot('06-backup-done');
  // restore wizard: database
  await tab('Protezione', 'Ripristino'); await p.waitForSelector('text=Cosa vuoi ripristinare');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 });
  // a database that is in the backups and not on the server is DROPPED, in red, with the date found in the WAL
  await p.waitForSelector('.dbrow.gone:has-text("reports") .dropped', { timeout: 10000 }); await p.waitForSelector('.dbrow.gone:has-text("reports"):has-text("2026"), .dbrow.gone:has-text("reports"):has-text("ott")', { timeout: 10000 });
  assert(await p.locator('.dbrow:has-text("appdb") .here').count() === 1, 'live database says Presente');
  assert(await p.locator('.dbrow:has-text("arca_rl_20261010")').count() === 1, 'pg_arca working database is listed (apart)');
  await p.click('button[role=radio]:has-text("reports")'); await p.waitForSelector('.dropnote'); await shot('07a-restore-dropped');
  await p.click('button[role=radio]:has-text("appdb")'); await shot('07-restore-what'); await p.click('button:has-text("Avanti")');
  await p.waitForSelector('[role=slider]'); await shot('08-timeline');
  const tr = await p.locator('.rt .track').boundingBox();
  await p.mouse.click(tr.x + tr.width * 0.55, tr.y + 30); await p.waitForTimeout(200); await shot('09-timeline-picked');
  await p.click('summary:has-text("Hai cancellato")'); await p.click('button:has-text("Avvia analisi")'); await p.waitForSelector('text=appdb.public.orders', { timeout: 10000 }); await shot('10-forensics');
  await p.click('button:has-text("Avanti")'); await p.waitForSelector('text=Nome del nuovo database');
  await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('text=Ripristino possibile', { timeout: 10000 }); await p.waitForSelector('.preflight.warn'); await p.waitForSelector('.spacebars .vol'); await p.waitForSelector('.placement code:has-text("/var/tmp/pg_arca_scratch")'); await shot('11-plan');
  // a taken destination name is a blocker: the start button stays disabled
  const nameIn = p.locator('.field:has-text("Nome del nuovo database") input');
  await p.click('button:has-text("Indietro")'); const keep = await nameIn.inputValue(); await nameIn.fill('taken'); await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('.preflight.bad');
  if (!(await p.locator('button:has-text("Avvia ripristino")').isDisabled())) throw new Error('start must be blocked by a failing pre-flight');
  await shot('11b-plan-blocked'); await p.click('button:has-text("Indietro")'); await nameIn.fill(keep); await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('.preflight.warn');
  await p.click('button:has-text("Avvia ripristino")'); await p.click('.modal button:has-text("Avvia")');
  await p.waitForSelector('text=Ripristino completato', { timeout: 15000 }); await shot('12-restore-done');
  // restore one table, then promote it back
  await p.click('button:has-text("Nuovo ripristino")'); await p.click('button.choice:has-text("Una o più tabelle")');
  await p.waitForSelector('button[role=radio]:has-text("appdb")', { timeout: 10000 }); await p.click('button[role=radio]:has-text("appdb")');
  await p.click('.tree button:has-text("orders")'); await p.click('button:has-text("Avanti")'); await p.waitForSelector('[role=slider]'); await p.click('button:has-text("Avanti")');
  await p.waitForSelector('text=Quarantena'); await p.click('button:has-text("Controlla piano")'); await p.waitForSelector('text=Ripristino possibile', { timeout: 10000 });
  await p.click('button:has-text("Avvia ripristino")'); await p.click('.modal button:has-text("Avvia")');
  await p.waitForSelector('text=Riporta nel database', { timeout: 15000 }); await p.click('button:has-text("Anteprima delle modifiche")'); await p.waitForSelector('text=Chiavi esterne da ricollegare', { timeout: 10000 }); await shot('12b-promote');
  await p.click('button:has-text("Confronta riga per riga")'); await p.waitForSelector('text=Differenze trovate', { timeout: 10000 });
  await p.click('label:has-text("[200]") input'); await p.click('label:has-text("[1]") input'); await shot('12a-rows');
  await p.click('button:has-text("Applica (2)")'); await p.click('.modal button:has-text("Applica")'); await p.waitForSelector('text=Righe recuperate', { timeout: 10000 });
  await p.click('label:has-text("Al posto degli originali") input');
  await p.getByRole('button', { name: 'Riporta', exact: true }).click();
  if (!(await p.locator('.modal button:has-text("Riporta")').isDisabled())) throw new Error('replace needs the typed confirmation');
  await p.fill('.modal input.input', 'SOSTITUISCI'); await shot('12d-replace-confirm');
  await p.click('.modal button:has-text("Riporta")'); await p.waitForSelector('text=Riportato nel database', { timeout: 10000 }); await shot('12c-promoted');
  // ripristino e archivi: istanza di recupero (globale -> cluster, verifica, installazione) e destinazione dei backup (controllo, applicazione)
  await p.goto(base + '/#/infra'); await p.waitForSelector('text=Ripristino e archivi'); await p.waitForSelector('text=Tutti i cluster');
  await p.locator('tr:has-text("Tutti i cluster") button:has-text("Modifica")').click(); await p.waitForSelector('text=Dove gira l’istanza di recupero');
  await p.fill('input[placeholder="/var/tmp/pg_arca_scratch"]', '/data/scratch'); await p.fill('input[placeholder="es. 55000"]', '55000'); await p.fill('input[placeholder="es. 55100"]', '55100');
  await p.click('.modal button:has-text("Salva")'); await p.waitForSelector('text=Impostazioni salvate'); await p.waitForSelector('text=porte 55000-55100'); await shot('15-infra-eph');
  await p.locator('tr:has-text("prodpg") button:has-text("Verifica")').click(); await p.waitForSelector('text=Il recupero non può partire da questo nodo', { timeout: 10000 }); await p.waitForSelector('text=Installare PostgreSQL 15'); await shot('16-infra-preflight');
  await p.click('button:has-text("Installa PostgreSQL 15")'); await p.fill('.modal input >> nth=-1', 'INSTALL'); await p.click('.modal button:has-text("Installa") >> nth=-1'); await p.waitForSelector('text=Installazione dei binari', { timeout: 10000 });
  await p.click('.modal button:has-text("Chiudi")');
  await p.click('role=tab[name="Destinazione dei backup"]'); await p.waitForSelector('text=Dove finiscono repository e archivio WAL');
  await p.locator('tr:has-text("Tutti i cluster") button:has-text("Modifica")').click(); await p.waitForSelector('text=Dove vengono scritti i backup');
  await p.selectOption('.modal select >> nth=0', 'nfs'); await p.fill('input[placeholder="/mnt/backup/pgarca"]', '/mnt/backup/pgarca'); await p.fill('input[placeholder="/mnt/backup/wal/{env}/{cluster}"]', '/mnt/backup/wal/{env}/{cluster}');
  assert(await p.locator('.modal option[disabled]:has-text("Anteprima")').count() >= 4, 'object stores are listed as preview and disabled');
  await p.click('.modal button:has-text("Salva")'); await p.waitForSelector('text=Impostazioni salvate'); await shot('17-infra-dest');
  await p.locator('tr:has-text("prodpg") button:has-text("Controlla e applica")').click(); await p.waitForSelector('text=/Destinazione dei backup . prodpg/');
  assert(await p.locator('button:has-text("Applica ai nodi")').isDisabled(), 'apply needs a check first');
  await p.click('button:has-text("Controlla su tutti i nodi")'); await p.waitForSelector('text=is on nfs4', { timeout: 15000 }); await p.waitForSelector('text=controllo riuscito', { timeout: 15000 });
  await p.click('button:has-text("Applica ai nodi")'); await p.waitForSelector('text=Applicazione avviata', { timeout: 10000 }); await shot('18-infra-applied');
  await p.click('.modal button:has-text("Chiudi")');
  await p.click('.side button.navbtn:has-text("Tutti i cluster")'); await p.click('a:has-text("prodpg")'); await p.waitForSelector('text=Protezione dei dati');
  // ops tab, logs tab, preview tab
  await tab('Operatività', 'Operazioni'); await p.waitForSelector('text=Registro operazioni'); await shot('13-ops');
  await tab('Operatività', 'Log'); await p.waitForSelector('text=Log in tempo reale');
  await tab('Accessi', 'HBA'); await p.waitForSelector('text=Regole gestite dalla console'); await p.waitForSelector('text=Repliche attive senza'); await shot('14-hba');
  await tab('Operatività', 'Tuning'); await p.waitForSelector('text=16.0 GB di RAM'); await p.waitForSelector('tr:has-text("shared_buffers") >> text=4GB'); await shot('14e-tuning');
  await p.click('tr:has-text("work_mem") button:has-text("Applica")'); await p.click('.modal button:has-text("Applica")'); await p.waitForSelector('text=Completata', { timeout: 10000 });
  await tab('Accessi', 'HBA'); await p.waitForSelector('text=Regole gestite dalla console');
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
  await p.waitForTimeout(2000);
  // temporary rule + adopt existing rules
  await p.click('button:has-text("Aggiungi una regola")'); await p.fill('input[list=hba-users]', 'ext'); await p.fill('input[placeholder="10.0.20.0/24"]', '10.9.9.0/24');
  await p.selectOption('select[aria-label="Validità della regola"]', '8'); await p.click('button:has-text("Aggiungi alla lista")'); await p.waitForSelector('text=Temporanea · scade tra 8 h');
  await p.click('button:has-text("Adotta nel blocco gestito")'); await p.waitForSelector('td:has-text("amministra")', { timeout: 3000 }).catch(() => {});
  await shot('14e0-adopt'); assert.equal(await p.locator('button:has-text("Adotta nel blocco gestito")').count(), 0, 'adopted');
  await p.click('button:has-text("Verifica effetto")'); await p.waitForSelector('text=Connessione simulata'); await shot('14f-hba-adopt');
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
  // a server announces itself (agent installed without a token) -> banner -> approve
  { const fp = 'e2efingerprint0000000001', secret = 'a'.repeat(64); const sh = require('crypto').createHash('sha256').update(secret).digest('hex');
    const r = await p.request.post(base + '/api/agent/request-join', { data: { fingerprint: fp, secret_hash: sh, node_name: 'e2e-new', agent_version: '2.0', discovery: { postgres_instances: [{ version: '16.4', data_directory: '/var/lib/postgresql/16/main', port: 5432, cluster_key: 'sysid:e2e-new-key', role: 'primary' }] } } });
    assert.equal(r.status(), 201);
    await p.goto(base + '/#/'); await p.waitForSelector('text=Nuovo server rilevato: e2e-new', { timeout: 15000 }); await p.click('.join-banner button:has-text("Esamina")');
    await p.waitForSelector('text=Aggiungere e2e-new?'); await p.selectOption('.modal select', 'dev'); await shot('15a-join');
    await p.click('.modal button:has-text("Approva e collega")'); await p.waitForSelector('text=Server approvato', { timeout: 10000 });
    const st = await p.request.post(base + '/api/agent/join-status', { data: { fingerprint: fp, secret } }); assert.equal((await st.json()).status, 'approved'); }
  // today + settings
  await p.goto(base + '/#/today'); await p.waitForSelector('h1:has-text("Oggi")'); await p.waitForSelector('.banner', { timeout: 10000 }); await shot('16a-today');
  await p.goto(base + '/#/settings'); await p.waitForSelector('text=Aggiungi canale'); await p.click('button:has-text("Aggiungi canale")');
  await p.fill('input[aria-label="Nome del canale"]', 'Slack DBA'); await p.fill('input[aria-label="Indirizzo del webhook"]', 'https://hooks.example.com/services/T0/B0/abcd1234');
  await p.click('button:has-text("Salva")'); await p.waitForSelector('text=Notifiche salvate'); await p.waitForSelector('button:has-text("Invia prova")');
  await p.waitForSelector('text=Serve un secondo amministratore'); await shot('16b-settings');
  // users
  await p.goto(base + '/#/users'); await p.waitForSelector('text=Nuovo utente'); await p.click('button:has-text("Nuovo utente")');
  await p.fill('.modal input >> nth=0', 'operatore1'); await p.fill('.modal input[type=password]', 'operator-password-1'); await p.click('.modal button:has-text("Crea utente")');
  await p.waitForSelector('tr:has-text("operatore1")'); await shot('15e-users');
  // attach wizard
  await p.goto(base + '/#/'); await p.click('button:has-text("Collega cluster") >> nth=0'); await p.waitForSelector('text=Con agent (consigliato)'); await p.click('text=Con agent (consigliato)');
  await p.click('button:has-text("Genera comando")'); await p.waitForSelector('text=PG_ARCA_ENROLL_TOKEN'); await shot('16-attach');
  // operational machines: sidebar entry, list, detail, check as recovery host, use for recoveries
  await p.keyboard.press('Escape').catch(() => {});
  await p.goto(base + '/#/workers'); await p.waitForSelector('td:has-text("bk01")'); await shot('18a-workers');
  await p.click('.side .citem:has-text("bk01")'); await p.waitForSelector('text=Dischi e condivisioni'); await p.waitForSelector('text=/backup');
  await p.click('button:has-text("Verifica come host di recupero")'); await p.waitForSelector('text=Può eseguire i ripristini', { timeout: 15000 }); await shot('18b-worker');
  await p.click('button:has-text("Usala per i ripristini")'); await p.click('.modal button:has-text("Usa questa macchina")'); await p.waitForSelector('text=nodo di recupero per tutti i cluster', { timeout: 10000 });
  // geo-redundancy: the pair, the DR strip on the standby site, endpoint + planned switchover through both DCS
  await p.goto(base + '/#/geo'); await p.waitForSelector('.geosite:has-text("geo-dc2")'); await p.waitForSelector('text=Sito di replica (DR)'); await shot('19a-geo');
  // DR readiness: one-click fixes through the site's DCS
  await p.waitForSelector('.geoready'); await p.click('button:has-text("Attiva la riserva dall’archivio")'); await p.waitForSelector('text=Riserva dall’archivio in attivazione');
  await p.waitForSelector('.geochecks li.ok:has-text("pg-arca-wal")', { timeout: 20000 }).catch(() => null);
  await p.click('button:has-text("Attiva pg_rewind") >> nth=0'); await p.waitForSelector('text=pg_rewind in attivazione'); await shot('19a2-geo-ready');
  await p.click('button:has-text("Switchover pianificato verso geo-dc2")'); await p.fill('.modal input.mono >> nth=0', 'dc2-haproxy'); await p.click('.modal button:has-text("Salva")');
  await p.waitForSelector('.modal button:has-text("Avvia lo switchover")'); await p.fill('.modal input.input', 'SWITCHOVER'); await p.click('.modal button:has-text("Avvia lo switchover")');
  await p.waitForSelector('.geojob:has-text("completato")', { timeout: 30000 }); await p.waitForSelector('.geosite.primary:has-text("geo-dc2")', { timeout: 15000 }); await shot('19b-geo-switched');
  // pg_hba on a Patroni site: DCS only, previous versions kept by the console and restorable
  await p.goto(base + '/#/'); const g1 = await p.locator('.fleettable a:has(strong:text-is("geo-dc1"))').getAttribute('href'); await p.goto(base + '/' + g1 + '/hba');
  await p.waitForSelector('text=Patroni non può aprire la connessione di replica locale', { timeout: 20000 }); await shot('14f2-hba-patroni-local');
  await p.waitForSelector('text=Patroni · configurazione condivisa (DCS)'); await p.waitForSelector('text=Altre regole della lista nel DCS');
  await p.click('button:has-text("Aggiungi una regola")'); await p.fill('input[list=hba-users]', 'app'); await p.fill('input[placeholder="10.0.20.0/24"]', '172.30.9.0/24');
  await p.click('button:has-text("Aggiungi alla lista")'); await p.click('button:has-text("Verifica effetto")'); await p.waitForSelector('text=Connessione simulata');
  await p.click('button:has-text("Applica a tutto il cluster")'); await p.click('.modal button:has-text("Applica")'); await p.waitForSelector('text=written to the DCS', { timeout: 15000 });
  await p.waitForSelector('.card:has-text("Versioni precedenti") button:has-text("Ripristina")', { timeout: 15000 }); await shot('14g-hba-dcs');
  await p.click('.card:has-text("Versioni precedenti") button:has-text("Ripristina") >> nth=0'); await p.click('.modal button:has-text("Ripristina nel DCS")');
  await p.waitForSelector('text=Versione ripristinata nel DCS', { timeout: 15000 });
  // relationships: the standby site sits under its primary (auto); "no relationship" detaches it; a cluster without telemetry declared as replica by hand
  await p.goto(base + '/#/'); await p.waitForSelector('.fleettable tr.replicarow');
  const stbyName = (await p.locator('.fleettable tr.replicarow strong').first().innerText()).trim();
  await p.click(`.fleettable tr:has(strong:text-is("${stbyName}")) button:has-text("Organizza")`); await p.check('.modal input[name=glm] >> nth=2'); await p.click('.modal button:has-text("Salva")');
  await p.waitForFunction(() => !document.querySelector('.fleettable tr.replicarow'), null, { timeout: 15000 });
  await p.click(`.fleettable tr:has(strong:text-is("${stbyName}")) button:has-text("Organizza")`); await p.check('.modal input[name=glm] >> nth=0'); await p.click('.modal button:has-text("Salva")');
  await p.waitForSelector('.fleettable tr.replicarow', { timeout: 15000 });
  await p.click('.fleettable tr:has(strong:text-is("pg-e2e-new")) button:has-text("Organizza")'); await p.check('.modal input[name=glm] >> nth=1');
  await p.selectOption('.modal fieldset select', { label: 'prodpg · prod' }); await p.click('.modal button:has-text("Salva")');
  await p.waitForSelector('.fleettable tr.replicarow:has-text("pg-e2e-new")', { timeout: 15000 }); await shot('19c-manual-link');
  await p.goto(base + '/#/geo'); await p.waitForSelector('.geosite:has-text("impostato a mano")'); await shot('19d-geo-manual');
  // mobile
  await p.setViewportSize({ width: 390, height: 800 }); await shot('17-mobile');
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no page errors'); assert.strictEqual(errs.length, 0);
  await b.close(); console.log('UI e2e OK');
})().catch(async e => { console.error('FAIL', e.message); try { await global.__p.screenshot({ path: `${out}/fail.png` }); } catch { /* no page */ } process.exit(1); });
