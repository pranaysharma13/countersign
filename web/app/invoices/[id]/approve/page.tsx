'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, call, reasonsOf, type Row, type Tables, type CallResult } from '@/lib/client';
import { money, when, qty, HOLD_LABEL, ROLE_LABEL } from '@/lib/format';
import { StatusStrip, Loading } from '@/components/parts';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact', 'payee_profile',
  'proposal', 'payment_approval', 'payment', 'deposit', 'deposit_allocation', 'receipt_attestation', 'ledger_line', 'purchase'];

/** Mirrors the module's six eligibility rules so the button can say why it's disabled. The module re-checks on click. */
function blockedReasons(t: Tables, p: Row, inv: Row): string[] {
  const ref = JSON.parse(p.evidence_json || '{}');
  const out: string[] = [];
  if (inv.active_revision_id !== ref.revision_id) out.push('The invoice has a newer revision.');
  for (const h of t.hold.filter(h => h.revision_id === ref.revision_id && h.status === 'open' && h.code !== 'APPROVAL_STALE')) {
    out.push(`Still blocking: ${HOLD_LABEL[h.code] ?? h.code}.`);
  }
  if (!['manually_confirmed', 'not_required'].includes(inv.receipt_status)) out.push('Delivery not confirmed on site.');
  const verified = t.payee_profile.find(x => x.supplier_id === inv.supplier_id && x.status === 'verified');
  if (!verified || verified.id !== ref.payee_profile_id) out.push("The bank account is not the one we already checked.");
  const latest = t.assessment.filter(a => a.revision_id === ref.revision_id).sort((a, b) => b.version - a.version)[0];
  if (!latest || latest.id !== ref.assessment_id) out.push('The assessment changed after this was proposed.');
  return out;
}

