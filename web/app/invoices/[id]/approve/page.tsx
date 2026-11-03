'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, call, reasonsOf, type Row, type Tables, type CallResult } from '@/lib/client';
import { money, when, qty, HOLD_LABEL, ROLE_LABEL } from '@/lib/format';
import { StatusStrip, Loading } from '@/components/parts';
import { Hear } from '@/components/Hear';
import { PayeeCall } from '@/components/PayeeCall';
import { Readback } from '@/components/Readback';
import { usePersona } from '@/lib/usePersona';
import { blockedSpeech, transferSpeech, type PayVerdict } from '@/lib/voice';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact', 'payee_profile',
  'proposal', 'payment_approval', 'payment', 'deposit', 'deposit_allocation', 'receipt_attestation', 'ledger_line', 'purchase', 'authority'];

function blockedReasons(t: Tables, p: Row, inv: Row): string[] {
  const ref = JSON.parse(p.evidence_json || '{}');
  const out: string[] = [];
  if (inv.active_revision_id !== ref.revision_id) out.push('This bill has a newer version.');
  for (const h of t.hold.filter(h => h.revision_id === ref.revision_id && h.status === 'open' && h.code !== 'APPROVAL_STALE')) {
    out.push(HOLD_LABEL[h.code] ?? h.code);
  }
  if (!['manually_confirmed', 'not_required'].includes(inv.receipt_status)) out.push('Site has not confirmed delivery.');
  const verified = t.payee_profile.find(x => x.supplier_id === inv.supplier_id && x.status === 'verified');
  if (!verified || verified.id !== ref.payee_profile_id) out.push('The bank account is not the one already on file.');
  const latest = t.assessment.filter(a => a.revision_id === ref.revision_id).sort((a, b) => b.version - a.version)[0];
  if (!latest || latest.id !== ref.assessment_id) out.push('The check changed after this was proposed.');
  return out;
}

