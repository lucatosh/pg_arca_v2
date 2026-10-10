/**
 * Agentless ("direct") cluster attach: the console talks to PostgreSQL over libpq (node-postgres)
 * and, optionally, to the Patroni REST API. Same operation journal and idempotency guarantees as
 * agent mode; the capability set is smaller and every response says what is unavailable and why.
 *
 * Connection secrets are AES-256-GCM encrypted at rest (store.ts). A least-privilege role is
 * recommended: `pg_monitor` + `pg_read_all_settings` (+ superuser only if ALTER SYSTEM / pg_switch_wal
 * are wanted from the console). Each call reports which of these the role actually has.
 */
import pg from 'pg';
import { classify, MIN_LEGACY } from './pgcompat';
import { Store, DirectConnection, encrypt, decrypt, newId, nowIso } from './store';
import { audit } from './ops';
import { lsnToBig } from './view';

export interface ConnInput {
  host: string; port?: number; database?: string; user: string; password?: string;
  sslmode?: 'disable' | 'require' | 'verify-full'; caCertPem?: string;
  patroniUrl?: string; patroniUser?: string; patroniPassword?: string;
}

const KEY_SETTINGS = ['port', 'listen_addresses', 'wal_level', 'archive_mode', 'archive_command', 'archive_timeout', 'max_wal_senders',
  'max_connections', 'wal_log_hints', 'data_checksums', 'shared_preload_libraries', 'hot_standby', 'max_wal_size', 'shared_buffers',
  'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'checkpoint_timeout', 'checkpoint_completion_target', 'synchronous_standby_names',
  'synchronous_commit', 'wal_compression', 'wal_keep_size', 'autovacuum', 'cluster_name'];

export function validateConnInput(c: ConnInput): string | null {
  if (!c || typeof c.host !== 'string' || !/^[A-Za-z0-9_.:-]{1,253}$/.test(c.host)) return 'invalid host';
  if (c.port !== undefined && !(Number.isInteger(c.port) && c.port > 0 && c.port < 65536)) return 'invalid port';
  if (typeof c.user !== 'string' || !c.user || c.user.length > 63) return 'user required';
  if (c.sslmode && !['disable', 'require', 'verify-full'].includes(c.sslmode)) return 'invalid sslmode';
  if (c.sslmode === 'verify-full' && !c.caCertPem) return 'verify-full needs the CA certificate (PEM)';
  if (c.patroniUrl && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(c.patroniUrl)) return 'invalid patroniUrl (http(s)://host:8008)';
  return null;
}

function clientConfig(c: { host: string; port: number; database: string; user: string; sslmode: string; caCertPem?: string }, password?: string, database?: string): pg.ClientConfig {
  return {
    host: c.host, port: c.port, database: database || c.database, user: c.user, password,
    ssl: c.sslmode === 'disable' ? false : c.sslmode === 'verify-full' ? { rejectUnauthorized: true, ca: c.caCertPem } : { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000,
    application_name: 'pg_arca_console',
  };
}

async function withClient<T>(cfg: pg.ClientConfig, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(cfg);
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => undefined); }
}

const q = async (c: pg.Client, sql: string, params: any[] = []) => (await c.query(sql, params)).rows;
const tryq = async (c: pg.Client, sql: string, params: any[] = []) => { try { return await q(c, sql, params); } catch { return null; } };

