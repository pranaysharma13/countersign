'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { refreshAll } from '@/lib/client';
import { PERSONAS, personaOf, initials } from '@/lib/personas';
import { Mark } from '@/components/Mark';
import { PERSONA_EVENT } from '@/lib/usePersona';
import { Tour } from '@/components/Tour';
import { requestTour } from '@/lib/tour';

interface Session {
  persona: string;
  unlocked: boolean;
  mode: 'live' | 'local';
  pinRequired: boolean;
  auth: 'supabase' | 'desk';
  email: string | null;
  emailLogin: boolean;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [s, setS] = useState<Session | null>(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { fetch('/api/session').then(r => r.json()).then(setS); }, []);

  useEffect(() => {
    if (!s?.pinRequired || !s.unlocked) return;
    let t = window.setTimeout(lock, 12 * 60 * 1000);
    const bump = () => {
      window.clearTimeout(t);
      t = window.setTimeout(lock, 12 * 60 * 1000);
    };
    const ev = ['pointerdown', 'keydown'] as const;
    ev.forEach(n => window.addEventListener(n, bump));
    return () => {
      window.clearTimeout(t);
      ev.forEach(n => window.removeEventListener(n, bump));
    };
    async function lock() {
      const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lock: true }) });
      const j = await r.json();
      setS(prev => (prev ? { ...prev, unlocked: j.unlocked } : prev));
    }
  }, [s?.pinRequired, s?.unlocked]);

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

  if (path === '/' || path === '/login' || path === '/start') return <>{children}</>;

  const me = personaOf(s?.persona ?? 'owner');
  const nav = [
    { href: '/office', label: 'Work', on: path.startsWith('/office') },
    { href: '/bills', label: 'Bills', on: path === '/bills' || path.startsWith('/invoices') || path.startsWith('/purchases') },
    { href: '/proof', label: 'Proof', on: path.startsWith('/proof') },
    { href: '/banks', label: 'Banks', on: path.startsWith('/banks') },
    { href: '/calls', label: 'Calls', on: path.startsWith('/calls') },
    { href: '/inbox', label: 'Inbox', on: path.startsWith('/inbox') },
    { href: '/sneak', label: 'Sneak', on: path.startsWith('/sneak') },
  ];

  return (
    <div className="app">
      <header className="top">
        <Mark href="/" />
        <nav className="nav" aria-label="Main">
          {nav.map(n => (
            <Link key={n.href} href={n.href} aria-current={n.on ? 'page' : undefined}>{n.label}</Link>
          ))}
        </nav>
        <div className="top-end">
          <button className="btn secondary" type="button" onClick={requestTour}>Walkthrough</button>
          {s?.auth === 'supabase' ? (
            <form action="/api/auth/logout" method="post" onSubmit={async e => {
              e.preventDefault();
              await fetch('/api/auth/logout', { method: 'POST' });
              window.location.href = '/login';
            }}>
              <button className="ghost-inline" type="submit">{s.email || 'Sign out'}</button>
            </form>
          ) : (
            <label className="who">
              {me && <span className="avatar sm" aria-hidden="true">{initials(me.name)}</span>}
              {me && (
                <span className="who-name" aria-hidden="true">
                  <span className="who-first">{me.name.split(' ')[0]}</span>
                  <span className="who-last"> {me.name.split(' ').slice(1).join(' ')}</span>
                  <span className="who-role"> · {me.role}</span>
                </span>
              )}
              <select className="who-pick" value={s?.persona ?? 'owner'} onChange={e => post({ persona: e.target.value })} aria-label="I am">
                {PERSONAS.map(p => <option key={p.id} value={p.id}>{p.name}, {p.role}</option>)}
              </select>
            </label>
          )}
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
        {me && (
          <p className="desk-who" aria-live="polite">
            <span className="desk-who-id"><strong>{me.name}</strong> · {me.role}</span>
            <span className="desk-who-job">{me.does} {me.cannot}</span>
          </p>
        )}
        {children}
        <Tour />
      </main>
    </div>
  );
}

