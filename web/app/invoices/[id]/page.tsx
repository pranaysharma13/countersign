'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, call, newId, type Row, type Tables, type CallResult } from '@/lib/client';
import { money, day, time, ids, HOLD_LABEL, HOLD_DETAIL, ROLE_LABEL, assessmentLines, billStory, nextStep, safeReason, ceilingCopy, plainCalc, plainTerms } from '@/lib/format';
import { StatusStrip, Evidence, Loading, Outcome, sourceOf } from '@/components/parts';
import { Papers } from '@/components/Stationery';
import { auditHref } from '@/lib/files';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact', 'purchase',
  'project', 'document', 'source_file', 'source_fragment', 'email_message', 'outbox', 'agent_step', 'audit_log', 'receipt_attestation',
  'change_request', 'proposal', 'settlement_decision'];
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

  return (
    <div className="stack">
      <div className="head">
        <div>
          <div className="small muted"><Link href="/bills">Bills</Link> · {inv.invoice_number}</div>
          <h1>{sup?.name ?? 'Supplier'}</h1>
          <p className="lede">{billStory(inv, holds)}</p>
          <div className="case-amt">{money(rev?.balance_requested_cents)}</div>
          <p className="small muted" style={{ marginTop: 6 }}>
            {pur ? <>Order <Link href={`/purchases/${pur.id}`}>{pur.po_number}</Link>. </> : 'No purchase order. '}
            Dated {day(inv.invoice_date)}, due {day(inv.due_date)}.{rev && rev.revision > 1 ? ` Revision ${rev.revision} is the one that counts.` : ''}
          </p>
        </div>
        <div className="row">
          <a className="btn secondary" href={auditHref(inv.id)} download>Download audit</a>
          {inv.payment_status === 'settled' ? null
            : holds.length > 0
              ? <a className="btn" href="#holds">Review what's blocking</a>
              : <Link className="btn" href={`/invoices/${id}/approve`}>Review payment</Link>}
        </div>
      </div>

      <StatusStrip inv={inv} />
      <p className="next">
        {next.role
          ? <><strong>{ROLE_LABEL[next.role] ?? next.role} — </strong>{next.action}</>
          : next.action}
      </p>

      <div className="split">
        <div className="stack">
          {assessment ? <Reconciliation a={assessment} rev={rev!} holds={holds} /> : <div className="sheet pad muted">Still checking this bill.</div>}
          {assessment && <Ledger a={assessment} holds={holds} t={t} />}
          <Holds holds={holds} inv={inv} pur={pur} t={t} />
          <DisputedLines inv={inv} a={assessment} t={t} />
          <Revisions revs={revs} active={inv.active_revision_id} />
        </div>
        <div className="stack">
          <Clarifications inv={inv} t={t} mode={mode} />
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
        <p className="small muted" style={{ marginTop: -4 }}>Open a source to read the page of the document.</p>
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
                    {l.calculation && <div className="calc">{plainCalc(l.calculation)}</div>}
                    {over && overAmt > 0 && <div className="calc">{ceilingCopy(over.evidence_json, over.reason)}</div>}
                    {l.uncertainty && <div className="calc">{plainTerms(l.uncertainty)}</div>}
                    <Evidence ids={l.fragment_ids} t={t} />
                  </td>
                  <td className="num">{money(l.claimed_cents)}</td>
                  <td className="num">{money(l.accepted_cents)}</td>
                  <td className="num" style={{ color: notAgreed ? 'var(--hold)' : undefined }}>{notAgreed ? money(notAgreed) : '—'}</td>
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

function Holds({ holds, inv, pur, t }: { holds: Row[]; inv: Row; pur?: Row; t: Tables }) {
  const [note, setNote] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CallResult | null>(null);
  return (
    <section className="sheet pad" aria-labelledby="holds">
      <h2 id="holds">What's blocking payment</h2>
      {holds.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing is blocking. Each block clears on its own — clearing one never clears another.</p>}
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
                {h.code === 'PO_CEILING'
                  ? ceilingCopy(h.evidence_json, h.reason || HOLD_DETAIL[h.code])
                  : (HOLD_DETAIL[h.code] ?? plainTerms(h.reason))}
              </p>
              {injection ? (
                <p className="hold-src">
                  Found on {src || 'the invoice'}. The instruction was not followed.
                </p>
              ) : h.code === 'PO_CEILING' ? (
                <p className="hold-src">
                  {h.reason}
                  {pur?.po_document_id || inv.active_revision_id ? ' Compare the purchase order and this invoice in Documents.' : ''}
                </p>
              ) : (
                <Evidence ids={ids(h.evidence_json)} t={t} />
              )}
              {OWNER_RESOLVABLE.includes(h.code) ? (
                <form className="row" style={{ marginTop: 12 }} onSubmit={async e => {
                  e.preventDefault();
                  setResult(await call('resolve_hold', { id: h.id, note: note[h.id] ?? '' }));
                }}>
                  <input
                    type="text"
                    placeholder={injection ? 'What you reviewed (required)' : 'Why you are clearing this (required)'}
                    value={note[h.id] ?? ''}
                    aria-label={injection ? 'Review note' : `Note for ${HOLD_LABEL[h.code] ?? h.code}`}
                    onChange={e => setNote({ ...note, [h.id]: e.target.value })}
                    style={{ flex: 1, minWidth: 200 }}
                  />
                  <button className="btn secondary" type="submit" disabled={!(note[h.id] ?? '').trim()}>
                    {injection ? 'Record review' : 'Clear this hold'}
                  </button>
                </form>
              ) : (
                <div className="small muted" style={{ marginTop: 8 }}>
                  {h.code === 'RECEIPT_NOT_VERIFIED' ? 'Clears when someone on site confirms the delivery.'
                    : h.code === 'PAYEE_CHANGE_PENDING' ? 'Clears when the owner calls a number already on file — never a number from the request.'
                      : MONEY_HOLD.includes(h.code) ? 'Ask the supplier for a corrected invoice, or the owner decides each disputed line below. This cannot be waved from here.'
                        : 'This stays open until the matching event happens.'}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Outcome r={result} />
    </section>
  );
}

/** §9.9: when the supplier won't correct the invoice, the owner decides each disputed line. Never pays short silently:
 * "pay agreed" drafts a notice to the supplier, and payment waits until it's sent. */
function DisputedLines({ inv, a, t }: { inv: Row; a?: Row; t: Tables }) {
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
      <h2 id="disputed">If they won&apos;t correct it</h2>
      <p className="small" style={{ marginTop: 0 }}>
        The owner decides each disputed line. Accepting pays it as billed, within your limit. Paying the agreed part drafts a
        notice to the supplier; nothing is paid until it&apos;s sent, and the rest stays open.
      </p>
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
                {notice ? (notice.status === 'sent' ? 'sent (simulated)' : notice.status === 'draft' ? 'draft — send it below' : notice.status) : 'none'}.
              </p>
            ) : (
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

function Revisions({ revs, active }: { revs: Row[]; active: string }) {
  if (revs.length < 2) return null;
  return (
    <section className="sheet pad" aria-labelledby="revs">
      <h2 id="revs">Revisions</h2>
      <p className="small" style={{ marginTop: 0 }}>The original claim is kept. A corrected invoice replaces it only for payment.</p>
      <table>
        <thead><tr><th>Revision</th><th className="num">Gross</th><th className="num">Balance requested</th><th>Status</th></tr></thead>
        <tbody>{revs.map(r => (
          <tr key={r.id}><td>{r.revision}{r.id === active ? ' (active)' : ''}</td><td className="num">{money(r.gross_cents)}</td>
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
              <span className="small muted">Countersign wrote this draft. Only purchasing or the owner can send it.</span>
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
            <strong className="small">{m.subject}</strong>
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
      <h2 id="steps">What Countersign did</h2>
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
