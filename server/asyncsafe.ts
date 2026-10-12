/**
 * Express 4 does not catch a rejected promise from an async route handler: the request then hangs until the browser gives up
 * (the console shows a spinner forever) and the error is only an "unhandled rejection" line in the log.
 * makeAsyncSafe wraps every route registered AFTER it so a throw or rejection becomes next(err); asyncErrorHandler answers it
 * with a JSON 500 that says what failed (never a stack trace to the client).
 */
import type { NextFunction, Request, Response } from 'express';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;

export function makeAsyncSafe(app: any): void {
  for (const m of METHODS) {
    const orig = app[m].bind(app);
    app[m] = (...args: any[]) => {
      if (m === 'get' && args.length === 1) return orig(...args);          // app.get('setting') reads a setting
      return orig(...args.map((h, i) => (i > 0 && typeof h === 'function' && h.length < 4 ? wrap(h) : h)));
    };
  }
}

function wrap(h: (req: Request, res: Response, next: NextFunction) => any) {
  return function safe(req: Request, res: Response, next: NextFunction) {
    try {
      const r = h(req, res, next);
      if (r && typeof r.then === 'function') r.then(undefined, next);
    } catch (e) { next(e); }
  };
}

export function asyncErrorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'Request too large.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.' });
  console.error(`[pg_arca] ${req.method} ${req.path} failed:`, err?.stack || err);
  res.status(500).json({ error: 'internal_error', message: `The console could not complete ${req.method} ${req.path}: ${String(err?.message || err).slice(0, 300)}. Details are in the console log.` });
}
