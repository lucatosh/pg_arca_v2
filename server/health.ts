/**
 * Fleet health: a PURE evaluation of the persisted state (agent telemetry + operations journal + resolved policy) into a list of issues.
 * Every issue carries a plain-language cause and a suggested next step, so the briefing says what is wrong AND what to do.
 * No I/O here: the same function feeds the "Oggi" page, the notification dispatcher and the tests.
 */
import { resolvePolicy } from './policies';
import { classify } from './pgcompat';
import { geoIssues } from './geo';
import { resolveScoped } from './scoped';

export type Severity = 'critical' | 'warning' | 'info';
export interface Issue {
  key: string;                       // stable: <clusterId>:<code>[:<detail>] -> used to de-duplicate notifications
  clusterId: string; clusterName: string; environment: string; nodeId?: string; nodeName?: string;
  severity: Severity; code: string; title: string; cause: string; action?: { label: string; page?: string };
}
export const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const ONLINE_MS = 45_000;
const GB = 1024 ** 3;
const hrs = (h: number) => (h >= 48 ? `${Math.round(h / 24)} giorni` : `${Math.round(h)} ore`);
const bytesH = (b: number) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
const ts = (s?: string) => (s ? Date.parse(s) : NaN);

export function evaluate(st: any, now = Date.now()): Issue[] {
  const out: Issue[] = [];
  for (const c of st.clusters as any[]) {
    if (c.isSandbox || c.source === 'direct') continue;
    const nodes = Object.values(st.nodes).filter((n: any) => n.clusterId === c.id) as any[];
    if (!nodes.length) continue;
    const add = (i: Omit<Issue, 'clusterId' | 'clusterName' | 'environment' | 'key'> & { detail?: string }) => {
      const { detail, ...rest } = i;
      out.push({ ...rest, key: `${c.id}:${i.code}${detail ? ':' + detail : ''}`, clusterId: c.id, clusterName: c.name, environment: c.environment });
    };
    const on = (n: any) => !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;
    const online = nodes.filter(on);
    const primary = online.find(n => n.snapshot?.postgres?.is_in_recovery === false);
    const isProd = c.environment === 'prod';

    // geo DR site (Patroni standby cluster): no primary by design; its own findings (replication between sites) come from geo.ts
    const standbySite = !primary && online.some(n => n.snapshot?.patroni?.local_node?.role === 'standby_leader' || n.snapshot?.patroni?.standby_cluster);
    if (!primary && !standbySite) add({ severity: 'critical', code: 'no_primary', title: 'Nessun primario raggiungibile', cause: online.length ? 'Gli agenti rispondono ma nessun nodo riporta il ruolo di primario.' : 'Nessun agente del cluster risponde da più di 45 secondi.', action: { label: 'Apri il cluster', page: 'cluster' } });
    for (const n of nodes.filter(x => !on(x))) {
      if (!primary && online.length === 0 && nodes.length === 1) break;           // already covered by no_primary
      add({ severity: 'warning', code: 'node_offline', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Nodo ${n.name} non risponde`, cause: n.lastSeen ? `Ultimo contatto ${new Date(n.lastSeen).toISOString()}. Agente fermo, server spento o rete interrotta.` : 'Questo nodo non ha mai inviato dati.' });
    }
    // Patroni members with no agent: if the nodes WITH an agent fail, nothing can run backups/restores/HBA changes there.
    const known = new Set(nodes.map((n: any) => n.name));
    const orphan = new Map<string, any>();
    for (const n of online) for (const m of (n.snapshot?.patroni?.members || [])) if (m?.name && !known.has(m.name) && !orphan.has(m.name)) orphan.set(m.name, m);
    for (const [name, m] of orphan) add({ severity: 'warning', code: 'node_without_agent', detail: name, nodeName: name, title: `Nodo ${name} senza agent`, cause: `Patroni lo vede (${m.role || 'membro'}, ${m.state || 'stato sconosciuto'}) ma non c’è un agent: se i nodi con l’agent si fermano, backup, ripristini e modifiche non sono possibili. Installa l’agent su ogni nodo del cluster.`, action: { label: 'Collega il nodo', page: 'cluster' } });
    const pg = primary?.snapshot?.postgres || {};
    const pol = resolvePolicy(st, c).policy;

    // ---- a database still marked "restore in progress" while no restore is running: the restore was interrupted (agent restart, crash) and the copy is INCOMPLETE
    const busy = new Set((st.operations || []).filter((o: any) => o.clusterId === c.id && ['queued', 'leased', 'running'].includes(o.status) && o.type === 'restore_database').map((o: any) => o.params?.new_name));
    for (const d of (pg.databases || []) as any[]) {
      if (d?.restoring && !busy.has(d.name)) add({ severity: 'warning', code: 'restore_incomplete', detail: d.name, title: `Database ${d.name}: ripristino interrotto`,
        cause: 'Il ripristino che lo stava riempiendo non è arrivato alla fine: il contenuto è incompleto. Eliminalo e ripeti il ripristino.', action: { label: 'Vai al ripristino', page: 'restore' } });
    }

    // ---- backups
    const bk = (nodes.filter(n => n.snapshot?.backup?.configured).sort((a, b) => (b.snapshot.backup.sets || 0) - (a.snapshot.backup.sets || 0))[0] || primary)?.snapshot?.backup;
    const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
    const last = sets.length ? sets[sets.length - 1] : null;
    const lastMs = last ? ts(last.start_time) : NaN;
    const expectH = pol?.enabled ? Math.min(pol.fullEveryHours, pol.incrEveryHours || pol.fullEveryHours) : 0;
    if (!sets.length && standbySite) {
      // backups are taken on the primary site (same database, shared repository): nothing to report here
    } else if (!sets.length) {
      add({ severity: isProd || pol?.enabled ? 'critical' : 'warning', code: 'no_backup', title: 'Nessun backup completo', cause: pol?.enabled ? 'La strategia è attiva ma non esiste ancora un backup riuscito.' : 'Il cluster non ha una strategia di backup né backup eseguiti: i dati non sono protetti.', action: { label: pol?.enabled ? 'Vedi i backup' : 'Assegna una strategia', page: pol?.enabled ? 'backup' : 'strategy' } });
    } else if (expectH && Number.isFinite(lastMs) && now - lastMs > expectH * 3600_000 * 2) {
      const age = (now - lastMs) / 3600_000;
      add({ severity: age > expectH * 4 ? 'critical' : 'warning', code: 'backup_stale', title: `Ultimo backup di ${hrs(age)} fa`, cause: `La strategia prevede un backup ogni ${hrs(expectH)}: ne manca almeno uno. Controlla l’ultimo errore o se l’agente è offline.`, action: { label: 'Vedi i backup', page: 'backup' } });
    }
    const failedSince = (bk?.last_failure && (!last || ts(bk.last_failure.start_time) > lastMs)) ? bk.last_failure : null;
    if (failedSince) add({ severity: 'warning', code: 'backup_failed', title: 'L’ultimo tentativo di backup è fallito', cause: String(failedSince.reason || 'Motivo non riportato.').slice(0, 300), action: { label: 'Vedi i backup', page: 'backup' } });
    const lastVerify = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'backup_verify' && o.status === 'succeeded').map(o => ts(o.updatedAt)).sort().pop();
    if (pol?.enabled && pol.verifyEveryHours && sets.length) {
      const base = Number.isFinite(lastVerify as number) ? (lastVerify as number) : lastMs;
      if (now - base > pol.verifyEveryHours * 3600_000 * 2) add({ severity: 'info', code: 'verify_stale', title: 'Verifica dei backup in ritardo', cause: lastVerify ? `Ultima verifica riuscita ${hrs((now - lastVerify) / 3600_000)} fa.` : 'Nessuna verifica riuscita finora: un backup non verificato è solo una speranza.', action: { label: 'Vedi i backup', page: 'backup' } });
    }

    const drills = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'restore_drill' && o.status === 'succeeded');
    const lastDrill = drills.length ? drills[drills.length - 1] : null;
    if (isProd && sets.length && !standbySite && (!lastDrill || now - Date.parse(lastDrill.updatedAt) > 90 * 86400_000))
      add({ severity: 'info', code: 'drill_stale', title: lastDrill ? 'Prova di disaster recovery vecchia di oltre 90 giorni' : 'Mai provato il ripristino completo', cause: lastDrill ? 'Una prova periodica conferma che il ripristino funziona ancora e quanto tempo richiede.' : 'Non sai ancora quanto tempo servirebbe a ripristinare l’intero cluster: una prova lo misura senza toccare la produzione.', action: { label: 'Vedi i backup', page: 'backup' } });

    // ---- PostgreSQL version: supported / legacy / end-of-life, and binaries of another major (the agent knows which binaries it uses)
    const seenVer = new Set<string>();
    for (const n of online) {
      const pgn = n.snapshot?.postgres || {};
      const cmp = pgn.compat || (() => { const k = classify(pgn.version); return k ? { label: k.label, problems: k.problems.map(p => ({ severity: p.severity, code: p.code, text: p.text })), tool_problems: [] } : null; })();
      if (!cmp) continue;
      for (const p of (cmp.problems || []) as any[]) {
        const code = 'pg_' + p.code;
        if (seenVer.has(code + cmp.label)) continue;                     // same major on several nodes: one issue per cluster
        seenVer.add(code + cmp.label);
        add({ severity: p.severity, code, detail: String(cmp.label), title: p.code === 'eol' ? `PostgreSQL ${cmp.label} è a fine vita` : p.code === 'unsupported' ? `PostgreSQL ${cmp.label} non supportato` : p.code === 'legacy' ? `PostgreSQL ${cmp.label} in modalità legacy` : `PostgreSQL ${cmp.label} non ancora verificato`, cause: String(p.text || '') });
      }
      for (const t of (cmp.tool_problems || []) as any[])
        add({ severity: t.severity, code: 'pg_' + t.code, detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: binari PostgreSQL non adatti al server`, cause: String(t.text || '') });
    }

    // ---- WAL / archiving
    const wal = (primary || nodes[0])?.snapshot?.wal;
    if (wal && wal.gap_count > 0) add({ severity: 'critical', code: 'wal_gap', title: `Archivio WAL con ${wal.gap_count} buco/i`, cause: 'Mancano segmenti WAL: il recupero a un istante preciso oltre il buco non è possibile. Esegui subito un nuovo backup completo.', action: { label: 'Vedi il recupero', page: 'restore' } });
    if (wal && wal.conflicts > 0) add({ severity: 'critical', code: 'wal_conflict', title: 'Segmenti WAL divergenti in quarantena', cause: 'Due server hanno archiviato contenuti diversi per lo stesso segmento: possibile split-brain. Verifica quale nodo è il primario.', action: { label: 'Apri il cluster', page: 'cluster' } });
    const arch = pg.archiver;
    if (arch?.last_failed_time && (!arch.last_archived_time || ts(arch.last_failed_time) > ts(arch.last_archived_time)) && now - ts(arch.last_failed_time) < 3600_000 * 6)
      add({ severity: 'critical', code: 'archiver_failing', title: 'L’archiviazione dei WAL sta fallendo', cause: `Ultimo segmento fallito: ${arch.last_failed_wal || '?'}${pg.archive_error?.error ? ` — motivo: ${pg.archive_error.error}` : ''}. Finché non si risolve i WAL si accumulano sul server e il disco si riempie.`, action: { label: 'Vedi i backup', page: 'backup' } });
    if (pol?.enabled && pg.settings && pg.settings.archive_mode === 'off') add({ severity: 'warning', code: 'archive_off', title: 'archive_mode è spento', cause: 'La strategia di backup è attiva ma PostgreSQL non archivia i WAL: nessun recupero a un istante preciso.', action: { label: 'Vedi i backup', page: 'backup' } });

    // ---- shared storage: a switchover/failover moves archiving to another node. If every node writes to ITS OWN local repo / WAL archive, the archive splits and PITR breaks silently.
    if (online.length >= 2) {
      for (const [field, what] of [['wal_id', 'L’archivio WAL'], ['repo_id', 'Il repository dei backup']] as const) {
        const ids = new Map<string, string[]>();
        for (const n of online) { const v = n.snapshot?.storage?.[field]; if (v) ids.set(v, [...(ids.get(v) || []), n.name]); }
        if (ids.size >= 2) add({ severity: 'warning', code: field === 'wal_id' ? 'wal_not_shared' : 'repo_not_shared', title: `${what} non è condiviso tra i nodi`, cause: `Ogni nodo scrive nella propria cartella (${[...ids.values()].map(v => v.join(', ')).join(' | ')}). Dopo uno switchover o un failover i WAL e i backup finiscono su un altro nodo e il ripristino a un istante preciso si spezza senza avvisi. Monta lo stesso storage condiviso (NFS, CephFS, volume condiviso…) sullo stesso percorso su ogni nodo e indicalo nelle impostazioni dell’agent.`, action: { label: 'Percorsi dell’agent', page: 'nodes' } });
      }
    }

    // ---- replication / slots / connections / disk
    for (const n of online) {
      const dn = (n.snapshot?.postgres?.replication || []) as any[];
      for (const r of dn) {
        const lag = Number(r.replay_lag_bytes) || 0;
        if (lag > 64 * 1048576) add({ severity: lag > GB ? 'critical' : 'warning', code: 'repl_lag', detail: String(r.application_name), nodeId: n.id, nodeName: n.name, title: `Replica ${r.application_name} in ritardo di ${bytesH(lag)}`, cause: 'La replica non sta recuperando: rete lenta, disco saturo o query lunghe sulla replica.', action: { label: 'Apri il cluster', page: 'cluster' } });
      }
      for (const s of (n.snapshot?.postgres?.slots || []) as any[]) {
        const kept = Number(s.retained_bytes) || 0;
        if (!s.active && kept > GB) add({ severity: kept > 10 * GB ? 'critical' : 'warning', code: 'slot_stale', detail: String(s.name), nodeId: n.id, nodeName: n.name, title: `Slot “${s.name}” inattivo trattiene ${bytesH(kept)} di WAL`, cause: 'Nessuno sta consumando questo slot: PostgreSQL conserva tutti i WAL e il disco si riempie. Se la replica non serve più, elimina lo slot.', action: { label: 'Apri il cluster', page: 'cluster' } });
      }
      const conn = n.snapshot?.postgres?.connections;
      if (conn?.max && conn.used / conn.max > 0.85) add({ severity: conn.used / conn.max > 0.95 ? 'critical' : 'warning', code: 'connections', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Connessioni al ${Math.round(conn.used / conn.max * 100)}% su ${n.name}`, cause: `${conn.used} di ${conn.max}: nuove connessioni saranno rifiutate. Valuta un pooler o l’analisi delle sessioni inattive.`, action: { label: 'Apri il cluster', page: 'cluster' } });
      for (const [label, d] of Object.entries((n.snapshot?.system?.disks || {}) as Record<string, any>)) {
        if (!d?.total_bytes) continue;
        const free = d.free_bytes / d.total_bytes;
        if (free < 0.15) add({ severity: free < 0.07 ? 'critical' : 'warning', code: 'disk', detail: `${n.id}:${label}`, nodeId: n.id, nodeName: n.name, title: `Disco ${label} quasi pieno su ${n.name} (${Math.round(free * 100)}% libero)`, cause: label === 'repo' ? 'Il repository dei backup sta finendo lo spazio: riduci la conservazione o amplia il volume.' : label === 'wal_archive' ? 'L’archivio WAL sta finendo lo spazio: controlla la conservazione dei backup.' : 'Se il disco dei dati si riempie PostgreSQL si ferma.', action: { label: 'Apri il cluster', page: 'cluster' } });
      }
      const pv = n.snapshot?.patroni; const ps = n.snapshot?.postgres?.settings || {};
      if (pv?.accessible && (pv.members?.length || 0) + (pv.standby_cluster ? 1 : 0) >= 2 && !out.some(x => x.key === `${c.id}:patroni_rewind:dcs`)) {
        const hints = ps.wal_log_hints === 'on' || ps.data_checksums === 'on' || n.snapshot?.postgres?.checksums === true;
        if (pv.use_pg_rewind === false || pv.use_pg_rewind == null) add({ severity: 'warning', code: 'patroni_rewind', detail: 'dcs', nodeId: n.id, nodeName: n.name, title: 'Patroni senza pg_rewind (use_pg_rewind spento)',
          cause: 'Dopo un failover il vecchio leader, o una replica rimasta avanti, non può essere riallineato e Patroni lo ricostruisce copiando tutti i dati (o resta fermo). Attiva postgresql.use_pg_rewind nella configurazione dinamica (patronictl edit-config).', action: { label: 'Apri l’alta affidabilità', page: 'ha' } });
        else if (pv.use_pg_rewind === true && ps.wal_log_hints !== undefined && !hints) add({ severity: 'warning', code: 'patroni_rewind', detail: 'dcs', nodeId: n.id, nodeName: n.name, title: 'pg_rewind attivo ma inutilizzabile',
          cause: 'pg_rewind richiede wal_log_hints = on oppure i checksum dei dati: nessuno dei due è attivo, quindi dopo un failover il riallineamento fallisce. Imposta wal_log_hints = on (riavvio necessario).', action: { label: 'Apri i parametri', page: 'params' } });
      }
      const plc = n.snapshot?.postgres?.hba_patroni_local;
      if (plc && plc.ok === false && !out.some(x => x.key === `${c.id}:patroni_local_replication:hba`)) add({ severity: 'warning', code: 'patroni_local_replication', detail: 'hba', nodeId: n.id, nodeName: n.name,
        title: 'pg_hba non consente a Patroni la connessione di replica locale',
        cause: `Patroni legge la timeline delle repliche con una connessione di replica locale (127.0.0.1, utente ${plc.denied.join(', ')}), che pg_hba rifiuta. Dopo un failover una replica (o un intero sito di replica) rimasta avanti rispetto al nuovo leader non viene riallineata con pg_rewind e resta ferma. Regola da aggiungere: ${plc.suggest[0] || ''}.`,
        action: { label: 'Apri le regole di accesso', page: 'hba' } });
      if (n.snapshot?.postgres?.pending_restart?.length) add({ severity: 'info', code: 'pending_restart', detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: riavvio in sospeso`, cause: `Parametri modificati ma non ancora attivi: ${n.snapshot.postgres.pending_restart.slice(0, 5).join(', ')}.` });
    }
  }
  for (const i of geoIssues(st, now)) out.push(i);
  // ---- operational machines: a recovery host that is down or full stops every restore that depends on it
  const centralUsers = (id: string) => Object.entries(((st.settings?.scoped || {}).ephemeral || {}) as Record<string, any>).filter(([, v]) => v?.placement === 'central' && v?.centralNode === id).map(([k]) => k);
  for (const n of Object.values(st.nodes || {}) as any[]) {
    if (n.kind !== 'worker') continue;
    const users = centralUsers(n.id);
    const add = (i: Omit<Issue, 'clusterId' | 'clusterName' | 'environment' | 'key'> & { detail?: string }) => {
      const { detail, ...rest } = i;
      out.push({ ...rest, key: `worker:${n.id}:${i.code}${detail ? ':' + detail : ''}`, clusterId: `worker:${n.id}`, clusterName: n.name, environment: '', nodeId: n.id, nodeName: n.name });
    };
    const isOn = !!n.lastSeen && now - Date.parse(n.lastSeen) < ONLINE_MS;
    if (!isOn) add({ severity: users.length ? 'critical' : 'warning', code: 'worker_offline', title: `Macchina operativa ${n.name} non raggiungibile`, cause: users.length ? `È il nodo dei ripristini per ${users.length} livelli di configurazione: finché non torna, quei ripristini non possono partire.` : 'L’agent non risponde da più di 45 secondi.', action: { label: 'Apri la macchina' } });
    const w = n.snapshot?.worker || {};
    for (const m of (w.mounts || []) as any[]) {
      if (!m.total_bytes) continue;
      const free = m.free_bytes / m.total_bytes;
      if (free < 0.15) add({ severity: free < 0.07 ? 'critical' : 'warning', code: 'worker_disk', detail: m.mount, title: `${n.name}: ${m.mount} quasi pieno (${Math.round(free * 100)}% libero)`, cause: m.remote ? 'Una condivisione di rete usata per i backup sta finendo lo spazio.' : 'Su questa macchina girano ripristini o backup: senza spazio falliscono.', action: { label: 'Apri la macchina' } });
    }
    if (users.length && Array.isArray(w.pg_installations)) {
      const have = new Set((w.pg_installations as any[]).map(i => Number(i.major)));
      // only the clusters that really restore HERE (their effective configuration says central + this machine): another cluster's version is not this machine's business
      const need = new Map<number, string[]>();
      for (const c of st.clusters as any[]) {
        const m = parseInt(String(c.pgVersion || ''), 10);
        if (!m || c.isSandbox) continue;
        let eff: any; try { eff = resolveScoped(st, 'ephemeral', c).value; } catch { continue; }
        if (eff.placement !== 'central' || eff.centralNode !== n.id) continue;
        need.set(m, [...(need.get(m) || []), c.name]);
      }
      const missing = [...need.keys()].filter(m => !have.has(m)).sort((a, b) => a - b);
      if (missing.length) add({ severity: 'warning', code: 'worker_pg_missing', title: `${n.name}: mancano i binari di PostgreSQL ${missing.join(', ')}`,
        cause: `È il nodo dei ripristini di ${missing.map(m => `${(need.get(m) || []).slice(0, 3).join(', ')} (PostgreSQL ${m})`).join('; ')}: non potrà recuperarne i backup finché non installi i binari (dalla pagina della macchina, un clic).`, action: { label: 'Apri la macchina' } });
    }
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.clusterName.localeCompare(b.clusterName));
}

