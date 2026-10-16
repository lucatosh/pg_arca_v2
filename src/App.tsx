import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from './AuthGate';
import { useQuery } from './hooks';
import { Icon, Toasts, Dot, Empty, Skeleton } from './ui';
import { go, nav as routeNav, useRoute } from './router';
import { CLUSTER_TASKS } from './tasks';
import { TAB_ITEMS } from './tabs';
import { TodayPage, useHealth } from './pages/Today';
import { JoinBanner } from './pages/Join';
import { ActivityDock } from './Dock';
import { OpLogHost } from './OpLog';
import { netState, onNet } from './api';
import { toast } from './hooks';
import { FleetTree, toneOf, primaryOf } from './Fleet';

// Everything but the shell, "Today" and the first page is loaded on demand: a first paint of a few tens of KB, not the whole console.
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
const PAGE_TITLE: Record<string, string> = { today: 'Today', clusters: 'Clusters', strategy: 'Backup policies', infra: 'Storage & recovery', discovery: 'Discovery', settings: 'Settings', users: 'Users', audit: 'Activity log', history: 'Activity log', workers: 'Worker hosts', worker: 'Worker host', geo: 'Geo-redundancy' };

function Shell({ user, role, logout }: { user: string; role: string; logout: () => void }) {
  const route = useRoute();
  const { data, loading } = useQuery<{ clusters: any[]; demoAvailable: boolean }>('/api/clusters', { interval: 6000 });
  const wq = useQuery<{ workers: { id: string; name: string; label: string; online: boolean; roles: string[] }[] }>('/api/workers-summary', { interval: 10000 });
  const workers = wq.data?.workers || [];
  const ver = useQuery<{ version?: string }>('/api/health').data?.version;
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
  // basic / expert detail (independent review, big idea 5): LSNs, timelines, set ids and other internals are shown only to who asks, per browser
  const [xp, setXp] = useState<boolean>(() => { try { return localStorage.getItem('pgarca.detail') === 'expert'; } catch { return false; } });
  useEffect(() => { document.documentElement.setAttribute('data-detail', xp ? 'expert' : 'basic'); try { localStorage.setItem('pgarca.detail', xp ? 'expert' : 'basic'); } catch { /* private mode */ } }, [xp]);
  const cycle = () => { const n = th === 'auto' ? 'dark' : th === 'dark' ? 'light' : 'auto'; applyTheme(n); setTh(n); };
  const toggleRail = () => { const n = !rail; setRail(n); wr('arca.rail', n ? '1' : '0'); };
  const nav = (page: string, to: string, icon: string, text: string, extra?: React.ReactNode) =>
    <button className="navbtn" aria-current={route.page === page || (page === 'history' && route.page === 'audit') || (page === 'workers' && route.page === 'worker') ? 'page' : undefined} onClick={() => go(to)} title={rail ? text : undefined}><Icon n={icon} /><span className="lbl">{text}</span>{extra}</button>;

  return <div className="shell" data-rail={rail ? '1' : '0'}>
    <aside className="side" aria-label="Navigation">
      <div className="brand"><span className="logo"><Icon n="ark" s={18} /></span><span className="name">pg_arca{ver ? <span className="ver" title="Console version">{ver}</span> : null}</span>
        <button className="railtoggle" onClick={toggleRail} aria-label={rail ? 'Expand the sidebar' : 'Collapse the sidebar'} title={rail ? 'Expand' : 'Collapse'}><Icon n="panel" /></button></div>
      {clusters.length ? (() => { const real = clusters.filter(c => !c.isSandbox); const t = real.map(c => toneOf(c, healthMap)); const bad = t.filter(x => x === 'bad').length, warn = t.filter(x => x === 'warn').length;
        const tone = bad ? 'bad' : warn ? 'warn' : 'ok';
        return <button className={`fleetstate ${tone}`} onClick={() => go('today')} title="Overall status: open Today for causes and next steps"><Dot kind={tone} />
          {/* the same counts as Today (findings, not clusters): one number for one thing across the console */}
          <span className="lbl">{hc?.critical ? `${hc.critical} urgent` : ''}{hc?.critical && hc?.warning ? ' · ' : ''}{hc?.warning ? `${hc.warning} need${hc.warning === 1 ? 's' : ''} attention` : ''}{!hc?.critical && !hc?.warning ? (bad || warn ? 'Needs attention' : 'All good') : ''}</span></button>; })() : null}
      <div className="sidescroll">
      <div className="sgroup">Overview</div>
      <nav>
        {nav('today', 'today', 'alert', 'Today', urgent ? <span className={`navcount ${hc?.critical ? 'bad' : 'warn'}`}>{urgent}</span> : null)}
        {nav('clusters', '', 'layers', 'All clusters')}
      </nav>
      <div className="sgroup">Protection</div>
      {/* by task: protecting data here, running the console below (a review found Worker hosts reachable only through a '+' and Discovery under Protection) */}
      <nav>{nav('strategy', 'strategy', 'shield', 'Backup policies')}{nav('infra', 'infra', 'restore', 'Storage & recovery')}{nav('geo', 'geo', 'swap', 'Geo-redundancy')}{nav('workers', 'workers', 'server', 'Worker hosts')}</nav>
      <div className="sgroup">Administration</div>
      <nav>
        {role === 'admin' ? nav('settings', 'settings', 'settings', 'Settings') : null}
        {role === 'admin' ? nav('users', 'users', 'user', 'Users') : null}
        {nav('history', 'history', 'activity', 'Activity log')}
        {nav('discovery', 'discovery', 'search', 'Discovery')}
      </nav>
      <div className="sgroup">Connected clusters{clusters.some(c => !c.isSandbox) ? ` (${clusters.filter(c => !c.isSandbox).length})` : ''}</div>
      {clusters.length > 6 ? <input className="csearch" placeholder="Filter by name or folder…" aria-label="Filter clusters" value={cq} onChange={e => setCq(e.target.value)} /> : null}
      <div className="clist">
        {loading ? <div style={{ padding: 10 }}><div className="skeleton" style={{ height: 16 }} /></div> : null}
        {!loading ? <FleetTree clusters={clusters} health={healthMap} current={route.page === 'cluster' ? route.id : undefined} query={cq} /> : null}
        {!loading && !clusters.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>No clusters.</div> : null}
        {!loading && clusters.length && !shown.length ? <div className="small lbl" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>No results.</div> : null}
      </div>
      <div className="sgroup row" style={{ paddingRight: 14 }}><span className="grow">Worker hosts{workers.length ? ` (${workers.length})` : ''}</span>
        <button className="sgadd" onClick={() => go('workers')} title="All worker hosts and how to add one" aria-label="Worker hosts"><Icon n="plus" s={13} /></button></div>
      <div className="wlist">
        {workers.map(w => <button key={w.id} className="citem" title={w.label || w.name} aria-current={route.page === 'worker' && route.id === w.id ? 'page' : undefined} onClick={() => go(`w/${encodeURIComponent(w.id)}`)}>
          <Dot kind={w.online ? 'ok' : 'bad'} /><span className="n lbl">{w.name}</span><span className="faint small lbl">{w.roles.includes('repository') ? 'backup' : w.roles.includes('recovery') ? 'recovery' : ''}</span></button>)}
        {!workers.length ? <button className="citem" onClick={() => go('workers')}><Icon n="server" s={14} /><span className="n lbl small" style={{ color: 'var(--side-ink-2)' }}>Backup servers, recovery hosts…</span></button> : null}
      </div>
      </div>
      {/* simple vs expert, in words (an unlabeled icon was not found by reviewers): internals such as LSN, timelines and backup ids */}
      <div className="viewsw" title="Expert view also shows internals: LSN, timelines, backup ids, segment counts"><span className="small">View</span>
        <span className="seg" role="group" aria-label="View"><button aria-pressed={!xp} onClick={() => setXp(false)}>Simple</button><button aria-pressed={xp} onClick={() => setXp(true)}>Expert</button></span></div>
      <div className="foot">
        <span className="trunc who" title={user}><Icon n="user" s={14} /> {user}{role !== 'admin' ? <span className="faint"> · {role === 'viewer' ? 'read-only' : 'operator'}</span> : null}</span>
        <span className="row gap-s">
          <button className="btn ghost sm icon" style={{ color: 'inherit' }} onClick={cycle} title={`Theme: ${th === 'auto' ? 'automatic' : th === 'dark' ? 'dark' : 'light'}`} aria-label="Change theme"><Icon n={th === 'dark' ? 'moon' : th === 'light' ? 'sun' : 'halfmoon'} /></button>
          <button className="btn ghost sm icon" style={{ color: 'inherit' }} onClick={logout} title="Sign out" aria-label="Sign out"><Icon n="logout" /></button>
        </span>
      </div>
    </aside>
    <div className="main">
      <NetBar />
      <div className="topbar">
        <select className="input mobnav" aria-label="Go to" value={route.page === 'cluster' ? `c/${encodeURIComponent(route.id || "")}` : route.page === 'clusters' ? '' : route.page === 'worker' ? 'workers' : route.page} onChange={e => go(e.target.value)}>
          {/* every page of the sidebar is here (a review found the Users page shown as "All clusters" on a phone) */}
          <optgroup label="Overview"><option value="today">{urgent ? `Today (${urgent} to do)` : 'Today'}</option><option value="">All clusters</option></optgroup>
          {clusters.length ? <optgroup label="Clusters">{clusters.map(c => <option key={c.id} value={`c/${encodeURIComponent(c.id)}`}>{c.name}</option>)}</optgroup> : null}
          <optgroup label="Protection"><option value="strategy">Backup policies</option><option value="infra">Storage & recovery</option><option value="geo">Geo-redundancy</option><option value="workers">Worker hosts</option></optgroup>
          <optgroup label="Administration"><option value="discovery">Discovery</option>{role === 'admin' ? <><option value="settings">Settings</option><option value="users">Users</option></> : null}<option value="history">Activity log: operations</option><option value="audit">Activity log: who changed what</option></optgroup></select>
        <div className="crumbs" aria-label="Location">
          {route.page === 'cluster' ? <><a href="#/">Clusters</a>{(() => { const p = cur ? primaryOf(cur, clusters) : null; const base = p || cur;
            return <>{base?.folder ? <><Icon n="chev" s={12} /><span className="faint trunc">{base.folder}</span></> : null}{p ? <><Icon n="chev" s={12} /><a className="trunc" href={`#/c/${encodeURIComponent(p.id)}`} title="Primary site">{p.name}</a></> : null}</>; })()}<Icon n="chev" s={12} /><strong className="trunc">{cur?.name || '…'}</strong></> : <strong>{PAGE_TITLE[route.page] || ''}</strong>}
        </div>
        <div className="grow" />
        <span id="actslot" className="actslot" />
        <button className="btn palbtn" onClick={() => setPal(true)} aria-label="Search clusters and actions"><Icon n="search" /><span className="pt">Search clusters, actions…</span><span className="kbd end">Ctrl K</span></button>
      </div>
      <main className="page" ref={pageRef}>
        {role === 'admin' ? <JoinBanner /> : null}
        <Suspense fallback={<div className="stack"><Skeleton h={30} w={260} /><Skeleton h={140} /><Skeleton h={140} /></div>}>
          {route.page === 'clusters' && <Clusters clusters={clusters} loading={loading} demoAvailable={!!data?.demoAvailable} />}
          {route.page === 'cluster' && <ClusterView key={route.id} id={route.id!} tab={route.tab} />}   {/* one instance per cluster: no state of another cluster's page (results, busy flags, overrides) */}
          {route.page === 'audit' && <Audit clusters={clusters} />}
          {route.page === 'history' && <HistoryPage clusters={clusters} />}
          {route.page === 'discovery' && <Discovery />}
          {route.page === 'strategy' && <StrategyPage />}
          {route.page === 'infra' && <InfraPage tab={route.tab} />}
          {route.page === 'today' && <TodayPage me={user} role={role} />}
          {route.page === 'workers' && <WorkersPage role={role} />}
          {route.page === 'geo' && <GeoPage role={role} />}
          {route.page === 'worker' && <WorkerView id={route.id!} role={role} />}
          {route.page === 'settings' && (role === 'admin' ? <SettingsPage /> : <Empty icon="lock" title="Administrators only" />)}
          {route.page === 'users' && (role === 'admin' ? <UsersPage me={user} /> : <Empty icon="lock" title="Administrators only" />)}
        </Suspense>
      </main>
    </div>
    <ActivityDock me={user} clusters={clusters} />
    <OpLogHost />
    {pal ? <Palette onClose={() => setPal(false)} clusters={clusters} route={route} cycle={cycle} xp={xp} setXp={setXp} logout={logout} /> : null}
  </div>;
}