/** One consistent read-only pass. Output mirrors the agent's snapshot.postgres so the same view code applies. */
export async function introspect(cfg: pg.ClientConfig) {
  return withClient(cfg, async c => {
    await c.query('SET default_transaction_read_only = on');
    const [{ ver, rec, maxc }] = await q(c, `SELECT current_setting('server_version') ver, pg_is_in_recovery() rec, current_setting('max_connections')::int maxc`);
    const cmp = classify(String(ver)); if (cmp?.tier === 'unsupported') throw new Error(`PostgreSQL ${cmp.label} non è supportato (minimo ${MIN_LEGACY}): la connessione diretta richiede funzioni di monitoraggio introdotte nella 10.`);
    const [role] = await q(c, `SELECT rolsuper, pg_has_role(current_user,'pg_monitor','member') monitor,
                                      pg_has_role(current_user,'pg_read_all_settings','member') settings FROM pg_roles WHERE rolname=current_user`);
    const lsnRow = await q(c, rec ? 'SELECT pg_last_wal_replay_lsn()::text lsn' : 'SELECT pg_current_wal_lsn()::text lsn');
    const lsn: string | null = lsnRow[0]?.lsn ?? null;
    let timeline: number | null = null;
    if (!rec && lsn) { const r = await tryq(c, 'SELECT substr(pg_walfile_name(pg_current_wal_lsn()),1,8) h'); if (r) timeline = parseInt(r[0].h, 16); }
    else { const r = await tryq(c, 'SELECT received_tli FROM pg_stat_wal_receiver'); if (r?.[0]) timeline = r[0].received_tli; }
    const sys = await tryq(c, 'SELECT system_identifier::text sid FROM pg_control_system()');
    const dbs = await q(c, `SELECT d.oid::int oid, d.datname name, pg_database_size(d.oid)::bigint size FROM pg_database d WHERE NOT d.datistemplate AND d.datallowconn ORDER BY 2`);
    const set = await tryq(c, `SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name = ANY($1)`, [KEY_SETTINGS]) || [];
    const repl = rec ? [] : (await tryq(c, `SELECT application_name, client_addr::text, state, sync_state,
         sent_lsn::text, replay_lsn::text, COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn),0)::bigint replay_lag_bytes,
         COALESCE(EXTRACT(EPOCH FROM replay_lag)*1000,0)::bigint replay_lag_ms FROM pg_stat_replication`)) || [];
    const arch = await tryq(c, `SELECT archived_count, failed_count, last_archived_wal, last_archived_time, last_failed_wal, last_failed_time FROM pg_stat_archiver`);
    const act = await tryq(c, `SELECT count(*)::int n FROM pg_stat_activity WHERE backend_type='client backend'`);
    const xact = await tryq(c, `SELECT COALESCE(sum(xact_commit+xact_rollback),0)::bigint t FROM pg_stat_database`);
    return {
      alive: true, version: ver as string, is_in_recovery: !!rec, role: rec ? 'standby' : 'primary',
      current_lsn: lsn, timeline, system_identifier: sys?.[0]?.sid ?? null,
      databases: dbs.map((d: any) => ({ oid: d.oid, name: d.name, size: Number(d.size) })),
      settings: Object.fromEntries(set.map((s: any) => [s.name, s.setting + (s.unit || '')])),
      pending_restart: set.filter((s: any) => s.pending_restart).map((s: any) => s.name),
      replication: repl.map((r: any) => ({ ...r, replay_lag_bytes: Number(r.replay_lag_bytes), replay_lag_ms: Number(r.replay_lag_ms) })),
      archiver: arch?.[0] ?? null, connections: { used: act?.[0]?.n ?? 0, max: maxc },
      xact_total: xact ? Number(xact[0].t) : null,
      privileges: { superuser: !!role?.rolsuper, pg_monitor: !!role?.monitor, pg_read_all_settings: !!role?.settings || !!role?.rolsuper },
    };
  });
}

