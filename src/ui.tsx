import React, { useEffect, useRef, useState } from 'react';
import { useToasts } from './hooks';

/* ---------- icons: 24px stroke set, inline (no dependency) ---------- */
const P: Record<string, string> = {
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  ark: 'M3 15c3 1.5 6 2 9 2s6-.5 9-2l-2 4H5l-2-4zM12 3v8M12 5l5 3-5 2',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  server: 'M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z', restore: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 8v4l3 2',
  plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18', check: 'M5 12l5 5L20 7', alert: 'M12 3l10 18H2L12 3zM12 10v5M12 18h.01',
  info: 'M12 8h.01M11 12h1v5h1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', refresh: 'M20 11a8 8 0 00-14.9-3M4 4v4h4M4 13a8 8 0 0014.9 3M20 20v-4h-4',
  play: 'M7 4l13 8-13 8V4z', stop: 'M6 6h12v12H6z', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15V4h11', link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .7a7 7 0 00-1.6-.9L15 4H9l-.4 2.8a7 7 0 00-1.6.9L5 7l-2 4 2 1a7 7 0 000 2l-2 1 2 4 2-.7c.5.4 1 .7 1.6.9L9 20h6l.4-2.8c.6-.2 1.1-.5 1.6-.9l2 .7 2-4-2-1c.1-.7.1-1.3 0-2z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', logs: 'M4 4h16v16H4zM8 9l3 3-3 3M13 15h4', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  swap: 'M7 4l-4 4 4 4M3 8h14M17 20l4-4-4-4M21 16H7', search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  chev: 'M9 6l6 6-6 6', down: 'M6 9l6 6 6-6', hdd: 'M3 14h18v6H3zM3 14l3-9h12l3 9M7 17h.01', layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5', zap: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z', pause: 'M8 5v14M16 5v14', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  logout: 'M9 4H4v16h5M16 8l4 4-4 4M20 12H9', bolt: 'M11 3L5 13h6l-1 8 7-11h-6l0-7z', flask: 'M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3', calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
};
export function Icon({ n, s = 16, className, spin }: { n: string; s?: number; className?: string; spin?: boolean }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={(className || '') + (spin ? ' spin' : '')} aria-hidden="true"><path d={P[n] || P.info} /></svg>;
}

