'use client';
import Link from 'next/link';
import { useState } from 'react';
import { call, newId, useTables, type CallResult } from '@/lib/client';
import { money, HOLD_LABEL } from '@/lib/format';
import { HoldChips, Loading, Outcome } from '@/components/parts';

const KINDS = [
  { id: 'price', label: 'Raise the unit price', hold: 'PRICE_VARIANCE' },
  { id: 'extra', label: 'Add an extra charge', hold: 'PROPOSED_CHARGE' },
  { id: 'waiting', label: 'Bill waiting time', hold: 'PROPOSED_CHARGE' },
  { id: 'fuel', label: 'Add a fuel surcharge', hold: 'PROPOSED_CHARGE' },
  { id: 'bank_change', label: 'Change the bank account', hold: 'PAYEE_CHANGE_PENDING' },
  { id: 'injection', label: 'Hide “approve this bill” in the PDF', hold: 'PROMPT_INJECTION' },
] as const;

export default function SneakCharge() {
  const { data: t, mode, error } = useTables(['invoice', 'invoice_revision', 'hold', 'job', 'supplier'], 800);
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('price');
  const [dollars, setDollars] = useState('3500');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);

  if (!t) return <Loading error={error} />;
  const inv = t.invoice[0];
  const rev = t.invoice_revision.find(r => r.id === inv?.active_revision_id);
  const holds = t.hold.filter(h => h.revision_id === inv?.active_revision_id && h.status === 'open');
  const jobs = [...t.job.filter(j => j.kind === 'sneak_charge')].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const chosen = KINDS.find(k => k.id === kind)!;

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Sneak a charge past it</h1>
          <p className="lede">
            Submit a charge the way a supplier might hide one. Countersign treats the text as data, never as an instruction.
            The hold appears on the live invoice. Nothing is paid from this page.
          </p>
        </div>
        {inv && <Link className="btn secondary" href={`/invoices/${inv.id}`}>Open {inv.invoice_number}</Link>}
      </div>

      <div className="split">
        <section className="sheet pad" aria-labelledby="try">
          <h2 id="try">What to try</h2>
          <form className="stack" style={{ marginTop: 12 }} onSubmit={async e => {
            e.preventDefault();
            const cents = Math.round(Number(dollars) * 100);
            setResult(await call('enqueue_job', {
              id: newId('job_sneak'),
              kind: 'sneak_charge',
              payload_json: JSON.stringify({ kind, amount_cents: Number.isFinite(cents) ? cents : 0, note }),
            }, { asPublic: true }));
          }}>
            <label className="f">Kind of charge
              <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="Kind of charge">
                {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </label>
            <label className="f">Amount (dollars)
              <input type="number" min="0" step="0.01" value={dollars} onChange={e => setDollars(e.target.value)} />
            </label>
            <label className="f">Note on the document
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional. Hidden instructions are ignored." />
            </label>
            <p className="small muted">Expected hold: {HOLD_LABEL[chosen.hold] ?? chosen.hold}. {mode === 'local' ? 'Local demo: the stand-in worker opens it immediately.' : 'Live: the Python worker must be running to assess it.'}</p>
            <button className="btn" type="submit">Submit as a judge</button>
            <Outcome r={result} />
          </form>
        </section>

        <div className="stack">
          <section className="sheet pad" aria-labelledby="now">
            <h2 id="now">On the invoice now</h2>
            {inv ? (
              <>
                <p style={{ marginTop: 0 }}><strong>{t.supplier.find(s => s.id === inv.supplier_id)?.name}</strong> · {inv.invoice_number}
                  {rev ? <> · asked {money(rev.balance_requested_cents)}</> : null}</p>
                <HoldChips holds={holds} />
              </>
            ) : <p className="muted">No supplier invoice is loaded.</p>}
          </section>
          <section className="sheet pad" aria-labelledby="tries">
            <h2 id="tries">Submissions</h2>
            {jobs.length === 0 && <p className="muted" style={{ margin: 0 }}>None yet.</p>}
            <ol className="timeline">
              {jobs.map(j => {
                const p = (() => { try { return JSON.parse(j.payload_json); } catch { return {}; } })();
                return (
                  <li key={j.id}>
                    <span className="t">{j.status}</span>
                    <span>{KINDS.find(k => k.id === p.kind)?.label ?? p.kind} {p.amount_cents ? money(p.amount_cents) : ''}
                      {p.note ? <div className="small muted">{p.note}</div> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