function Palette({ onClose, clusters, route, cycle, xp, setXp, logout }: { onClose: () => void; clusters: any[]; route: any; cycle: () => void; xp: boolean; setXp: (v: boolean) => void; logout: () => void }) {
  const [q, setQ] = useState(''); const [i, setI] = useState(0); const ref = useRef<HTMLUListElement>(null);
  const items = useMemo(() => {
    const a: { label: string; hint?: string; icon: string; run: () => void }[] = [];
    for (const c of clusters) a.push({ label: c.name, hint: c.environment, icon: 'db', run: () => go(`c/${encodeURIComponent(c.id)}`) });
    // a task runs on the cluster on screen; off a cluster page, one entry per cluster (it never picks one by itself)
    const cid = route.page === 'cluster' ? route.id : undefined;
    for (const c of cid ? clusters.filter(x => x.id === cid) : clusters.filter(x => !x.isSandbox)) for (const t of CLUSTER_TASKS) a.push({ label: `${t.label} — ${c.name}`, hint: t.hint, icon: t.icon, run: () => t.run(c.id) });
    if (cid) for (const t of TAB_ITEMS) if (!t.preview) a.push({ label: `${clusters.find(c => c.id === cid)?.name || ''} › ${t.label}`, icon: t.icon || 'chev', run: () => go(`c/${encodeURIComponent(cid)}/${t.id}`) });
    a.push({ label: 'Today: what needs attention', icon: 'alert', run: () => go('today') }, { label: 'All clusters', icon: 'layers', run: () => go('') }, { label: 'Backup policies', icon: 'shield', run: () => go('strategy') }, { label: 'Storage & recovery: backup destination and recovery hosts', icon: 'restore', run: () => go('infra') }, { label: 'Discovery', icon: 'search', run: () => go('discovery') }, { label: 'Worker hosts: backup servers and recovery hosts', icon: 'server', run: () => go('workers') }, { label: 'Geo-redundancy: primary and standby sites', icon: 'swap', run: () => go('geo') }, { label: 'Activity log: operations (backups, restores…)', icon: 'activity', run: () => go('history') }, { label: 'Activity log: who changed what (audit)', icon: 'list', run: () => go('audit') }, { label: 'Show running activity', hint: 'Ctrl J', icon: 'activity', run: () => window.dispatchEvent(new Event('arca:dock')) }, { label: 'Change theme', icon: 'halfmoon', run: cycle },
      { label: xp ? 'Switch to the simple view' : 'Switch to the expert view (LSN, timelines, backup ids)', icon: 'layers', run: () => setXp(!xp) }, { label: 'Sign out', icon: 'logout', run: logout });
    const s = q.trim().toLowerCase();
    return s ? a.filter(x => x.label.toLowerCase().includes(s)) : a;
  }, [q, clusters, route, cycle, xp]);
  useEffect(() => setI(0), [q]);
  useEffect(() => { ref.current?.children[i]?.scrollIntoView({ block: 'nearest' }); }, [i]);
  const pick = (n: number) => { const it = items[n]; if (it) { onClose(); it.run(); } };
  return <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal cmd" role="dialog" aria-label="Quick search" onKeyDown={e => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') { e.preventDefault(); setI(x => Math.min(items.length - 1, x + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setI(x => Math.max(0, x - 1)); }
      else if (e.key === 'Enter') pick(i);
    }}>
      <input className="input" autoFocus placeholder="Go to a cluster or a section…" value={q} onChange={e => setQ(e.target.value)} />
      <ul ref={ref}>{items.map((it, n) => <li key={n}><button aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => pick(n)}><Icon n={it.icon} /><span className="grow">{it.label}</span>{it.hint ? <span className="faint small">{it.hint}</span> : null}</button></li>)}
        {!items.length ? <li className="faint" style={{ padding: 14 }}>No results.</li> : null}</ul>
    </div></div>;
}

/** One bar for the whole app while the console cannot be reached; it probes by itself and disappears when the console answers again. */
function NetBar() {
  const [n, setN] = useState(netState()); const [, tick] = useState(0); const prev = useRef(netState().down);
  useEffect(() => onNet(() => { const cur = netState(); if (prev.current && !cur.down) toast('Connection to the console restored', 'ok'); prev.current = cur.down; setN(cur); }), []);
  useEffect(() => { if (!n.down) return; const t = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(t); }, [n.down]);
  if (!n.down) return null;
  const s = Math.round((Date.now() - (n.since || Date.now())) / 1000);
  return <div className="netbar" role="alert"><Icon n="alert" /><div className="grow"><strong>The console is not responding</strong> for {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}: what is on screen may be stale and actions cannot start. Retrying every few seconds; nothing you entered is lost.</div></div>;
}
