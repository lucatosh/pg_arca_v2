import React, { useEffect, useState } from 'react';
import { api, get } from './api';
import { clearAllDrafts, draftsOwner } from './hooks';
import { Button, Field, Icon, Banner } from './ui';

export interface Session { user: string; role: string }
export function AuthGate({ children }: { children: (s: Session, logout: () => void) => React.ReactNode }) {
  const [st, setSt] = useState<{ setupRequired: boolean; setupCodeRequired?: boolean; authenticated: boolean; user?: string; role?: string } | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const load = () => get('/api/auth/status').then(setSt).catch(e => setFail(e.message));
  useEffect(() => {
    load();
    const f = () => load();
    window.addEventListener('arca:auth', f);
    return () => window.removeEventListener('arca:auth', f);
  }, []);
  if (fail) return <div className="authwrap"><Banner kind="bad" title="Server non raggiungibile">{fail}</Banner></div>;
  if (!st) return <div className="authwrap"><div className="skeleton" style={{ height: 220, width: 360 }} /></div>;
  if (st.authenticated) { draftsOwner(st.user || 'admin'); return <>{children({ user: st.user || 'admin', role: st.role || 'admin' }, async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } clearAllDrafts(); load(); })}</>; }
  return <Login setup={st.setupRequired} needCode={!!st.setupCodeRequired} onDone={load} />;
}

function Login({ setup, needCode, onDone }: { setup: boolean; needCode: boolean; onDone: () => void }) {
  const [u, setU] = useState(setup ? '' : 'admin'); const [p, setP] = useState(''); const [p2, setP2] = useState(''); const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const weak = setup && p.length > 0 && p.length < 12;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (setup && p !== p2) return setErr('Le due password non coincidono.');
    setBusy(true);
    try { await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { username: u, password: p, ...(setup && needCode ? { setupCode: code } : {}) }); onDone(); }
    catch (x: any) { setErr(x.body?.message || (x.status === 429 ? 'Troppi tentativi: riprova tra qualche minuto.' : x.status === 401 ? 'Utente o password non corretti.' : x.message)); }
    finally { setBusy(false); }
  };
  return <div className="authwrap"><form className="card authcard" onSubmit={submit}>
    <div className="brand" style={{ color: 'var(--ink)', padding: 0 }}><Icon n="ark" s={26} />pg_arca</div>
    <div><h1>{setup ? 'Crea l’amministratore' : 'Accedi'}</h1><p className="sub">{setup ? 'Prima configurazione: questo account potrà gestire tutti i cluster.' : 'Console di gestione backup e cluster PostgreSQL.'}</p></div>
    {err ? <Banner kind="bad">{err}</Banner> : null}
    <Field label="Utente"><input className="input" value={u} onChange={e => setU(e.target.value)} autoComplete="username" autoFocus required /></Field>
    <Field label="Password" error={weak ? 'Servono almeno 12 caratteri.' : null} hint={setup ? 'Minimo 12 caratteri.' : undefined}><input className="input" type="password" value={p} onChange={e => setP(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required /></Field>
    {setup && needCode ? <Field label="Codice di prima configurazione" hint="Lo trovi nel log della console all’avvio o nel file setup-code della sua cartella dati: protegge la console finché l’amministratore non esiste."><input className="input mono" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" required /></Field> : null}
    {setup ? <Field label="Ripeti password"><input className="input" type="password" value={p2} onChange={e => setP2(e.target.value)} autoComplete="new-password" required /></Field> : null}
    <Button kind="primary" busy={busy} type="submit" disabled={!u || !p || weak}>{setup ? 'Crea e accedi' : 'Accedi'}</Button>
  </form></div>;
}
