import assert from 'assert'; import fs from 'fs'; import path from 'path';
import { APP_ROOT, APP_VERSION, readVersion, findAppRoot } from '../../server/version';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// one version everywhere: VERSION, package.json, the agent package
const v = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
assert.match(v, /^\d+\.\d+\.\d+(-(rc|beta|alpha)\.\d+)?$/, 'VERSION is semver (x.y.z or x.y.z-rc.N)');
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, v, 'package.json version = VERSION');
const init = fs.readFileSync(path.join(root, 'unix-agent/pg_arca/__init__.py'), 'utf8');
assert.strictEqual((init.match(/__version__ = "([^"]+)"/) || [])[1], v, 'agent __version__ = VERSION');
assert.match(fs.readFileSync(path.join(root, 'unix-agent/pg_arca/runtime.py'), 'utf8'), /AGENT_VERSION = __version__/, 'the agent reports its package version');
// the console finds its root (VERSION + unix-agent) from server/ and reads the version from it
assert.strictEqual(APP_ROOT, root); assert.strictEqual(APP_VERSION, v);
assert.strictEqual(findAppRoot(path.join(root, 'server')), root);
assert.strictEqual(readVersion('/nonexistent'), '0.0.0-dev');
console.log('version OK', v);
