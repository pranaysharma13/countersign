'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, call, newId, type Row, type Tables, type CallResult } from '@/lib/client';
import { money, day, time, ids, HOLD_LABEL, HOLD_DETAIL, ROLE_LABEL, nextWho, assessmentLines, billStory, nextStep, safeReason, ceilingCopy, ceilingFacts, plainTerms, lineWhy, type AssessmentLine } from '@/lib/format';
import { StatusStrip, Evidence, Loading, Outcome, sourceOf, ReceiptForm } from '@/components/parts';
import { Papers } from '@/components/Stationery';
import { DeskCall } from '@/components/DeskCall';
import { PayeeCall } from '@/components/PayeeCall';
import { VoiceRecord } from '@/components/VoiceRecord';
import { Hear } from '@/components/Hear';
import { TrustCase } from '@/components/Trust';
import { billTrust } from '@/lib/trust';
import { billSpeech, letterSpeech } from '@/lib/voice';
import { auditHref } from '@/lib/files';
import { fromGmail } from '@/lib/mail';
import { isDeskHold } from '@/lib/deskCall';
import { usePersona } from '@/lib/usePersona';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact', 'purchase',
  'project', 'document', 'source_file', 'source_fragment', 'email_message', 'outbox', 'agent_step', 'audit_log', 'receipt_attestation',
  'change_request', 'proposal', 'settlement_decision', 'job', 'payee_profile', 'payment', 'ledger_line', 'request_result',
  'extraction_run', 'term', 'payment_approval'];
const ACTION_WORDS: Record<string, string> = {
  record_invoice: 'recorded the invoice', record_invoice_revision: 'recorded a revision', record_invoice_line: 'recorded a line',
  set_work_item_state: 'updated the case', open_hold: 'opened a hold', resolve_hold: 'cleared a hold', record_assessment: 'assessed the invoice',
  draft_outbox: 'drafted a clarification', approve_outbox: 'approved sending the clarification', mark_outbox: 'delivered the clarification',
  attest_receipt: 'confirmed receipt', propose_supplier_payment: 'proposed a payment', approve_supplier_payment: 'approved the payment',
  reject_supplier_payment: 'rejected the payment', start_payment: 'started the payment', record_payment: 'recorded the payment',
  decide_payee_profile: 'decided a bank change', add_payee_profile: 'recorded a bank change request', enqueue_job: 'queued work',
  claim_job: 'picked up work', finish_job: 'finished work',
};
const OWNER_RESOLVABLE = ['DUPLICATE_REVIEW', 'EXTRACTION_REVIEW', 'CONTRACT_REVIEW', 'PROMPT_INJECTION', 'SUPPLIER_RISK'];
const MONEY_HOLD = ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING'];

