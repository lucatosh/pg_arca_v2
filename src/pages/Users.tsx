import React, { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, Field, Modal, Skeleton } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';

const ROLE: Record<string, [string, string]> = { admin: ['Amministratore', 'Tutto, compresi utenti, strategie e scollegamento dei cluster.'], operator: ['Operatore', 'Esegue backup, ripristini, HBA e interventi HA; non amministra la console.'], viewer: ['Sola lettura', 'Vede tutto, non cambia nulla.'] };

export function UsersPage({ me }: { me: string }) {
  const q = useQuery<{ users: { user: string; role: string; disabled: boolean; bootstrap?: boolean }[] }>('/api/users', { interval: 15000 });
  const [add, setAdd] = useState(false); const [del, setDel] = useState<string | null>(null); const [reset, setReset] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok, 'ok'); revalidate('/api/users'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  return <>
    <div className="pagehead"><div className="grow"><h1>Utenti</h1><p className="sub">Chi può accedere alla console e cosa può fare. Ogni azione resta nel registro con il nome di chi l’ha eseguita.</p></div><Button kind="primary" icon="plus" onClick={() => setAdd(true)}>Nuovo utente</Button></div>
    <Card pad={false}>{!q.data ? <div className="bd"><Skeleton h={60} /></div> : <div className="tablewrap"><table className="t"><thead><tr><th>Utente</th><th>Ruolo</th><th>Stato</th><th /></tr></thead><tbody>
      {q.data.users.map(u => <tr key={u.user}><td><strong>{u.user}</strong>{u.user === me ? <span className="faint"> (tu)</span> : null}{u.bootstrap ? <div className="small muted">Account iniziale</div> : null}</td>
        <td>{u.bootstrap ? <Badge kind="accent">{ROLE.admin[0]}</Badge> : <select className="input" style={{ width: 'auto' }} value={u.role} aria-label={`Ruolo di ${u.user}`} onChange={e => act(() => api('PATCH', `/api/users/${encodeURIComponent(u.user)}`, { role: e.target.value }), 'Ruolo aggiornato: dovrà accedere di nuovo')}>{Object.entries(ROLE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</td>
        <td>{u.disabled ? <Badge kind="warn">Disattivato</Badge> : <Badge kind="ok">Attivo</Badge>}</td>
        <td className="num">{u.bootstrap ? null : <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Button sm onClick={() => act(() => api('PATCH', `/api/users/${encodeURIComponent(u.user)}`, { disabled: !u.disabled }), u.disabled ? 'Utente riattivato' : 'Utente disattivato')}>{u.disabled ? 'Riattiva' : 'Disattiva'}</Button>
          <Button sm onClick={() => setReset(u.user)}>Nuova password</Button><Button sm kind="ghost" aria-label={`Elimina ${u.user}`} onClick={() => setDel(u.user)}>Elimina</Button></div>}</td></tr>)}</tbody></table></div>}</Card>
    <Card title="Cosa può fare ogni ruolo"><dl className="kv">{Object.entries(ROLE).map(([k, [l, d]]) => <React.Fragment key={k}><dt>{l}</dt><dd>{d}</dd></React.Fragment>)}</dl></Card>
    {add ? <AddUser onClose={() => setAdd(false)} onDone={() => { setAdd(false); revalidate('/api/users'); }} /> : null}
    {reset ? <ResetPw name={reset} onClose={() => setReset(null)} /> : null}
    {del ? <Confirm danger title={`Eliminare ${del}?`} confirmLabel="Elimina" onClose={() => setDel(null)} onConfirm={() => { const n = del; setDel(null); act(() => api('DELETE', `/api/users/${encodeURIComponent(n)}`), 'Utente eliminato'); }}><p>L’utente perde subito l’accesso. Le sue azioni passate restano nel registro.</p></Confirm> : null}
  </>;
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [r, setR] = useState('operator'); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const ok = /^[A-Za-z0-9_.@-]{3,64}$/.test(u) && p.length >= 12;
  const save = async () => { setBusy(true); setErr(null); try { await api('POST', '/api/users', { username: u, password: p, role: r }); toast('Utente creato', 'ok'); onDone(); } catch (e: any) { setErr(e.body?.message || (e.body?.error === 'user_exists' ? 'Esiste già un utente con questo nome.' : e.message)); } finally { setBusy(false); } };
  return <Modal title="Nuovo utente" onClose={onClose} footer={<><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} disabled={!ok} onClick={save}>Crea utente</Button></>}>
    <div className="stack"><Field label="Nome utente" hint="3-64 caratteri: lettere, numeri, . _ @ -"><input className="input" value={u} onChange={e => setU(e.target.value)} autoFocus /></Field>
      <Field label="Password iniziale" hint="Almeno 12 caratteri. L’utente può cambiarla dopo l’accesso."><input className="input" type="password" autoComplete="new-password" value={p} onChange={e => setP(e.target.value)} /></Field>
      <Field label="Ruolo"><select className="input" value={r} onChange={e => setR(e.target.value)}>{Object.entries(ROLE).map(([k, [l, d]]) => <option key={k} value={k}>{l} — {d}</option>)}</select></Field>{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
function ResetPw({ name, onClose }: { name: string; onClose: () => void }) {
  const [p, setP] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('PATCH', `/api/users/${encodeURIComponent(name)}`, { password: p }); toast('Password cambiata: l’utente deve accedere di nuovo', 'ok'); onClose(); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); setBusy(false); } };
  return <Modal title={`Nuova password per ${name}`} onClose={onClose} footer={<><Button onClick={onClose}>Annulla</Button><Button kind="primary" busy={busy} disabled={p.length < 12} onClick={save}>Cambia password</Button></>}>
    <Field label="Nuova password" hint="Almeno 12 caratteri."><input className="input" type="password" autoComplete="new-password" value={p} onChange={e => setP(e.target.value)} autoFocus /></Field></Modal>;
}
