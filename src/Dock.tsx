import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { Icon, Button, Progress, ago } from './ui';
import { Op, OPS_SLIM_KEY, isTerminal, revalidateOps, toast, useQuery, useRole, dismissToastsTagged, isOnScreen } from './hooks';
import { go } from './router';
import { openOpLog } from './OpLog';
import { OP_LABEL, PHASE, STATUS_LABEL, pctOf, hintFor } from './pages/shared';
import { WINDOWS } from './pages/History';
import { itCheck } from './i18n';

/** Operations that only read (catalogue, plans, scans) are noise for the dock: they finish in a blink and nobody waits for them. */
const QUIET = ['backup_catalog', 'restore_plan', 'backup_info', 'discovery_scan', 'list_objects', 'hba_read', 'hba_plan', 'agent_config_get', 'compat_check', 'wal_forensics', 'restore_diff'];   // read-only helpers: the page that asked shows the outcome
const KEY = 'arca.dock'; const SEEN = 'arca.dock.seen'; const WIN = 'arca.dock.window'; const FILT = 'arca.dock.filter'; const GONE = 'arca.dock.dismissed';
const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

type SlimOp = Op & { subtype?: string; background?: boolean; readonly?: boolean; work?: string };
// the same work again (server/optypes sameWork): same type, cluster and meaningful parameters, same node except for backups
const same = (a: SlimOp, b: SlimOp) => a.type === b.type && a.clusterId === b.clusterId && (a.work ?? '') === (b.work ?? '') && (a.type === 'backup_run' || a.type === 'backup_expire' || (a.nodeId || '') === (b.nodeId || ''));
const label = (o: SlimOp) => `${OP_LABEL[o.type] || o.type}${o.subtype ? ` (${o.subtype})` : ''}`;
const elapsed = (from: string, now: number) => { const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`; };

/** Opens the page where the operation can be followed: the cluster's operation log (or Backup / Restore for the long data operations). */
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
  const [hours, setHours] = useState(() => { const h = Number(read(WIN, '1')); return WINDOWS.some(w => w.h === h) ? h : 1; });
  const [filt, setFilt] = useState<'all' | 'failed' | 'ok'>(() => { const f = read(FILT, 'all'); return f === 'failed' || f === 'ok' ? f : 'all'; });
  const [gone, setGone] = useState<string[]>(() => { try { const a = JSON.parse(read(GONE, '[]')); return Array.isArray(a) ? a.slice(-500) : []; } catch { return []; } });
  const [busy, setBusy] = useState<string | null>(null);
  const names = useMemo(() => { const m: Record<string, string> = {}; for (const c of clusters) m[c.id] = c.name; return m; }, [clusters]);

  // Poll fast only while something runs; otherwise a slow heartbeat is enough (the query also pauses with the tab hidden and skips unchanged payloads).
  const [fast, setFast] = useState(false);
  const q = useQuery<{ operations: SlimOp[] }>(OPS_SLIM_KEY, { interval: fast ? 2000 : 8000 });
  // background = lookups the page makes on its own; readonly = operations that change nothing (reading settings, listing, planning): the page
  // that asked shows the answer, a card or a toast for them is noise (an independent UX review found toasts covering the buttons on most screens)
  const all = (q.data?.operations || []).filter(o => !QUIET.includes(o.type) && !o.background && !o.readonly);
  const running = all.filter(o => !isTerminal(o.status));
  const gset = useMemo(() => new Set(gone), [gone]);
  const finished = all.filter(o => isTerminal(o.status) && Date.parse(o.updatedAt || o.createdAt) >= now - hours * 3_600_000 && !gset.has(o.id));
  const failedAll = finished.filter(o => o.status === 'failed' || o.status === 'expired');
  const recent = finished.filter(o => filt === 'all' || (filt === 'failed' ? o.status === 'failed' || o.status === 'expired' : o.status === 'succeeded')).slice(0, 40);
  // a failure followed by a success of the same operation on the same cluster is history, not an alarm on every page
  const superseded = (o: SlimOp) => all.some(x => x.status === 'succeeded' && same(x, o) && Date.parse(x.updatedAt) > Date.parse(o.updatedAt));
  const failedNew = all.filter(o => o.status === 'failed' && !gset.has(o.id) && Date.parse(o.updatedAt) > seenAt && Date.now() - Date.parse(o.updatedAt) < 10 * 60_000 && !superseded(o));
  useEffect(() => { setFast(running.length > 0); }, [running.length]);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  // live clock only while it is visible and useful
  useEffect(() => { if (!open || !running.length) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [open, running.length]);

  // Tell the user how their own operations ended (scheduled ones stay quiet: they are in the dock and on Today).
  const prev = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const cur: Record<string, string> = {}; for (const o of q.data.operations) cur[o.id] = o.status;
    if (prev.current) for (const o of q.data.operations) {
      const was = prev.current[o.id];
      if (!was || isTerminal(was) || !isTerminal(o.status)) continue;
      const tag = `${o.clusterId || ''}:${o.type}:${o.type === 'backup_run' ? '' : o.nodeId || ''}:${o.work || ''}`;
      if (o.status === 'succeeded') dismissToastsTagged(tag);                 // a retry that worked: the earlier failure toast is stale
      if (o.createdBy !== me || QUIET.includes(o.type) || o.background || o.readonly || (o.params?.dry_run && o.status === 'succeeded')) continue;
      if (isOnScreen(o.id)) continue;                                          // the page that started it shows the outcome itself
      // successes: the page that started it shows the outcome and the chip says it; only what needs attention pops up
      if (o.status === 'failed') { const first = itCheck((o.error || '').split('\n')[0]); const hint = hintFor(o.error); const code = (/PGA-[A-Z]+-\d+/.exec(first) || [])[0];
        // a toast is a pointer, not the report: the first sentence of the explanation, the whole of it is on the page and in Activity
        const one = (t: string) => { const x = t.split(/(?<=\.)\s/)[0]; return x.length > 150 ? x.slice(0, 147) + '…' : x; };
        toast(`${label(o)} failed: ${one(hint || first)}${code ? ` (${code})` : ''} Details in Activity.`, 'bad', 9000, tag); }
      else if (o.status === 'cancelled') toast(`${label(o)}: cancelled`, 'info');
    }
    prev.current = cur;
  }, [q.data, me]);

  useEffect(() => { const f = () => { revalidateOps(); setTimeout(revalidateOps, 1200); }; window.addEventListener('arca:ops', f); return () => window.removeEventListener('arca:ops', f); }, []);
  const toggle = useCallback((v?: boolean) => setOpen(o => { const n = v ?? !o; write(KEY, n ? '1' : '0'); return n; }), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle(); } };
    const show = () => toggle(true); const flip = () => toggle();
    window.addEventListener('keydown', k); window.addEventListener('arca:dock', show); window.addEventListener('arca:dock-toggle', flip);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('arca:dock', show); window.removeEventListener('arca:dock-toggle', flip); };
  }, [toggle]);

  const cancel = async (o: SlimOp) => {
    setBusy(o.id);
    try { await api('POST', `/api/operations/${o.id}/cancel`); toast('Cancellation requested', 'info'); }
    catch (e: any) { toast(e.body?.reason || e.message, 'bad'); }
    await revalidateOps(); setBusy(null);
  };
  const dismiss = (ids: string[]) => setGone(g => { const n = [...g, ...ids].slice(-500); write(GONE, JSON.stringify(n)); return n; });
  const clear = () => { const t = Date.now(); setSeenAt(t); write(SEEN, String(t)); dismiss(recent.map(o => o.id)); };
  const pickHours = (h: number) => { setHours(h); write(WIN, String(h)); setNow(Date.now()); };
  const pickFilt = (f: 'all' | 'failed' | 'ok') => { setFilt(f); write(FILT, f); };
  const chipClass = running.length ? 'live' : failedNew.length ? 'fail' : '';
  const one = running.length === 1 ? running[0] : null; const onePct = one ? pctOf(one.progress) : null;
  // a failure names WHAT failed (round 4: "1 operation failed" during a restore was read as the restore)
  const chipText = one ? `${label(one)}${onePct != null ? ` · ${onePct}%` : ' running'}` : running.length ? `${running.length} operations running` : failedNew.length === 1 ? `${label(failedNew[0])} failed` : failedNew.length ? `${failedNew.length} operations failed` : 'Activity';
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('actslot')); }, []);

  // idle, the activity lives in the top bar (a floating chip covered the wizards' Next / Put back buttons, round-3 review):
  // the chip floats only while something runs or has just failed, and the panel opens where it was asked from
  // the top bar carries the state (running / failed, by name); the chip floats only while something RUNS - a failure no longer sits over the
  // page's buttons for ten minutes
  const floating = chipClass === 'live';
  const topBtn = slot ? createPortal(<button className={`btn actbtn ${chipClass}`} onClick={() => toggle()} aria-expanded={open} aria-controls="dock-panel" title="Activity: running and recent operations (Ctrl J)">
    {chipClass ? <span className="pip" /> : <Icon n="activity" />}<span className="pt">{chipClass ? chipText : 'Activity'}</span></button>, slot) : null;
  return <div className={`dock ${floating ? '' : 'top'}`} role="complementary" aria-label="Activity">{topBtn}
    {open ? <div className="dock-panel" id="dock-panel" onKeyDown={e => { if (e.key === 'Escape') toggle(false); }}>
      <div className="dock-hd"><Icon n="activity" /><h2>Activity</h2>
        <span className="small faint">{running.length ? `${running.length} running` : 'No operation running'}</span>
        <Button kind="ghost" sm className="icon" onClick={() => toggle(false)} aria-label="Close the activity panel" title="Close (Esc)"><Icon n="down" /></Button></div>
      <div className="dock-body">
        {running.length ? <div className="dock-sec">Running</div> : null}
        {running.map(o => {
          const p = o.progress; const pct = pctOf(p); const to = target(o);
          return <div className="dock-item" key={o.id}>
            <div className="t"><Icon n="refresh" spin /><strong>{label(o)}</strong><span className="end small faint nowrap">{elapsed(o.createdAt, now)}</span></div>
            <Progress pct={pct} />
            <div className="small muted">{o.cancelRequested ? 'Cancelling…' : p?.phase ? PHASE[p.phase] || p.phase : o.status === 'queued' ? 'Queued: starts as soon as the agent is free' : 'Running…'}</div>
            <div className="m"><span>{names[o.clusterId] || o.clusterId}</span>{o.createdBy ? <span>by {o.createdBy}</span> : null}<span>{STATUS_LABEL[o.status] || o.status}</span></div>
            <div className="acts">{to ? <Button sm icon="external" onClick={() => go(to)}>Open</Button> : null}
              <Button sm icon="logs" onClick={() => openOpLog(o.id, label(o))}>Log</Button>
              {canAct && !o.cancelRequested ? <Button sm kind="danger" icon="stop" busy={busy === o.id} onClick={() => cancel(o)}>Cancel</Button> : null}</div>
          </div>;
        })}
        {!running.length && !recent.length ? <div className="dock-item"><div className="muted small">Backups, restores and other operations show up here while they run and for an hour after they end. Keep working: the panel updates by itself.</div></div> : null}
        <div className="dock-sec dock-tools">
          <span>Finished</span>
          <select className="input sm" value={hours} onChange={e => pickHours(Number(e.target.value))} aria-label="Time range">{WINDOWS.map(w => <option key={w.h} value={w.h}>{w.label}</option>)}</select>
          <span className="seg" role="group" aria-label="Outcome">
            {([['all', 'All'], ['failed', `Failed${failedAll.length ? ` (${failedAll.length})` : ''}`], ['ok', 'Succeeded']] as const).map(([k, t]) => <button key={k} aria-pressed={filt === k} onClick={() => pickFilt(k)}>{t}</button>)}</span>
        </div>
        {!recent.length && (running.length || all.length) ? <div className="dock-item"><div className="muted small">{filt === 'failed' ? 'No failed operation in this range.' : filt === 'ok' ? 'No successful operation in this range.' : 'Nothing finished in this range.'} <a href="#/history" onClick={() => toggle(false)}>Open the history</a> to search further back.</div></div> : null}
        {recent.map(o => {
          const to = target(o);
          return <div className="dock-item done" key={o.id}>
            <div className="t"><Icon n={o.status === 'succeeded' ? 'check' : o.status === 'failed' ? 'alert' : 'cancel'} /><strong>{label(o)}</strong><span className="end small faint nowrap">{ago(o.updatedAt)}</span>
              <button className="x" onClick={() => dismiss([o.id])} aria-label={`Remove from the list: ${label(o)}`} title="Remove from the list (it stays in the history)"><Icon n="x" s={14} /></button></div>
            <div className="m"><span>{STATUS_LABEL[o.status] || o.status}</span><span>{names[o.clusterId] || o.clusterId}</span>{o.createdBy ? <span>by {o.createdBy}</span> : null}</div>
            {o.status === 'failed' && o.error ? <div className="err">{o.error}</div> : null}
            <div className="acts">{to ? <Button sm icon="external" onClick={() => go(to)}>Details</Button> : null}<Button sm icon="logs" onClick={() => openOpLog(o.id, label(o))}>Log</Button></div>
          </div>;
        })}
      </div>
      <div className="dock-ft"><span className="small faint">Ctrl J opens and closes</span><div className="grow" /><a className="small" href="#/history" onClick={() => toggle(false)}>History</a>{recent.length ? <Button sm kind="ghost" onClick={clear}>Clear list</Button> : null}</div>
    </div> : null}
    {floating ? <button className={`dock-chip ${chipClass}`} onClick={() => toggle()} aria-expanded={open} aria-controls="dock-panel" title="Activity (Ctrl J)">
      <span className="pip" /><span aria-live="polite">{chipText}</span><Icon n="down" className={open ? '' : 'flip'} />
    </button> : null}
  </div>;
}