export default function ApprovalReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, error } = useTables(TABLES);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);
  if (!t) return <Loading error={error} />;
  const inv = t.invoice.find(i => i.id === id);
  if (!inv) return <div className="empty">No invoice {id}.</div>;

  const sup = t.supplier.find(s => s.id === inv.supplier_id);
  const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
  const proposals = t.proposal.filter(p => p.work_item_id === `wi_${id}` && p.kind === 'supplier_payment').sort((a, b) => b.created_at - a.created_at);
  const p = proposals.find(x => ['pending', 'approved', 'executing', 'executed'].includes(x.status)) ?? proposals[0];
  const ref = p ? JSON.parse(p.evidence_json || '{}') : {};
  const assessment = t.assessment.find(a => a.id === ref.assessment_id);
  const latest = t.assessment.filter(a => a.revision_id === rev?.id).sort((a, b) => b.version - a.version)[0];
  const payee = t.payee_profile.find(x => x.id === ref.payee_profile_id) ?? t.payee_profile.find(x => x.supplier_id === inv.supplier_id && x.status === 'verified');
  const viaContact = t.supplier_contact.find(c => c.id === payee?.verified_via_contact_id);
  const pendingPayees = t.payee_profile.filter(x => x.supplier_id === inv.supplier_id && x.status === 'pending');
  const approvals = t.payment_approval.filter(a => a.invoice_id === id).sort((a, b) => b.created_at - a.created_at);
  const stale = approvals.find(a => a.status === 'stale');
  const atts = t.receipt_attestation.filter(a => a.invoice_id === id);
  const reasons = p && p.status === 'pending' ? blockedReasons(t, p, inv) : [];

  return (
    <div className="stack">
      <div className="head">
        <div>
          <div className="small muted"><Link href={`/invoices/${id}`}>{sup?.name} · {inv.invoice_number}</Link> / Pay or reject</div>
          <h1>Pay this bill?</h1>
          <p className="lede">This yes is only for this amount, this bank, and this version of the bill. If any of those change, you have to say yes again.</p>
        </div>
      </div>

      <StatusStrip inv={inv} />

      {stale && inv.approval_status === 'stale' && (
        <div className="notice hold" role="alert"><strong>Your earlier approval is out of date.</strong> {stale.stale_reason}. Review the current figures and approve again.</div>
      )}

      <div className="split">
        <div className="stack">
          <section className="sheet pad" aria-labelledby="pay">
            <h2 id="pay">The transfer</h2>
            {!p ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing is ready to pay yet. See what is blocking on the{' '}
                <Link href={`/invoices/${id}`}>bill</Link>.
              </p>
            ) : (
              <table>
                <tbody>
                  <tr><td>Pay</td><td className="num" style={{ fontSize: 22, fontWeight: 700 }}>{money(p.amount_cents)}</td></tr>
                  <tr><td>Revision</td><td className="num">{rev?.revision} of {inv.invoice_number} (gross {money(rev?.gross_cents)})</td></tr>
                  <tr><td>Deposit applied</td><td className="num">{money(Number(ref.deposit_allocation_cents ?? 0))}</td></tr>
                  <tr><td>To this account</td><td className="num">{payee ? `${payee.bank_name} ····${payee.last4}` : '—'}</td></tr>
                  <tr><td>Suggested by</td><td className="num">{ROLE_LABEL[p.proposed_by_role]}, {when(p.created_at)}</td></tr>
                  <tr><td>Status</td><td className="num">{({ pending: 'Waiting for your approval', approved: 'Approved, queued for payment', executing: 'Settling', executed: 'Paid', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed' } as Record<string, string>)[p.status] ?? p.status}</td></tr>
                </tbody>
              </table>
            )}
            {assessment && <p className="small">{assessment.summary}</p>}

            {p?.status === 'pending' && (
              <div className="stack" style={{ marginTop: 16 }}>
                {reasons.length > 0 && (
                  <div className="notice hold" role="status">
                    <strong>You cannot pay yet:</strong>
                    <ul>{reasons.map(r => <li key={r}>{r}</li>)}</ul>
                  </div>
                )}
                <label className="f">Note for the record
                  <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" />
                </label>
                <div className="row">
                  <button className="btn" disabled={reasons.length > 0}
                    onClick={async () => setResult(await call('approve_supplier_payment', { proposal_id: p.id, expected_fingerprint: latest?.fingerprint ?? '', note }))}>
                    Approve {money(p.amount_cents)}
                  </button>
                  <button className="btn danger" onClick={async () => setResult(await call('reject_supplier_payment', { proposal_id: p.id, note: note || 'Rejected by owner' }))}>
                    Reject
                  </button>
                  <Link className="btn secondary" href={`/invoices/${id}`}>Back to the bill</Link>
                </div>
              </div>
            )}
            {result && (result.outcome === 'ok'
              ? <div className="notice ok" role="status">Approved. The money goes out once, and the books update.</div>
              : <div className="notice stop" role="alert"><strong>Refused:</strong><ul>{reasonsOf(result.message).map(r => <li key={r}>{r}</li>)}</ul></div>)}
          </section>

          <Settlement t={t} inv={inv} proposalId={p?.id} />
        </div>

        <div className="stack">
          <section className="sheet pad" aria-labelledby="payee">
            <h2 id="payee">Who gets the money</h2>
            {payee ? (
              <p style={{ marginTop: 0 }}>{payee.bank_name} ····{payee.last4}<br />
                <span className="small muted">{payee.requested_via === 'seed' ? 'This account has been on file from the start.' : `Checked by ${ROLE_LABEL[payee.verified_by_role]} with ${viaContact?.name ?? 'someone already on file'}.`}</span></p>
            ) : <p className="muted">No verified account on file.</p>}
            {pendingPayees.map(x => <PayeeChange key={x.id} profile={x} t={t} />)}
          </section>

          <section className="sheet pad" aria-labelledby="rcpt">
            <h2 id="rcpt">Delivery</h2>
            {atts.length ? atts.map(a => (
              <p key={a.id} className="small" style={{ marginTop: 0 }}><span className="chip ok">Confirmed</span><br />
                {qty(a.quantity_milli, a.unit)}, {a.scope}. “{a.reason}” {ROLE_LABEL[a.attested_by_role]}, {when(a.created_at)}</p>
            )) : <p className="muted small" style={{ margin: 0 }}>Not confirmed. Payment stays blocked until someone on site confirms the delivery.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function PayeeChange({ profile, t }: { profile: Row; t: Tables }) {
  const trusted = t.supplier_contact.filter(c => c.supplier_id === profile.supplier_id && c.pre_established);
  const [contact, setContact] = useState(trusted[0]?.id ?? '');
  const [result, setResult] = useState<CallResult | null>(null);
  return (
    <div className="notice stop" style={{ marginTop: 8 }}>
      <strong>Bank change requested:</strong> new account ····{profile.last4} at {profile.bank_name}, via {profile.requested_via}.
      <p className="small" style={{ margin: '6px 0' }}>Call a contact who was on file before this request. Never use a number from the request itself.</p>
      <div className="row">
        <select value={contact} onChange={e => setContact(e.target.value)} aria-label="Contact you verified with">
          {trusted.map(c => <option key={c.id} value={c.id}>{c.name}, {c.phone}</option>)}
        </select>
        <button className="btn secondary" onClick={async () => setResult(await call('decide_payee_profile', { id: profile.id, approve: true, verified_via_contact_id: contact, note: 'Verified by phone with a contact on file' }))}>Verified, accept</button>
        <button className="btn danger" onClick={async () => setResult(await call('decide_payee_profile', { id: profile.id, approve: false, verified_via_contact_id: '', note: 'Supplier did not request this change' }))}>Reject change</button>
      </div>
      {result && result.outcome !== 'ok' && <div className="small" style={{ marginTop: 6 }}>Refused: {result.message}</div>}
    </div>
  );
}

function Settlement({ t, inv, proposalId }: { t: Tables; inv: Row; proposalId?: string }) {
  const pay = proposalId ? t.payment.find(x => x.id === proposalId) : null;
  const allocs = t.deposit_allocation.filter(a => a.invoice_id === inv.id);
  const refs = new Set([inv.id, inv.purchase_id, proposalId].filter(Boolean));
  const lines = t.ledger_line.filter(l => refs.has(l.ref_id));
  if (!pay && !lines.length) return null;
  const journals = [...new Set(lines.map(l => l.journal_id))];
  const net = (acct: string) => lines.filter(l => l.account === acct).reduce((s, l) => s + l.credit_cents - l.debit_cents, 0);
  return (
    <section className="sheet pad" aria-labelledby="settle">
      <h2 id="settle">What left the account</h2>
      {pay && <p style={{ marginTop: 0 }}><span className={`st ${pay.status === 'sent' ? 'ok' : 'stop'}`}>{pay.status === 'sent' ? 'Paid' : 'Failed'}</span>{' '}
        {money(pay.amount_cents)}, transfer <code>{pay.nessie_transfer_id}</code>{pay.nessie_transfer_id.includes('sim') ? ' (simulated Nessie)' : ''}.</p>}
      {allocs.map(a => <p key={a.id} className="small">Deposit applied once: {money(a.amount_cents)}.</p>)}
      <div className="scroll">
        <table>
          <thead><tr><th>Entry</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {journals.map(j => lines.filter(l => l.journal_id === j).map((l, i) => (
              <tr key={l.id}><td className="small">{i === 0 ? l.memo : ''}</td><td className="small">{l.account}</td>
                <td className="num">{l.debit_cents ? money(l.debit_cents) : ''}</td><td className="num">{l.credit_cents ? money(l.credit_cents) : ''}</td></tr>
            )))}
          </tbody>
        </table>
      </div>
      <p className="small" style={{ marginBottom: 0 }}>Accounts payable for this invoice: <strong>{money(net('accounts_payable'))}</strong>. Cash paid for this purchase, including the deposit: <strong>{money(net('cash'))}</strong>.</p>
    </section>
  );
}
