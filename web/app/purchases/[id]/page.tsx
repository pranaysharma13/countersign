'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useTables, type Row, type Tables } from '@/lib/client';
import { money, day, ids, qty, ROLE_LABEL } from '@/lib/format';
import { Evidence, Loading, sourceOf } from '@/components/parts';
import { fileHref } from '@/lib/files';

const TABLES = ['purchase', 'supplier', 'supplier_contact', 'project', 'term', 'change_request', 'deposit', 'deposit_allocation',
  'document', 'source_file', 'source_fragment', 'email_message', 'authority', 'actor', 'invoice'];

const CLASS_WORD: Record<string, string> = {
  AUTHORISED_FIXED: 'Authorised', AUTHORISED_RATE_USAGE_MISSING: 'Rate authorised, usage unproven', PROPOSED: 'Only proposed',
  DECLINED: 'Declined', AMBIGUOUS: 'Unclear', UNRELATED: 'Unrelated',
};

export default function PurchaseRecord({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, error } = useTables(TABLES, 2000);
  if (!t) return <Loading error={error} />;
  const pur = t.purchase.find(p => p.id === id);
  if (!pur) return <div className="empty">No purchase {id}.</div>;
  const sup = t.supplier.find(s => s.id === pur.supplier_id);
  const proj = t.project.find(p => p.id === pur.project_id);
  const terms = t.term.filter(x => x.purchase_id === id && x.status === 'accepted');
  const changes = t.change_request.filter(c => c.purchase_id === id);
  const deposits = t.deposit.filter(d => d.purchase_id === id);
  const valid = terms.find(x => x.code === 'valid_through');
  const ack = t.source_fragment.find(f => f.document_id === pur.po_document_id && /acknowledged/i.test(f.text));

  return (
    <div className="stack">
      <div className="head">
        <div>
          <div className="small muted"><Link href="/">Work queue</Link> / {sup?.name}</div>
          <h1>{pur.po_number}: {pur.description}</h1>
          <p className="lede">{sup?.name} for {proj?.name ?? pur.project_id}. {valid ? `Prices fixed through ${day(valid.effective_to)}.` : ''}</p>
        </div>
        <div className="row">
          {t.invoice.filter(i => i.purchase_id === id).map(i => <Link key={i.id} className="btn secondary" href={`/invoices/${i.id}`}>Invoice {i.invoice_number}</Link>)}
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="sheet" aria-labelledby="terms">
            <div className="pad" style={{ paddingBottom: 0 }}><h2 id="terms">What was agreed</h2>
              <p className="small muted" style={{ marginTop: -4 }}>Accepted quote terms and the acknowledged PO. Each term cites its source.</p></div>
            <div className="scroll"><table>
              <thead><tr><th>Term</th><th>Agreed</th><th className="num">Amount</th></tr></thead>
              <tbody>{terms.map(x => (
                <tr key={x.id}><td><strong>{x.label}</strong><Evidence ids={ids(x.source_fragment_ids_json)} t={t} /></td>
                  <td className="small">{x.text}</td>
                  <td className="num">{x.amount_cents ? money(x.amount_cents) : x.quantity_milli ? qty(x.quantity_milli, pur.unit) : ''}</td></tr>
              ))}</tbody>
            </table></div>
            {ack && <p className="pad small" style={{ margin: 0 }}><span className="st ok">Supplier acknowledged the PO</span> “{ack.text}”</p>}
          </section>

          <section className="sheet" aria-labelledby="changes">
            <div className="pad" style={{ paddingBottom: 0 }}><h2 id="changes">Changes since</h2>
              <p className="small muted" style={{ marginTop: -4 }}>A proposal isn't an acceptance. A change counts only when a person approved it in the app, within their limit, and the supplier agreed.</p></div>
            <div className="scroll"><table>
              <thead><tr><th>Change</th><th className="num">Amount</th><th>Our approval</th><th>Supplier</th></tr></thead>
              <tbody>{changes.map(c => <ChangeRow key={c.id} c={c} t={t} />)}</tbody>
            </table></div>
          </section>

          <section className="sheet pad" aria-labelledby="dep">
            <h2 id="dep">Deposit</h2>
            {deposits.length === 0 && <p className="muted" style={{ margin: 0 }}>No deposit on this purchase.</p>}
            {deposits.map(d => {
              const used = t.deposit_allocation.filter(a => a.deposit_id === d.id);
              const left = d.amount_cents - used.reduce((s, a) => s + a.amount_cents, 0);
              return (
                <p key={d.id} style={{ margin: 0 }}>{money(d.amount_cents)} {d.status === 'settled' ? 'paid' : 'approved'} ({d.transfer_ref.includes('sim') ? 'simulated Nessie transfer' : d.transfer_ref}).{' '}
                  {used.length ? <>Applied to {used.map(a => t.invoice.find(i => i.id === a.invoice_id)?.invoice_number ?? a.invoice_id).join(', ')}; {money(left)} left.</> : 'Not yet applied to an invoice.'}</p>
              );
            })}
          </section>
        </div>

        <div className="stack">
          <section className="sheet pad" aria-labelledby="contacts">
            <h2 id="contacts">Supplier contacts on file</h2>
            {t.supplier_contact.filter(c => c.supplier_id === pur.supplier_id).map(c => (
              <p key={c.id} className="small" style={{ margin: '0 0 8px' }}><strong>{c.name}</strong>, {c.title}<br />{c.email} · {c.phone}
                {c.pre_established && <><br /><span className="muted">On file before any dispute: usable to verify bank changes</span></>}</p>
            ))}
          </section>
          <Sources pur={pur} t={t} />
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ c, t }: { c: Row; t: Tables }) {
  const approver = t.actor.find(a => a.identity === c.decided_by_identity);
  const auth = t.authority.find(a => a.identity === c.decided_by_identity);
  const amount = c.rate_cents ? `${money(c.rate_cents)}/${c.rate_unit}` : money(c.amount_cents);
  return (
    <tr>
      <td><strong>{c.description}</strong> <span className="small muted">({CLASS_WORD[c.classification] ?? c.classification})</span>
        <Evidence ids={[...ids(c.source_fragment_ids_json), ...ids(c.supplier_acceptance_fragment_ids_json)]} t={t} /></td>
      <td className="num">{amount}</td>
      <td className="small">{c.internal_status === 'approved'
        ? <><span className="st ok">Approved</span><br />{approver?.display_name ?? ROLE_LABEL[c.decided_by_role]}, {ROLE_LABEL[c.decided_by_role]?.toLowerCase()}{auth ? `, within a ${money(auth.limit_cents)} limit` : ''}</>
        : c.internal_status === 'rejected' ? <span className="st stop">Rejected</span> : <span className="st idle">Not approved</span>}</td>
      <td className="small">{c.supplier_acceptance === 'accepted' ? <span className="st ok">Accepted in writing</span>
        : c.supplier_acceptance === 'declined' ? <span className="st stop">Declined</span>
          : c.supplier_acceptance === 'proposed' ? <span className="st hold">Proposed by supplier</span> : <span className="st idle">No agreement</span>}</td>
    </tr>
  );
}

/** Source viewer: every document and its quoted fragments, exactly as stored (immutable). */
function Sources({ pur, t }: { pur: Row; t: Tables }) {
  const docIds = [pur.quote_document_id, pur.po_document_id, ...t.email_message.map(e => e.document_id)].filter(Boolean);
  const docs = docIds.map(d => t.document.find(x => x.id === d)).filter(Boolean) as Row[];
  const [open, setOpen] = useState<string | null>(docs[0]?.id ?? null);
  return (
    <section className="sheet pad" aria-labelledby="src">
      <h2 id="src">Source documents</h2>
      {docs.map(d => (
        <div key={d.id} style={{ borderTop: '1px solid var(--rule-2)', padding: '8px 0' }}>
          <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 13 }} aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>
            {d.filename}
          </button>
          <span className="small muted"> {d.kind}</span>
          {fileHref(d.source_file_id) && <> · <a href={fileHref(d.source_file_id)!} target="_blank" rel="noreferrer">Open file</a></>}
          {open === d.id && t.source_fragment.filter(f => f.document_id === d.id).map(f => (
            <blockquote key={f.id} className="quote">“{f.text}”<div className="src">{sourceOf(f, t)}</div></blockquote>
          ))}
        </div>
      ))}
    </section>
  );
}
