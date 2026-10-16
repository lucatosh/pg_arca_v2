/**
 * Durable state store.
 *
 * Guarantees:
 *  - ATOMIC: every commit is written to a temp file, fsync'ed, then rename()d over the
 *    live file (POSIX-atomic). A crash leaves either the old or the new state, never a mix.
 *  - SERIALIZED: a mutation function runs synchronously, start to end, on the live state: nothing
 *    can interleave with it (single thread, no await inside), so read-modify-write cycles never mix.
 *  - RECOVERABLE: previous generation kept as state.json.bak and used if the main file is corrupt.
 *  - TRANSACTIONAL: `mutate(fn)` records every change fn makes (undo journal through a Proxy); if fn
 *    throws, the journal is replayed backwards and the state is exactly what it was.
 *  - DURABLE BEFORE ACK: the promise of a mutation resolves only once a write that contains it is on
 *    disk (fsync'ed). Writes are grouped: while one is in flight, the mutations that follow are
 *    committed together by the next one (group commit). A mutation that changes nothing writes nothing.
 *
 * Why not a deep copy per mutation (what this store did before): measured on a 4 MB state (10 nodes,
 * 300 operations with results, 5000 audit rows) one structuredClone cost ~100 ms of blocked event loop,
 * and EVERY agent heartbeat is a mutation: tens of nodes would saturate the console. See
 * tests/server/store.test.ts for the semantics and the timing check.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const STATE_VERSION = 1;

export interface EnrollmentToken {
  id: string;
  hash: string;            // sha256(token)
  label: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  usedByNode?: string;
  /** how many servers may enroll with it (a Patroni cluster: one command for all its nodes). Default 1. */
  maxUses?: number;
  usedBy?: { node: string; at: string }[];
  clusterId?: string;      // optional: bind the node to an existing cluster
  environment?: string;    // environment given to a cluster auto-created at enrollment
  kind?: 'worker';         // the token enrolls an operational machine (no cluster)
}

export interface NodeRecord {
  id: string;                 // stable id, assigned at enrollment
  name: string;
  tokenHash: string;          // sha256 of per-agent secret
  enrolledAt: string;
  /** First heartbeat after enrollment: from then on the enrollment token cannot re-enroll this node (replace its secret). */
  firstHeartbeatAt?: string;
  lastSeen?: string;
  clusterId?: string;
  clusterKey?: string;        // "patroni:<scope>" | "sysid:<id>" computed by agent discovery
  agentVersion?: string;
  clockSkewMs?: number;          // node clock minus console clock at the last heartbeat (ms; positive = node ahead)
  agentInstance?: string;        // PG_ARCA_INSTANCE of this agent (one agent per PostgreSQL instance on a host): named in its upgrade command
  tlsCaFile?: string;            // the CA file the agent trusts the console with (private certificate): reused by its upgrade command
  agentBuild?: string;        // fingerprint of the agent code it runs (pg_arca/build.py); differs from the console's -> outdated
  consoleUrl?: string;        // the console address this agent uses (upgrade command)
  tlsInsecure?: boolean;      // the agent talks to the console in clear (http://) or without verifying its certificate
  agentStarted?: number;     // start time of the agent process (a change = restart: what the old process had leased is handed back)
  agentStartedSeenAt?: number; // last heartbeat (console clock) that carried agentStarted: an older start time after a long silence is a restart, not a duplicate
  duplicateAgentAt?: string; // a heartbeat with an OLDER start time than the last one: two agent processes share these credentials
  remoteIp?: string;
  /** inbound URL, only if the operator chose inbound mode */
  inboundUrl?: string;
  snapshot?: any;             // last heartbeat payload (postgres/patroni/wal/cas/system)
  discovery?: any;            // last discovery report
  prevXact?: { total: number; at: number };   // for TPS derivation
  tps?: number;
  /** 'worker' = operational machine (backup server, recovery host): no database, no cluster (see server/workers.ts). Absent = database server. */
  kind?: 'worker';
  label?: string;             // operational machines: what it is for, in the operator's words
  roles?: string[];           // operational machines: 'recovery' | 'repository' | 'drill'
}

export type OpStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled';

export interface Operation {
  id: string;
  idempotencyKey: string;
  type: string;
  clusterId: string;
  nodeId?: string;            // agent-executed
  params: Record<string, any>;
  status: OpStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  attempts: number;
  leaseUntil?: string;
  ttlSeconds: number;         // after this, a still-queued op expires instead of running late
  result?: any;
  error?: string;
  progress?: any;             // live progress reported by the agent while running (phase, pct, bytes...)
  cancelRequested?: boolean;  // cooperative cancel of a running data operation
  history: { at: string; status: OpStatus; note?: string }[];
  log?: { at: string; text: string; k?: string }[];   // what the agent reported while running (phase changes, messages, periodic counters); capped
}

export interface DirectConnection {
  clusterId: string;
  host: string;
  port: number;
  database: string;
  user: string;
  passwordEnc?: string;       // AES-256-GCM, see secrets()
  sslmode: 'disable' | 'require' | 'verify-full';
  caCertPem?: string;
  patroniUrl?: string;
  patroniUser?: string;
  patroniPasswordEnc?: string;
  lastOk?: string;
  lastError?: string;
}

