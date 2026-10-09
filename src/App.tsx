import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AuthGate } from './AuthGate';
import { useQuery, isTerminal, Op } from './hooks';
import { Icon, Toasts, Dot, Modal } from './ui';
import { go, useRoute } from './router';
import { Clusters } from './pages/Clusters';
import { ClusterView, TAB_ITEMS } from './pages/ClusterView';
import { Audit, Discovery } from './pages/Global';

export const statusKind = (s?: string): 'ok' | 'warn' | 'bad' => (s === 'healthy' ? 'ok' : s === 'degraded' ? 'warn' : s === 'critical' || s === 'down' ? 'bad' : 'warn');

function theme(): 'light' | 'dark' | 'auto' { try { return (localStorage.getItem('arca.theme') as any) || 'auto'; } catch { return 'auto'; } }
function applyTheme(t: string) { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('arca.theme', t); } catch { /* private mode */ } }

export function App() {
  useEffect(() => { applyTheme(theme()); }, []);
  return <><AuthGate>{(s, logout) => <Shell user={s.user} logout={logout} />}</AuthGate><Toasts /></>;
}

function Shell({ user, logout }: { user: string; logout: () => void }) {
  const route = useRoute();
  const { data, loading } = useQuery<{ clusters: any[]; demoAvailable: boolean }>('/api/clusters', { interval: 5000 });
  const opsQ = useQuery<{ operations: Op[] }>('/api/operations', { interval: 4000 });
  const [pal, setPal] = useState(false);
  const [th, setTh] = useState(theme());
  const clusters = data?.clusters || [];
  const running = (opsQ.data?.operations || []).filter(o => !isTerminal(o.status) && !['backup_catalog', 'restore_plan', 'backup_info', 'discovery_scan', 'list_objects'].includes(o.type));

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal(p => !p); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  const cycle = () => { const n = th === 'auto' ? 'dark' : th === 'dark' ? 'light' : 'auto'; applyTheme(n); setTh(n); };

  return <div className="shell">
    <aside className="side">
      <div className="brand"><Icon n="ark" s={22} />pg_arca</div>
      <nav>
        <button className="navbtn" aria-current={route.page === 'clusters' ? 'page' : undefined} onClick={() => go('')}><Icon n="layers" />Cluster</button>
        <button className="navbtn" aria-current={route.page === 'discovery' ? 'page' : undefined} onClick={() => go('discovery')}><Icon n="search" />Rilevamento</button>
        <button className="navbtn" aria-current={route.page === 'audit' ? 'page' : undefined} onClick={() => go('audit')}><Icon n="list" />Registro attività</button>
      </nav>
      <div className="group">Cluster collegati</div>
      <div className="clist">
        {loading ? <div style={{ padding: 10 }}><div className="skeleton" style={{ height: 16 }} /></div> : null}
        {clusters.map(c => <button key={c.id} className="citem" aria-current={route.page === 'cluster' && route.id === c.id ? 'page' : undefined} onClick={() => go(`c/${encodeURIComponent(c.id)}`)}>
          <Dot kind={statusKind(c.status)} /><span className="n">{c.name}</span>{c.isSandbox ? <span className="faint small">demo</span> : null}
        </button>)}
        {!loading && !clusters.length ? <div className="small" style={{ padding: '6px 10px', color: 'var(--side-ink-2)' }}>Nessun cluster.</div> : null}
      </div>
      <div className="foot">
        <span className="trunc" title={user}><Icon n="user" s={14} /> {user}</span>
        <span className="row gap-s">
          <button className="btn ghost sm icon" style={{ color: 'inherit' }} onClick={cycle} title={`Tema: ${th === 'auto' ? 'automatico' : th === 'dark' ? 'scuro' : 'chiaro'}`} aria-label="Cambia tema"><Icon n={th === 'dark' ? 'moon' : th === 'light' ? 'sun' : 'settings'} /></button>
          <button className="btn ghost sm" style={{ color: 'inherit' }} onClick={logout}>Esci</button>
        </span>
      </div>
    </aside>
    <div className="main">
      <div className="topbar">
        <select className="input mobnav" aria-label="Vai a" value={route.page === 'cluster' ? `c/${route.id}` : route.page === 'clusters' ? '' : route.page} onChange={e => go(e.target.value)}>
          <option value="">Tutti i cluster</option>{clusters.map(c => <option key={c.id} value={`c/${encodeURIComponent(c.id)}`}>{c.name}</option>)}<option value="discovery">Rilevamento</option><option value="audit">Registro attività</option></select>
        <button className="btn" onClick={() => setPal(true)} style={{ minWidth: 260, justifyContent: 'flex-start', color: 'var(--ink-3)' }}><Icon n="search" />Cerca cluster, azioni…<span className="kbd end">Ctrl K</span></button>
        <div className="grow" />
        {running.length ? <button className="btn" onClick={() => { const o = running[0]; if (o.clusterId && o.clusterId !== 'unassigned') go(`c/${encodeURIComponent(o.clusterId)}/operations`); }}><Icon n="refresh" spin />{running.length} {running.length === 1 ? 'operazione in corso' : 'operazioni in corso'}</button> : null}
      </div>
      <main className="page">
        {route.page === 'clusters' && <Clusters clusters={clusters} loading={loading} demoAvailable={!!data?.demoAvailable} />}
        {route.page === 'cluster' && <ClusterView id={route.id!} tab={route.tab} />}
        {route.page === 'audit' && <Audit clusters={clusters} />}
        {route.page === 'discovery' && <Discovery />}
      </main>
    </div>
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
    a.push({ label: 'Tutti i cluster', icon: 'layers', run: () => go('') }, { label: 'Rilevamento', icon: 'search', run: () => go('discovery') }, { label: 'Registro attività', icon: 'list', run: () => go('audit') }, { label: 'Cambia tema', icon: 'settings', run: cycle });
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
