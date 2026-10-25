'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { refreshAll } from '@/lib/client';
import { PERSONAS, personaLabel, personaOf, initials } from '@/lib/personas';
import { PERSONA_EVENT } from '@/lib/usePersona';

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
    window.dispatchEvent(new CustomEvent(PERSONA_EVENT, { detail: j.persona }));
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

  if (path === '/') return <>{children}</>;

  const me = personaOf(s?.persona ?? 'owner');
  const nav = [
    { href: '/bills', label: 'Bills', on: path === '/bills' || path.startsWith('/invoices') || path.startsWith('/purchases') },
    { href: '/inbox', label: 'Inbox', on: path.startsWith('/inbox') },
    { href: '/sneak', label: 'Sneak', on: path.startsWith('/sneak') },
  ];

  return (
    <div className="app">
      <header className="top">
        <Link href="/" className="mark">Countersign</Link>
        <nav className="nav" aria-label="Main">
          {nav.map(n => <Link key={n.href} href={n.href} aria-current={n.on ? 'page' : undefined}>{n.label}</Link>)}
        </nav>
        <div className="top-end">
          <Link className="btn" href="/inbox">Open inbox</Link>
          {me && <div className="avatar" title={me.name}>{initials(me.name)}</div>}
          <select className="who-pick" value={s?.persona ?? 'owner'} onChange={e => post({ persona: e.target.value })} aria-label="I am">
            {PERSONAS.map(p => <option key={p.id} value={p.id}>{personaLabel(p.id)}</option>)}
          </select>
        </div>
      </header>
      <main>
        {s?.pinRequired && !s.unlocked && (
          <form onSubmit={e => { e.preventDefault(); post({ pin }); }} className="row" style={{ marginBottom: 16 }}>
            <input type="text" inputMode="numeric" placeholder="Demo PIN" value={pin} onChange={e => setPin(e.target.value)} aria-label="Demo PIN" />
            <button className="btn secondary" type="submit">Unlock</button>
          </form>
        )}
        {s?.persona === 'owner' && s.mode === 'local' && (
          <button className="ghost" onClick={reset}>Start over</button>
        )}
        {err && <div className="notice stop" role="alert">{err}</div>}
        {children}
      </main>
    </div>
  );
}