/* ---------- formatters ---------- */
export function bytes(n?: number | null): string { if (n == null || !isFinite(n)) return '—'; const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; let v = Math.abs(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${(n < 0 ? -v : v).toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`; }
export function dur(sec?: number | null): string { if (sec == null) return '—'; const s = Math.round(sec); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`; return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; }
export function ago(iso?: string | null, now = Date.now()): string { if (!iso) return '—'; const s = (now - Date.parse(iso)) / 1000; if (!isFinite(s)) return '—'; if (s < 0) return 'ora'; if (s < 60) return `${Math.floor(s)}s fa`; if (s < 3600) return `${Math.floor(s / 60)} min fa`; if (s < 86400) return `${Math.floor(s / 3600)} h fa`; return `${Math.floor(s / 86400)} g fa`; }
export const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-CH', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const num = (n?: number | null) => (n == null ? '—' : n.toLocaleString('it-CH'));

/* ---------- components ---------- */
export function Button({ kind, sm, icon, busy, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'danger' | 'ghost'; sm?: boolean; icon?: string; busy?: boolean }) {
  return <button {...rest} disabled={rest.disabled || busy} className={`btn ${kind || ''} ${sm ? 'sm' : ''} ${rest.className || ''}`}>{busy ? <Icon n="refresh" spin /> : icon ? <Icon n={icon} /> : null}{children}</button>;
}
export const Badge = ({ kind, children, title }: { kind?: 'ok' | 'warn' | 'bad' | 'info' | 'accent'; children: React.ReactNode; title?: string }) => <span title={title} className={`badge ${kind || ''}`}>{children}</span>;
export const Dot = ({ kind }: { kind?: 'ok' | 'warn' | 'bad' }) => <span className={`dot ${kind || ''}`} />;
export function Card({ title, actions, children, pad = true }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; pad?: boolean }) {
  return <section className="card">{title ? <div className="hd"><h2>{title}</h2>{actions}</div> : null}{pad ? <div className="bd">{children}</div> : children}</section>;
}
export function Banner({ kind, icon, title, children, actions }: { kind: 'ok' | 'warn' | 'bad' | 'info'; icon?: string; title?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'bad' ? 'alert' : 'status'}><Icon n={icon || (kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert')} s={18} className="ic" /><div className="grow">{title ? <strong>{title}</strong> : null}{children ? <div className={title ? 'small' : ''} style={{ marginTop: title ? 2 : 0 }}>{children}</div> : null}</div>{actions}</div>;
}
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}</div>;
}
export const Progress = ({ pct }: { pct?: number | null }) => pct == null ? <div className="progress indet"><i /></div> : <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>;
export function Empty({ icon, title, children, action }: { icon?: string; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="empty">{icon ? <Icon n={icon} s={30} /> : null}<h2>{title}</h2>{children ? <p style={{ maxWidth: 520, margin: '0 auto 14px' }}>{children}</p> : null}{action}</div>;
}
export const Skeleton = ({ h = 14, w = '100%' }: { h?: number; w?: number | string }) => <div className="skeleton" style={{ height: h, width: w }} />;

export function Modal({ title, onClose, children, footer, wide, locked }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; locked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button.primary')?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !locked) onClose(); };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus?.(); };
  }, [onClose, locked]);
  return <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget && !locked) onClose(); }}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref}>
      <div className="hd"><h2>{title}</h2>{!locked && <Button kind="ghost" className="icon" onClick={onClose} aria-label="Chiudi"><Icon n="x" /></Button>}</div>
      <div className="bd">{children}</div>{footer ? <div className="ft">{footer}</div> : null}
    </div></div>;
}
export function Confirm({ title, children, confirmLabel, danger, requireText, onConfirm, onClose, busy }: { title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; requireText?: string; onConfirm: () => void; onClose: () => void; busy?: boolean }) {
  const [t, setT] = useState('');
  return <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Annulla</Button><Button kind={danger ? 'danger' : 'primary'} busy={busy} disabled={!!requireText && t !== requireText} onClick={onConfirm}>{confirmLabel}</Button></>}>
    <div className="stack">{children}{requireText ? <Field label={`Per confermare scrivi ${requireText}`}><input className="input" value={t} onChange={e => setT(e.target.value)} autoFocus /></Field> : null}</div>
  </Modal>;
}
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; icon?: string; preview?: boolean; badge?: React.ReactNode }[] }) {
  return <div className="tabs" role="tablist">{items.map(i => <button key={i.id} role="tab" aria-selected={value === i.id} className={i.preview ? 'preview' : ''} onClick={() => onChange(i.id)}>{i.icon ? <Icon n={i.icon} /> : null}{i.label}{i.preview ? <Badge>Anteprima</Badge> : null}{i.badge}</button>)}</div>;
}
export function Toasts() {
  const ts = useToasts();
  return <div className="toasts" aria-live="polite">{ts.map(t => <div key={t.id} className={`toast ${t.kind === 'info' ? '' : t.kind}`}><Icon n={t.kind === 'bad' ? 'alert' : t.kind === 'ok' ? 'check' : 'info'} />{t.text}</div>)}</div>;
}
export function CopyBlock({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <div className="copy"><pre className="out">{text}</pre><Button sm icon={ok ? 'check' : 'copy'} onClick={async () => { try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ } setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? 'Copiato' : 'Copia'}</Button></div>;
}
export const Preview = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card><Empty icon="flask" title={title} action={<Badge>Anteprima</Badge>}>{children}</Empty></Card>
);
