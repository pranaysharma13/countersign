'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PERSONAS, initials, type PersonaId } from '@/lib/personas';
import { refreshAll, useTables } from '@/lib/client';
import { HOLD_LABEL, isSandbox, money, nextStep } from '@/lib/format';
import { HonestAsk, useHonestSnap } from '@/components/Honest';
import { Mark } from '@/components/Mark';

export default function Start() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const { data: t } = useTables(['invoice', 'invoice_revision', 'supplier', 'hold']);
  const honest = useHonestSnap();

  const today = useMemo(() => {
    if (!t) return [];
    return t.invoice
      .filter(i => !isSandbox(i) && i.payment_status !== 'settled')
      .map(inv => {
        const holds = t.hold.filter(h => h.status === 'open' && h.revision_id === inv.active_revision_id);
        const next = nextStep(inv, holds);
        const sup = t.supplier.find(s => s.id === inv.supplier_id);
        const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
        return {
          id: String(inv.id),
          supplier: String(sup?.name ?? 'Supplier'),
          number: String(inv.invoice_number),
          cents: Number(rev?.balance_requested_cents) || 0,
          block: holds[0] ? (HOLD_LABEL[holds[0].code] ?? 'Needs a look') : 'Ready for the owner',
          who: next.role === 'owner' ? 'Dana' : next.role === 'purchasing' ? 'Buyer' : next.role === 'receiver' ? 'Site' : next.role ? 'A person' : 'Dana',
          action: next.action,
        };
      })
      .sort((a, b) => (a.block === 'New bank account' ? -1 : b.block === 'New bank account' ? 1 : 0))
      .slice(0, 4);
  }, [t]);

  async function enter(id: PersonaId) {
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

  return (
    <div className="cover">
      <header className="cover-top">
        <Mark size="cover" />
        <div className="row">
          <Link href="/" className="ghost-inline">Cover</Link>
          <Link href="/login" className="btn">Sign in</Link>
        </div>
      </header>

      <div className="cover-body">
        <div className="cover-hero">
          <p className="card-kicker">Walkthrough desks</p>
          <h1>Sit as Dana, Jordan, Luis, or Sam.</h1>
          <p className="lede">
            Dana can pay. Jordan sends the correction. Luis confirms what landed on Oakview. Sam can read every bill and cannot pay.
            Company email login is on the sign-in page.
          </p>
        </div>

        {honest && <HonestAsk snap={honest} />}

        <section className="desk-sheet" aria-labelledby="who">
          <div className="desk-sheet-head">
            <p className="card-kicker" id="who">Open a desk</p>
            <h2>These desks skip company email.</h2>
          </div>
          <div className="people">
            {PERSONAS.map(p => (
              <button
                key={p.id}
                type="button"
                className={`person${p.id === 'owner' ? ' featured' : ''}`}
                disabled={busy}
                onClick={() => enter(p.id)}
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
          {err && <div className="notice stop" role="alert">{err}</div>}
        </section>

        <section className="today" aria-labelledby="today">
          <div className="today-head">
            <h2 id="today">Waiting on someone</h2>
            <p className="small muted">Live from this workspace.</p>
          </div>
          {today.length === 0 ? (
            <p className="small muted">The books are still loading.</p>
          ) : (
            <ol className="today-list">
              {today.map(row => (
                <li key={row.id}>
                  <div className="wait-who">
                    <strong>{row.supplier}</strong>
                    <span className="small muted">{row.number} · {row.block}</span>
                  </div>
                  <p className="wait-next">{row.who}: {row.action}</p>
                  <b className="num">{money(row.cents)}</b>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
