import React, { useRef } from 'react';
import { TYPE_LABEL, SetRow } from './Backup';
import { dt } from '../ui';

export interface TlEvent { at: number; label: string }
const fmt = (ms: number) => dt(ms);
/** The axis has three labels side by side: day and minute are enough there (the full point is in the slider value). */
const axis = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** The recovery timeline: backups as ticks, the recoverable window shaded, a draggable pointer for the target instant. */
export function RecoveryTimeline({ sets, from, to, value, onChange, events = [], broken }: { sets: SetRow[]; from: number; to: number; value: number | null; onChange: (ms: number | null) => void; events?: TlEvent[]; broken?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const span = Math.max(to - from, 60_000);
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - from) / span) * 100));
  const at = (clientX: number) => { const r = ref.current!.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width)); return f >= 0.995 ? null : Math.round(from + f * span); };
  const cur = value ?? to;
  const key = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 3600_000 : 60_000; let n: number | null | undefined;
    if (e.key === 'ArrowLeft') n = Math.max(from, cur - step); else if (e.key === 'ArrowRight') n = cur + step >= to ? null : cur + step;
    else if (e.key === 'Home') n = from; else if (e.key === 'End') n = null; else return;
    e.preventDefault(); onChange(n);
  };
  const done = sets.filter(s => s.status === 'COMPLETE' && s.stop_time);
  return <div className="rt rtwrap">
    <div className="track" ref={ref} role="slider" tabIndex={0} aria-label="Recovery target" aria-valuemin={from} aria-valuemax={to} aria-valuenow={cur} aria-valuetext={value == null ? 'latest available point' : fmt(value)}
      onKeyDown={key} onPointerDown={e => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); onChange(at(e.clientX)); }}
      onPointerMove={e => { if (e.buttons & 1) onChange(at(e.clientX)); }}>
      <div className="window" style={{ left: 0, right: 0 }} />
      {done.map(s => { const t = Date.parse(s.stop_time!); return t >= from && t <= to ? <div key={s.id} className={`tick ${s.type === 'full' ? 'F' : s.type === 'diff' ? 'D' : 'I'}`} style={{ left: `${pct(t)}%` }} title={`${TYPE_LABEL[s.type]} — ${fmt(t)}`} /> : null; })}
      {events.map((e, i) => <div key={i} className="evt" style={{ left: `${pct(e.at)}%` }} title={e.label} />)}
      <div className="ptr" style={{ left: `${Math.min(pct(cur), 99.3)}%` }} />
    </div>
    <div className="axis"><span>{axis(from)}</span><span>{axis(from + span / 2)}</span><span>{axis(to)}</span></div>
    <div className="row wrap small muted" style={{ marginTop: 8, gap: 16 }}>
      <span><i className="tick F" style={{ position: 'static', display: 'inline-block', height: 12, width: 4, marginRight: 6 }} />Full</span>
      <span><i className="tick D" style={{ position: 'static', display: 'inline-block', height: 12, marginRight: 6 }} />Differential</span>
      <span><i className="tick I" style={{ position: 'static', display: 'inline-block', height: 12, marginRight: 6 }} />Incremental</span>
      {events.length ? <span><i className="evt" style={{ position: 'static', display: 'inline-block', transform: 'rotate(45deg)', marginRight: 8 }} />DROP / TRUNCATE</span> : null}
      {broken ? <span style={{ color: 'var(--bad)' }}>Careful: the WAL archive has gaps, not the whole window is recoverable.</span> : null}
    </div></div>;
}
