import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from './AuthGate';
import { useQuery } from './hooks';
import { Icon, Toasts, Dot, Empty, Skeleton } from './ui';
import { go, useRoute } from './router';
import { TAB_ITEMS } from './tabs';
import { TodayPage, useHealth } from './pages/Today';
import { JoinBanner } from './pages/Join';
import { ActivityDock } from './Dock';

// Everything but the shell, "Oggi" and the first page is loaded on demand: a first paint of a few tens of KB, not the whole console.
const Clusters = lazy(() => import('./pages/Clusters').then(m => ({ default: m.Clusters })));
const ClusterView = lazy(() => import('./pages/ClusterView').then(m => ({ default: m.ClusterView })));
const Audit = lazy(() => import('./pages/Global').then(m => ({ default: m.Audit })));
const Discovery = lazy(() => import('./pages/Global').then(m => ({ default: m.Discovery })));
const StrategyPage = lazy(() => import('./pages/Strategy').then(m => ({ default: m.StrategyPage })));
const UsersPage = lazy(() => import('./pages/Users').then(m => ({ default: m.UsersPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then(m => ({ default: m.SettingsPage })));

export const statusKind = (s?: string): 'ok' | 'warn' | 'bad' => (s === 'healthy' ? 'ok' : s === 'degraded' ? 'warn' : s === 'critical' || s === 'down' ? 'bad' : 'warn');

function theme(): 'light' | 'dark' | 'auto' { try { return (localStorage.getItem('arca.theme') as any) || 'auto'; } catch { return 'auto'; } }
function applyTheme(t: string) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('arca.theme', t); } catch { /* private mode */ } }

export function App() {
  useEffect(() => { applyTheme(theme()); }, []);
  return <><AuthGate>{(s, logout) => <Shell user={s.user} role={s.role} logout={logout} />}</AuthGate><Toasts /></>;
}

const rd = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const wr = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const PAGE_TITLE: Record<string, string> = { today: 'Oggi', clusters: 'Cluster', strategy: 'Strategie di backup', discovery: 'Rilevamento', settings: 'Impostazioni', users: 'Utenti', audit: 'Registro attività' };

function Shell({ user, role, logout }: { user: string; role: string; logout: () => void }) {
  const route = useRoute();
  const { data, loading } = useQuery<{ clusters: any[]; demoAvailable: boolean }>('/api/clusters', { interval: 6000 });
  const health = useHealth(30000); const hc = health.data?.counts; const urgent = (hc?.critical || 0) + (hc?.warning || 0);
  const [pal, setPal] = useState(false);
  const [th, setTh] = useState(theme());
  const [rail, setRail] = useState(() => rd('arca.rail') === '1');
  const [cq, setCq] = useState('');
  const clusters = data?.clusters || [];
  const shown = useMemo(() => { const s = cq.trim().toLowerCase(); return s ? clusters.filter(c => c.name.toLowerCase().includes(s)) : clusters; }, [clusters, cq]);
  const cur = route.page === 'cluster' ? clusters.find(c => c.id === route.id) : null;

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal(p => !p); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  // each page starts at the top; the cluster pages keep their position when only the tab changes
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => { pageRef.current?.scrollTo({ top: 0 }); }, [route.page, route.id]);
  const cycle = () => { const n = th === 'auto' ? 'dark' : th === 'dark' ? 'light' : 'auto'; applyTheme(n); setTh(n); };
  const toggleRail = () => { const n = !rail; setRail(n); wr('arca.rail', n ? '1' : '0'); };
  const nav = (page: string, to: string, icon: string, text: string, extra?: React.ReactNode) =>
    <button className="navbtn" aria-current={route.page === page ? 'page' : undefined} onClick={() => go(to)} title={rail ? text : undefined}><Icon n={icon} /><span className="lbl">{text}</span>{extra}</button>;

  return <div className="shell" data-rail={rail ? '1' : '0'}>
    <aside className="side" aria-label="Navigazione">
      <div className="brand"><span className="logo"><Icon n="ark" s={18} /></span><span className="name">pg_arca</span>
        <button className="railtoggle" onClick={toggleRail} aria-label={rail ? 'Espandi la barra laterale' : 'Comprimi la barra laterale'} title={rail ? 'Espandi' : 'Comprimi'}><Icon n="panel" /></button></div>
      <div className="sgroup">Panoramica</div>
      <nav>
        {nav('today', 'today', 'alert', 'Oggi', urgent ? <span className={`navcount ${hc?.critical ? 'bad' : 'warn'}`}>{urgent}</span> : null)}
        {nav('clusters', '', 'layers', 'Tutti i cluster')}
      </nav>
      <div className="sgroup">Protezione</div>
      <nav>{nav('strategy', 'strategy', 'shield', 'Strategie di backup')}{nav('discovery', 'discovery', 'search', 'Rilevamento')}</nav>
      <div className="sgroup">Amministrazione</div>
      <nav>
        {role === 'admin' ? nav('settings', 'settings', 'settings', 'Impostazioni') : null}
        {role === 'admin' ? nav('users', 'users', 'user', 'Utenti') : null}
        {nav('audit', 'audit', 'list', 'Registro attività')}
      </nav>
      <div className="sgroup">Cluster collegati{clusters.length ? ` (${clusters.length})` : ''}</div>
      {clusters.length > 6 ? <input className="csearch" placeholder="Filtra…" aria-label="Filtra i cluster" value={cq} onChange={e => setCq(e.target.value)} /> : null}
      <div className="clist">
        {loading ? <div style={{ padding: 10 }}><div className="skeleton" style={{ height: 16 }} /></div> : null}
        {shown.map(c => <button key={c.id} className="citem" title={c.name} aria-current={route.page === 'cluster' && route.id === c.id ? 'page' : undefined} onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>
          <Dot kind={statusKind(c.status)} /><span className="n lbl">{c.name}</span>{c.isSandbox ? <span className="faint small lbl">demo</span> : null}
        </button>)}
        {!loading && !clusters.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>Nessun cluster.</div> : null}
        {!loading && clusters.length && !shown.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>Nessun risultato.</div> : null}
      </div>
      <div className="foot">
        <span className="trunc who" title={user}><Icon n="user" s={14} /> {user}{role !== 'admin' ? <span className="faint"> · {role === 'viewer' ? 'sola lettura' : 'operatore'}</span> : null}</span>
        <span className="row gap-s">
          <button className="btn ghost sm icon" style={{ color: 'inherit' }} onClick={cycle} title={`Tema: ${th === 'auto' ? 'automatico' : th === 'dark' ? 'scuro' : 'chiaro'}`} aria-label="Cambia tema"><Icon n={th === 'dark' ? 'moon' : th === 'light' ? 'sun' : 'settings'} /></button>
          <button className="btn ghost sm icon" style={{ color: 'inherit' }} onClick={logout} title="Esci" aria-label="Esci"><Icon n="logout" /></button>
        </span>
      </div>
    </aside>
    <div className="main">
      <div className="topbar">
        <select className="input mobnav" aria-label="Vai a" value={route.page === 'cluster' ? `c/${route.id}` : route.page === 'clusters' ? '' : route.page} onChange={e => go(e.target.value)}>
          <option value="">Tutti i cluster</option>{clusters.map(c => <option key={c.id} value={`c/${encodeURIComponent(c.id)}`}>{c.name}</option>)}<option value="today">Oggi</option><option value="strategy">Strategie di backup</option><option value="discovery">Rilevamento</option><option value="audit">Registro attività</option></select>
        <div className="crumbs" aria-label="Posizione">
          {route.page === 'cluster' ? <><a href="#/">Cluster</a><Icon n="chev" s={12} /><strong className="trunc">{cur?.name || '…'}</strong></> : <strong>{PAGE_TITLE[route.page] || ''}</strong>}
        </div>
        <div className="grow" />
        <button className="btn palbtn" onClick={() => setPal(true)} aria-label="Cerca cluster e azioni"><Icon n="search" /><span className="pt">Cerca cluster, azioni…</span><span className="kbd end">Ctrl K</span></button>
      </div>
      <main className="page" ref={pageRef}>
        {role === 'admin' ? <JoinBanner /> : null}
        <Suspense fallback={<div className="stack"><Skeleton h={30} w={260} /><Skeleton h={140} /><Skeleton h={140} /></div>}>
          {route.page === 'clusters' && <Clusters clusters={clusters} loading={loading} demoAvailable={!!data?.demoAvailable} />}
          {route.page === 'cluster' && <ClusterView id={route.id!} tab={route.tab} />}
          {route.page === 'audit' && <Audit clusters={clusters} />}
          {route.page === 'discovery' && <Discovery />}
          {route.page === 'strategy' && <StrategyPage />}
          {route.page === 'today' && <TodayPage me={user} role={role} />}
          {route.page === 'settings' && (role === 'admin' ? <SettingsPage /> : <Empty icon="lock" title="Solo per gli amministratori" />)}
          {route.page === 'users' && (role === 'admin' ? <UsersPage me={user} /> : <Empty icon="lock" title="Solo per gli amministratori" />)}
        </Suspense>
      </main>
    </div>
    <ActivityDock me={user} clusters={clusters} />
    {pal ? <Palette onClose={() => setPal(false)} clusters={clusters} route={route} cycle={cycle} /> : null}
  </div>;
}