export default function InvoiceCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, mode, error } = useTables(TABLES);
  const persona = usePersona();
  if (!t) return <Loading error={error} />;
  const inv = t.invoice.find(i => i.id === id);
  if (!inv) return <div className="empty">No bill {id}. Check the <Link href="/bills">bills list</Link>.</div>;

  const revs = t.invoice_revision.filter(r => r.invoice_id === id).sort((a, b) => a.revision - b.revision);
  const rev = revs.find(r => r.id === inv.active_revision_id);
  const sup = t.supplier.find(s => s.id === inv.supplier_id);
  const pur = t.purchase.find(p => p.id === inv.purchase_id);
  const assessment = t.assessment.filter(a => a.revision_id === rev?.id).sort((a, b) => b.version - a.version)[0];
  const holds = t.hold.filter(h => h.revision_id === rev?.id && h.status === 'open');
  const next = nextStep(inv, holds);
  const pendingPayees = (t.payee_profile ?? []).filter(x => x.supplier_id === inv.supplier_id && x.status === 'pending');
  const oldLast4 = String((t.payee_profile ?? []).find(x => x.supplier_id === inv.supplier_id && x.status === 'verified')?.last4 ?? '');
  const bankHold = holds.some(h => h.code === 'PAYEE_CHANGE_PENDING')
    || pendingPayees.length > 0
    || inv.payee_status === 'change_pending'
    || inv.payee_status === 'unverified';
  const receiptHold = holds.some(h => h.code === 'RECEIPT_NOT_VERIFIED') || inv.receipt_status === 'required';
  const drafts = t.outbox.filter(o => o.invoice_id === id);

  return (
    <div
      className="stack"
      itemScope
      itemType="https://schema.org/Invoice"
      data-invoice-id={String(inv.id)}
      data-invoice-number={String(inv.invoice_number)}
      data-supplier={String(sup?.name ?? '')}
      data-cents={Number(rev?.balance_requested_cents) || 0}
      data-hold={holds[0] ? String(holds[0].code) : ''}
      data-next-role={next.role || ''}
      data-payment-status={String(inv.payment_status)}
    >
      <div className="head">
        <div>
          <div className="small muted"><Link href="/bills">Bills</Link> · <span itemProp="identifier">{inv.invoice_number}</span></div>
          <h1 itemProp="provider">{sup?.name ?? 'Supplier'}</h1>
          <p className="lede">{billStory(inv, holds)}</p>
          <div className="case-amt" itemProp="totalPaymentDue">{money(rev?.balance_requested_cents)}</div>
          <p className="small muted" style={{ marginTop: 6 }}>
            {pur ? <>Order <Link href={`/purchases/${pur.id}`}>{pur.po_number}</Link>. </> : 'No purchase order. '}
            Dated {day(inv.invoice_date)}, due {day(inv.due_date)}.{rev && rev.revision > 1 ? ` Revision ${rev.revision} is the one that counts.` : ''}
          </p>
        </div>
        <div className="row">
          <a className="btn secondary" href={auditHref(inv.id)} download>Download audit</a>
          {inv.payment_status === 'settled' ? null
            : bankHold
              ? <a className="btn" href="#next">Call about the new account</a>
              : holds.some(h => isDeskHold(String(h.code)))
                ? <a className="btn" href="#desk-call">Call the supplier</a>
              : holds.length > 0
                ? <a className="btn" href="#next">What to do next</a>
                : <Link className="btn" href={`/invoices/${id}/approve`}>Pay this bill</Link>}
        </div>
      </div>

      <StatusStrip inv={inv} />

      <NextCard
        inv={inv}
        holds={holds}
        next={next}
        persona={persona}
        drafts={drafts}
        t={t}
        assessment={assessment}
      />

      {holds.filter(h => isDeskHold(String(h.code))).slice(0, 1).map(h => {
        const rows = (t.supplier_contact ?? []).filter(c => c.supplier_id === inv.supplier_id && c.pre_established);
        const ar = rows.find(c => /receivable/i.test(String(c.title ?? ''))) ?? rows[0];
        if (!ar) return null;
        return (
          <DeskCall
            key={String(h.id)}
            invoiceId={String(inv.id)}
            invoiceNumber={String(inv.invoice_number)}
            supplier={String(sup?.name ?? 'Supplier')}
            contactName={String(ar.name)}
            contactPhone={String(ar.phone ?? '')}
            holdCode={String(h.code)}
            extraCents={Number(h.amount_cents) || 0}
          />
        );
      })}

      {bankHold && pendingPayees.map(p => (
        <PayeeCall
          key={p.id}
          invoiceId={String(inv.id)}
          invoiceNumber={String(inv.invoice_number)}
          supplier={String(sup?.name ?? 'Supplier')}
          oldLast4={oldLast4}
          profile={p}
          t={t}
        />
      ))}

      {receiptHold && <ReceiptForm inv={inv} rev={rev} t={t} />}

      <TrustCase bill={billTrust(t, inv)} />

      <div className="split">
        <div className="stack">
          {assessment ? <Reconciliation a={assessment} rev={rev!} holds={holds} /> : <div className="sheet pad muted">Still checking this bill.</div>}
          {assessment && <Ledger a={assessment} holds={holds} t={t} />}
          <Holds holds={holds} t={t} />
          <DisputedLines inv={inv} a={assessment} t={t} persona={persona} />
          <Revisions revs={revs} active={inv.active_revision_id} t={t} />
        </div>
        <div className="stack">
          <Clarifications inv={inv} t={t} mode={mode} />
          <VoiceRecord invoiceId={id} />
          <Thread inv={inv} sup={sup} pur={pur} t={t} />
          <details className="sheet pad activity">
            <summary>Activity</summary>
            <AgentSteps wi={`wi_${id}`} t={t} />
            <Timeline inv={inv} revs={revs} t={t} />
          </details>
        </div>
      </div>

      <Papers
        docs={[
          t.document.find(d => d.id === rev?.document_id),
          t.document.find(d => d.id === pur?.po_document_id),
          t.document.find(d => d.id === pur?.quote_document_id),
        ].filter(Boolean) as Row[]}
        t={t}
        inv={inv}
        rev={rev}
        pur={pur}
      />
    </div>
  );
}

