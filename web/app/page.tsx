'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PERSONAS, initials } from '@/lib/personas';
import { refreshAll } from '@/lib/client';

export default function Landing() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  async function enter(persona: string) {
    setBusy(persona);
    setErr('');
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({ message: 'Could not sign in' }));
      setErr(j.message || 'Could not sign in');
      setBusy(null);
      return;
    }
    refreshAll();
    router.push('/bills');
  }

  return (
    <div className="cover">
      <header className="cover-top">
        <div className="mark">Countersign</div>
        <div className="inbox-on"><span className="dot ok" /> ap@marlowfinch.example</div>
      </header>

      <div className="cover-hero">
        <p className="card-kicker">Marlow &amp; Finch Builders</p>
        <h1>Check the bill. Then you decide.</h1>
        <p className="lede">Quote, purchase order, and the email. A hidden instruction or a new bank account stops here.</p>
      </div>

      <div className="cover-sign">
        <h2>Who is opening the books?</h2>
        <p className="small muted">A demo company. Pick a person. There is no Google login.</p>
        <div className="people">
          {PERSONAS.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={`tile person${i === 0 ? ' featured' : ''}`}
              disabled={busy !== null}
              onClick={() => enter(p.id)}
            >
              <div className="tile-top">
                <span className="avatar">{initials(p.name)}</span>
                <span className="chip idle">{p.role}</span>
              </div>
              <div className="tile-name">{p.name}</div>
              <p className="tile-story">{busy === p.id ? 'Opening…' : p.does}</p>
            </button>
          ))}
        </div>
        {err && <div className="notice stop" role="alert">{err}</div>}
      </div>
    </div>
  );
}
