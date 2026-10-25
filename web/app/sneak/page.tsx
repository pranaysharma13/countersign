'use client';
import Link from 'next/link';
import { useState } from 'react';
import { call, newId, useTables, type CallResult, type Row } from '@/lib/client';
import { money, HOLD_LABEL } from '@/lib/format';
import { HoldChips, Loading, Outcome } from '@/components/parts';

const KINDS = [
  { id: 'price', label: 'Raise the unit price', hold: 'PRICE_VARIANCE' },
  { id: 'extra', label: 'Add an extra charge', hold: 'PROPOSED_CHARGE' },
  { id: 'waiting', label: 'Bill waiting time', hold: 'PROPOSED_CHARGE' },
  { id: 'fuel', label: 'Add a fuel surcharge', hold: 'USAGE_EVIDENCE_MISSING' },
  { id: 'bank_change', label: 'Change the bank account', hold: 'PAYEE_CHANGE_PENDING' },
  { id: 'injection', label: 'Hide “approve this bill” in the PDF', hold: 'PROMPT_INJECTION' },
] as const;

type JobResult = { status?: string; invoice_number?: string; reason?: string; extraction?: string };
const parse = (raw: unknown): Row => { try { return JSON.parse(String(raw || '{}')); } catch { return {}; } };

export default function SneakCharge() {
  const { data: t, error } = useTables(['invoice', 'hold', 'job'], 800);
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('price');
  const [dollars, setDollars] = useState('3500');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);
  const [mine, setMine] = useState<string | null>(null);

  if (!t) return <Loading error={error} />;
  const jobs = [...t.job.filter(j => j.kind === 'sneak_charge')].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const chosen = KINDS.find(k => k.id === kind)!;
  // The sandbox invoice a submission became (its number is in the job result), and the holds the checks opened.
  const outcome = (job: Row | undefined) => {
    const r = parse(job?.result_json) as JobResult;
    const inv = r.invoice_number ? t.invoice.find(i => i.invoice_number === r.invoice_number) : undefined;
    const holds = inv ? t.hold.filter(h => h.revision_id === inv.active_revision_id && h.status === 'open') : [];
    return { r, inv, holds, reading: !!r.invoice_number && (!inv || !inv.active_revision_id || inv.commercial_status === 'pending') };
  };
  const myJob = jobs.find(j => j.id === mine);
  const my = outcome(myJob);

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Sneak a charge past it</h1>
          <p className="lede">
            Your charge becomes a real invoice from a fictional sandbox supplier and goes through the same checks as every
            invoice. The checks decide which holds open. It never touches BayMix&apos;s invoice, and nothing is paid from this page.
          </p>
        </div>
      </div>

      <div className="split">
        <section className="sheet pad" aria-labelledby="try">
          <h2 id="try">What to try</h2>
          <form className="stack" style={{ marginTop: 12 }} onSubmit={async e => {
            e.preventDefault();
            const cents = Math.round(Number(dollars) * 100);
            const id = newId('job_sneak');
            const r = await call('enqueue_job', {
              id,
              kind: 'sneak_charge',
              payload_json: JSON.stringify({ kind, amount_cents: Number.isFinite(cents) ? cents : 0, note }),
            }, { asPublic: true });
            setResult(r);
            if (r.outcome === 'ok') setMine(id);
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
            <p className="small muted">Usually opens: {HOLD_LABEL[chosen.hold] ?? chosen.hold}. The checks decide.</p>
            <button className="btn" type="submit">Submit as a judge</button>
            <Outcome r={result} />
          </form>
        </section>

        <div className="stack">
          <section className="sheet pad" aria-labelledby="now">
            <h2 id="now">Your sandbox invoice</h2>
            {!myJob ? <p className="muted" style={{ margin: 0 }}>Submit a charge to see the invoice it becomes.</p>
              : my.inv && !my.reading ? (
                <>
                  <p style={{ marginTop: 0 }}><strong>Judge sandbox</strong> · {my.inv.invoice_number} · not paid
                    {my.r.extraction ? <span className="small muted"> · reading: {my.r.extraction}</span> : null}</p>
                  {my.holds.length ? <HoldChips holds={my.holds} /> : <p className="muted" style={{ margin: 0 }}>No holds: the checks found nothing wrong.</p>}
                  <p style={{ marginBottom: 0 }}><Link href={`/invoices/${my.inv.id}`}>Open {my.inv.invoice_number}</Link></p>
                </>
              ) : my.r.reason ? <p className="muted" style={{ margin: 0 }}>{my.r.reason}</p>
              : <p className="muted" style={{ margin: 0 }}>Countersign is reading it…</p>}
          </section>
          <section className="sheet pad" aria-labelledby="tries">
            <h2 id="tries">Submissions</h2>
            {jobs.length === 0 && <p className="muted" style={{ margin: 0 }}>None yet.</p>}
            <ol className="timeline">
              {jobs.map(j => {
                const p = parse(j.payload_json);
                const o = outcome(j);
                return (
                  <li key={j.id}>
                    <span className="t">{o.inv ? o.inv.invoice_number : j.status}</span>
                    <span>{KINDS.find(k => k.id === p.kind)?.label ?? p.kind} {p.amount_cents ? money(p.amount_cents) : ''}
                      {p.note ? <div className="small muted">{p.note}</div> : null}
                      {o.holds.length ? <div className="small">{o.holds.map(h => HOLD_LABEL[h.code] ?? h.code).join(' · ')}</div> : null}
                      {!o.inv && o.r.reason ? <div className="small muted">{o.r.reason}</div> : null}
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
