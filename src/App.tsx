import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from './AuthGate';
import { useQuery } from './hooks';
import { Icon, Toasts, Dot, Empty, Skeleton } from './ui';
import { go, nav as routeNav, useRoute } from './router';
import { TAB_ITEMS } from './tabs';
import { TodayPage, useHealth } from './pages/Today';
import { JoinBanner } from './pages/Join';
import { ActivityDock } from './Dock';
import { OpLogHost } from './OpLog';
import { netState, onNet } from './api';
import { toast } from './hooks';
import { FleetTree, toneOf, primaryOf } from './Fleet';

// Everything but the shell, "Oggi" and the first page is loaded on demand: a first paint of a few tens of KB, not the whole console.
const Clusters = lazy(() => import('./pages/Clusters').then(m => ({ default: m.Clusters })));
const ClusterView = lazy(() => import('./pages/ClusterView').then(m => ({ default: m.ClusterView })));
const HistoryPage = lazy(() => import('./pages/History').then(m => ({ default: m.HistoryPage })));
const Audit = lazy(() => import('./pages/Global').then(m => ({ default: m.Audit })));
const Discovery = lazy(() => import('./pages/Global').then(m => ({ default: m.Discovery })));
const StrategyPage = lazy(() => import('./pages/Strategy').then(m => ({ default: m.StrategyPage })));
const InfraPage = lazy(() => import('./pages/Infra').then(m => ({ default: m.InfraPage })));
const UsersPage = lazy(() => import('./pages/Users').then(m => ({ default: m.UsersPage })));
const WorkersPage = lazy(() => import('./pages/Workers').then(m => ({ default: m.WorkersPage })));
const WorkerView = lazy(() => import('./pages/Workers').then(m => ({ default: m.WorkerView })));
const GeoPage = lazy(() => import('./pages/Geo').then(m => ({ default: m.GeoPage })));
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
const PAGE_TITLE: Record<string, string> = { today: 'Oggi', clusters: 'Cluster', strategy: 'Strategie di backup', infra: 'Ripristino e archivi', discovery: 'Rilevamento', settings: 'Impostazioni', users: 'Utenti', audit: 'Registro attività', history: 'Storico operazioni', workers: 'Macchine operative', worker: 'Macchina operativa', geo: 'Georidondanza' };

