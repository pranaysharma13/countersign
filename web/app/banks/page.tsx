'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Loading } from '@/components/parts';
import { JsonLd } from '@/components/Semantic';
import { useTables } from '@/lib/client';
import { WORKING_CAPITAL_CENTS, buildTreasury, type Treasury } from '@/lib/banks';
import { booksGraph } from '@/lib/semantic';
import { money } from '@/lib/format';

export default function Banks() {
  const { data: t, error } = useTables(['invoice', 'invoice_revision', 'supplier', 'hold', 'payee_profile']);
  const [live, setLive] = useState<Treasury | null>(null);
  useEffect(() => {
    fetch('/api/banks', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.treasury) setLive(j.treasury); })
      .catch(() => { /* fixture from tables is enough */ });
  }, []);
  const snap = useMemo(() => live ?? (t ? buildTreasury(t) : null), [live, t]);
  if (!t || !snap) return <Loading error={error} />;

  return (
    <div className="office banks" itemScope itemType="https://schema.org/BankAccount">
      <JsonLd data={booksGraph(t, snap)} />
      <header className="head">
        <div>
          <p className="card-kicker">Demo bank · not real money</p>
          <h1>Banks</h1>
          <p className="lede">
            This is the Oakview job account: a pretend bank for the demo, not a real transfer.
            Dana is the only person who can let money leave. Every row is labeled simulated.
          </p>
        </div>
        <p className="small muted" data-nessie-source={snap.source}>{snap.label}</p>
      </header>

      <section className="pipe" aria-label="Books versus bank" data-rec={snap.diffCents === 0 ? 'tied' : 'off'}>
        <div className="pipe-cell">
          <span>Books</span>
          <b className="num" itemProp="amount">{money(snap.booksCents)}</b>
        </div>
        <div className="pipe-cell">
          <span>Job bank</span>
          <b className="num">{money(snap.bankCents)}</b>
        </div>
        <div className="pipe-cell">
          <span>Difference</span>
          <b className={`num${snap.diffCents ? ' hold' : ''}`}>{money(snap.diffCents)}</b>
        </div>
        <div className="pipe-cell">
          <span>Held until a person acts</span>
          <b className="num hold">{money(snap.heldCents)}</b>
        </div>
      </section>

      <div className="office-grid">
        <section className="sheet pad" itemScope itemType="https://schema.org/BankAccount">
          <h2>Job operating</h2>
          <p className="small muted">
            {snap.operating.nickname}. Last four {snap.operating.last4}.
            Demo bank id <code data-nessie-id={snap.operating.nessieId}>{snap.operating.nessieId}</code>.
          </p>
          <dl className="office-dl">
            <div><dt>Type</dt><dd>{snap.operating.type}</dd></div>
            <div><dt>On the books</dt><dd className="num">{money(snap.operating.cents)}</dd></div>
            <div><dt>Ready to leave</dt><dd className="num">{money(snap.readyCents)} · {snap.readyCount} bill{snap.readyCount === 1 ? '' : 's'}</dd></div>
            <div><dt>ACH cutoff</dt><dd>{snap.window.cutoffHour}:00 PT · settles {snap.window.settles}</dd></div>
          </dl>
          <p className="small muted">Working capital {money(WORKING_CAPITAL_CENTS)} plus draws 1–2. Owner account ····{snap.owner.last4} still holds {money(snap.owner.cents)}.</p>
        </section>

        <section className="sheet pad">
          <h2>What already moved</h2>
          <p className="small muted">Deposits first. No supplier transfer until Dana pays.</p>
          <ul className="office-rows">
            {snap.moves.map(m => (
              <li key={m.id} data-transfer-id={m.id} data-cents={m.cents} data-rail={m.rail}>
                <span>{m.iso} · {m.memo}</span>
                <b className="num">{money(m.cents)}</b>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="sheet pad">
        <h2>Payees on file</h2>
        <p className="small muted">Verified accounts can receive ACH. A pending last-4 waits for a call. Clerk does not pay a number from the email that asked for the change.</p>
        <ul className="payee-book">
          {snap.payees.map(p => (
            <li
              key={p.id}
              data-payee-id={p.id}
              data-supplier={p.supplier}
              data-last4={p.last4}
              data-status={p.status}
              data-name-match={p.nameMatch ? 'yes' : 'no'}
              data-rail={p.rail}
            >
              <div>
                <strong>{p.supplier}</strong>
                <span className="small muted">{p.bank} ····{p.last4} · {p.ref}</span>
              </div>
              <div className="payee-meta">
                <span className={`chip ${p.status === 'verified' ? 'ok' : p.status === 'pending' ? 'hold' : 'idle'}`}>{p.status}</span>
                <span className="small muted">{p.rail.toUpperCase()}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="sheet pad">
        <h2>Guardrails</h2>
        <ul className="office-close">
          {snap.controls.map(c => (
            <li key={c.id} className={c.ok ? 'done' : 'open'} data-control={c.id} data-ok={c.ok ? 'yes' : 'no'}>
              <span className="tick" aria-hidden="true">{c.ok ? '✓' : '·'}</span>
              <div>
                <strong>{c.label}</strong>
                <p className="small muted">{c.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="small muted">
        Ready bills live on <Link href="/office">Work</Link>. Cedar is the one that can leave today if Dana reads the last four back.
      </p>
    </div>
  );
}