function Palette({ onClose, clusters, route, cycle }: { onClose: () => void; clusters: any[]; route: any; cycle: () => void }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0); const ref = useRef<HTMLUListElement>(null);
  const items = useMemo(() => {
    const a: { label: string; hint?: string; icon: string; run: () => void }[] = [];
    for (const c of clusters) a.push({ label: c.name, hint: c.environment, icon: 'db', run: () => go(`c/${encodeURIComponent(c.id)}`) });
    const cid = route.page === 'cluster' ? route.id : clusters[0]?.id;
    if (cid) for (const t of TAB_ITEMS) if (!t.preview) a.push({ label: `${clusters.find(c => c.id === cid)?.name || ''} › ${t.label}`, icon: t.icon || 'chev', run: () => go(`c/${encodeURIComponent(cid)}/${t.id}`) });
    a.push({ label: 'Oggi: cosa richiede attenzione', icon: 'alert', run: () => go('today') }, { label: 'Tutti i cluster', icon: 'layers', run: () => go('') }, { label: 'Strategie di backup', icon: 'shield', run: () => go('strategy') }, { label: 'Rilevamento', icon: 'search', run: () => go('discovery') }, { label: 'Registro attività', icon: 'list', run: () => go('audit') }, { label: 'Mostra le attività in corso', hint: 'Ctrl J', icon: 'activity', run: () => window.dispatchEvent(new Event('arca:dock')) }, { label: 'Cambia tema', icon: 'settings', run: cycle });
    const s = q.trim().toLowerCase();
    return s ? a.filter(x => x.label.toLowerCase().includes(s)) : a;
  }, [q, clusters, route, cycle]);
  useEffect(() => setI(0), [q]);
  useEffect(() => { ref.current?.children[i]?.scrollIntoView({ block: 'nearest' }); }, [i]);
  const pick = (n: number) => { const it = items[n]; if (it) { onClose(); it.run(); } };
  return <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal cmd" role="dialog" aria-label="Ricerca rapida" onKeyDown={e => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(items.length - 1, x + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); }
      else if (e.key === 'Enter') pick(i);
    }}>
      <input className="input" autoFocus placeholder="Vai a un cluster o a una sezione…" value={q} onChange={e => setQ(e.target.value)} />
      <ul ref={ref}>{items.map((it, n) => <li key={n}><button aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => pick(n)}><Icon n={it.icon} /><span className="grow">{it.label}</span>{it.hint ? <span className="faint small">{it.hint}</span> : null}</button></li>)}
        {!items.length ? <li className="faint" style={{ padding: 14 }}>Nessun risultato.</li> : null}</ul>
    </div></div>;
}
