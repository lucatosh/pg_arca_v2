import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';
import { Icon, Button, Progress, tm } from './ui';
import { isTerminal, toast } from './hooks';
import { OP_LABEL, PHASE, STATUS_LABEL, pctOf } from './pages/shared';

/** Floating, movable, resizable, minimisable window with the log of ONE operation (what the agent reported + the status changes). Not modal: the work underneath stays usable.
 *  Opened from anywhere with openOpLog(id, title). Position / size / minimised state are remembered per browser. */
export type LogLine = { at: string; text: string; kind: 'status' | 'log' };
const EVT = 'arca:oplog'; const POS = 'arca.oplog.geom';
export const openOpLog = (id: string, title?: string) => window.dispatchEvent(new CustomEvent(EVT, { detail: { id, title } }));
const readGeom = () => { try { const g = JSON.parse(localStorage.getItem(POS) || ''); if (g && typeof g.x === 'number') return g; } catch { /* default */ } return null; };
const hhmmss = (iso: string) => tm(iso);
const STATUS_TEXT: Record<string, string> = { queued: 'queued', leased: 'assigned to the agent', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', expired: 'expired' };
const lineText = (l: LogLine) => {
  if (l.kind === 'status') { const [st, ...rest] = l.text.split(': '); return `${STATUS_TEXT[st] ? STATUS_TEXT[st][0].toUpperCase() + STATUS_TEXT[st].slice(1) : st}${rest.length ? ' — ' + rest.join(': ') : ''}`; }
  const [phase, ...rest] = l.text.split(' · ');
  return [PHASE[phase] || phase, ...rest].join(' · ');
};

function OneLog({ id, title, index, onClose }: { id: string; title?: string; index: number; onClose: () => void }) {
  const [lines, setLines] = useState<LogLine[]>([]); const [meta, setMeta] = useState<any>(null);
  const [min, setMin] = useState(false); const [onlyAgent, setOnlyAgent] = useState(false); const [follow, setFollow] = useState(true);
  const [geom, setGeom] = useState<{ x: number; y: number; w: number; h: number }>(() => { const g = readGeom(); const w = Math.min(g?.w || 460, window.innerWidth - 16), h = Math.min(g?.h || 300, window.innerHeight - 16); return { x: Math.max(8, Math.min(g?.x ?? 24 + index * 28, window.innerWidth - w - 8)), y: Math.max(8, Math.min(g?.y ?? window.innerHeight - h - 90 - index * 28, window.innerHeight - 60)), w, h }; });
  const after = useRef(0); const body = useRef<HTMLDivElement>(null); const box = useRef<HTMLDivElement>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let t: any; let stop = false;
    const tick = async () => {
      try {
        const r: any = await get(`/api/operations/${id}/log?after=${after.current}`);
        if (!alive.current || stop) return;
        if (r.lines?.length) { after.current = r.total; setLines(p => [...p, ...r.lines].slice(-1500)); }
        setMeta({ status: r.status, type: r.type, progress: r.progress, error: r.error });
        if (isTerminal(r.status)) return;          // everything is in: no more polling
      } catch (e: any) { if (alive.current && !stop) setMeta((m: any) => ({ ...(m || {}), problem: e.message })); }
      t = setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, [id]);

  useEffect(() => { if (follow && !min && body.current) body.current.scrollTop = body.current.scrollHeight; }, [lines, follow, min]);
  const persist = (g: typeof geom) => { try { localStorage.setItem(POS, JSON.stringify(g)); } catch { /* private mode */ } };
  // move by the header (pointer events: mouse, pen and touch alike); the window never leaves the viewport
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const sx = e.clientX, sy = e.clientY, g0 = geom; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => setGeom(g => ({ ...g, x: Math.max(0, Math.min(window.innerWidth - 120, g0.x + ev.clientX - sx)), y: Math.max(0, Math.min(window.innerHeight - 40, g0.y + ev.clientY - sy)) }));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setGeom(g => { persist(g); return g; }); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  // CSS `resize: both` does the resizing; remember the size when the pointer is released
  const keepSize = () => { const b = box.current; if (!b || min) return; setGeom(g => { const n = { ...g, w: b.offsetWidth, h: b.offsetHeight }; persist(n); return n; }); };
  const done = isTerminal(meta?.status); const p = meta?.progress; const pct = pctOf(p);
  const shown = onlyAgent ? lines.filter(l => l.kind === 'log') : lines;
  const copy = async () => { try { await navigator.clipboard.writeText(shown.map(l => `${l.at} ${lineText(l)}`).join('\n')); toast('Log copied', 'ok'); } catch { toast('Copy failed: select the text by hand', 'bad'); } };
  const name = title || OP_LABEL[meta?.type] || meta?.type || 'Operation';
  const tone = meta?.status === 'failed' || meta?.status === 'expired' ? 'bad' : meta?.status === 'succeeded' ? 'ok' : meta?.status === 'cancelled' ? 'warn' : 'live';
  return <div ref={box} className={`oplog ${min ? 'min' : ''} ${tone}`} role="dialog" aria-label={`Log: ${name}`} onPointerUp={keepSize}
    style={{ left: geom.x, top: geom.y, width: min ? 300 : geom.w, height: min ? undefined : geom.h }}>
    <div className="oplog-hd" onPointerDown={drag} onDoubleClick={() => setMin(m => !m)}>
      <span className="pip" />
      <strong className="nm" title={name}>{name}</strong>
      <span className="st small">{meta ? STATUS_TEXT[meta.status] || STATUS_LABEL[meta.status] || meta.status : '…'}{!done && pct != null ? ` · ${pct}%` : ''}</span>
      <Button kind="ghost" sm className="icon" onClick={() => setMin(m => !m)} aria-label={min ? 'Expand the log' : 'Minimize'} title={min ? 'Expand' : 'Shrink'}><Icon n={min ? 'chev' : 'minus'} s={14} /></Button>
      <Button kind="ghost" sm className="icon" onClick={onClose} aria-label="Close the log" title="Close (the operation keeps running)"><Icon n="x" s={14} /></Button>
    </div>
    {min ? null : <>
      {!done ? <div className="oplog-pr"><Progress pct={pct} /><div className="small muted">{p?.phase ? PHASE[p.phase] || p.phase : meta?.status === 'queued' ? 'Queued: starts as soon as the agent is free' : 'Running…'}</div></div> : null}
      <div className="oplog-tools small">
        <label className="chk"><input type="checkbox" checked={onlyAgent} onChange={e => setOnlyAgent(e.target.checked)} /> Progress only</label>
        <label className="chk"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Follow</label>
        <span className="grow" /><button className="lnk" onClick={copy}>Copy</button>
      </div>
      <div className="oplog-body mono" ref={body} onScroll={e => { const el = e.currentTarget; const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24; if (!atEnd && follow) setFollow(false); }} tabIndex={0} aria-live="off">
        {shown.length ? shown.map((l, i) => <div key={i} className={`ln ${l.kind}`}><span className="t">{hhmmss(l.at)}</span><span className="x">{lineText(l)}</span></div>)
          : <div className="muted small" style={{ padding: 10 }}>{meta?.problem ? `Log unavailable: ${meta.problem}` : 'Waiting for the agent’s first messages…'}</div>}
        {done && meta?.error ? <div className="ln status err"><span className="t" /><span className="x">{String(meta.error).slice(0, 1200)}</span></div> : null}
      </div>
    </>}
  </div>;
}

export function OpLogHost() {
  const [open, setOpen] = useState<{ id: string; title?: string }[]>([]);
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent).detail; if (!d?.id) return; setOpen(o => (o.some(x => x.id === d.id) ? o : [...o, { id: d.id, title: d.title }].slice(-3))); };
    window.addEventListener(EVT, f); return () => window.removeEventListener(EVT, f);
  }, []);
  const close = useCallback((id: string) => setOpen(o => o.filter(x => x.id !== id)), []);
  return <>{open.map((o, i) => <OneLog key={o.id} id={o.id} title={o.title} index={i} onClose={() => close(o.id)} />)}</>;
}
