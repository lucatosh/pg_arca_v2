import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type http from 'http';
import { sessionUser } from './auth';
import { LEVEL_SEVERITY, FLUSH_MS, MAX_QUEUE, MAX_BUFFERED_BYTES, recordLog, recent, setWatching } from './logring';
import type { LiveLogEntry } from './logring';
export type { LiveLogEntry } from './logring';
export { logModeFor } from './logring';

interface WsSubscription {
  ws: WebSocket;
  clusterId?: string;
  nodeName?: string;
  service?: string;
  minLevel?: string;
  search?: string;
  isPaused?: boolean;
  subscribed?: boolean;
  queue?: LiveLogEntry[];
  dropped?: number;
}

const activeSubscriptions = new Set<WsSubscription>();

// Create WebSocket server attached to HTTP server on /ws/logs
let wss: WebSocketServer;
export function attachLogSocket(server: http.Server, authenticate: (req: any) => string | null = sessionUser) {
  wss = new WebSocketServer({ server, path: '/ws/logs' });
  wss.on('connection', (ws: WebSocket, req: any) => onConnection(ws, req, authenticate));
}

function shouldEmitLogToSub(sub: WsSubscription, entry: LiveLogEntry): boolean {
  if (sub.isPaused || !sub.subscribed) return false;
  if (sub.clusterId && sub.clusterId !== 'all' && entry.clusterId !== sub.clusterId) return false;
  if (sub.nodeName && sub.nodeName !== 'all' && entry.nodeName !== sub.nodeName) return false;
  if (sub.service && sub.service !== 'all' && entry.service !== sub.service) return false;
  if (sub.minLevel && sub.minLevel !== 'all') {
    const minSev = LEVEL_SEVERITY[sub.minLevel] || 0;
    const entrySev = LEVEL_SEVERITY[entry.level] || 0;
    if (entrySev < minSev) return false;
  }
  if (sub.search && sub.search.trim()) {
    const q = sub.search.toLowerCase();
    if (!entry.message.toLowerCase().includes(q) &&
        !entry.nodeName.toLowerCase().includes(q) &&
        !entry.raw.toLowerCase().includes(q)) {
      return false;
    }
  }
  return true;
}

export function broadcastLiveLog(entryData: Omit<LiveLogEntry, 'id'>) {
  const entry = recordLog(entryData);
  for (const sub of activeSubscriptions) {
    if (sub.ws.readyState === WebSocket.OPEN && shouldEmitLogToSub(sub, entry)) {
      const q = sub.queue || (sub.queue = []);
      q.push(entry);
      if (q.length > MAX_QUEUE) { const cut = q.length - MAX_QUEUE; q.splice(0, cut); sub.dropped = (sub.dropped || 0) + cut; }
    }
  }
}

/** One frame per subscriber per tick. A consumer whose socket is backed up simply skips the tick (its queue stays bounded). */
function flush() {
  for (const sub of activeSubscriptions) {
    if (!sub.queue || !sub.queue.length) continue;
    if (sub.ws.readyState !== WebSocket.OPEN) { sub.queue = []; continue; }
    if (sub.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    const entries = sub.queue; sub.queue = [];
    const dropped = sub.dropped || 0; sub.dropped = 0;
    try { sub.ws.send(JSON.stringify({ type: 'batch', entries, dropped })); } catch { /* socket gone: the close handler cleans up */ }
  }
}
let flusher: NodeJS.Timeout | null = null;

function recompute() {
  let all = 0; const ids = new Set<string>();
  for (const s of activeSubscriptions) {
    if (!s.subscribed || s.isPaused || s.ws.readyState !== WebSocket.OPEN) continue;
    if (!s.clusterId || s.clusterId === 'all') all++; else ids.add(s.clusterId);
  }
  setWatching(all, ids);
}
setInterval(recompute, 2000).unref();

function onConnection(ws: WebSocket, req: any, authenticate: (req: any) => string | null) {
  if (!authenticate(req)) { ws.close(4401, 'unauthenticated'); return; }
  const sub: WsSubscription = {
    ws,
    clusterId: 'all',
    nodeName: 'all',
    service: 'all',
    minLevel: 'all',
    isPaused: false,
    subscribed: false              // nothing is sent (and nothing is "watched") until the client says what it wants to see
  };
  activeSubscriptions.add(sub);
  if (!flusher) { flusher = setInterval(flush, FLUSH_MS); flusher.unref(); }
  const sendInit = () => {
    const logs = recent(e => shouldEmitLogToSub({ ...sub, isPaused: false }, e), 150);
    try { ws.send(JSON.stringify({ type: 'init', logs, connectedAt: new Date().toISOString() })); } catch { /* closing */ }
  };

  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' || msg.type === 'filter') {
        if (msg.type === 'subscribe') sub.subscribed = true;
        if (msg.clusterId !== undefined) sub.clusterId = msg.clusterId;
        if (msg.nodeName !== undefined) sub.nodeName = msg.nodeName;
        if (msg.service !== undefined) sub.service = msg.service;
        if (msg.minLevel !== undefined) sub.minLevel = msg.minLevel;
        if (msg.search !== undefined) sub.search = msg.search;
        if (msg.isPaused !== undefined) sub.isPaused = msg.isPaused;
        recompute();
        if (msg.type === 'subscribe') sendInit();          // the client replaces its list with the filtered backlog
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'pause') {
        sub.isPaused = true; recompute();
      } else if (msg.type === 'resume') {
        sub.isPaused = false; recompute();
      }
    } catch (err) {
      // ignore
    }
  });

  const gone = () => { activeSubscriptions.delete(sub); sub.queue = []; recompute(); };
  ws.on('close', gone);
  ws.on('error', gone);
}



export function mountLogRoutes(app: any) {
  app.get('/api/logs/history', (req: Request, res: Response) => {
    const { clusterId, nodeName, service, level, search, limit = '200' } = req.query as Record<string, string>;
    const q = search ? search.toLowerCase() : '';
    const f = recent(l =>
      (!clusterId || clusterId === 'all' || l.clusterId === clusterId) && (!nodeName || nodeName === 'all' || l.nodeName === nodeName) &&
      (!service || service === 'all' || l.service === service) && (!level || level === 'all' || l.level === level) &&
      (!q || l.message.toLowerCase().includes(q) || l.raw.toLowerCase().includes(q)), 100000);
    const max = Math.min(parseInt(limit, 10) || 200, 1000);
    res.json({ total: f.length, entries: f.slice(-max) });
  });
}
