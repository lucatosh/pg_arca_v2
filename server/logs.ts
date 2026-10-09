import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type http from 'http';
import { sessionUser } from './auth';

export interface LiveLogEntry {
  id: string;
  timestamp: string;
  clusterId: string;
  clusterName: string;
  nodeName: string;
  nodeHost: string;
  service: 'patroni' | 'postgres' | 'wal_archiver' | 'agent' | 'etcd';
  level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'DEBUG';
  message: string;
  raw: string;
  details?: Record<string, any>;
}

interface WsSubscription {
  ws: WebSocket;
  clusterId?: string;
  nodeName?: string;
  service?: string;
  minLevel?: string;
  search?: string;
  isPaused?: boolean;
}

const liveLogBuffer: LiveLogEntry[] = [];
const activeSubscriptions = new Set<WsSubscription>();

// Create WebSocket server attached to HTTP server on /ws/logs
let wss: WebSocketServer;
export function attachLogSocket(server: http.Server) {
  wss = new WebSocketServer({ server, path: '/ws/logs' });
  wss.on('connection', onConnection);
}

const LEVEL_SEVERITY: Record<string, number> = {
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5
};

function shouldEmitLogToSub(sub: WsSubscription, entry: LiveLogEntry): boolean {
  if (sub.isPaused) return false;
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
  const entry: LiveLogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...entryData
  };

  liveLogBuffer.push(entry);
  if (liveLogBuffer.length > 2500) {
    liveLogBuffer.splice(0, liveLogBuffer.length - 2500);
  }

  const payload = JSON.stringify({ type: 'log', entry });
  for (const sub of activeSubscriptions) {
    if (sub.ws.readyState === WebSocket.OPEN && shouldEmitLogToSub(sub, entry)) {
      try {
        sub.ws.send(payload);
      } catch (err) {
        // ignore send error
      }
    }
  }
}

function onConnection(ws: WebSocket, req: any) {
  if (!sessionUser(req)) { ws.close(4401, 'unauthenticated'); return; }
  const sub: WsSubscription = {
    ws,
    clusterId: 'all',
    nodeName: 'all',
    service: 'all',
    minLevel: 'all',
    isPaused: false
  };
  activeSubscriptions.add(sub);

  // Send initial batch of recent matching logs
  const initialBatch = liveLogBuffer.slice(-150);
  ws.send(JSON.stringify({
    type: 'init',
    logs: initialBatch,
    connectedAt: new Date().toISOString()
  }));

  ws.on('message', (data: any) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' || msg.type === 'filter') {
        if (msg.clusterId !== undefined) sub.clusterId = msg.clusterId;
        if (msg.nodeName !== undefined) sub.nodeName = msg.nodeName;
        if (msg.service !== undefined) sub.service = msg.service;
        if (msg.minLevel !== undefined) sub.minLevel = msg.minLevel;
        if (msg.search !== undefined) sub.search = msg.search;
        if (msg.isPaused !== undefined) sub.isPaused = msg.isPaused;
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (msg.type === 'pause') {
        sub.isPaused = true;
      } else if (msg.type === 'resume') {
        sub.isPaused = false;
      }
    } catch (err) {
      // ignore
    }
  });

  ws.on('close', () => {
    activeSubscriptions.delete(sub);
  });

  ws.on('error', () => {
    activeSubscriptions.delete(sub);
  });
}



export function mountLogRoutes(app: any) {
  app.get('/api/logs/history', (req: Request, res: Response) => {
    const { clusterId, nodeName, service, level, search, limit = '200' } = req.query as Record<string, string>;
    let f = [...liveLogBuffer];
    if (clusterId && clusterId !== 'all') f = f.filter(l => l.clusterId === clusterId);
    if (nodeName && nodeName !== 'all') f = f.filter(l => l.nodeName === nodeName);
    if (service && service !== 'all') f = f.filter(l => l.service === service);
    if (level && level !== 'all') f = f.filter(l => l.level === level);
    if (search) { const q = search.toLowerCase(); f = f.filter(l => l.message.toLowerCase().includes(q) || l.raw.toLowerCase().includes(q)); }
    const max = Math.min(parseInt(limit, 10) || 200, 1000);
    res.json({ total: f.length, entries: f.slice(-max) });
  });
}
