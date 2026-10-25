'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PERSONAS, initials } from '@/lib/personas';
import { refreshAll, useTables, type Row, type Tables } from '@/lib/client';
import { money, HOLD_LABEL, daysUntil } from '@/lib/format';

const MONEY_HOLD = ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING'];
const SEVERITY = ['PROMPT_INJECTION', 'PAYEE_CHANGE_PENDING', 'PO_CEILING', 'PROPOSED_CHARGE', 'PRICE_VARIANCE', 'DUPLICATE_REVIEW'];
const CATCH_COPY: Record<string, string> = {
  PROMPT_INJECTION: 'A line in the invoice told the checker to approve it. Countersign ignored it and stopped the bill.',
  PAYEE_CHANGE_PENDING: 'The supplier asked to be paid into a new account. Nothing moves until someone calls a number on file.',
  PO_CEILING: 'The invoice bills more than the purchase order allows. The extra waits for a corrected invoice.',
  PROPOSED_CHARGE: 'A charge that was never agreed in writing. It is held, not paid.',
  PRICE_VARIANCE: 'The unit price is higher than the accepted quote.',
  DUPLICATE_REVIEW: 'This looks like a bill we have already seen.',
};

export default function Landing() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const { data: t } = useTables(['invoice', 'invoice_revision', 'supplier', 'hold']);

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

      <div className="home">
        <div className="home-left">
          <div className="cover-hero">
            <p className="card-kicker">Marlow &amp; Finch Builders</p>
            <h1>Check the bill.<br />Then you decide.</h1>
            <p className="lede">
              Every supplier bill is read against its quote, purchase order and emails. A hidden instruction or a new bank account stops here.
            </p>
          </div>

          <section className="home-people" aria-labelledby="who">
            <div className="home-people-head">
              <h2 id="who">Open the books</h2>
              <span className="small muted">Demo company · no Google login</span>
            </div>
            <div className="people">
              {PERSONAS.filter(p => p.id === 'owner').map(p => (
                <button
                  key={p.id}
                  type="button"
                  className="person featured"
                  disabled={busy !== null}
                  onClick={() => enter(p.id)}
                >
                  <span className="avatar">{initials(p.name)}</span>
                  <span className="person-body">
                    <span className="person-name">{p.name}</span>
                    <span className="person-does">{busy === p.id ? 'Opening…' : p.does}</span>
                  </span>
                  <span className="person-go" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
            {err && <div className="notice stop" role="alert">{err}</div>}
          </section>
        </div>

        {t && t.invoice.length > 0 ? <Preview t={t} /> : <div className="home-right" aria-hidden="true" />}
      </div>
    </div>
  );
}

function Preview({ t }: { t: Tables }) {
  const invoices = t.invoice;
  const rev = (inv: Row) => t.invoice_revision.find(r => r.id === inv.active_revision_id);
  const unpaid = invoices.filter(i => i.payment_status !== 'settled');
  const unpaidRevs = new Set(unpaid.map(i => i.active_revision_id));
  const openHolds = t.hold.filter(h => h.status === 'open' && unpaidRevs.has(h.revision_id));
  const holdsOf = (inv: Row) => openHolds.filter(h => h.revision_id === inv.active_revision_id);
  const asked = unpaid.reduce((s, i) => s + (Number(rev(i)?.balance_requested_cents) || 0), 0);
  const held = openHolds.filter(h => MONEY_HOLD.includes(h.code)).reduce((s, h) => s + (Number(h.amount_cents) || 0), 0);
  const caughtBills = unpaid.filter(i => holdsOf(i).length > 0).length;
  const pct = unpaid.length ? Math.round((caughtBills / unpaid.length) * 100) : 0;

  const stages = [
    { k: 'Arrived', n: invoices.length },
    { k: 'Checked', n: invoices.filter(i => i.commercial_status && i.commercial_status !== 'pending').length },
    { k: 'Blocked', n: unpaid.filter(i => holdsOf(i).length > 0).length },
    { k: 'With owner', n: unpaid.filter(i => holdsOf(i).length === 0).length },
    { k: 'Paid', n: invoices.length - unpaid.length },
  ];

  const worst = [...openHolds].sort((a, b) => {
    const ia = SEVERITY.indexOf(a.code), ib = SEVERITY.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0];
  const worstInv = worst && invoices.find(i => i.active_revision_id === worst.revision_id);
  const worstSup = worstInv && t.supplier.find(s => s.id === worstInv.supplier_id);
  const caught = new Set(openHolds.map(h => h.code)).size;

  const byDay = new Map<string, Row[]>();
  unpaid.forEach(i => { if (i.due_date) byDay.set(i.due_date, [...(byDay.get(i.due_date) ?? []), i]); });
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 6);

  return (
    <div className="home-right" aria-label="Live from the demo books">
      <section className="bento bento-stats">
        <div>
          <div className="bento-big">{unpaid.length}</div>
          <div className="bento-label">bills waiting on a person</div>
        </div>
        <div>
          <div className="bento-big">{money(asked).replace(/\.00$/, '')}</div>
          <div className="bento-label">suppliers asked for</div>
        </div>
        <div>
          <div className="bento-big hold">{money(held).replace(/\.00$/, '')}</div>
          <div className="bento-label">not paid until agreed</div>
        </div>
      </section>

      <section className="bento bento-gauge">
        <div className="card-kicker">Open bills on hold</div>
        <Gauge pct={pct} />
        <p className="small muted bento-foot">{caughtBills} of {unpaid.length} open bills have something to fix before paying.</p>
      </section>

      {worst && (
        <section className="bento bento-dark">
          <div className="bento-dark-top">
            <span className="card-kicker">Stopped</span>
            <span className="bento-count">{caught} kinds caught</span>
          </div>
          <h3>{HOLD_LABEL[worst.code] ?? 'Needs a look'}</h3>
          <p>{CATCH_COPY[worst.code] ?? 'Held for a person to review.'}</p>
          <div className="bento-dark-foot">
            <span>{worstSup?.name ?? 'Supplier'} · {worstInv?.invoice_number}</span>
            {worst.amount_cents > 0 && <b>{money(worst.amount_cents)}</b>}
          </div>
        </section>
      )}

      <section className="bento bento-flow">
        <div className="card-kicker">Where the bills are</div>
        <ol className="flow">
          {stages.map((s, i) => (
            <li key={s.k} className={s.k === 'Blocked' && s.n > 0 ? 'flow-hot' : i === stages.length - 1 ? 'flow-end' : ''}>
              <b>{s.n}</b>
              <span>{s.k}</span>
            </li>
          ))}
        </ol>
      </section>

      {days.length > 0 && (
        <section className="bento bento-days">
          <div className="bento-days-head">
            <div className="card-kicker">Coming due</div>
            <span className="small muted">
              {[...new Set(days.map(([iso]) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'long' })))].join(' – ')}
            </span>
          </div>
          <div className="days">
            {days.map(([iso, list], i) => {
              const d = new Date(`${iso}T12:00:00`);
              const left = daysUntil(iso);
              return (
                <div key={iso} className={`day${i === 0 ? ' soonest' : ''}${left != null && left < 0 ? ' late' : ''}`}>
                  <span className="day-n">{d.getDate()}</span>
                  <span className="day-w">{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <span className="day-c">{list.length} {list.length === 1 ? 'bill' : 'bills'}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Gauge({ pct }: { pct: number }) {
  const ticks = 36;
  const on = Math.round((pct / 100) * ticks);
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 110" role="img" aria-label={`${pct}% of open bills on hold`}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const a = Math.PI - (i / ticks) * Math.PI;
          const r1 = 78, r2 = i % 6 === 0 ? 96 : 92;
          return (
            <line
              key={i}
              x1={100 + r1 * Math.cos(a)} y1={100 - r1 * Math.sin(a)}
              x2={100 + r2 * Math.cos(a)} y2={100 - r2 * Math.sin(a)}
              stroke={i <= on ? '#141414' : '#d9ddd6'}
              strokeWidth={i % 6 === 0 ? 2.4 : 1.6}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
      <div className="gauge-n">{pct}%</div>
    </div>
  );
}