export interface AppState {
  version: number;
  demoDeleted: boolean;
  clusters: any[];                        // ManagedCluster (persisted view; live fields refreshed by pollers)
  nodes: Record<string, NodeRecord>;
  enrollmentTokens: EnrollmentToken[];
  directConnections: Record<string, DirectConnection>;
  operations: Operation[];
  audit: any[];
  settings: Record<string, any>;
}

function emptyState(): AppState {
  return { version: STATE_VERSION, demoDeleted: false, clusters: [], nodes: {}, enrollmentTokens: [],
           directConnections: {}, operations: [], audit: [], settings: {} };
}

/** One mutation in flight: wraps the live state in proxies that record how to undo each change. */
class Tx {
  readonly undo: (() => void)[] = [];
  private proxies = new WeakMap<object, any>();     // target -> proxy
  private targets = new WeakMap<object, object>();  // proxy -> target
  private known = new WeakSet<object>();            // objects that already belong to the state (never walked by unwrap)

  wrap<T>(v: T): T {
    if (v === null || typeof v !== 'object') return v;
    if (this.targets.has(v as any)) return v;
    let p = this.proxies.get(v as any);
    if (!p) {
      const tx = this;
      this.known.add(v as any);
      p = new Proxy(v as any, {
        get(t, k) { const x = Reflect.get(t, k); return typeof x === 'object' && x !== null ? tx.wrap(x) : x; },
        set(t, k, val) {
          const had = Object.prototype.hasOwnProperty.call(t, k); const old = t[k];
          const len = Array.isArray(t) ? t.length : -1;        // writing past the end of an array grows `length` implicitly: undo must shrink it back
          tx.undo.push(() => { if (had) t[k] = old; else delete t[k]; if (len >= 0) t.length = len; });
          t[k] = tx.unwrap(val); return true;
        },
        deleteProperty(t, k) {
          if (!Object.prototype.hasOwnProperty.call(t, k)) return true;
          const old = t[k]; tx.undo.push(() => { t[k] = old; });
          delete t[k]; return true;
        },
        defineProperty(t, k, desc) {
          const had = Object.getOwnPropertyDescriptor(t, k);
          tx.undo.push(() => { if (had) Object.defineProperty(t, k, had); else delete t[k]; });
          if ('value' in desc) desc = { ...desc, value: tx.unwrap(desc.value) };
          return Reflect.defineProperty(t, k, desc);
        },
      });
      this.proxies.set(v as any, p); this.targets.set(p, v as any);
    }
    return p;
  }

  /** The value that goes INTO the state: proxies replaced by what they wrap, also inside freshly built objects/arrays (`{...cluster, x}` copies proxies). */
  unwrap(v: any, depth = 0): any {
    if (v === null || typeof v !== 'object') return v;
    const t = this.targets.get(v);
    if (t) return t;
    if (this.known.has(v) || depth > 64) return v;
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
    this.known.add(v);
    for (const k of Object.keys(v)) { const x = v[k]; if (x !== null && typeof x === 'object') { const u = this.unwrap(x, depth + 1); if (u !== x) v[k] = u; } }
    return v;
  }

  rollback() { for (let i = this.undo.length - 1; i >= 0; i--) { try { this.undo[i](); } catch { /* keep going: best effort to the last step */ } } }
}