// ---------------------------------------------------------------------------
// Patroni REST (optional in direct mode)
// ---------------------------------------------------------------------------
async function patroni(c: { patroniUrl?: string; patroniUser?: string }, pw: string | undefined, method: string, path: string, body?: any) {
  if (!c.patroniUrl) throw new Error('Patroni REST URL not configured for this cluster');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (c.patroniUser) headers.authorization = 'Basic ' + Buffer.from(`${c.patroniUser}:${pw || ''}`).toString('base64');
  const r = await fetch(c.patroniUrl.replace(/\/$/, '') + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

// ---------------------------------------------------------------------------
// Driver bound to a Store + secret key
// ---------------------------------------------------------------------------
export class DirectDriver {
  constructor(private store: Store, private key: Buffer) {}

  private conn(clusterId: string): DirectConnection {
    const c = this.store.peek().directConnections[clusterId];
    if (!c) throw new Error('no direct connection stored for this cluster');
    return c;
  }
  private pw(c: DirectConnection) { return c.passwordEnc ? decrypt(this.key, c.passwordEnc) : undefined; }
  private cfg(c: DirectConnection, db?: string) { return clientConfig(c, this.pw(c), db); }
  private ppw(c: DirectConnection) { return c.patroniPasswordEnc ? decrypt(this.key, c.patroniPasswordEnc) : undefined; }

  async test(input: ConnInput) {
    const bad = validateConnInput(input);
    if (bad) throw Object.assign(new Error(bad), { code: 'INVALID' });
    const snap = await introspect(clientConfig({ host: input.host, port: input.port || 5432, database: input.database || 'postgres', user: input.user,
                                                 sslmode: input.sslmode || 'require', caCertPem: input.caCertPem }, input.password));
    let patroniInfo: any = null;
    if (input.patroniUrl) {
      try { patroniInfo = (await patroni(input, input.patroniPassword, 'GET', '/cluster')).json; } catch (e: any) { patroniInfo = { error: e.message }; }
    }
    const caps = {
      read_state: true,
      reload: true,
      set_parameters: snap.privileges.superuser,
      wal_switch: snap.privileges.superuser,
      patroni_ops: !!input.patroniUrl && !patroniInfo?.error,
      host_metrics: false,   // CPU / memory / disk need the agent
      backup_restore: false, // physical backup & PITR need the agent on the DB host
    };
    return { snapshot: snap, patroni: patroniInfo, capabilities: caps };
  }

  /** Idempotent attach: same (host, port, system_identifier) returns the existing cluster. */
  async attach(input: ConnInput & { name: string; environment: string }, actor: string) {
    const t = await this.test(input);
    const sid = t.snapshot.system_identifier as string | null;
    const key = sid ? `sysid:${sid}` : `dsn:${input.host}:${input.port || 5432}`;
    const enc = input.password ? encrypt(this.key, input.password) : undefined;
    const penc = input.patroniPassword ? encrypt(this.key, input.patroniPassword) : undefined;
    return this.store.mutate(d => {
      const found = d.clusters.find((c: any) => c.clusterKey === key);
      if (found) return { cluster: found, created: false, test: t };
      const id = newId('cl');
      d.clusters.push({ id, name: input.name, environment: input.environment, clusterKey: key, source: 'direct', isSandbox: false,
                        status: 'healthy', databases: [], hbaRules: [], features: {}, createdAt: nowIso() });
      d.directConnections[id] = { clusterId: id, host: input.host, port: input.port || 5432, database: input.database || 'postgres', user: input.user,
        passwordEnc: enc, sslmode: input.sslmode || 'require', caCertPem: input.caCertPem, patroniUrl: input.patroniUrl, patroniUser: input.patroniUser, patroniPasswordEnc: penc, lastOk: nowIso() };
      audit(d, { clusterId: id, actor, action: 'cluster.attach_direct', status: 'OK', details: { host: input.host, port: input.port || 5432 } });
      return { cluster: d.clusters[d.clusters.length - 1], created: true, test: t };
    });
  }

  /** Refresh one direct cluster's persisted view. Never throws; failures are recorded. */
  async poll(clusterId: string) {
    const c = this.store.peek().directConnections[clusterId];
    if (!c) return;
    try {
      const snap = await introspect(this.cfg(c));
      let members: any[] = [];
      if (c.patroniUrl) { try { members = (await patroni(c, this.ppw(c), 'GET', '/cluster')).json.members || []; } catch { /* optional */ } }
      await this.store.mutate(d => {
        const idx = d.clusters.findIndex((x: any) => x.id === clusterId);
        if (idx < 0) return;
        d.clusters[idx] = buildDirectView(d.clusters[idx], c, snap, members, d.clusters[idx].__prevXact);
        d.clusters[idx].__prevXact = { total: snap.xact_total, at: Date.now() };
        if (d.directConnections[clusterId]) { d.directConnections[clusterId].lastOk = nowIso(); d.directConnections[clusterId].lastError = undefined; }
      });
    } catch (e: any) {
      await this.store.mutate(d => {
        const idx = d.clusters.findIndex((x: any) => x.id === clusterId);
        if (idx >= 0) d.clusters[idx].status = 'degraded';
        if (d.directConnections[clusterId]) d.directConnections[clusterId].lastError = String(e.message).slice(0, 300);
      });
    }
  }

  startPolling(intervalMs = 15000) {
    const tick = async () => {
      const ids = Object.keys(this.store.peek().directConnections);
      await Promise.all(ids.map(id => this.poll(id)));
    };
    tick().catch(() => undefined);
    return setInterval(() => tick().catch(() => undefined), intervalMs);
  }

  /** Operation executor for agentless clusters (called inside ops.runLocal). */
  exec = async (cluster: any, type: string, params: any) => {
    const c = this.conn(cluster.id);
    const run = <T>(fn: (cl: pg.Client) => Promise<T>, db?: string) => withClient(this.cfg(c, db), fn);
    switch (type) {
      case 'pg_reload':
        return run(async cl => ({ reloaded: (await q(cl, 'SELECT pg_reload_conf() ok'))[0].ok }));
      case 'checkpoint':
        return run(async cl => { await cl.query('CHECKPOINT'); return { done: true }; });
      case 'wal_switch':
        return run(async cl => {
          if ((await q(cl, 'SELECT pg_is_in_recovery() r'))[0].r) throw new Error('refused: node is in recovery (standby)');
          return { segment: (await q(cl, 'SELECT pg_walfile_name(pg_switch_wal()) seg'))[0].seg };
        });
      case 'pg_set_param': {
        if (c.patroniUrl) {        // under Patroni the DCS owns parameters: ALTER SYSTEM would be overwritten / diverge
          const r = await patroni(c, this.ppw(c), 'PATCH', '/config', { postgresql: { parameters: { [params.name]: params.value } } });
          if (r.status >= 300) throw new Error(`Patroni refused: ${JSON.stringify(r.json)}`);
          return { via: 'patroni', applied: true, restartMayBeRequired: true };
        }
        return run(async cl => {
          const [s] = await q(cl, 'SELECT setting, unit, context, pending_restart FROM pg_settings WHERE name=$1', [params.name]);
          if (!s) throw new Error(`unknown parameter ${params.name}`);
          const lit = params.value === null ? 'DEFAULT' : cl.escapeLiteral(String(params.value));
          const before = s.setting;
          await cl.query(`ALTER SYSTEM ${params.value === null ? 'RESET ' + cl.escapeIdentifier(params.name) : 'SET ' + cl.escapeIdentifier(params.name) + ' = ' + lit}`);
          await cl.query('SELECT pg_reload_conf()');
          const [a] = await q(cl, 'SELECT setting, pending_restart FROM pg_settings WHERE name=$1', [params.name]);
          return { via: 'alter_system', before, after: a.setting, restartRequired: a.pending_restart || s.context === 'postmaster', changed: before !== a.setting || a.pending_restart };
        });
      }
      case 'list_objects':
        return run(async cl => ({ objects: await q(cl, `SELECT n.nspname schema, c.relname "table", c.relkind, pg_total_relation_size(c.oid)::bigint size_bytes, c.reltuples::bigint rows_estimate
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 4 DESC LIMIT 5000`) }), params.database);
      case 'patroni_switchover': case 'patroni_failover': case 'patroni_restart': case 'patroni_reload': case 'patroni_pause': case 'patroni_config_patch': {
        const pw = this.ppw(c);
        if (type === 'patroni_switchover') {
          const cur = (await patroni(c, pw, 'GET', '/cluster')).json;
          const leader = (cur.members || []).find((m: any) => m.role === 'leader' || m.role === 'master' || m.role === 'primary');
          if (!leader || leader.name !== params.leader) throw new Error(`stale request: current leader is '${leader?.name}', not '${params.leader}'`);
          const r = await patroni(c, pw, 'POST', '/switchover', { leader: params.leader, candidate: params.candidate, scheduled_at: params.scheduled_at });
          if (r.status >= 300) throw new Error(`Patroni refused: ${JSON.stringify(r.json)}`);
          return r.json;
        }
        const map: Record<string, [string, string, any]> = {
          patroni_failover: ['POST', '/failover', { candidate: params.candidate }],
          patroni_restart: ['POST', '/restart', params.role ? { role: params.role } : {}],
          patroni_reload: ['POST', '/reload', undefined],
          patroni_pause: ['PATCH', '/config', { pause: params.enable }],
          patroni_config_patch: ['PATCH', '/config', params.patch],
        };
        const [m, p, b] = map[type];
        const r = await patroni(c, pw, m, p, b);
        if (r.status >= 300) throw new Error(`Patroni refused (${r.status}): ${JSON.stringify(r.json)}`);
        return r.json;
      }
      default:
        throw new Error(`'${type}' needs the pg_arca agent on the database host`);
    }
  };
}

function buildDirectView(prior: any, c: DirectConnection, snap: any, members: any[], prev?: { total: number; at: number }) {
  const now = Date.now();
  const nodes: any[] = [];
  const primaryName = members.find(m => m.role === 'leader' || m.role === 'master' || m.role === 'primary')?.name;
  if (!snap.is_in_recovery || !members.length) {
    nodes.push({ name: primaryName || c.host, role: snap.is_in_recovery ? 'replica' : 'primary', state: 'running', host: c.host, port: c.port, timeline: snap.timeline ?? 0, lsn: snap.current_lsn || '',
      replicationLagBytes: 0, replicationLagMs: 0, dcsLeader: !snap.is_in_recovery && !!members.length, cpuPercent: 0, memoryPercent: 0,
      connections: snap.connections.used, maxConnections: snap.connections.max, online: true, source: 'direct', metricsAvailable: false });
  }
  for (const m of members) {
    if (nodes.some(n => n.name === m.name)) continue;
    const r = snap.replication.find((x: any) => x.application_name === m.name);
    nodes.push({ name: m.name, role: m.role === 'leader' ? 'primary' : (r?.sync_state === 'sync' ? 'sync_standby' : m.role === 'sync_standby' ? 'sync_standby' : 'replica'),
      state: m.state || 'unknown', host: m.host, port: m.port || 5432, timeline: m.timeline || 0, lsn: '', replicationLagBytes: Number(r?.replay_lag_bytes ?? m.lag ?? 0),
      replicationLagMs: Number(r?.replay_lag_ms ?? 0), dcsLeader: m.role === 'leader', cpuPercent: 0, memoryPercent: 0, connections: 0, maxConnections: 0,
      online: m.state === 'running' || m.state === 'streaming', source: 'patroni', metricsAvailable: false });
  }
  if (!members.length) for (const r of snap.replication) {
    nodes.push({ name: r.application_name || r.client_addr, role: r.sync_state === 'sync' ? 'sync_standby' : 'replica', state: r.state, host: r.client_addr || '', port: 5432, timeline: snap.timeline ?? 0,
      lsn: r.replay_lsn || '', replicationLagBytes: r.replay_lag_bytes, replicationLagMs: r.replay_lag_ms, dcsLeader: false, cpuPercent: 0, memoryPercent: 0, connections: 0, maxConnections: 0,
      online: r.state === 'streaming', source: 'direct', metricsAvailable: false });
  }
  const dbs = snap.databases.map((d: any) => ({ oid: String(d.oid), name: d.name, size: d.size, schemas: (prior.databases || []).find((x: any) => x.name === d.name)?.schemas || [] }));
  let tps = prior.tps || 0;
  if (prev && snap.xact_total !== null && snap.xact_total >= prev.total && now > prev.at) tps = Math.round(((snap.xact_total - prev.total) / ((now - prev.at) / 1000)) * 10) / 10;
  const lag = nodes.some(n => n.role !== 'primary' && n.replicationLagBytes > 64 * 1024 * 1024);
  return {
    ...prior, pgVersion: snap.version, status: nodes.some(n => !n.online) || lag ? 'degraded' : 'healthy', tps,
    totalSizeBytes: dbs.reduce((a: number, d: any) => a + d.size, 0), activeTimeline: snap.timeline ?? 0, currentLSN: snap.current_lsn || '',
    databases: dbs, liveAt: new Date(now).toISOString(), privileges: snap.privileges, settings: snap.settings, pendingRestart: snap.pending_restart, archiver: snap.archiver,
    haState: { clusterName: prior.name, dcsType: members.length ? 'patroni' : 'none', dcsEndpoint: c.patroniUrl || '', failoverMode: members.length ? 'auto' : 'manual',
               maintenanceMode: false, activeTimeline: snap.timeline ?? 0, nodes, managedByPatroni: members.length > 0 },
  };
}

export { lsnToBig };