/** An operation refused by a check BEFORE it changed anything: what the operator asked could not or should not be done (not a product failure). */
export function isRefusal(err: string, type = ''): boolean {
  if (/^refused\b|would lock out|refused before touching|lock.?out/i.test(err)) return true;
  if (/^PGA-(SEC-030|GEN-03[0-4]|GEN-065|GEN-08[0-8]|GEN-09[34]|PITR-00[12]|PITR-016|RST-03[1-3]|RST-04[01]|WAL-022|INS-002)\b/.test(err)) return true;
  return type === 'restore_plan';                                              // a plan that says "no" is its answer, not a failure
}

export function briefing(st: any, now = Date.now()) {
  const issues = evaluate(st, now);
  const counts = { critical: 0, warning: 0, info: 0 } as Record<Severity, number>;
  for (const i of issues) counts[i.severity]++;
  const since = now - 24 * 3600_000;
  const recentOps = (st.operations as any[]).filter(o => Date.parse(o.updatedAt) >= since);
  const clusters = (st.clusters as any[]).filter(c => !c.isSandbox && c.source !== 'direct').map(c => {
    const mine = issues.filter(i => i.clusterId === c.id);
    const dr = (st.operations as any[]).filter(o => o.clusterId === c.id && o.type === 'restore_drill' && o.status === 'succeeded').pop();
    return { id: c.id, name: c.name, environment: c.environment, folder: c.folder || '', issues: mine.length, worst: mine[0]?.severity || 'ok', rto: dr?.result?.rto_seconds != null ? { seconds: dr.result.rto_seconds, at: dr.updatedAt, bytes: dr.result.data_bytes } : null };
  });
  return {
    generatedAt: new Date(now).toISOString(), status: counts.critical ? 'critical' : counts.warning ? 'warning' : 'ok', counts, issues, clusters,
    // a safety check that said NO before touching anything (lock-out, wrong target, name taken, plan that cannot work) is not a failure of the product:
    // counted apart, so the number that matters ("something broke") is not drowned
    last24h: (() => {
      const failed = recentOps.filter(o => o.status === 'failed');
      const refusal = (o: any) => isRefusal(String(o.error?.message || o.error || ''), o.type);
      const real = failed.filter(o => !refusal(o));
      return { operations: recentOps.length, failed: real.length, refused: failed.length - real.length, backups: recentOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').length,
        failures: real.slice(-5).reverse().map(o => ({ id: o.id, type: o.type, clusterId: o.clusterId, at: o.updatedAt, error: String(o.error?.message || o.error || '').slice(0, 200) })),
        refusals: failed.filter(refusal).slice(-5).reverse().map(o => ({ id: o.id, type: o.type, clusterId: o.clusterId, at: o.updatedAt, error: String(o.error?.message || o.error || '').slice(0, 200) })) };
    })(),
  };
}
