/**
 * Durable state store.
 *
 * Guarantees:
 *  - ATOMIC: every commit is written to a temp file, fsync'ed, then rename()d over the
 *    live file (POSIX-atomic). A crash leaves either the old or the new state, never a mix.
 *  - SERIALIZED: all mutations run one at a time through a promise queue, so concurrent
 *    HTTP requests cannot interleave read-modify-write cycles.
 *  - RECOVERABLE: previous generation kept as state.json.bak and used if the main file is corrupt.
 *  - TRANSACTIONAL: `mutate(fn)` runs fn on a deep copy; if fn throws, nothing is committed.
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
  clusterId?: string;      // optional: bind the node to an existing cluster
  environment?: string;    // environment given to a cluster auto-created at enrollment
}

export interface NodeRecord {
  id: string;                 // stable id, assigned at enrollment
  name: string;
  tokenHash: string;          // sha256 of per-agent secret
  enrolledAt: string;
  lastSeen?: string;
  clusterId?: string;
  clusterKey?: string;        // "patroni:<scope>" | "sysid:<id>" computed by agent discovery
  agentVersion?: string;
  remoteIp?: string;
  /** inbound URL, only if the operator chose inbound mode */
  inboundUrl?: string;
  snapshot?: any;             // last heartbeat payload (postgres/patroni/wal/cas/system)
  discovery?: any;            // last discovery report
  prevXact?: { total: number; at: number };   // for TPS derivation
  tps?: number;
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
  history: { at: string; status: OpStatus; note?: string }[];
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

export class Store {
  private state: AppState;
  private queue: Promise<unknown> = Promise.resolve();
  readonly file: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'state.json');
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
   * Run `fn` on a draft copy. If it returns normally the draft is persisted atomically and
   * becomes the new state; if it throws, state is untouched. Calls are strictly serialized.
   */
  mutate<T>(fn: (draft: AppState) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const draft = structuredClone(this.state);
      const out = fn(draft);
      this.persist(draft);
      this.state = draft;
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private persist(s: AppState) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const data = JSON.stringify(s);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* first write */ }
    fs.renameSync(tmp, this.file);
    try {                                   // make the rename itself durable
      const dfd = fs.openSync(this.dir, 'r');
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
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
