import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Icon } from '../ui';

const SEV: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
export function LogsTab({ c }: { c: any }) {
  const [lines, setLines] = useState<any[]>([]); const [state, setState] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [level, setLevel] = useState('INFO'); const [search, setSearch] = useState(''); const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false); const box = useRef<HTMLDivElement>(null); const stick = useRef(true);
  pausedRef.current = paused;
  useEffect(() => {
    let ws: WebSocket | null = null; let dead = false; let retry: any;
    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/logs`);
      ws.onopen = () => { setState('live'); ws!.send(JSON.stringify({ type: 'subscribe', clusterId: c.id })); };
      ws.onmessage = ev => {
        let m: any; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'init') setLines((m.logs || []).filter((l: any) => l.clusterId === c.id).slice(-400));
        else if (m.type === 'log' && !pausedRef.current && m.entry.clusterId === c.id) setLines(p => [...p.slice(-399), m.entry]);
      };
      ws.onclose = () => { if (dead) return; setState('closed'); retry = setTimeout(open, 3000); };
    };
    open();
    return () => { dead = true; clearTimeout(retry); ws?.close(); };
  }, [c.id]);
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lines]);
  const shown = lines.filter(l => (SEV[l.level] ?? 1) >= SEV[level] && (!search || (l.message + l.nodeName).toLowerCase().includes(search.toLowerCase())));
  return <Card title="Log in tempo reale" actions={<Badge kind={state === 'live' ? 'ok' : 'warn'}>{state === 'live' ? 'Connesso' : state === 'connecting' ? 'Connessione…' : 'Riconnessione…'}</Badge>}>
    <div className="stack"><div className="row wrap"><select className="input" style={{ width: 160 }} value={level} onChange={e => setLevel(e.target.value)} aria-label="Livello minimo">{['DEBUG', 'INFO', 'WARN', 'ERROR'].map(l => <option key={l} value={l}>da {l}</option>)}</select>
      <input className="input" style={{ maxWidth: 280 }} placeholder="Cerca nei log" value={search} onChange={e => setSearch(e.target.value)} /><div className="grow" />
      <Button icon={paused ? 'play' : 'pause'} onClick={() => setPaused(!paused)}>{paused ? 'Riprendi' : 'Pausa'}</Button><Button onClick={() => setLines([])}>Svuota</Button></div>
      <div className="logbox" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
        {shown.length ? shown.map(l => <div key={l.id} className={`logline ${l.level}`}><span className="faint">{new Date(l.timestamp).toLocaleTimeString('it-CH')}</span> [{l.nodeName}/{l.service}] {l.message}</div>) :
          <span className="faint">Nessuna riga: gli agent inviano i log di PostgreSQL e Patroni appena vengono scritti.</span>}</div></div></Card>;
}
