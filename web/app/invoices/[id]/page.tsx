'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, call, type Row, type Tables, type CallResult } from '@/lib/client';
import { money, day, time, ids, HOLD_LABEL, HOLD_DETAIL, ROLE_LABEL, assessmentLines, billStory, nextStep } from '@/lib/format';
import { StatusStrip, Evidence, Loading, Outcome } from '@/components/parts';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact', 'purchase',
  'project', 'document', 'source_file', 'source_fragment', 'email_message', 'outbox', 'agent_step', 'audit_log', 'receipt_attestation',
  'change_request', 'proposal'];
const ACTION_WORDS: Record<string, string> = {
  record_invoice: 'recorded the invoice', record_invoice_revision: 'recorded a revision', record_invoice_line: 'recorded a line',
  set_work_item_state: 'updated the case', open_hold: 'opened a hold', resolve_hold: 'cleared a hold', record_assessment: 'assessed the invoice',
  draft_outbox: 'drafted a clarification', approve_outbox: 'approved sending the clarification', mark_outbox: 'delivered the clarification',
  attest_receipt: 'confirmed receipt', propose_supplier_payment: 'proposed a payment', approve_supplier_payment: 'approved the payment',
  reject_supplier_payment: 'rejected the payment', start_payment: 'started the payment', record_payment: 'recorded the payment',
  decide_payee_profile: 'decided a bank change', add_payee_profile: 'recorded a bank change request', enqueue_job: 'queued work',
  claim_job: 'picked up work', finish_job: 'finished work',
};
const OWNER_RESOLVABLE = ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING', 'DUPLICATE_REVIEW',
  'EXTRACTION_REVIEW', 'CONTRACT_REVIEW', 'PROMPT_INJECTION', 'SUPPLIER_RISK'];

export default function InvoiceCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, mode, error } = useTables(TABLES);
  if (!t) return <Loading error={error} />;
  const inv = t.invoice.find(i => i.id === id);
  if (!inv) return <div className="empty">No bill {id}. Check the <Link href="/">bills list</Link>.</div>;

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
          <div className="small muted"><Link href="/">Bills</Link> / {sup?.name}</div>
          <h1>{sup?.name} · {inv.invoice_number}</h1>
          <p className="lede">{billStory(inv, holds)}</p>
          <p className="small muted" style={{ marginTop: 6 }}>
            {pur ? <>Order <Link href={`/purchases/${pur.id}`}>{pur.po_number}</Link>. </> : 'No purchase order. '}
            Dated {day(inv.invoice_date)}, due {day(inv.due_date)}.{rev && rev.revision > 1 ? ` Revision ${rev.revision} is the one that counts.` : ''}
          </p>
        </div>
        <div className="row">
          <Link className="btn" href={`/invoices/${id}/approve`}>Pay or reject</Link>
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
          {assessment ? <Reconciliation a={assessment} rev={rev!} /> : <div className="sheet pad muted">Still checking this bill.</div>}
          {assessment && <Ledger a={assessment} t={t} />}
          <Holds holds={holds} t={t} />
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
    </div>
  );
}

