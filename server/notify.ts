/**
 * Notifications: outgoing webhooks (generic JSON or Slack/Teams-compatible "text") fed by the health evaluation.
 *  - one message per webhook per tick, listing NEW problems, REMINDERS (default every 24 h while still open) and RECOVERED ones
 *  - state is persisted (settings.notifyState) and only advanced after a successful delivery -> a failed delivery is retried, a console
 *    restart never repeats what was already sent
 *  - the webhook URL is a secret (Slack URLs embed a token): it is never returned to the browser, only a masked form
 */
import crypto from 'crypto';
import { Store, nowIso } from './store';
import { audit } from './ops';
import { evaluate, Issue, Severity, SEV_RANK } from './health';

export interface Webhook { id: string; name: string; url: string; format: 'generic' | 'slack'; minSeverity: Severity; enabled: boolean }
export type Sender = (url: string, body: any) => Promise<{ ok: boolean; status?: number; error?: string }>;

export const defaultSender: Sender = async (url, body) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal, redirect: 'error' });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `HTTP ${r.status}` };
  } catch (e: any) { return { ok: false, error: e.name === 'AbortError' ? 'timeout (8 s)' : String(e.message || e).slice(0, 200) }; }
  finally { clearTimeout(t); }
};

export const maskUrl = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}/…${u.slice(-4)}`; } catch { return '…'; } };
export function validUrl(u: any): string | null {
  try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') && String(u).length <= 600 ? null : 'URL http(s) richiesto'; } catch { return 'URL non valido'; }
}
const ICON: Record<Severity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };

export function payload(w: Webhook, ev: { opened: Issue[]; reminders: Issue[]; resolved: { key: string; title: string; clusterName: string }[]; test?: boolean }, baseUrl = '') {
  const line = (i: Issue) => `${ICON[i.severity]} [${i.clusterName}/${i.environment}] ${i.title} — ${i.cause}`;
  const lines = [
    ...(ev.test ? ['✅ Notifica di prova da pg_arca: il canale funziona.'] : []),
    ...ev.opened.map(line), ...ev.reminders.map(i => '⏰ Ancora aperto: ' + line(i)), ...ev.resolved.map(r => `🟢 [${r.clusterName}] Risolto: ${r.title}`),
  ];
  if (w.format === 'slack') return { text: lines.join('\n') + (baseUrl ? `\n${baseUrl}` : '') };
  return { event: ev.test ? 'pg_arca.test' : 'pg_arca.health', at: nowIso(), opened: ev.opened, reminders: ev.reminders, resolved: ev.resolved, summary: lines.join('\n') };
}

/** One dispatcher pass. Returns what was sent per webhook (for tests / the UI "last result"). */
export async function notifyTick(store: Store, now = Date.now(), send: Sender = defaultSender): Promise<Record<string, { sent: number; error?: string }>> {
  const st = store.peek();
  const cfg = st.settings.notifications || { webhooks: [], reminderHours: 24 };
  const result: Record<string, { sent: number; error?: string }> = {};
  const issues = evaluate(st, now);
  for (const w of (cfg.webhooks || []) as Webhook[]) {
    if (!w.enabled) continue;
    const ns = (st.settings.notifyState || {})[w.id] || { issues: {} };
    if (ns.nextTryAt && now < ns.nextTryAt) continue;
    const cur = issues.filter(i => SEV_RANK[i.severity] <= SEV_RANK[w.minSeverity]);
    const known = ns.issues || {};
    const opened = cur.filter(i => !known[i.key]);
    const reminders = cur.filter(i => known[i.key] && now - known[i.key].sentAt >= (cfg.reminderHours || 24) * 3600_000);
    const curKeys = new Set(cur.map(i => i.key));
    const resolved = Object.entries(known).filter(([k]) => !curKeys.has(k)).map(([k, v]: any) => ({ key: k, title: v.title, clusterName: v.clusterName }));
    if (!opened.length && !reminders.length && !resolved.length) continue;
    const r = await send(w.url, payload(w, { opened, reminders, resolved }));
    await store.mutate(d => {
      const all = (d.settings.notifyState ||= {});
      const s = (all[w.id] ||= { issues: {} });
      if (r.ok) {
        for (const i of [...opened, ...reminders]) s.issues[i.key] = { sentAt: now, title: i.title, clusterName: i.clusterName, severity: i.severity };
        for (const x of resolved) delete s.issues[x.key];
        s.lastOk = new Date(now).toISOString(); s.lastError = undefined; s.nextTryAt = undefined;
      } else { s.lastError = r.error; s.lastErrorAt = new Date(now).toISOString(); s.nextTryAt = now + 5 * 60_000; }
    });
    result[w.id] = { sent: r.ok ? opened.length + reminders.length + resolved.length : 0, error: r.ok ? undefined : r.error };
  }
  return result;
}

export function startNotifier(store: Store, everyMs = 60_000) {
  const t = setInterval(() => { notifyTick(store).catch(e => console.error('[notify]', e.message)); }, everyMs);
  t.unref?.();
  return t;
}

export function mountNotifyRoutes(app: any, store: Store, send: Sender = defaultSender) {
  const actor = (req: any) => req.actor || 'admin';
  const view = () => {
    const s = store.peek().settings; const cfg = s.notifications || { webhooks: [], reminderHours: 24 };
    return { reminderHours: cfg.reminderHours || 24, webhooks: (cfg.webhooks || []).map((w: Webhook) => {
      const ns = (s.notifyState || {})[w.id] || {};
      return { id: w.id, name: w.name, urlMasked: maskUrl(w.url), format: w.format, minSeverity: w.minSeverity, enabled: w.enabled, lastOk: ns.lastOk, lastError: ns.lastError, open: Object.keys(ns.issues || {}).length };
    }) };
  };
  app.get('/api/notifications', (_req: any, res: any) => res.json(view()));
  // body: { reminderHours?, webhooks: [{ id?, name, url?, format, minSeverity, enabled }] }  (url omitted = keep the stored one)
  app.put('/api/notifications', async (req: any, res: any) => {
    const b = req.body || {}; const list = Array.isArray(b.webhooks) ? b.webhooks : null;
    if (!list || list.length > 10) return res.status(400).json({ error: 'invalid_webhooks', message: 'Al massimo 10 canali.' });
    const rh = b.reminderHours === undefined ? 24 : Number(b.reminderHours);
    if (!Number.isFinite(rh) || rh < 1 || rh > 720) return res.status(400).json({ error: 'invalid_reminder', message: 'Promemoria tra 1 e 720 ore.' });
    const prev: Webhook[] = store.peek().settings.notifications?.webhooks || [];
    const next: Webhook[] = [];
    for (const w of list) {
      const old = prev.find(p => p.id === w.id);
      const url = w.url ?? old?.url;
      const e = validUrl(url);
      if (e || !String(w.name || '').trim() || String(w.name).length > 60) return res.status(400).json({ error: 'invalid_webhook', message: e || 'Nome obbligatorio (max 60 caratteri).' });
      if (!['generic', 'slack'].includes(w.format)) return res.status(400).json({ error: 'invalid_format' });
      if (!['critical', 'warning', 'info'].includes(w.minSeverity)) return res.status(400).json({ error: 'invalid_severity' });
      next.push({ id: old?.id || 'wh_' + crypto.randomBytes(5).toString('hex'), name: String(w.name).trim(), url, format: w.format, minSeverity: w.minSeverity, enabled: w.enabled !== false });
    }
    await store.mutate(d => {
      d.settings.notifications = { webhooks: next, reminderHours: rh };
      const ids = new Set(next.map(w => w.id)); const ns = d.settings.notifyState || {};
      for (const k of Object.keys(ns)) if (!ids.has(k)) delete ns[k];
      audit(d, { actor: actor(req), action: 'notifications.save', status: 'OK', details: { channels: next.map(w => ({ name: w.name, format: w.format, min: w.minSeverity, enabled: w.enabled })) } });
    });
    res.json(view());
  });
  app.post('/api/notifications/test', async (req: any, res: any) => {
    const w = (store.peek().settings.notifications?.webhooks || []).find((x: Webhook) => x.id === req.body?.id);
    if (!w) return res.status(404).json({ error: 'not_found' });
    const r = await send(w.url, payload(w, { opened: [], reminders: [], resolved: [], test: true }));
    res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true } : { ok: false, error: r.error });
  });
}
