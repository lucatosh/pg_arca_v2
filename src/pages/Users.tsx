import React, { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Button, Card, Confirm, CopyBlock, Field, Modal, Skeleton, ago } from '../ui';
import { revalidate, toast, useQuery } from '../hooks';

const ROLE: Record<string, [string, string]> = { admin: ['Administrator', 'Everything, including users, policies and detaching clusters.'], operator: ['Operator', 'Runs backups, restores, HBA changes and HA actions; does not administer the console.'], viewer: ['Read-only', 'Sees everything, changes nothing.'] };

export function UsersPage({ me }: { me: string }) {
  const q = useQuery<{ users: { user: string; role: string; disabled: boolean; bootstrap?: boolean }[] }>('/api/users', { interval: 15000 });
  const [add, setAdd] = useState(false); const [del, setDel] = useState<string | null>(null); const [reset, setReset] = useState<string | null>(null);
  const act = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok, 'ok'); revalidate('/api/users'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } };
  return <>
    <div className="pagehead"><div className="grow"><h1>Users</h1><p className="sub">Who can access the console and what they can do. Every action stays in the audit log with the name of who performed it.</p></div><Button kind="primary" icon="plus" onClick={() => setAdd(true)}>New user</Button></div>
    <Card pad={false}>{!q.data ? <div className="bd"><Skeleton h={60} /></div> : <div className="tablewrap"><table className="t"><thead><tr><th>User</th><th>Role</th><th>Status</th><th /></tr></thead><tbody>
      {q.data.users.map(u => <tr key={u.user}><td><strong>{u.user}</strong>{u.user === me ? <span className="faint"> (you)</span> : null}{u.bootstrap ? <div className="small muted">Initial account</div> : null}</td>
        <td>{u.bootstrap ? <Badge kind="accent">{ROLE.admin[0]}</Badge> : <select className="input" style={{ width: 'auto' }} value={u.role} aria-label={`Role of ${u.user}`} onChange={e => act(() => api('PATCH', `/api/users/${encodeURIComponent(u.user)}`, { role: e.target.value }), 'Role updated: the user must sign in again')}>{Object.entries(ROLE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>}</td>
        <td>{u.disabled ? <Badge kind="warn">Disabled</Badge> : <Badge kind="ok">Active</Badge>}</td>
        <td className="num">{u.bootstrap ? null : <div className="row gap-s" style={{ justifyContent: 'flex-end' }}>
          <Button sm onClick={() => act(() => api('PATCH', `/api/users/${encodeURIComponent(u.user)}`, { disabled: !u.disabled }), u.disabled ? 'User re-enabled' : 'User disabled')}>{u.disabled ? 'Re-enable' : 'Disable'}</Button>
          <Button sm onClick={() => setReset(u.user)}>New password</Button><Button sm kind="ghost" aria-label={`Delete ${u.user}`} onClick={() => setDel(u.user)}>Delete</Button></div>}</td></tr>)}</tbody></table></div>}</Card>
    <Card title="What each role can do"><dl className="kv">{Object.entries(ROLE).map(([k, [l, d]]) => <React.Fragment key={k}><dt>{l}</dt><dd>{d}</dd></React.Fragment>)}</dl></Card>
    <ApiTokens />
    {add ? <AddUser onClose={() => setAdd(false)} onDone={() => { setAdd(false); revalidate('/api/users'); }} /> : null}
    {reset ? <ResetPw name={reset} onClose={() => setReset(null)} /> : null}
    {del ? <Confirm danger title={`Delete ${del}?`} confirmLabel="Delete" onClose={() => setDel(null)} onConfirm={() => { const n = del; setDel(null); act(() => api('DELETE', `/api/users/${encodeURIComponent(n)}`), 'User deleted'); }}><p>The user loses access immediately. Their past actions stay in the audit log.</p></Confirm> : null}
  </>;
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [r, setR] = useState('operator'); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const ok = /^[A-Za-z0-9_.@-]{3,64}$/.test(u) && p.length >= 12;
  const save = async () => { setBusy(true); setErr(null); try { await api('POST', '/api/users', { username: u, password: p, role: r }); toast('User created', 'ok'); onDone(); } catch (e: any) { setErr(e.body?.message || (e.body?.error === 'user_exists' ? 'A user with this name already exists.' : e.message)); } finally { setBusy(false); } };
  return <Modal title="New user" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={!ok} onClick={save}>Create user</Button></>}>
    <div className="stack"><Field label="Username" hint="3-64 characters: letters, digits, . _ @ -"><input className="input" value={u} onChange={e => setU(e.target.value)} autoFocus /></Field>
      <Field label="Initial password" hint="At least 12 characters. The user can change it after signing in."><input className="input" type="password" autoComplete="new-password" value={p} onChange={e => setP(e.target.value)} /></Field>
      <Field label="Role"><select className="input" value={r} onChange={e => setR(e.target.value)}>{Object.entries(ROLE).map(([k, [l, d]]) => <option key={k} value={k}>{l} — {d}</option>)}</select></Field>{err ? <Banner kind="bad">{err}</Banner> : null}</div></Modal>;
}
function ResetPw({ name, onClose }: { name: string; onClose: () => void }) {
  const [p, setP] = useState(''); const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api('PATCH', `/api/users/${encodeURIComponent(name)}`, { password: p }); toast('Password changed: the user must sign in again', 'ok'); onClose(); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); setBusy(false); } };
  return <Modal title={`New password for ${name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} disabled={p.length < 12} onClick={save}>Change password</Button></>}>
    <Field label="New password" hint="At least 12 characters."><input className="input" type="password" autoComplete="new-password" value={p} onChange={e => setP(e.target.value)} autoFocus /></Field></Modal>;
}

/** Bearer tokens for automation (CI, Ansible, scripts, Prometheus): each with its own role and expiry; the secret is shown once; revocable. */
function ApiTokens() {
  const q = useQuery<{ tokens: { id: string; label: string; role: string; createdBy: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }[] }>('/api/api-tokens', { interval: 30000 });
  const [open, setOpen] = useState(false); const [label, setLabel] = useState(''); const [role, setRole] = useState('operator'); const [ttl, setTtl] = useState('90');
  const [made, setMade] = useState<any>(null); const [busy, setBusy] = useState(false); const [revoke, setRevoke] = useState<{ id: string; label: string } | null>(null);
  const create = async () => { setBusy(true); try { setMade(await api('POST', '/api/api-tokens', { label, role, ttlDays: ttl === '' ? null : Number(ttl) })); revalidate('/api/api-tokens'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } finally { setBusy(false); } };
  const live = (q.data?.tokens || []).filter(t => !t.revokedAt);
  return <Card title="API tokens (automation)" actions={<Button sm kind="primary" icon="plus" onClick={() => { setMade(null); setLabel(''); setOpen(true); }}>New token</Button>}>
    <p className="small muted">For scripts, CI pipelines, configuration management and monitoring: <code>Authorization: Bearer &lt;token&gt;</code> on any API call, with the role of the token. Every action is audited as <code>token:&lt;label&gt;</code>.</p>
    {!q.data ? <Skeleton h={40} /> : !live.length ? <p className="muted small">No tokens.</p> : <div className="tablewrap"><table className="t small"><thead><tr><th>Label</th><th>Role</th><th>Expires</th><th>Last used</th><th>Created</th><th /></tr></thead><tbody>
      {live.map(t => <tr key={t.id}><td><strong>{t.label}</strong></td><td><Badge kind={t.role === 'admin' ? 'accent' : undefined}>{ROLE[t.role]?.[0] || t.role}</Badge></td>
        <td>{t.expiresAt ? (Date.parse(t.expiresAt) < Date.now() ? <Badge kind="warn">expired</Badge> : (d => d <= 1 ? 'within a day' : `in ${d} days`)(Math.ceil((Date.parse(t.expiresAt) - Date.now()) / 86400000))) : <span className="muted">never</span>}</td>
        <td>{t.lastUsedAt ? ago(t.lastUsedAt) : <span className="muted">never</span>}</td><td className="muted">{ago(t.createdAt)} by {t.createdBy}</td>
        <td className="num"><Button sm kind="ghost" onClick={() => setRevoke({ id: t.id, label: t.label })}>Revoke</Button></td></tr>)}</tbody></table></div>}
    {open ? <Modal title="New API token" onClose={() => setOpen(false)} footer={<><div className="grow" /><Button onClick={() => setOpen(false)}>Close</Button>{!made ? <Button kind="primary" busy={busy} disabled={label.trim().length < 2} onClick={create}>Create</Button> : null}</>}>
      {!made ? <div className="stack">
        <Field label="Label" hint="What uses it, e.g. ci-deploy, ansible, grafana"><input className="input" value={label} onChange={e => setLabel(e.target.value)} autoFocus /></Field>
        <Field label="Role" hint="The least that does the job: viewer for monitoring, operator for backups and restores, admin only for provisioning"><select className="input" value={role} onChange={e => setRole(e.target.value)}>{Object.entries(ROLE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Expires in (days)" hint="Empty = never. A rotating 90-day token is the usual compromise."><input className="input" style={{ width: 120 }} value={ttl} onChange={e => setTtl(e.target.value.replace(/[^0-9]/g, ''))} /></Field>
      </div> : <div className="stack">
        <Banner kind="ok" title="Token created: copy it now, it is not shown again" />
        <CopyBlock text={made.token} />
        <p className="small muted">Example: <code>curl -H "Authorization: Bearer {made.token.slice(0, 12)}…" {location.origin}/api/clusters</code></p>
      </div>}</Modal> : null}
    {revoke ? <Confirm danger title={`Revoke the token “${revoke.label}”?`} confirmLabel="Revoke" onClose={() => setRevoke(null)} onConfirm={async () => { const r = revoke; setRevoke(null); try { await api('DELETE', `/api/api-tokens/${encodeURIComponent(r.id)}`); toast('Token revoked', 'ok'); revalidate('/api/api-tokens'); } catch (e: any) { toast(e.body?.message || e.message, 'bad'); } }}>
      <p>Every call made with it stops working at once. Scripts that use it must get a new one.</p></Confirm> : null}
  </Card>;
}
