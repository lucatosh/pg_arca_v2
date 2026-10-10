import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Button, Progress, ago } from './ui';
import { Op, OPS_SLIM_KEY, isTerminal, revalidateOps, toast, useQuery, useRole } from './hooks';
import { go } from './router';
import { OP_LABEL, PHASE, STATUS_LABEL, pctOf } from './pages/shared';

/** Operations that only read (catalogue, plans, scans) are noise for the dock: they finish in a blink and nobody waits for them. */
const QUIET = ['backup_catalog', 'restore_plan', 'backup_info', 'discovery_scan', 'list_objects', 'hba_read', 'hba_plan', 'agent_config_get', 'compat_check'];
const KEY = 'arca.dock'; const SEEN = 'arca.dock.seen';
const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

type SlimOp = Op & { subtype?: string };
const label = (o: SlimOp) => `${OP_LABEL[o.type] || o.type}${o.subtype ? ` (${o.subtype})` : ''}`;
const elapsed = (from: string, now: number) => { const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`; };

/** Opens the page where the operation can be followed: the cluster's operation log (or Backup / Ripristino for the long data operations). */
function target(o: SlimOp): string | null {
  if (!o.clusterId || o.clusterId === 'unassigned') return null;
  const c = encodeURIComponent(o.clusterId);
  return `c/${c}/operations`;
}

export function ActivityDock({ me, clusters }: { me: string; clusters: any[] }) {
  const [open, setOpen] = useState(() => read(KEY, '0') === '1');
  const role = useRole();
  const canAct = role === 'admin' || role === 'operator';
  const [seenAt, setSeenAt] = useState(() => Number(read(SEEN, '0')) || 0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const names = useMemo(() => { const m: Record<string, string> = {}; for (const c of clusters) m[c.id] = c.name; return m; }, [clusters]);

  // Poll fast only while something runs; otherwise a slow heartbeat is enough (the query also pauses with the tab hidden and skips unchanged payloads).
  const [fast, setFast] = useState(false);
  const q = useQuery<{ operations: SlimOp[] }>(OPS_SLIM_KEY, { interval: fast ? 2000 : 8000 });
  const all = (q.data?.operations || []).filter(o => !QUIET.includes(o.type));
  const running = all.filter(o => !isTerminal(o.status));
  const recent = all.filter(o => isTerminal(o.status) && Date.parse(o.updatedAt || o.createdAt) > seenAt).slice(0, 10);
  const failedNew = recent.filter(o => o.status === 'failed' && Date.now() - Date.parse(o.updatedAt) < 10 * 60_000);
  useEffect(() => { setFast(running.length > 0); }, [running.length]);

  // live clock only while it is visible and useful
  useEffect(() => { if (!open || !running.length) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [open, running.length]);

  // Tell the user how their own operations ended (scheduled ones stay quiet: they are in the dock and in Oggi).
  const prev = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const cur: Record<string, string> = {}; for (const o of q.data.operations) cur[o.id] = o.status;
    if (prev.current) for (const o of q.data.operations) {
      const was = prev.current[o.id];
      if (!was || isTerminal(was) || !isTerminal(o.status) || o.createdBy !== me || QUIET.includes(o.type)) continue;
      if (o.status === 'succeeded') toast(`${label(o)} completato`, 'ok');
      else if (o.status === 'failed') toast(`${label(o)} non riuscito: ${(o.error || '').split('\n')[0].slice(0, 140)}`, 'bad', 9000);
      else if (o.status === 'cancelled') toast(`${label(o)} annullato`, 'info');
    }
    prev.current = cur;
  }, [q.data, me]);

  useEffect(() => { const f = () => { revalidateOps(); setTimeout(revalidateOps, 1200); }; window.addEventListener('arca:ops', f); return () => window.removeEventListener('arca:ops', f); }, []);
  const toggle = useCallback((v?: boolean) => setOpen(o => { const n = v ?? !o; write(KEY, n ? '1' : '0'); return n; }), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle(); } };
    const show = () => toggle(true);
    window.addEventListener('keydown', k); window.addEventListener('arca:dock', show);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('arca:dock', show); };
  }, [toggle]);

  const cancel = async (o: SlimOp) => {
    setBusy(o.id);
    try { await api('POST', `/api/operations/${o.id}/cancel`); toast('Annullamento richiesto', 'info'); }
    catch (e: any) { toast(e.body?.reason || e.message, 'bad'); }
    await revalidateOps(); setBusy(null);
  };
  const clear = () => { const t = Date.now(); setSeenAt(t); write(SEEN, String(t)); };
  const chipClass = running.length ? 'live' : failedNew.length ? 'fail' : '';
  const one = running.length === 1 ? running[0] : null; const onePct = one ? pctOf(one.progress) : null;
  const chipText = one ? `${label(one)}${onePct != null ? ` · ${onePct}%` : ' in corso'}` : running.length ? `${running.length} operazioni in corso` : failedNew.length ? `${failedNew.length} ${failedNew.length === 1 ? 'operazione fallita' : 'operazioni fallite'}` : 'Attività';

  return <div className="dock" role="complementary" aria-label="Attività">
    {open ? <div className="dock-panel" id="dock-panel" onKeyDown={e => { if (e.key === 'Escape') toggle(false); }}>
      <div className="dock-hd"><Icon n="activity" /><h2>Attività</h2>
        <span className="small faint">{running.length ? `${running.length} in corso` : 'Nessuna operazione in corso'}</span>
        <Button kind="ghost" sm className="icon" onClick={() => toggle(false)} aria-label="Chiudi il pannello attività" title="Chiudi (Esc)"><Icon n="down" /></Button></div>
      <div className="dock-body">
        {running.length ? <div className="dock-sec">In corso</div> : null}
        {running.map(o => {
          const p = o.progress; const pct = pctOf(p); const to = target(o);
          return <div className="dock-item" key={o.id}>
            <div className="t"><Icon n="refresh" spin /><strong>{label(o)}</strong><span className="end small faint nowrap">{elapsed(o.createdAt, now)}</span></div>
            <Progress pct={pct} />
            <div className="small muted">{o.cancelRequested ? 'Annullamento in corso…' : p?.phase ? PHASE[p.phase] || p.phase : o.status === 'queued' ? 'In coda: parte appena l’agent è libero' : 'In esecuzione…'}</div>
            <div className="m"><span>{names[o.clusterId] || o.clusterId}</span>{o.createdBy ? <span>da {o.createdBy}</span> : null}<span>{STATUS_LABEL[o.status] || o.status}</span></div>
            <div className="acts">{to ? <Button sm icon="external" onClick={() => go(to)}>Apri</Button> : null}
              {to ? <Button sm icon="logs" onClick={() => go(to.replace('/operations', '/logs'))}>Log</Button> : null}
              {canAct && !o.cancelRequested ? <Button sm kind="danger" icon="stop" busy={busy === o.id} onClick={() => cancel(o)}>Annulla</Button> : null}</div>
          </div>;
        })}
        {!running.length && !recent.length ? <div className="dock-item"><div className="muted small">Qui compaiono backup, ripristini e interventi mentre sono in corso e per un’ora dopo la fine. Puoi continuare a lavorare: il pannello si aggiorna da solo.</div></div> : null}
        {recent.length ? <div className="dock-sec">Terminate di recente</div> : null}
        {recent.map(o => {
          const to = target(o);
          return <div className="dock-item done" key={o.id}>
            <div className="t"><Icon n={o.status === 'succeeded' ? 'check' : o.status === 'failed' ? 'alert' : 'cancel'} /><strong>{label(o)}</strong><span className="end small faint nowrap">{ago(o.updatedAt)}</span></div>
            <div className="m"><span>{STATUS_LABEL[o.status] || o.status}</span><span>{names[o.clusterId] || o.clusterId}</span>{o.createdBy ? <span>da {o.createdBy}</span> : null}</div>
            {o.status === 'failed' && o.error ? <div className="err">{o.error}</div> : null}
            {to ? <div className="acts"><Button sm icon="external" onClick={() => go(to)}>Dettagli</Button></div> : null}
          </div>;
        })}
      </div>
      <div className="dock-ft"><span className="small faint">Ctrl J apre e chiude</span>{recent.length ? <Button sm kind="ghost" onClick={clear}>Svuota elenco</Button> : null}</div>
    </div> : null}
    <button className={`dock-chip ${chipClass}`} onClick={() => toggle()} aria-expanded={open} aria-controls="dock-panel" title="Attività (Ctrl J)">
      <span className="pip" /><span aria-live="polite">{chipText}</span><Icon n="down" className={open ? '' : 'flip'} />
    </button>
  </div>;
}
