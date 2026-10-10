import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card } from '../ui';

const SEV: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const KEEP = 600;       // entries held in memory
const SHOW = 300;       // rows in the DOM: a log view must stay light however fast the stream is

const Line = React.memo(function Line({ l }: { l: any }) {
  return <div className={`logline ${l.level}`}><span className="faint">{new Date(l.timestamp).toLocaleTimeString('it-CH')}</span> [{l.nodeName}/{l.service}] {l.message}</div>;
});

/**
 * Live log of one cluster. The stream is on demand: the console only asks the agents for the full log while somebody is watching it
 * (hidden tab or Pausa = not watching); otherwise agents send just warnings and errors, so many clusters never weigh on the console or the browser.
 */
export function LogsTab({ c }: { c: any }) {
  const [lines, setLines] = useState<any[]>([]); const [state, setState] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [level, setLevel] = useState('INFO'); const [search, setSearch] = useState(''); const [paused, setPaused] = useState(false); const [dropped, setDropped] = useState(0);
  const box = useRef<HTMLDivElement>(null); const stick = useRef(true); const wsRef = useRef<WebSocket | null>(null);
  const live = useRef({ paused: false, level: 'INFO' }); live.current = { paused, level };
  const send = (m: any) => { try { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(m)); } catch { /* reconnecting */ } };

  useEffect(() => {
    let ws: WebSocket | null = null; let dead = false; let retry: any;
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/logs`); wsRef.current = ws;
      ws.onopen = () => { setState('live'); ws!.send(JSON.stringify({ type: 'subscribe', clusterId: c.id, minLevel: live.current.level === 'DEBUG' ? 'all' : live.current.level, isPaused: live.current.paused || document.hidden })); };
      ws.onmessage = ev => {
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'init') setLines((m.logs || []).filter((l: any) => l.clusterId === c.id).slice(-KEEP));
        else if (m.type === 'batch' && !live.current.paused) {
          const add = (m.entries || []).filter((l: any) => l.clusterId === c.id);
          if (add.length) setLines(p => (p.length + add.length > KEEP ? [...p, ...add].slice(-KEEP) : [...p, ...add]));
          if (m.dropped) setDropped(d => d + m.dropped);
        }
      };
      ws.onclose = () => { if (dead) return; setState('closed'); retry = setTimeout(open, 3000); };
    };
    open();
    // A hidden tab is not watching: stop the full stream (the agents go back to warnings only after a minute), resume with a fresh backlog when it comes back.
    const vis = () => { if (document.hidden) send({ type: 'pause' }); else if (!live.current.paused) { send({ type: 'resume' }); send({ type: 'subscribe', clusterId: c.id }); } };
    document.addEventListener('visibilitychange', vis);
    return () => { dead = true; clearTimeout(retry); document.removeEventListener('visibilitychange', vis); ws?.close(); wsRef.current = null; };
  }, [c.id]);

  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lines, level, search]);
  const shown = useMemo(() => {
    const q = search.toLowerCase(); const min = SEV[level];
    const f = lines.filter(l => (SEV[l.level] ?? 1) >= min && (!q || (l.message + l.nodeName).toLowerCase().includes(q)));
    return f.length > SHOW ? f.slice(-SHOW) : f;
  }, [lines, level, search]);

  const changeLevel = (v: string) => { setLevel(v); send({ type: 'filter', minLevel: v === 'DEBUG' ? 'all' : v }); };
  const togglePause = () => { const n = !paused; setPaused(n); send({ type: n ? 'pause' : 'resume' }); if (!n) send({ type: 'subscribe', clusterId: c.id }); };
  return <Card title="Log in tempo reale" actions={<Badge kind={state === 'live' ? (paused ? 'warn' : 'ok') : 'warn'}>{state !== 'live' ? (state === 'connecting' ? 'Connessione…' : 'Riconnessione…') : paused ? 'In pausa' : 'Connesso'}</Badge>}>
    <div className="stack"><div className="row wrap"><select className="input" style={{ width: 160 }} value={level} onChange={e => changeLevel(e.target.value)} aria-label="Livello minimo">{['DEBUG', 'INFO', 'WARN', 'ERROR'].map(l => <option key={l} value={l}>da {l}</option>)}</select>
      <input className="input" style={{ maxWidth: 280 }} placeholder="Cerca nei log" value={search} onChange={e => setSearch(e.target.value)} /><div className="grow" />
      <Button icon={paused ? 'play' : 'pause'} onClick={togglePause}>{paused ? 'Riprendi' : 'Pausa'}</Button><Button onClick={() => { setLines([]); setDropped(0); }}>Svuota</Button></div>
      <div className="logbox" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
        {shown.length ? shown.map(l => <Line key={l.id} l={l} />) :
          <span className="faint">Nessuna riga. I log completi arrivano dagli agent solo mentre questa pagina è aperta (pochi secondi dopo l’apertura); warning ed errori arrivano sempre.</span>}</div>
      <div className="small faint">Ultime {SHOW} righe{dropped ? ` · ${dropped} saltate perché il flusso era troppo veloce` : ''}. Il log completo di PostgreSQL resta sul server.</div></div></Card>;
}