function Reconciliation({ a, rev }: { a: Row; rev: Row }) {
  const review = a.variance_cents + a.pending_cents;
  const accepted = a.authorised_cents;
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
            <tr><td>Deposit already paid</td><td className="num">− {money(a.deposit_available_cents)}</td></tr>
            <tr><td><strong>Ready to pay if nothing is blocking</strong></td><td className="num"><strong>{money(a.proposed_payment_cents)}</strong></td></tr>
            <tr><td className="muted small">Balance they asked us to send</td><td className="num muted small">{money(rev.balance_requested_cents)}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ledger({ a, t }: { a: Row; t: Tables }) {
  const lines = assessmentLines(a.details_json);
  const total = (k: 'claimed_cents' | 'accepted_cents' | 'pending_cents' | 'variance_cents') =>
    lines.reduce((s, l) => s + (Number(l[k]) || 0), 0);
  return (
    <section className="sheet" aria-labelledby="lines">
      <div className="pad" style={{ paddingBottom: 0 }}>
        <h2 id="lines">Each line</h2>
        <p className="small muted" style={{ marginTop: -4 }}>Click a source to read the exact words on the document.</p>
      </div>
      <div className="scroll">
        <table className="ledger">
          <thead><tr><th>Line</th><th className="num">They asked</th><th className="num">We accept</th><th className="num">Not agreed</th><th></th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const review = (l.variance_cents ?? 0) + l.pending_cents;
              return (
                <tr key={i} className={l.status === 'under_review' ? 'under' : l.status === 'pending' ? 'pending' : ''}>
                  <td className="desc">
                    <strong>{l.line}</strong>
                    <div className="calc">{l.calculation}</div>
                    {l.uncertainty && <div className="calc"><em>{l.uncertainty}</em></div>}
                    <Evidence ids={l.fragment_ids} t={t} />
                  </td>
                  <td className="num">{money(l.claimed_cents)}</td>
                  <td className="num">{money(l.accepted_cents)}</td>
                  <td className="num" style={{ color: review ? 'var(--hold)' : undefined }}>{review ? money(review) : '—'}</td>
                  <td>{l.status === 'accepted' ? <span className="st ok">OK</span>
                    : l.status === 'pending' ? <span className="st hold">Waiting</span>
                      : <span className="st hold">Not agreed</span>}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{money(total('claimed_cents'))}</td><td className="num">{money(total('accepted_cents'))}</td>
            <td className="num">{money(total('pending_cents') + total('variance_cents'))}</td><td /></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

function Holds({ holds, t }: { holds: Row[]; t: Tables }) {
  const [note, setNote] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CallResult | null>(null);
  return (
    <section className="sheet pad" aria-labelledby="holds">
      <h2 id="holds">What's blocking payment</h2>
      {holds.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing. Each block clears on its own — clearing one never clears another.</p>}
      {holds.map(h => (
        <div key={h.id} style={{ padding: '10px 0', borderTop: '1px solid var(--rule-2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className={`chip ${h.code === 'PAYEE_CHANGE_PENDING' ? 'stop' : ''}`}>{HOLD_LABEL[h.code] ?? h.code}</span>
            {h.amount_cents > 0 && <span className="num small">{money(h.amount_cents)}</span>}
          </div>
          <div className="small" style={{ marginTop: 4 }}>{HOLD_DETAIL[h.code] ?? h.reason}</div>
          <Evidence ids={ids(h.evidence_json)} t={t} />
          {OWNER_RESOLVABLE.includes(h.code) ? (
            <form className="row" style={{ marginTop: 8 }} onSubmit={async e => {
              e.preventDefault();
              setResult(await call('resolve_hold', { id: h.id, note: note[h.id] ?? '' }));
            }}>
              <input type="text" placeholder="Why you're allowing this (required)" value={note[h.id] ?? ''} aria-label={`Note for ${h.code}`}
                onChange={e => setNote({ ...note, [h.id]: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
              <button className="btn secondary" type="submit" disabled={!(note[h.id] ?? '').trim()}>Allow this (owner)</button>
            </form>
          ) : (
            <div className="small muted" style={{ marginTop: 6 }}>
              {h.code === 'RECEIPT_NOT_VERIFIED' ? 'Clears when someone on site confirms the delivery.'
                : h.code === 'PAYEE_CHANGE_PENDING' ? 'Clears when the owner calls a number already on file — never a number from the request.'
                  : 'The owner has to allow this, in writing, here.'}
            </div>
          )}
        </div>
      ))}
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
              <button className="btn" onClick={async () => setResult(await call('approve_outbox', { id: o.id }))}>Send to supplier (purchasing)</button>
              <span className="small muted">Countersign writes the draft. A person sends it.</span>
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
            <span className={s.kind === 'error' ? 'denied' : ''}>{s.kind === 'tool_call' ? <code>{s.title}</code> : s.title}</span></li>
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
  const rows = t.audit_log.filter(a => related.has(a.entity_id)).sort((a, b) => b.id - a.id).slice(0, 30);
  return (
    <section aria-labelledby="audit">
      <h2 id="audit">Record</h2>
      <p className="small muted" style={{ marginTop: -4 }}>Every change and every refused attempt, newest first.</p>
      <ol className="timeline">
        {rows.map(a => (
          <li key={a.id}><span className="t">{time(a.at)}</span>
            <span className={a.outcome === 'denied' ? 'denied' : ''}>
              <strong>{ROLE_LABEL[a.actor_role] ?? a.actor_role}</strong> {ACTION_WORDS[a.action] ?? a.action.replaceAll('_', ' ')}
              {a.outcome === 'denied' ? `, refused: ${a.reason}` : a.reason ? `: ${a.reason}` : ''}
            </span></li>
        ))}
      </ol>
    </section>
  );
}