export default function ApprovalReview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, error } = useTables(TABLES);
  const persona = usePersona();
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);
  const [spoken, setSpoken] = useState('');
  const [payVoice, setPayVoice] = useState<PayVerdict>('unclear');
  const [wantVoice, setWantVoice] = useState(false);
  if (!t) return <Loading error={error} />;
  const inv = t.invoice.find(i => i.id === id);
  if (!inv) return <div className="empty">No invoice {id}.</div>;

  const sup = t.supplier.find(s => s.id === inv.supplier_id);
  const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
  const proposals = t.proposal.filter(p => p.work_item_id === `wi_${id}` && p.kind === 'supplier_payment').sort((a, b) => b.created_at - a.created_at);
  const p = proposals.find(x => ['pending', 'approved', 'executing', 'executed'].includes(x.status)) ?? proposals[0];
  const ref = p ? JSON.parse(p.evidence_json || '{}') : {};
  const latest = t.assessment.filter(a => a.revision_id === rev?.id).sort((a, b) => b.version - a.version)[0];
  const payee = t.payee_profile.find(x => x.id === ref.payee_profile_id) ?? t.payee_profile.find(x => x.supplier_id === inv.supplier_id && x.status === 'verified');
  const viaContact = t.supplier_contact.find(c => c.id === payee?.verified_via_contact_id);
  const pendingPayees = t.payee_profile.filter(x => x.supplier_id === inv.supplier_id && x.status === 'pending');
  const approvals = t.payment_approval.filter(a => a.invoice_id === id).sort((a, b) => b.created_at - a.created_at);
  const stale = approvals.find(a => a.status === 'stale');
  const atts = t.receipt_attestation.filter(a => a.invoice_id === id);
  const reasons = p && p.status === 'pending' ? blockedReasons(t, p, inv) : [];
  const limit = (t.authority ?? []).filter(a => a.role === 'owner').sort((a, b) => Number(b.limit_cents) - Number(a.limit_cents))[0];
  const overLimit = !!(p && limit && Number(p.amount_cents) > Number(limit.limit_cents) && Number(limit.limit_cents) > 0);
  const sameHands = !!(p && persona && p.proposed_by_role === persona);
  const waitingBank = pendingPayees.length > 0 || reasons.includes(HOLD_LABEL.PAYEE_CHANGE_PENDING);
  const isOwner = persona === 'owner';
  const readyExceptRole = !!(p && p.status === 'pending' && reasons.length === 0 && !sameHands && !overLimit);
  const canPay = readyExceptRole && isOwner;
  const blocked = !canPay || (wantVoice && payVoice !== 'approve');

  return (
    <div className="stack">
      <div className="head">
        <div>
          <div className="small muted"><Link href={`/invoices/${id}`}>{sup?.name} · {inv.invoice_number}</Link></div>
          <h1>{waitingBank ? 'This bill cannot pay yet' : canPay ? 'Pay this bill?' : 'Not ready to pay'}</h1>
          <p className="lede">
            {waitingBank
              ? 'They asked for a new bank account. Call a number already on the quote. Clerk will not send money from this screen.'
              : canPay
                ? `${money(p?.amount_cents)} to ${payee ? `${payee.bank_name} ····${payee.last4}` : 'the account on file'}. This yes is only for this amount and this account.`
                : 'Something still has to be fixed before money can leave.'}
          </p>
        </div>
      </div>

      <StatusStrip inv={inv} />

      {stale && inv.approval_status === 'stale' && (
        <div className="notice hold" role="alert"><strong>Your earlier approval is out of date.</strong> {stale.stale_reason}. Review the current figures and approve again.</div>
      )}

      {waitingBank && (
        <div className="stack">
          <div className="notice hold" role="status">
            <strong>New bank account.</strong> The old account on file is {payee ? `${payee.bank_name} ····${payee.last4}` : 'the one already checked'}.
            Nothing moves until someone on file confirms the change, or you keep the old account.
          </div>
          {pendingPayees.map(x => (
            <PayeeCall
              key={x.id}
              invoiceId={String(inv.id)}
              invoiceNumber={String(inv.invoice_number)}
              supplier={String(sup?.name ?? 'Supplier')}
              oldLast4={String(payee?.last4 ?? '')}
              profile={x}
              t={t}
            />
          ))}
          <p className="small muted"><Link href={`/invoices/${id}`}>Back to the bill</Link></p>
        </div>
      )}

      {!waitingBank && (
        <div className="split">
          <div className="stack">
            <section className="sheet pad" aria-labelledby="pay">
              <h2 id="pay">{canPay ? 'Confirm the payment' : 'Why it cannot pay'}</h2>
              {!p ? (
                <p className="muted" style={{ margin: 0 }}>
                  Nothing is ready to pay. See what is blocking on the{' '}
                  <Link href={`/invoices/${id}`}>bill</Link>.
                </p>
              ) : (
                <>
                  <p className="case-amt" style={{ marginTop: 0 }}>{money(p.amount_cents)}</p>
                  <p className="small" style={{ marginTop: 4 }}>
                    To {payee ? `${payee.bank_name} ····${payee.last4}` : 'no account on file'}.
                    {payee?.requested_via === 'seed' ? ' This account has been on file from the start.' : ''}
                  </p>
                  <div className="row" style={{ marginTop: 10 }}>
                    {canPay && payee && (
                      <Hear
                        label="Hear this transfer"
                        text={transferSpeech({
                          supplier: String(sup?.name ?? 'Supplier'),
                          invoiceNumber: String(inv.invoice_number),
                          amount: money(p.amount_cents),
                          bank: String(payee.bank_name),
                          last4: String(payee.last4),
                        })}
                      />
                    )}
                    {!canPay && (
                      <Hear
                        label="Hear why it cannot pay"
                        text={blockedSpeech({
                          supplier: String(sup?.name ?? 'Supplier'),
                          invoiceNumber: String(inv.invoice_number),
                          amount: money(p.amount_cents),
                          reasons: [
                            ...reasons,
                            sameHands ? 'You proposed this. Someone else has to approve it.' : '',
                            overLimit ? `${money(p.amount_cents)} is over the owner limit.` : '',
                            readyExceptRole && !isOwner ? 'Only Dana can pay.' : '',
                          ].filter(Boolean),
                        })}
                      />
                    )}
                  </div>
                </>
              )}

              {p?.status === 'pending' && (
                <div className="stack" style={{ marginTop: 16 }}>
                  {reasons.length > 0 && (
                    <div className="notice hold" role="status">
                      <strong>Still blocking</strong>
                      <ul>{reasons.map(r => <li key={r}>{r}</li>)}</ul>
                      <Link href={`/invoices/${id}`}>Open the bill</Link>
                    </div>
                  )}
                  {sameHands && (
                    <div className="notice stop" role="status">You proposed this. Someone else has to approve it.</div>
                  )}
                  {overLimit && (
                    <div className="notice stop" role="status">
                      {money(p.amount_cents)} is over the owner limit of {money(limit?.limit_cents)}.
                    </div>
                  )}
                  {readyExceptRole && !isOwner && (
                    <div className="notice hold" role="status">
                      Only Dana can pay. Switch I am to Dana, Owner.
                    </div>
                  )}
                  {canPay && (
                    <>
                      <details
                        className="voice-opt"
                        onToggle={e => {
                          if (!(e.target as HTMLDetailsElement).open) {
                            setWantVoice(false);
                            setPayVoice('unclear');
                            setSpoken('');
                          }
                        }}
                      >
                        <summary>Confirm by voice (optional)</summary>
                        <Readback
                          invoiceId={id}
                          invoiceNumber={String(inv.invoice_number)}
                          supplier={String(sup?.name ?? 'Supplier')}
                          amount={money(p.amount_cents)}
                          bank={String(payee?.bank_name ?? 'the account on file')}
                          last4={String(payee?.last4 ?? '')}
                          onVerdict={(v, text) => {
                            setWantVoice(true);
                            setPayVoice(v);
                            setSpoken(text);
                          }}
                        />
                      </details>
                      <label className="f">Note for the record
                        <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" />
                      </label>
                      <div className="row">
                        <button className="btn" disabled={blocked}
                          onClick={async () => setResult(await call('approve_supplier_payment', {
                            proposal_id: p.id,
                            expected_fingerprint: latest?.fingerprint ?? '',
                            note: [note, spoken && `Spoken confirmation: “${spoken}”`].filter(Boolean).join(' '),
                          }))}>
                          Pay {money(p.amount_cents)}
                        </button>
                        <button className="btn danger" onClick={async () => setResult(await call('reject_supplier_payment', { proposal_id: p.id, note: note || 'Rejected by owner' }))}>
                          Don’t pay
                        </button>
                        <Link className="btn secondary" href={`/invoices/${id}`}>Back to the bill</Link>
                      </div>
                      {wantVoice && payVoice !== 'approve' && (
                        <p className="small muted">You started a voice check. Say “approve {payee?.last4}”, or close that panel to pay in writing.</p>
                      )}
                    </>
                  )}
                  {!canPay && (
                    <Link className="btn secondary" href={`/invoices/${id}`}>Back to the bill</Link>
                  )}
                </div>
              )}
              {result && (result.outcome === 'ok'
                ? <div className="notice ok" role="status">Approved. The money goes out once, and the books update. This demo bank is pretend money.</div>
                : <div className="notice stop" role="alert"><strong>Refused:</strong><ul>{reasonsOf(result.message).map(r => <li key={r}>{r}</li>)}</ul></div>)}
            </section>

            <Settlement t={t} inv={inv} proposalId={p?.id} />
          </div>

          <div className="stack">
            <section className="sheet pad" aria-labelledby="payee">
              <h2 id="payee">Who gets the money</h2>
              {payee ? (
                <p style={{ marginTop: 0 }}>{payee.bank_name} ····{payee.last4}<br />
                  <span className="small muted">{payee.requested_via === 'seed' ? 'On file from the start.' : `Checked by ${ROLE_LABEL[payee.verified_by_role]} with ${viaContact?.name ?? 'someone already on file'}.`}</span></p>
              ) : <p className="muted">No verified account on file.</p>}
            </section>

            <details className="sheet pad">
              <summary>More on this transfer</summary>
              {p && (
                <dl className="office-dl">
                  <div><dt>Bill</dt><dd>{inv.invoice_number}</dd></div>
                  <div><dt>Suggested by</dt><dd>{ROLE_LABEL[p.proposed_by_role]}, {when(p.created_at)}</dd></div>
                  {limit && <div><dt>Owner limit</dt><dd className="num">{money(limit.limit_cents)}</dd></div>}
                  <div><dt>Deposit applied</dt><dd className="num">{money(Number(ref.deposit_allocation_cents ?? 0))}</dd></div>
                </dl>
              )}
            </details>

            <section className="sheet pad" aria-labelledby="rcpt">
              <h2 id="rcpt">Delivery</h2>
              {atts.length ? atts.map(a => (
                <p key={a.id} className="small" style={{ marginTop: 0 }}><span className="chip ok">Confirmed</span><br />
                  {qty(a.quantity_milli, a.unit)}, {a.scope}. “{a.reason}” {ROLE_LABEL[a.attested_by_role]}, {when(a.created_at)}</p>
              )) : <p className="muted small" style={{ margin: 0 }}>Not confirmed. Payment stays blocked until someone on site confirms the delivery.</p>}
            </section>
          </div>
        </div>
      )}
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
    <details className="sheet pad">
      <summary>What left the account</summary>
      {pay && <p style={{ marginTop: 12 }}><span className={`st ${pay.status === 'sent' ? 'ok' : 'stop'}`}>{pay.status === 'sent' ? 'Paid' : 'Failed'}</span>{' '}
        {money(pay.amount_cents)}, {pay.nessie_transfer_id.includes('sim') ? 'simulated transfer' : 'transfer'} <code>{pay.nessie_transfer_id}</code>.</p>}
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
      <p className="small" style={{ marginBottom: 0 }}>Still owed on this bill: <strong>{money(net('accounts_payable'))}</strong>.</p>
    </details>
  );
}