function Shell({ user, role, logout }: { user: string; role: string; logout: () => void }) {
  const route = useRoute();
  const { data, loading } = useQuery<{ clusters: any[]; demoAvailable: boolean }>('/api/clusters', { interval: 6000 });
  const wq = useQuery<{ workers: { id: string; name: string; label: string; online: boolean; roles: string[] }[] }>('/api/workers-summary', { interval: 10000 });
  const workers = wq.data?.workers || [];
  const health = useHealth(30000); const hc = health.data?.counts; const urgent = (hc?.critical || 0) + (hc?.warning || 0);
  const healthMap = useMemo(() => Object.fromEntries(((health.data?.clusters || []) as any[]).map(c => [c.id, c.worst])), [health.data]);
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
  // a page opened from the app starts at the top (the cluster pages keep their position when only the tab changes); Back/Forward returns
  // to where you were on that page, also once its data has arrived
  const pageRef = useRef<HTMLElement>(null); const scrolls = useRef(new Map<string, number>());
  useEffect(() => { const el = pageRef.current; if (!el) return; let t: any; const f = () => { clearTimeout(t); t = setTimeout(() => scrolls.current.set(location.hash, el.scrollTop), 80); }; el.addEventListener('scroll', f, { passive: true }); return () => el.removeEventListener('scroll', f); }, []);
  useEffect(() => {
    const el = pageRef.current; if (!el) return;
    const want = routeNav.fromApp ? undefined : scrolls.current.get(location.hash); routeNav.fromApp = false;
    if (want == null) { if (prevPage.current !== `${route.page}/${route.id}`) el.scrollTo({ top: 0 }); prevPage.current = `${route.page}/${route.id}`; return; }
    prevPage.current = `${route.page}/${route.id}`;
    let n = 0; const step = () => { if (el.scrollHeight - el.clientHeight >= want || n++ > 40) { el.scrollTo({ top: want }); return; } requestAnimationFrame(step); }; step();
  }, [route.page, route.id, route.tab]);
  const prevPage = useRef('');
  const cycle = () => { const n = th === 'auto' ? 'dark' : th === 'dark' ? 'light' : 'auto'; applyTheme(n); setTh(n); };
  const toggleRail = () => { const n = !rail; setRail(n); wr('arca.rail', n ? '1' : '0'); };
  const nav = (page: string, to: string, icon: string, text: string, extra?: React.ReactNode) =>
    <button className="navbtn" aria-current={route.page === page ? 'page' : undefined} onClick={() => go(to)} title={rail ? text : undefined}><Icon n={icon} /><span className="lbl">{text}</span>{extra}</button>;

  return <div className="shell" data-rail={rail ? '1' : '0'}>
    <aside className="side" aria-label="Navigazione">
      <div className="brand"><span className="logo"><Icon n="ark" s={18} /></span><span className="name">pg_arca</span>
        <button className="railtoggle" onClick={toggleRail} aria-label={rail ? 'Espandi la barra laterale' : 'Comprimi la barra laterale'} title={rail ? 'Espandi' : 'Comprimi'}><Icon n="panel" /></button></div>
      {clusters.length ? (() => { const real = clusters.filter(c => !c.isSandbox); const t = real.map(c => toneOf(c, healthMap)); const bad = t.filter(x => x === 'bad').length, warn = t.filter(x => x === 'warn').length;
        const tone = bad ? 'bad' : warn ? 'warn' : 'ok';
        return <button className={`fleetstate ${tone}`} onClick={() => go('today')} title="Stato complessivo: apri «Oggi» per le cause e i passi successivi"><Dot kind={tone} />
          <span className="lbl">{bad ? `${bad} ${bad === 1 ? 'cluster critico' : 'cluster critici'}` : warn ? `${warn} da controllare` : 'Tutto in ordine'}</span><span className="lbl faint small">{real.length - bad - warn}/{real.length} ok</span></button>; })() : null}
      <div className="sidescroll">
      <div className="sgroup">Panoramica</div>
      <nav>
        {nav('today', 'today', 'alert', 'Oggi', urgent ? <span className={`navcount ${hc?.critical ? 'bad' : 'warn'}`}>{urgent}</span> : null)}
        {nav('clusters', '', 'layers', 'Tutti i cluster')}
      </nav>
      <div className="sgroup">Protezione</div>
      <nav>{nav('strategy', 'strategy', 'shield', 'Strategie di backup')}{nav('infra', 'infra', 'restore', 'Ripristino e archivi')}{nav('geo', 'geo', 'swap', 'Georidondanza')}{nav('discovery', 'discovery', 'search', 'Rilevamento')}</nav>
      <div className="sgroup">Amministrazione</div>
      <nav>
        {role === 'admin' ? nav('settings', 'settings', 'settings', 'Impostazioni') : null}
        {role === 'admin' ? nav('users', 'users', 'user', 'Utenti') : null}
        {nav('history', 'history', 'activity', 'Storico operazioni')}
        {nav('audit', 'audit', 'list', 'Registro attività')}
      </nav>
      <div className="sgroup">Cluster collegati{clusters.length ? ` (${clusters.length})` : ''}</div>
      {clusters.length > 6 ? <input className="csearch" placeholder="Filtra per nome o cartella…" aria-label="Filtra i cluster" value={cq} onChange={e => setCq(e.target.value)} /> : null}
      <div className="clist">
        {loading ? <div style={{ padding: 10 }}><div className="skeleton" style={{ height: 16 }} /></div> : null}
        {!loading ? <FleetTree clusters={clusters} health={healthMap} current={route.page === 'cluster' ? route.id : undefined} query={cq} /> : null}
        {!loading && !clusters.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>Nessun cluster.</div> : null}
        {!loading && clusters.length && !shown.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>Nessun risultato.</div> : null}
      </div>
      <div className="sgroup row" style={{ paddingRight: 14 }}><span className="grow">Macchine operative{workers.length ? ` (${workers.length})` : ''}</span>
        <button className="sgadd" onClick={() => go('workers')} title="Tutte le macchine operative e come aggiungerne una" aria-label="Macchine operative"><Icon n="plus" s={13} /></button></div>
      <div className="wlist">
        {workers.map(w => <button key={w.id} className="citem" title={w.label || w.name} aria-current={route.page === 'worker' && route.id === w.id ? 'page' : undefined} onClick={() => go(`w/${encodeURIComponent(w.id)}`)}>
          <Dot kind={w.online ? 'ok' : 'bad'} /><span className="n lbl">{w.name}</span><span className="faint small lbl">{w.roles.includes('repository') ? 'backup' : w.roles.includes('recovery') ? 'recupero' : ''}</span></button>)}
        {!workers.length ? <button className="citem" onClick={() => go('workers')}><Icon n="server" s={14} /><span className="n lbl small" style={{ color: 'var(--side-ink-2)' }}>Backup server, host di recupero…</span></button> : null}
      </div>
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
      <NetBar />
      <div className="topbar">
        <select className="input mobnav" aria-label="Vai a" value={route.page === 'cluster' ? `c/${route.id}` : route.page === 'clusters' ? '' : route.page} onChange={e => go(e.target.value)}>
          <option value="">Tutti i cluster</option>{clusters.map(c => <option key={c.id} value={`c/${encodeURIComponent(c.id)}`}>{c.name}</option>)}<option value="today">Oggi</option><option value="strategy">Strategie di backup</option><option value="infra">Ripristino e archivi</option><option value="discovery">Rilevamento</option><option value="workers">Macchine operative</option><option value="geo">Georidondanza</option><option value="history">Storico operazioni</option><option value="audit">Registro attività</option></select>
        <div className="crumbs" aria-label="Posizione">
          {route.page === 'cluster' ? <><a href="#/">Cluster</a>{(() => { const p = cur ? primaryOf(cur, clusters) : null; const base = p || cur;
            return <>{base?.folder ? <><Icon n="chev" s={12} /><span className="faint trunc">{base.folder}</span></> : null}{p ? <><Icon n="chev" s={12} /><a className="trunc" href={`#/c/${encodeURIComponent(p.id)}`} title="Sito primario">{p.name}</a></> : null}</>; })()}<Icon n="chev" s={12} /><strong className="trunc">{cur?.name || '…'}</strong></> : <strong>{PAGE_TITLE[route.page] || ''}</strong>}
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
          {route.page === 'history' && <HistoryPage clusters={clusters} />}
          {route.page === 'discovery' && <Discovery />}
          {route.page === 'strategy' && <StrategyPage />}
          {route.page === 'infra' && <InfraPage tab={route.tab} />}
          {route.page === 'today' && <TodayPage me={user} role={role} />}
          {route.page === 'workers' && <WorkersPage role={role} />}
          {route.page === 'geo' && <GeoPage role={role} />}
          {route.page === 'worker' && <WorkerView id={route.id!} role={role} />}
          {route.page === 'settings' && (role === 'admin' ? <SettingsPage /> : <Empty icon="lock" title="Solo per gli amministratori" />)}
          {route.page === 'users' && (role === 'admin' ? <UsersPage me={user} /> : <Empty icon="lock" title="Solo per gli amministratori" />)}
        </Suspense>
      </main>
    </div>
    <ActivityDock me={user} clusters={clusters} />
    <OpLogHost />
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
    a.push({ label: 'Oggi: cosa richiede attenzione', icon: 'alert', run: () => go('today') }, { label: 'Tutti i cluster', icon: 'layers', run: () => go('') }, { label: 'Strategie di backup', icon: 'shield', run: () => go('strategy') }, { label: 'Ripristino e archivi: istanza di recupero e destinazione dei backup', icon: 'restore', run: () => go('infra') }, { label: 'Rilevamento', icon: 'search', run: () => go('discovery') }, { label: 'Macchine operative: backup server e host di recupero', icon: 'server', run: () => go('workers') }, { label: 'Georidondanza: siti primario e di replica', icon: 'swap', run: () => go('geo') }, { label: 'Storico operazioni', icon: 'activity', run: () => go('history') }, { label: 'Registro attività', icon: 'list', run: () => go('audit') }, { label: 'Mostra le attività in corso', hint: 'Ctrl J', icon: 'activity', run: () => window.dispatchEvent(new Event('arca:dock')) }, { label: 'Cambia tema', icon: 'settings', run: cycle });
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

/** One bar for the whole app while the console cannot be reached; it probes by itself and disappears when the console answers again. */
function NetBar() {
  const [n, setN] = useState(netState()); const [, tick] = useState(0); const prev = useRef(netState().down);
  useEffect(() => onNet(() => { const cur = netState(); if (prev.current && !cur.down) toast('Connessione con la console ripristinata', 'ok'); prev.current = cur.down; setN(cur); }), []);
  useEffect(() => { if (!n.down) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [n.down]);
  if (!n.down) return null;
  const s = Math.round((Date.now() - (n.since || Date.now())) / 1000);
  return <div className="netbar" role="alert"><Icon n="alert" /><div className="grow"><strong>La console non risponde</strong> da {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}: i dati a schermo possono essere vecchi e le azioni non partono. Riprovo da solo ogni pochi secondi; nulla di quello che hai inserito va perso.</div></div>;
}
