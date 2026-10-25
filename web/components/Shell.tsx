'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { refreshAll } from '@/lib/client';

const PERSONAS = [
  { id: 'owner', label: 'Dana Marlow, owner' },
  { id: 'purchasing', label: 'Jordan Pike, buyer' },
  { id: 'receiver', label: 'Luis Ortega, site' },
  { id: 'bookkeeper', label: 'Sam Okafor, bookkeeper' },
];

interface Session { persona: string; unlocked: boolean; mode: 'live' | 'local'; pinRequired: boolean }

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [s, setS] = useState<Session | null>(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { fetch('/api/session').then(r => r.json()).then(setS); }, []);

  async function post(body: object) {
    const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { setErr(j.message); return; }
    setErr('');
    setS(prev => (prev ? { ...prev, persona: j.persona, unlocked: j.unlocked } : prev));
    refreshAll();
  }

  async function reset() {
    if (s?.mode === 'live') {
      const r = await fetch('/api/call', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reducer: 'enqueue_job', args: { id: `job_reset_${Date.now()}`, kind: 'reset_demo', payload_json: '{}' } }),
      }).then(x => x.json());
      setErr(r.outcome === 'ok' || r.outcome === 'duplicate' ? 'Reset queued for the worker.' : (r.message || 'Could not queue reset'));
      refreshAll();
      return;
    }
    const r = await fetch('/api/reset', { method: 'POST' }).then(x => x.json());
    setErr(r.ok ? '' : r.message);
    refreshAll();
  }

  const nav = [
    { href: '/', label: 'Bills', on: path === '/' },
    { href: '/sneak', label: 'Try a sneak charge', on: path.startsWith('/sneak') },
  ];

  return (
    <div className="shell">
      <aside className="side">
        <Link href="/" className="brand">Countersign<small>Check supplier bills</small></Link>
        <nav className="nav" aria-label="Main">
          {nav.map(n => <Link key={n.href} href={n.href} aria-current={n.on ? 'page' : undefined}>{n.label}</Link>)}
        </nav>
        <div className="who">
          <label className="f">
            I am
            <select value={s?.persona ?? 'owner'} onChange={e => post({ persona: e.target.value })}>
              {PERSONAS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          {s?.pinRequired && !s.unlocked && (
            <form onSubmit={e => { e.preventDefault(); post({ pin }); }} className="row">
              <input type="text" inputMode="numeric" placeholder="Demo PIN" value={pin} onChange={e => setPin(e.target.value)} aria-label="Demo PIN" />
              <button className="btn secondary" type="submit">Unlock</button>
            </form>
          )}
          {s?.persona === 'owner' && s.mode === 'local' && <button className="btn secondary" onClick={reset}>Start over</button>}
          {err && <div className="notice stop" role="alert">{err}</div>}
        </div>
      </aside>
      <main>{children}</main>
    </div>
  );
}
