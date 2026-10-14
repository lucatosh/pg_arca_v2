/**
 * Fingerprint of the agent code this console serves (/agent/pg-arca-agent.tar.gz), computed exactly like the agent computes its own
 * (unix-agent/pg_arca/build.py): pg-arca-agent.py + pg_arca/**\/*.py (no tests, no caches), relative paths with '/', sorted,
 * sha256 over "path NUL content NUL", first 12 hex digits. A node reporting another fingerprint runs older (or newer) agent code.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { APP_ROOT } from './version';

export function agentFingerprint(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__pycache__' && e.name !== 'tests') walk(p); }
      else if (e.isFile() && e.name.endsWith('.py')) files.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'pg_arca'));
  if (fs.existsSync(path.join(root, 'pg-arca-agent.py'))) files.push('pg-arca-agent.py');
  const h = crypto.createHash('sha256');
  // Python sorts str by code point; JS default sort compares UTF-16 units: identical for the ASCII file names of the agent
  for (const rel of files.sort()) {
    let data: Buffer; try { data = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    h.update(Buffer.concat([Buffer.from(rel), Buffer.from([0]), data, Buffer.from([0])]));
  }
  return h.digest('hex').slice(0, 12);
}

let cached: { at: number; v: string } | null = null;
/** The console's agent fingerprint (re-read at most every 30 s: a `git pull` without restart is seen too). */
export function consoleAgentBuild(root = path.join(APP_ROOT, 'unix-agent')): string {
  if (!cached || Date.now() - cached.at > 30000) cached = { at: Date.now(), v: agentFingerprint(root) };
  return cached.v;
}

/** Agent code older (or newer) than the one this console serves: some console features may be missing on that node. */
export function agentOutdated(n: { agentVersion?: string; agentBuild?: string }): boolean {
  return !!n.agentVersion && n.agentBuild !== consoleAgentBuild();
}
