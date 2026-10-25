'use client';
import Link from 'next/link';
import { useTables } from '@/lib/client';
import { money, day, ROLE_LABEL, billStory, nextStep } from '@/lib/format';
import { HoldChips, Loading } from '@/components/parts';

export default function WorkQueue() {
  const { data: t, error } = useTables(['invoice', 'invoice_revision', 'supplier', 'purchase', 'project', 'hold']);
  if (!t) return <Loading error={error} />;

  const invoices = [...(t.invoice ?? [])].sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  const openHolds = t.hold.filter(h => h.status === 'open');

  return (
    <div className="stack">
      <div className="head">
        <div>
          <h1>Bills</h1>
          <p className="lede">Who sent it, what they want, and what to do. Nothing is paid until the owner says so.</p>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="sheet empty">No bills yet.</div>
      ) : (
        <div className="bills">
          {invoices.map(inv => {
            const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
            const sup = t.supplier.find(s => s.id === inv.supplier_id);
            const pur = t.purchase.find(p => p.id === inv.purchase_id);
            const proj = t.project?.find(p => p.id === pur?.project_id);
            const holds = openHolds.filter(h => h.revision_id === inv.active_revision_id);
            const next = nextStep(inv, holds);
            return (
              <Link key={inv.id} href={`/invoices/${inv.id}`} className="bill">
                <header>
                  <div>
                    <strong>{sup?.name ?? inv.supplier_id}</strong>
                    <div className="small muted">
                      {inv.invoice_number}
                      {rev && rev.revision > 1 ? ` · revision ${rev.revision}` : ''}
                      {' · '}{proj?.name ?? 'No job'}
                      {' · due '}{day(inv.due_date)}
                    </div>
                  </div>
                  <div className="num amount">{money(rev?.balance_requested_cents)}</div>
                </header>
                <p className="story">{billStory(inv, holds)}</p>
                {holds.length > 0 && <div className="bill-holds"><HoldChips holds={holds} /></div>}
                <div className="next-plain">
                  {next.role
                    ? <><strong>{ROLE_LABEL[next.role] ?? next.role} — </strong>{next.action}</>
                    : next.action}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
