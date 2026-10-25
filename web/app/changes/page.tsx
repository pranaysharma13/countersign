'use client';
import Link from 'next/link';
import { useState } from 'react';
import { call, useTables, type CallResult, type Row } from '@/lib/client';
import { money, ids, ROLE_LABEL } from '@/lib/format';
import { Evidence, Loading, Outcome } from '@/components/parts';

const TABLES = ['change_request', 'purchase', 'supplier', 'actor', 'authority', 'source_fragment', 'document', 'email_message', 'source_file'];
const CLASS_WORD: Record<string, string> = {
  AUTHORISED_FIXED: 'Authorised', AUTHORISED_RATE_USAGE_MISSING: 'Rate authorised, usage unproven',
  PROPOSED: 'Only proposed', DECLINED: 'Declined', AMBIGUOUS: 'Unclear', UNRELATED: 'Unrelated',
};

export default function Changes() {
  const { data: t, error } = useTables(TABLES);
  if (!t) return <Loading error={error} />;
  const pending = t.change_request.filter(c => c.internal_status === 'pending');
  const decided = t.change_request.filter(c => c.internal_status !== 'pending');

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Price or extra-work asks</h1>
          <p className="lede">The buyer decides these here, within their limit. An email that says “approved” does not count. The person who asked cannot decide their own ask.</p>
        </div>
      </div>
      <section className="sheet" aria-labelledby="open">
        <div className="pad" style={{ paddingBottom: 0 }}><h2 id="open">Waiting for a decision</h2></div>
        {pending.length === 0 ? <p className="pad muted">None. The weekend delivery on MF-PO-1031 is already decided.</p> : (
          <div className="pad stack">{pending.map(c => <Decide key={c.id} c={c} t={t} />)}</div>
        )}
      </section>
      <section className="sheet" aria-labelledby="done">
        <div className="pad" style={{ paddingBottom: 0 }}><h2 id="done">Already decided</h2></div>
        <div className="scroll"><table>
          <thead><tr><th>Change</th><th className="num">Amount</th><th>Our decision</th><th>Supplier</th></tr></thead>
          <tbody>{decided.map(c => {
            const pur = t.purchase.find(p => p.id === c.purchase_id);
            const sup = t.supplier.find(s => s.id === pur?.supplier_id);
            const who = t.actor.find(a => a.identity === c.decided_by_identity);
            const auth = t.authority.find(a => a.identity === c.decided_by_identity);
            return (
              <tr key={c.id}>
                <td><strong>{c.description}</strong>
                  <div className="small muted">{sup?.name} · <Link href={`/purchases/${pur?.id}`}>{pur?.po_number}</Link> · {CLASS_WORD[c.classification] ?? c.classification}</div>
                  <Evidence ids={ids(c.source_fragment_ids_json)} t={t} />
                </td>
                <td className="num">{c.rate_cents ? `${money(c.rate_cents)}/${c.rate_unit}` : money(c.amount_cents)}</td>
                <td className="small">{c.internal_status === 'approved' ? <span className="st ok">Approved</span> : <span className="st stop">Rejected</span>}
                  <div>{who?.display_name ?? ROLE_LABEL[c.decided_by_role]}{auth ? `, ${money(auth.limit_cents)} limit` : ''}</div></td>
                <td className="small">{c.supplier_acceptance === 'accepted' ? <span className="st ok">Accepted</span>
                  : c.supplier_acceptance === 'declined' ? <span className="st stop">Declined</span> : <span className="st idle">No agreement</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>
    </div>
  );
}

function Decide({ c, t }: { c: Row; t: Record<string, Row[]> }) {
  const [note, setNote] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);
  const pur = t.purchase.find(p => p.id === c.purchase_id);
  return (
    <div>
      <div>
        <p style={{ margin: 0 }}><strong>{c.description}</strong> · {c.rate_cents ? `${money(c.rate_cents)}/${c.rate_unit}` : money(c.amount_cents)}</p>
        <div className="small muted">{pur?.po_number} · {CLASS_WORD[c.classification] ?? c.classification}</div>
      </div>
      <Evidence ids={ids(c.source_fragment_ids_json)} t={t} />
      <form className="row" style={{ marginTop: 8 }} onSubmit={e => e.preventDefault()}>
        <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Note for the record" aria-label="Note" style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" type="button" onClick={async () => setResult(await call('decide_change_request', { id: c.id, approve: true, note }))}>Approve (purchasing)</button>
        <button className="btn danger" type="button" onClick={async () => setResult(await call('decide_change_request', { id: c.id, approve: false, note: note || 'Rejected' }))}>Reject</button>
      </form>
      <Outcome r={result} />
    </div>
  );
}
