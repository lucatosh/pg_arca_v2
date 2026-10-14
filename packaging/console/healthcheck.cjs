// Container health check: /api/health answers 200 (https when the console serves TLS itself).
const tls = !!process.env.PG_ARCA_TLS_CERT;
const mod = require(tls ? 'https' : 'http');
const req = mod.get({ host: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/api/health', rejectUnauthorized: false, timeout: 4000 },
  r => process.exit(r.statusCode === 200 ? 0 : 1));
req.on('error', () => process.exit(1)); req.on('timeout', () => { req.destroy(); process.exit(1); });
