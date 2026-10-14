/**
 * Product version and the console's install root. One source of truth: the VERSION file at the root of the repository
 * (and of the release package). package.json and the agent (unix-agent/pg_arca/__init__.py) carry the same string;
 * tools/release/set-version.sh changes all three and tests/server/version.test.ts checks they match.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Directory that holds VERSION, dist/ and unix-agent/: the repository in development, the package directory once installed. */
export function findAppRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'unix-agent'))) return dir;
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return start;
}

export const APP_ROOT = findAppRoot();

export function readVersion(root = APP_ROOT): string {
  try { const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); if (/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v)) return v; } catch { /* below */ }
  return '0.0.0-dev';
}

export const APP_VERSION = readVersion();
