'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PERSONAS, initials, type PersonaId } from '@/lib/personas';
import { refreshAll } from '@/lib/client';
import { Mark } from '@/components/Mark';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    fetch('/api/auth/status').then(r => r.json()).then(j => setConfigured(!!j.configured)).catch(() => setConfigured(false));
  }, []);

  async function enterDesk(id: PersonaId) {
    setBusy(true);
    setErr('');
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: id }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({ message: 'Could not open the desk' }));
      setErr(j.message || 'Could not open the desk');
      setBusy(false);
      return;
    }
    refreshAll();
    router.push('/office');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setNote('');
    const r = await fetch(mode === 'in' ? '/api/auth/login' : '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.message || 'Could not sign in');
      setBusy(false);
      return;
    }
    if (j.confirm) {
      setNote(j.message || 'Check the mail for a confirm link.');
      setBusy(false);
      return;
    }
    refreshAll();
    router.push('/office');
  }

  return (
    <div className="cover">
      <header className="cover-top">
        <Mark size="cover" />
        <Link href="/" className="ghost-inline">Cover</Link>
      </header>

      <div className="cover-body">
        <div className="cover-hero">
          <p className="card-kicker">Sign in</p>
          <h1>Sign in with a company email.</h1>
          <p className="lede">
            Email and password. SSO is listed on this page and not wired. Walkthrough desks stay below so a judge can still sit down without an account.
          </p>
        </div>

        <section className="desk-sheet gate" aria-labelledby="mail">
          <div className="desk-sheet-head">
            <p className="card-kicker" id="mail">Company email</p>
            <h2>{mode === 'in' ? 'Sign in' : 'Create an account'}</h2>
          </div>
          {configured === false && (
            <p className="small muted">
              Email login is off on this host. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then use a desk below until those keys are in.
            </p>
          )}
          <form className="gate-form" onSubmit={submit}>
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                disabled={!configured || busy}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={mode === 'up' ? 8 : undefined}
                disabled={!configured || busy}
              />
            </label>
            <div className="row">
              <button className="btn" type="submit" disabled={!configured || busy}>
                {mode === 'in' ? 'Sign in' : 'Create account'}
              </button>
              <button
                className="ghost-inline"
                type="button"
                disabled={busy}
                onClick={() => { setMode(m => (m === 'in' ? 'up' : 'in')); setErr(''); setNote(''); }}
              >
                {mode === 'in' ? 'Need an account' : 'Already have an account'}
              </button>
            </div>
          </form>
          {note && <div className="notice" role="status">{note}</div>}
          {err && <div className="notice stop" role="alert">{err}</div>}
        </section>

        <section className="desk-sheet" aria-labelledby="desks">
          <div className="desk-sheet-head">
            <p className="card-kicker" id="desks">Walkthrough</p>
            <h2>Open a desk without an account.</h2>
          </div>
          <div className="people">
            {PERSONAS.map(p => (
              <button
                key={p.id}
                type="button"
                className={`person${p.id === 'owner' ? ' featured' : ''}`}
                disabled={busy}
                onClick={() => enterDesk(p.id)}
              >
                <span className="avatar">{initials(p.name)}</span>
                <span className="person-body">
                  <span className="person-name">
                    {p.name}
                    <span className="chip idle">{p.role}</span>
                  </span>
                  <span className="person-does">{p.does}</span>
                </span>
                <span className="person-go" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
