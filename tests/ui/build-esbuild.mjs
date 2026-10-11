// Fallback UI build for test environments without vite (only esbuild + react available, e.g. via NODE_PATH): same entry, same output layout.
// Usage: NODE_PATH=/opt/npm-tools/node_modules node tests/ui/build-esbuild.mjs <outDir>
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const require = createRequire(import.meta.url + '/../');
const esbuild = require(require.resolve('esbuild', { paths: (process.env.NODE_PATH || '').split(':').concat([process.cwd() + '/node_modules']) }));
const out = path.resolve(process.argv[2] || 'dist-e2e'); fs.rmSync(out, { recursive: true, force: true });
await esbuild.build({ entryPoints: ['src/main.tsx'], bundle: true, splitting: true, format: 'esm', outdir: path.join(out, 'assets'), jsx: 'automatic', minify: true, sourcemap: false,
  nodePaths: (process.env.NODE_PATH || '').split(':').filter(Boolean), loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' }, entryNames: 'index', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }, logLevel: 'warning' });
const html = fs.readFileSync('index.html', 'utf8').replace('<script type="module" src="/src/main.tsx"></script>', '<link rel="stylesheet" href="/assets/index.css" /><script type="module" src="/assets/index.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html); console.log('built', out);