function extraAsk(hold: Row): string {
  const amt = money(hold.amount_cents);
  if (hold.code === 'PROPOSED_CHARGE') {
    return `Please send a revised invoice without the extra ${amt}, or a written agreement for that charge. We will not pay the extra from this bill unless we accept it in the app.`;
  }
  return `Please send a revised invoice at the agreed price. The extra ${amt} is not agreed.`;
}

function NextCard({
  inv, holds, next, persona, drafts, t, assessment,
}: {
  inv: Row; holds: Row[]; next: { role: string; action: string }; persona: string | null;
  drafts: Row[]; t: Tables; assessment?: Row;
}) {
  const [result, setResult] = useState<CallResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  if (inv.payment_status === 'settled') return null;
  const ceiling = holds.find(h => h.code === 'PO_CEILING');
  const extra = holds.find(h => h.code === 'PROPOSED_CHARGE' || h.code === 'PRICE_VARIANCE');
  const reviewHold = holds.find(h => OWNER_RESOLVABLE.includes(String(h.code)));
  const facts = ceiling ? ceilingFacts(ceiling.evidence_json) : null;
  const draft = drafts.find(o => o.status === 'draft');
  const sent = drafts.find(o => o.status === 'sent' || o.status === 'approved');
  const who = nextWho(next.role);
  const yours = !!next.role && persona === next.role;
  const extraAmt = extra ? Number(extra.amount_cents) || 0 : 0;
  const asked = assessment ? Number(assessment.claimed_cents) || 0 : 0;
  const agreed = extraAmt > 0 && asked > extraAmt ? asked - extraAmt : (assessment ? Number(assessment.authorised_cents) || 0 : 0);
  const ask = facts
    ? `Please send a corrected invoice for ${facts.cap} at the agreed price, or a written change for the extra ${facts.extra} (${money(ceiling?.amount_cents)}). We will not pay the extra from this bill.`
    : extra ? extraAsk(extra) : next.action;
  const needLetter = !!(ceiling || extra);
  const contacts = t.supplier_contact.filter(c => c.supplier_id === inv.supplier_id);
  const ar = contacts.find(c => /receivable/i.test(String(c.title))) ?? contacts[0];
  const mail = ar?.email
    ? `mailto:${ar.email}?subject=${encodeURIComponent(`${inv.invoice_number}: this bill does not match the order`)}&body=${encodeURIComponent(ask)}`
    : '';
  const reviewedHidden = (t.hold ?? []).some(h =>
    h.revision_id === inv.active_revision_id && h.code === 'PROMPT_INJECTION' && h.status !== 'open');

  async function sendDraft() {
    if (!draft) return;
    setResult(await call('approve_outbox', { id: draft.id }));
  }

  async function copyAsk() {
    try {
      await navigator.clipboard.writeText(ask);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function recordReview() {
    if (!reviewHold) return;
    setResult(await call('resolve_hold', { id: reviewHold.id, note }));
  }

  return (
    <section className={`next-card${yours ? ' yours' : ''}`} id="next" aria-labelledby="next-title">
      <p className="card-kicker">{yours ? 'Your turn' : 'Waiting on someone'}</p>
      <h2 id="next-title">{who}: {next.action}</h2>
      <div className="row" style={{ margin: '8px 0 4px' }}>
        <Hear
          label="Hear this bill"
          text={billSpeech({
            supplier: String(t.supplier.find(s => s.id === inv.supplier_id)?.name ?? 'Supplier'),
            invoiceNumber: String(inv.invoice_number),
            story: billStory(inv, holds),
            who,
            action: next.action,
            math: facts && ceiling
              ? `Order allows ${facts.cap}. This bill is ${facts.billed}. Cannot pay ${money(ceiling.amount_cents)}.`
              : extra && extraAmt > 0
                ? `Matches the order ${money(agreed)}. They added ${money(extraAmt)}, not agreed.`
                : '',
          })}
        />
      </div>
      {facts && ceiling && (
        <div className="next-math" aria-label="Order versus this bill">
          <div><span>Order allows</span><b>{facts.cap}</b></div>
          <div><span>This bill</span><b>{facts.billed}</b></div>
          <div className="hold"><span>Cannot pay</span><b>{money(ceiling.amount_cents)}</b></div>
        </div>
      )}
      {extra && extraAmt > 0 && (
        <div className="next-math" aria-label="Agreed versus extra">
          <div><span>Matches the order</span><b>{money(agreed)}</b></div>
          <div><span>They added</span><b>{money(extraAmt)}</b></div>
          <div className="hold"><span>Not agreed</span><b>{money(extraAmt)}</b></div>
        </div>
      )}
      {ceiling && (
        <p className="small" style={{ marginTop: 0 }}>
          The extra {facts?.extra ?? 'quantity'} needs a corrected invoice or a written change.
          Dana cannot accept a quantity over the order from this screen.
        </p>
      )}
      {extra && (
        <p className="small" style={{ marginTop: 0 }}>
          Buyer asks for a corrected invoice. If they will not correct it, Dana decides each{' '}
          <a href="#disputed">disputed line</a>.
        </p>
      )}
      {holds.some(h => h.code === 'RECEIPT_NOT_VERIFIED') && (
        <p className="small" style={{ marginTop: 0 }}>Confirm the delivery in the form below. That is the only thing that clears this.</p>
      )}
      {holds.some(h => h.code === 'PAYEE_CHANGE_PENDING') && (
        <p className="small" style={{ marginTop: 0 }}>Call the number already on file. Do not use a number from the email that asked for the change.</p>
      )}
      {reviewedHidden && !holds.some(h => h.code === 'PROMPT_INJECTION') && (
        <p className="small" style={{ marginTop: 0 }}>
          A hidden instruction on this invoice was treated as printed text and ignored. The amounts still match the order.
        </p>
      )}
      {draft && !sent && (
        <div className="stack" style={{ marginTop: 12 }}>
          <details className="ask-box">
            <summary><strong className="small">{draft.subject}</strong></summary>
            <p className="small" style={{ margin: '6px 0 0' }}>{draft.body}</p>
          </details>
          <div className="row">
            <Hear label="Hear the letter" text={letterSpeech(String(draft.subject), String(draft.body))} />
            {(persona === 'purchasing' || persona === 'owner') ? (
              <button className="btn" type="button" onClick={sendDraft}>Send this to the supplier</button>
            ) : (
              <p className="small">Switch I am to Buyer to send this letter.</p>
            )}
          </div>
        </div>
      )}
      {sent && <p className="small">A letter was already sent. Waiting on the supplier.</p>}
      {needLetter && !draft && !sent && (
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="small" style={{ margin: 0 }}>
            Clerk has no letter queued to send from here. Buyer emails the supplier.
            {ar?.email ? ` ${ar.email}` : ''}
          </p>
          <div className="ask-box">{ask}</div>
          <div className="row">
            <Hear label="Hear the ask" text={ask} />
            {mail && <a className="btn" href={mail}>Open in email</a>}
            <button className={mail ? 'btn secondary' : 'btn'} type="button" onClick={copyAsk}>{copied ? 'Copied' : 'Copy the words'}</button>
            {persona !== 'purchasing' && <p className="small muted" style={{ margin: 0 }}>Switch I am to Buyer when you send it.</p>}
          </div>
        </div>
      )}
      {reviewHold && persona !== 'owner' && (
        <p className="small">Only Dana can record this review. Switch I am to Dana, Owner.</p>
      )}
      {reviewHold && persona === 'owner' && (
        <form className="row" style={{ marginTop: 12 }} onSubmit={e => { e.preventDefault(); void recordReview(); }}>
          <input
            type="text"
            placeholder={reviewHold.code === 'PROMPT_INJECTION' ? 'What you reviewed (required)' : 'Why you are clearing this (required)'}
            value={note}
            aria-label="Review note"
            onChange={e => setNote(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="btn" type="submit" disabled={!note.trim()}>
            {reviewHold.code === 'PROMPT_INJECTION' ? 'Record review' : 'Clear this hold'}
          </button>
        </form>
      )}
      {next.role === 'owner' && next.action === 'Pay this bill.' && (
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="btn" href={`/invoices/${inv.id}/approve`}>Pay this bill</Link>
        </div>
      )}
      <Outcome r={result} />
    </section>
  );
}

function Reconciliation({ a, rev, holds }: { a: Row; rev: Row; holds: Row[] }) {
  const over = holds.find(h => h.code === 'PO_CEILING');
  const overAmt = over ? Number(over.amount_cents) || 0 : 0;
  const review = a.variance_cents + a.pending_cents + overAmt;
  const accepted = Math.max(0, a.authorised_cents - overAmt);
  let conditional = 0;
  try { conditional = Number(JSON.parse(a.details_json || '{}').conditional_payment_cents) || 0; } catch { conditional = 0; }
  const heldForCorrection = a.proposed_payment_cents === 0 && review > 0;
  return (
    <section className="sheet pad" aria-labelledby="recon">
      <h2 id="recon">This bill</h2>
      <div className="scroll">
        <table>
          <tbody>
            <tr><td>They asked for</td><td className="num">{money(a.claimed_cents)}</td></tr>
            <tr><td>Not agreed yet {review > 0 && <span className="muted small">(we do not pay this unless someone accepts it)</span>}</td>
              <td className="num" style={{ color: review > 0 ? 'var(--hold)' : undefined }}>{review > 0 ? `− ${money(review)}` : money(0)}</td></tr>
            <tr><td><strong>Matches the order</strong></td><td className="num"><strong>{money(accepted)}</strong></td></tr>
            {a.deposit_available_cents > 0 && (
              <tr><td>Deposit already paid</td><td className="num">− {money(a.deposit_available_cents)}</td></tr>
            )}
            {heldForCorrection ? (
              <>
                <tr><td><strong>Pay now</strong> <span className="muted small">(we never pay part of a bill without the supplier agreeing)</span></td>
                  <td className="num"><strong>{money(0)}</strong></td></tr>
                <tr><td>Pay once they send a corrected invoice or agreed credit</td><td className="num">{money(conditional)}</td></tr>
              </>
            ) : (
              <tr><td><strong>Ready to pay once nothing is blocking</strong></td><td className="num"><strong>{money(a.proposed_payment_cents)}</strong></td></tr>
            )}
            <tr><td className="muted small">Balance they asked us to send</td><td className="num muted small">{money(rev.balance_requested_cents)}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ledger({ a, holds, t }: { a: Row; holds: Row[]; t: Tables }) {
  const lines = assessmentLines(a.details_json);
  const over = holds.find(h => h.code === 'PO_CEILING');
  const total = (k: 'claimed_cents' | 'accepted_cents' | 'pending_cents' | 'variance_cents') =>
    lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  return (
    <section className="sheet" aria-labelledby="lines">
      <div className="pad" style={{ paddingBottom: 0 }}>
        <h2 id="lines">Line items</h2>
      </div>
      <div className="scroll">
        <table className="ledger">
          <thead><tr><th>Line</th><th className="num">They asked</th><th className="num">We accept</th><th className="num">Not agreed</th><th></th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const review = (l.variance_cents ?? 0) + l.pending_cents;
              const overAmt = over && l.status === 'accepted' ? Number(over.amount_cents) : 0;
              const notAgreed = review || overAmt;
              return (
                <tr key={i} className={notAgreed ? 'under' : ''}>
                  <td className="desc">
                    <strong>{l.line}</strong>
                    {over && overAmt > 0 && <div className="calc">{ceilingCopy(over.evidence_json, over.reason)}</div>}
                    <WhyFold line={l} t={t} />
                  </td>
                  <td className="num">{money(l.claimed_cents)}</td>
                  <td className="num">{money(l.accepted_cents)}</td>
                  <td className="num" style={{ color: notAgreed ? 'var(--hold)' : undefined }}>{notAgreed ? money(notAgreed) : '-'}</td>
                  <td>{overAmt > 0 ? <span className="st hold">Over the order</span>
                    : l.status === 'accepted' ? <span className="st ok">OK</span>
                      : l.status === 'pending' ? <span className="st hold">Waiting</span>
                        : <span className="st hold">Not agreed</span>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{money(total('claimed_cents'))}</td><td className="num">{money(total('accepted_cents'))}</td>
            <td className="num">{money(total('pending_cents') + total('variance_cents') + (over ? Number(over.amount_cents) : 0))}</td><td /></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

function Holds({ holds, t }: { holds: Row[]; t: Tables }) {
  return (
    <section className="sheet pad" aria-labelledby="holds">
      <h2 id="holds">What's blocking payment</h2>
      {holds.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing is blocking. Each hold clears on its own. Clearing one never clears another.</p>}
      <div className="hold-list">
        {holds.map(h => {
          const injection = h.code === 'PROMPT_INJECTION';
          const frags = ids(h.evidence_json).map(id => t.source_fragment.find(f => f.id === id)).filter(Boolean) as Row[];
          const src = frags[0] ? sourceOf(frags[0], t) : '';
          return (
            <div key={h.id} className={injection ? 'finding' : 'hold-item'}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className={`chip ${injection || h.code === 'PAYEE_CHANGE_PENDING' ? 'stop' : ''}`}>{HOLD_LABEL[h.code] ?? h.code}</span>
                {h.amount_cents > 0 && <span className="num small">{money(h.amount_cents)}</span>}
              </div>
              <p className="hold-copy">
                {HOLD_DETAIL[h.code] ?? plainTerms(h.reason)}
              </p>
              {injection && (
                <p className="hold-src">Found on {src || 'the invoice'}. The instruction was not followed.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** §9.9: when the supplier won't correct the invoice, the owner decides each disputed line. Never pays short silently:
 * "pay agreed" drafts a notice to the supplier, and payment waits until it's sent. */
function DisputedLines({ inv, a, t, persona }: { inv: Row; a?: Row; t: Tables; persona: string | null }) {
  const [note, setNote] = useState<Record<string, string>>({});
  const [to, setTo] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CallResult | null>(null);
  if (!a) return null;
  const decisions = (t.settlement_decision ?? []).filter(d => d.invoice_id === inv.id && d.status === 'active');
  let raw: unknown[] = [];
  try { const d = JSON.parse(a.details_json || '{}'); raw = Array.isArray(d?.lines) ? d.lines : []; } catch { raw = []; }
  const cents = (v: unknown) => Number(v) || 0;
  const disputed = raw.map(l => (l && typeof l === 'object' ? l as Row : {}))
    .filter(l => MONEY_HOLD.includes(String(l.hold_code)) && cents(l.pending_cents) + cents(l.variance_cents) > 0);
  if (!disputed.length && !decisions.length) return null;
  const contacts = t.supplier_contact.filter(c => c.supplier_id === inv.supplier_id);
  const ar = contacts.find(c => /receivable/i.test(String(c.title))) ?? contacts[0];
  const stillOpen = decisions.filter(d => d.decision === 'pay_agreed_dispute_rest').reduce((s, d) => s + cents(d.amount_cents), 0);
  const decide = async (l: Row, decision: string) => {
    const id = String(l.line_id);
    setResult(await call('decide_disputed_line', {
      id: newId('dec'), invoice_line_id: id, decision, amount_cents: cents(l.pending_cents) + cents(l.variance_cents),
      expected_fingerprint: a.fingerprint, to_contact_id: decision === 'pay_agreed_dispute_rest' ? (to[id] || ar?.id || '') : '',
      note: note[id] ?? '',
    }));
  };
  return (
    <section className="sheet pad" aria-labelledby="disputed">
      <h2 id="disputed">If they will not correct a price or extra</h2>
      <p className="small" style={{ marginTop: 0 }}>
        Only Dana can accept the extra or dispute it. Buyer sends the correction letter above.
        A quantity over the purchase order is not decided here. That needs a corrected invoice.
      </p>
      {persona !== 'owner' && (
        <p className="small">You are not Dana. Switch I am to Dana, Owner to accept or dispute a line.</p>
      )}
      {disputed.map(l => {
        const id = String(l.line_id);
        const d = decisions.find(x => x.invoice_line_id === id);
        const amount = cents(l.pending_cents) + cents(l.variance_cents);
        const notice = d ? t.outbox.find(o => o.id === d.outbox_id) : undefined;
        return (
          <div key={id} className="hold-item">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>{String(l.description ?? id)}</span>
              <span className="num small">{money(amount)} disputed</span>
            </div>
            {d ? (
              <p className="small" style={{ marginBottom: 0 }}>
                Paying the agreed part; {money(amount)} stays open. Notice to the supplier:{' '}
                {notice ? (notice.status === 'sent' ? 'sent (simulated)' : notice.status === 'draft' ? 'draft: send it below' : notice.status) : 'none'}.
              </p>
            ) : persona === 'owner' ? (
              <form className="stack" style={{ marginTop: 10 }} onSubmit={e => e.preventDefault()}>
                <input type="text" placeholder="Why (required, stays internal)" value={note[id] ?? ''} style={{ width: '100%' }}
                  aria-label={`Note for ${String(l.description ?? id)}`} onChange={e => setNote({ ...note, [id]: e.target.value })} />
                <label className="f small">Send the notice to
                  <select value={to[id] || ar?.id || ''} onChange={e => setTo({ ...to, [id]: e.target.value })}>
                    {contacts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
                  </select>
                </label>
                <div className="row">
                  <button className="btn secondary" type="button" disabled={!(note[id] ?? '').trim()} onClick={() => decide(l, 'accept_as_billed')}>Accept as billed</button>
                  <button className="btn" type="button" disabled={!(note[id] ?? '').trim()} onClick={() => decide(l, 'pay_agreed_dispute_rest')}>Pay agreed, dispute the rest</button>
                </div>
              </form>
            ) : (
              <p className="small muted" style={{ marginBottom: 0 }}>Dana decides this line. Buyer’s job is the letter at the top.</p>
            )}
          </div>
        );
      })}
      {decisions.filter(d => d.decision === 'accept_as_billed').map(d => (
        <p key={d.id} className="small muted" style={{ marginBottom: 0 }}>Accepted as billed: {money(cents(d.amount_cents))} ({d.note}).</p>
      ))}
      {stillOpen > 0 && <p style={{ marginBottom: 0 }}><strong>Still open: {money(stillOpen)}</strong> until they correct the invoice or agree a credit.</p>}
      <Outcome r={result} />
    </section>
  );
}

function WhyFold({ line, t }: { line: AssessmentLine; t: Tables }) {
  const copy = lineWhy(line);
  if (!copy && !line.fragment_ids.length) return null;
  return (
    <details className="why-fold">
      <summary>Why</summary>
      <div className="why-open">
        {copy && <p>{copy}</p>}
        {line.fragment_ids.length > 0 && (
          <div className="why-papers">
            <div className="why-kicker">On the papers</div>
            <Evidence ids={line.fragment_ids} t={t} />
          </div>
        )}
      </div>
    </details>
  );
}

function Revisions({ revs, active, t }: { revs: Row[]; active: string; t: Tables }) {
  if (revs.length < 2) return null;
  return (
    <section className="sheet pad" aria-labelledby="revs">
      <h2 id="revs">Revisions</h2>
      <p className="small" style={{ marginTop: 0 }}>The original claim is kept. A corrected invoice replaces it only for payment.</p>
      <table>
        <thead><tr><th>Revision</th><th className="num">Gross</th><th className="num">Balance requested</th><th>Status</th></tr></thead>
        <tbody>{revs.map(r => (
          <tr key={r.id}><td>{r.revision}{r.id === active ? ' (active)' : ''}{fromGmail(t, r.document_id) && <> <span className="chip idle">From Gmail</span></>}</td><td className="num">{money(r.gross_cents)}</td>
            <td className="num">{money(r.balance_requested_cents)}</td>
            <td>{r.status === 'active' ? <span className="st ok">Active</span> : <span className="st idle">Superseded, kept on record</span>}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function Clarifications({ inv, t, mode }: { inv: Row; t: Tables; mode: string | null }) {
  const drafts = t.outbox.filter(o => o.invoice_id === inv.id);
  const [result, setResult] = useState<CallResult | null>(null);
  if (!drafts.length) return null;
  return (
    <section className="sheet pad" aria-labelledby="clar">
      <h2 id="clar">Message to the supplier</h2>
      {drafts.map(o => (
        <div key={o.id} className="mail">
          <div className="meta"><span>To {o.to_address}</span>
            <span>{o.status === 'draft' ? 'Draft' : o.status === 'approved' ? 'Sending' : o.status === 'sent' ? 'Sent' : 'Failed'}{o.simulated ? ' · simulated delivery' : ''}</span></div>
          <strong className="small">{o.subject}</strong>
          <p className="small">{o.body}</p>
          {o.status === 'draft' && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={async () => setResult(await call('approve_outbox', { id: o.id }))}>Send to supplier</button>
              <span className="small muted">Clerk wrote this draft. Only purchasing or the owner can send it.</span>
            </div>
          )}
        </div>
      ))}
      {mode === 'local' && <p className="small muted" style={{ marginBottom: 0 }}>In this demo, BayMix's reply is simulated.</p>}
      <Outcome r={result} />
    </section>
  );
}

function Thread({ inv, sup, pur, t }: { inv: Row; sup?: Row; pur?: Row; t: Tables }) {
  const domain = String(sup?.email_domain || '').toLowerCase();
  const contactMail = new Set(t.supplier_contact.filter(c => c.supplier_id === inv.supplier_id).map(c => c.email.toLowerCase()));
  const ownDocs = new Set(
    [pur?.quote_document_id, pur?.po_document_id, ...t.invoice_revision.filter(r => r.invoice_id === inv.id).map(r => r.document_id)]
      .filter(Boolean) as string[],
  );
  const mails = t.email_message.filter(m => {
    const from = String(m.from_address || '').toLowerCase();
    const to = String(m.to_addresses || '').toLowerCase();
    if (ownDocs.has(m.document_id)) return true;
    if (domain && (from.endsWith(`@${domain}`) || to.includes(`@${domain}`))) return true;
    return [...contactMail].some(addr => from === addr || to.includes(addr));
  }).sort((a, b) => (a.original_sent_at_iso < b.original_sent_at_iso ? -1 : 1));
  if (!mails.length) return null;
  return (
    <section className="sheet pad" aria-labelledby="mail">
      <h2 id="mail">Emails about {pur ? 'this purchase' : 'this supplier'}</h2>
      {mails.map(m => {
        const frag = t.source_fragment.find(f => f.id === m.body_fragment_id);
        return (
          <div key={m.id} className="mail">
            <div className="meta"><span>{m.from_address}{m.from_address.endsWith('@marlowfinch.example') ? ' (our team)' : m.from_known_contact ? '' : ' (not a contact on file)'}</span><span>{day(m.original_sent_at_iso)}</span></div>
            <strong className="small">{m.subject}</strong>{fromGmail(t, m.document_id) && <> <span className="chip idle">From Gmail</span></>}
            <p className="small">{frag?.text}</p>
          </div>
        );
      })}
    </section>
  );
}

function AgentSteps({ wi, t }: { wi: string; t: Tables }) {
  const steps = t.agent_step.filter(s => s.work_item_id === wi).sort((a, b) => a.id - b.id);
  if (!steps.length) return null;
  return (
    <section aria-labelledby="steps">
      <h2 id="steps">What Clerk did</h2>
      <ol className="timeline">
        {steps.map(s => (
          <li key={s.id}><span className="t">{time(s.at)}</span>
            <span className={s.kind === 'error' ? 'denied' : ''}>{s.kind === 'tool_call' ? <code>{s.title}</code> : String(s.title).replace(/\s*\(simulated outbox, waiting for a person to send it\)/, '. Waiting for someone to send it (simulated delivery).')}</span></li>
        ))}
      </ol>
    </section>
  );
}

function Timeline({ inv, revs, t }: { inv: Row; revs: Row[]; t: Tables }) {
  const related = new Set<string>([inv.id, `wi_${inv.id}`, ...revs.map(r => r.id),
    ...t.hold.filter(h => revs.some(r => r.id === h.revision_id)).map(h => h.id),
    ...t.outbox.filter(o => o.invoice_id === inv.id).map(o => o.id),
    ...t.proposal.filter(p => p.work_item_id === `wi_${inv.id}`).map(p => p.id),
    ...t.receipt_attestation.filter(a => a.invoice_id === inv.id).map(a => a.id)]);
  const byEvent = new Map<string, Row>();
  t.audit_log.filter(a => related.has(a.entity_id)).forEach(a => {
    const key = `${a.at}|${a.action}|${a.actor_role}|${a.outcome}`;
    const prev = byEvent.get(key);
    if (!prev || (!prev.reason && a.reason)) byEvent.set(key, a);
  });
  const rows = [...byEvent.values()].sort((a, b) => b.id - a.id).slice(0, 30);
  return (
    <section aria-labelledby="audit">
      <h2 id="audit">Record</h2>
      <p className="small muted" style={{ marginTop: -4 }}>Every change and every refused attempt, newest first.</p>
      <ol className="timeline">
        {rows.map(a => (
          <li key={a.id}><span className="t">{time(a.at)}</span>
            <span className={a.outcome === 'denied' ? 'denied' : ''}>
              <strong>{ROLE_LABEL[a.actor_role] ?? a.actor_role}</strong> {ACTION_WORDS[a.action] ?? a.action.replaceAll('_', ' ')}
              {a.outcome === 'denied' ? `, refused: ${safeReason(a.reason)}` : a.reason ? `: ${plainTerms(safeReason(a.reason))}` : ''}
            </span></li>
        ))}
      </ol>
    </section>
  );
}
