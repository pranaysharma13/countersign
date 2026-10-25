'use client';
import { useRouter } from 'next/navigation';
import { useTables } from '@/lib/client';
import { money, day, ROLE_LABEL } from '@/lib/format';
import { Status, HoldChips, Loading } from '@/components/parts';

export default function WorkQueue() {
  const router = useRouter();
  const { data: t, mode, error } = useTables(['invoice', 'invoice_revision', 'supplier', 'purchase', 'project', 'hold', 'extraction_run']);
  if (!t) return <Loading error={error} />;

  const invoices = [...(t.invoice ?? [])].sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const openHolds = t.hold.filter(h => h.status === 'open');

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Work queue</h1>
          <p className="lede">Every supplier invoice, checked against what was agreed. Nothing is paid without the owner's approval.</p>
        </div>
      </div>

      <div className="sheet scroll">
        {invoices.length === 0 ? (
          <div className="empty">No supplier invoices yet. New invoices appear here as soon as intake receives them.</div>
        ) : (
          <table className="queue">
            <thead>
              <tr>
                <th>Invoice</th><th className="num">Balance requested</th><th>Due</th>
                <th>Commercial</th><th>Receipt</th><th>Payee</th><th>Approval</th><th>Payment</th>
                <th>Open holds</th><th>Next</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => {
                const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
                const sup = t.supplier.find(s => s.id === inv.supplier_id);
                const pur = t.purchase.find(p => p.id === inv.purchase_id);
                const proj = t.project?.find(p => p.id === pur?.project_id);
                const run = t.extraction_run.find(e => e.document_id === rev?.document_id);
                const holds = openHolds.filter(h => h.revision_id === inv.active_revision_id);
                return (
                  <tr key={inv.id} className="link" tabIndex={0} onClick={() => router.push(`/invoices/${inv.id}`)}
                    onKeyDown={e => e.key === 'Enter' && router.push(`/invoices/${inv.id}`)}>
                    <td>
                      <strong>{sup?.name ?? inv.supplier_id}</strong>
                      <div className="small">{inv.invoice_number}{rev && rev.revision > 1 ? ` (revision ${rev.revision})` : ''} · {proj?.name ?? pur?.project_id ?? 'No project'}</div>
                      <div className="row small" style={{ gap: 4, marginTop: 4 }}>
                        {run && <span className="tag">{run.mode === 'live' ? 'Read live by Claude' : 'Fixture extraction'}</span>}
                        {mode === 'local' && <span className="tag">Simulated</span>}
                      </div>
                    </td>
                    <td className="num">{money(rev?.balance_requested_cents)}</td>
                    <td className="small">{day(inv.due_date)}</td>
                    <td><Status kind="commercial" value={inv.commercial_status} /></td>
                    <td><Status kind="receipt" value={inv.receipt_status} /></td>
                    <td><Status kind="payee" value={inv.payee_status} /></td>
                    <td><Status kind="approval" value={inv.approval_status} /></td>
                    <td><Status kind="payment" value={inv.payment_status} /></td>
                    <td><HoldChips holds={holds} /></td>
                    <td className="small"><strong>{ROLE_LABEL[inv.next_owner_role] ?? inv.next_owner_role}</strong><div>{inv.next_action}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