export class Store {
  private state: AppState;
  readonly file: string;
  private dirty = false;
  private writing: Promise<void> | null = null;
  private waiters: { resolve: () => void; reject: (e: any) => void }[] = [];
  private uncommitted: Tx[] = [];                   // changes in memory not yet on disk, oldest first: undone if their write fails
  /** test hook / metrics: how many times the state file was written */
  writes = 0;
  static LAZY_MS = 5000;
  private lazyTimer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
    // partial writes left by an earlier process (crash, disk full): never read, only taking space
    try { for (const f of fs.readdirSync(dir)) if (/^state\.json\..*\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use? leave it */ } } } catch { /* unreadable dir: load() says */ }
    this.state = this.load();
  }

  private load(): AppState {
    for (const f of [this.file, this.file + '.bak']) {
      try {
        const raw = fs.readFileSync(f, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.version) {
          if (f !== this.file) console.warn(`[store] main state unreadable, recovered from ${f}`);
          return { ...emptyState(), ...parsed };
        }
      } catch (e: any) {
        if (e.code !== 'ENOENT') console.warn(`[store] cannot read ${f}: ${e.message}`);
      }
    }
    return emptyState();
  }

  /** Read-only deep copy. Never mutate the returned object. */
  read(): AppState {
    return structuredClone(this.state);
  }

  /** Cheap read of a single section without cloning everything (do not mutate). */
  peek(): Readonly<AppState> {
    return this.state;
  }

  /**
   * Run `fn` on the state (synchronously: fn must not be async). If it throws, every change it made is undone and the promise rejects.
   * Otherwise the promise resolves with fn's result once the change is on disk. A fn that changes nothing resolves at once, without a write.
   * The result never contains proxies: it is the state's own objects (or fn's fresh ones), as with the previous implementation.
   */
  mutate<T>(fn: (draft: AppState) => T, opts: { lazy?: boolean } = {}): Promise<T> {
    const tx = new Tx();
    let out: T;
    try {
      out = tx.unwrap(fn(tx.wrap(this.state)));
    } catch (e) {
      tx.rollback();
      return Promise.reject(e);
    }
    if (!tx.undo.length) return Promise.resolve(out);
    this.dirty = true;
    this.uncommitted.push(tx);
    if (opts.lazy) {                                 // telemetry (heartbeat snapshot, progress counters): losing the last seconds of it in a crash is harmless; written within LAZY_MS
      if (!this.lazyTimer) { this.lazyTimer = setTimeout(() => { this.lazyTimer = null; if (this.dirty) this.flush().catch(() => undefined); }, Store.LAZY_MS); this.lazyTimer.unref?.(); }
      return Promise.resolve(out);
    }
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ resolve: () => resolve(out), reject });
      this.kick();
    });
  }

  /** Resolves when everything committed so far is on disk. */
  flush(): Promise<void> {
    if (!this.dirty && !this.writing) return Promise.resolve();
    return new Promise<void>((resolve, reject) => { this.waiters.push({ resolve, reject }); this.kick(); });
  }

  private kick() {
    if (this.writing) return;                        // the running write will look at `dirty` when it is done
    const batch = this.waiters; this.waiters = [];
    this.dirty = false;
    const data = JSON.stringify(this.state);         // the snapshot of this batch: everything committed up to now
    const n = this.uncommitted.length;
    this.writing = this.persist(data).then(
      () => { this.writes++; this.uncommitted.splice(0, n); for (const w of batch) w.resolve(); },
      (e) => {
        // the write failed (disk full, I/O error): what it carried must not stay live in memory - a caller told "error" would retry and the
        // first attempt, still queued in memory, would run too (independent review). Every change not on disk is undone, newest first (the ones
        // made during the failed write built on it), and every caller still waiting is told
        console.error('[store] cannot write the state, changes not saved are undone:', e?.message || e);
        for (let i = this.uncommitted.length - 1; i >= 0; i--) this.uncommitted[i].rollback();
        this.uncommitted = []; this.dirty = false;
        const late = this.waiters; this.waiters = [];
        for (const w of [...batch, ...late]) w.reject(e);
      },
    ).finally(() => {
      this.writing = null;
      if (this.waiters.length) this.kick();          // group commit: everything that arrived meanwhile goes in one write
    });
  }

  /** Daily protection of the console's own state: a gzip copy of the current state in <dir>/snapshots/, keep the newest `keep`.
   *  The secret key is NOT in it (it lives next to the state; install-console.sh --backup-state takes both). Returns the file written. */
  async snapshot(keep = 14): Promise<string> {
    const zlib = await import('zlib');
    await this.flush();
    const dir = path.join(this.dir, 'snapshots');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `state-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json.gz`;
    const out = path.join(dir, name); const tmp = out + '.tmp';
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(this.state)), { level: 6 });
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(gz); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.rename(tmp, out);
    const all = (await fs.promises.readdir(dir)).filter(f => /^state-.*\.json\.gz$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - keep))) { try { await fs.promises.unlink(path.join(dir, f)); } catch { /* gone */ } }
    return out;
  }

  /** The newest snapshot (name and time), for /api/health and the status page. */
  lastSnapshot(): { file: string; at: string } | null {
    try {
      const dir = path.join(this.dir, 'snapshots');
      const all = fs.readdirSync(dir).filter(f => /^state-.*\.json\.gz$/.test(f)).sort();
      if (!all.length) return null;
      const f = all[all.length - 1]; return { file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtime.toISOString() };
    } catch { return null; }
  }

  private async persist(data: string) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      await fs.promises.unlink(tmp).catch(() => undefined);      // a partial file would eat the space just freed, at every retry
      throw e;
    }
    await fh.close();
    try { await fs.promises.rename(this.file, this.file + '.bak'); } catch { /* first write */ }   // the previous generation (a crash right here leaves only .bak: load() uses it)
    await fs.promises.rename(tmp, this.file);
    try {                                   // make the renames themselves durable
      const dh = await fs.promises.open(this.dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* not supported on some FS */ }
  }
}

// ---------------------------------------------------------------------------
// secrets at rest (direct-attach DB passwords). AES-256-GCM, key from env or a
// 0600 key file next to the state. Losing the key = re-enter passwords.
// ---------------------------------------------------------------------------
export function loadSecretKey(dir: string): Buffer {
  const env = process.env.PG_ARCA_SECRET_KEY;
  if (env) return crypto.createHash('sha256').update(env).digest();
  const kf = path.join(dir, 'secret.key');
  try {
    return Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(kf, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

export function encrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

export function decrypt(key: Buffer, blob: string): string {
  const [v, iv, tag, enc] = blob.split(':');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const newSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const newId = (prefix: string) => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
export const nowIso = () => new Date().toISOString();
