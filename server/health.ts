/**
 * Fleet health: a PURE evaluation of the persisted state (agent telemetry + operations journal + resolved policy) into a list of issues.
 * Every issue carries a plain-language cause and a suggested next step, so the briefing says what is wrong AND what to do.
 * No I/O here: the same function feeds the "Oggi" page, the notification dispatcher and the tests.
 */
import { resolvePolicy } from './policies';

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

    if (!primary) add({ severity: 'critical', code: 'no_primary', title: 'Nessun primario raggiungibile', cause: online.length ? 'Gli agenti rispondono ma nessun nodo riporta il ruolo di primario.' : 'Nessun agente del cluster risponde da più di 45 secondi.', action: { label: 'Apri il cluster', page: 'cluster' } });
    for (const n of nodes.filter(x => !on(x))) {
      if (!primary && online.length === 0 && nodes.length === 1) break;           // already covered by no_primary
      add({ severity: 'warning', code: 'node_offline', detail: n.id, nodeId: n.id, nodeName: n.name, title: `Nodo ${n.name} non risponde`, cause: n.lastSeen ? `Ultimo contatto ${new Date(n.lastSeen).toISOString()}. Agente fermo, server spento o rete interrotta.` : 'Questo nodo non ha mai inviato dati.' });
    }
    const pg = primary?.snapshot?.postgres || {};
    const pol = resolvePolicy(st, c).policy;

    // ---- backups
    const bk = (nodes.filter(n => n.snapshot?.backup?.configured).sort((a, b) => (b.snapshot.backup.sets || 0) - (a.snapshot.backup.sets || 0))[0] || primary)?.snapshot?.backup;
    const sets: any[] = (bk?.recent_sets || []).filter((s: any) => s.status === 'COMPLETE');
    const last = sets.length ? sets[sets.length - 1] : null;
    const lastMs = last ? ts(last.start_time) : NaN;
    const expectH = pol?.enabled ? Math.min(pol.fullEveryHours, pol.incrEveryHours || pol.fullEveryHours) : 0;
    if (!sets.length) {
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
    if (isProd && sets.length && (!lastDrill || now - Date.parse(lastDrill.updatedAt) > 90 * 86400_000))
      add({ severity: 'info', code: 'drill_stale', title: lastDrill ? 'Prova di disaster recovery vecchia di oltre 90 giorni' : 'Mai provato il ripristino completo', cause: lastDrill ? 'Una prova periodica conferma che il ripristino funziona ancora e quanto tempo richiede.' : 'Non sai ancora quanto tempo servirebbe a ripristinare l’intero cluster: una prova lo misura senza toccare la produzione.', action: { label: 'Vedi i backup', page: 'backup' } });

    // ---- WAL / archiving
    const wal = (primary || nodes[0])?.snapshot?.wal;
    if (wal && wal.gap_count > 0) add({ severity: 'critical', code: 'wal_gap', title: `Archivio WAL con ${wal.gap_count} buco/i`, cause: 'Mancano segmenti WAL: il recupero a un istante preciso oltre il buco non è possibile. Esegui subito un nuovo backup completo.', action: { label: 'Vedi il recupero', page: 'restore' } });
    if (wal && wal.conflicts > 0) add({ severity: 'critical', code: 'wal_conflict', title: 'Segmenti WAL divergenti in quarantena', cause: 'Due server hanno archiviato contenuti diversi per lo stesso segmento: possibile split-brain. Verifica quale nodo è il primario.', action: { label: 'Apri il cluster', page: 'cluster' } });
    const arch = pg.archiver;
    if (arch?.last_failed_time && (!arch.last_archived_time || ts(arch.last_failed_time) > ts(arch.last_archived_time)) && now - ts(arch.last_failed_time) < 3600_000 * 6)
      add({ severity: 'critical', code: 'archiver_failing', title: 'L’archiviazione dei WAL sta fallendo', cause: `Ultimo segmento fallito: ${arch.last_failed_wal || '?'}. Finché non si risolve i WAL si accumulano sul server e il disco si riempie.`, action: { label: 'Vedi i backup', page: 'backup' } });
    if (pol?.enabled && pg.settings && pg.settings.archive_mode === 'off') add({ severity: 'warning', code: 'archive_off', title: 'archive_mode è spento', cause: 'La strategia di backup è attiva ma PostgreSQL non archivia i WAL: nessun recupero a un istante preciso.', action: { label: 'Vedi i backup', page: 'backup' } });

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
      if (n.snapshot?.postgres?.pending_restart?.length) add({ severity: 'info', code: 'pending_restart', detail: n.id, nodeId: n.id, nodeName: n.name, title: `${n.name}: riavvio in sospeso`, cause: `Parametri modificati ma non ancora attivi: ${n.snapshot.postgres.pending_restart.slice(0, 5).join(', ')}.` });
    }
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.clusterName.localeCompare(b.clusterName));
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
    last24h: { operations: recentOps.length, failed: recentOps.filter(o => o.status === 'failed').length, backups: recentOps.filter(o => o.type === 'backup_run' && o.status === 'succeeded').length,
      failures: recentOps.filter(o => o.status === 'failed').slice(-5).reverse().map(o => ({ id: o.id, type: o.type, clusterId: o.clusterId, at: o.updatedAt, error: String(o.error?.message || o.error || '').slice(0, 200) })) },
  };
}
