'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTables } from '@/lib/client';
import { money, day, ROLE_LABEL, HOLD_LABEL, HOLD_DETAIL, billStory, nextStep, daysUntil, dueWord } from '@/lib/format';
import { Loading } from '@/components/parts';
import { DueChart } from '@/components/DueChart';

export default function Bills() {
  const { data: t, error } = useTables(['invoice', 'invoice_revision', 'supplier', 'purchase', 'project', 'hold']);
  const [q, setQ] = useState('');
  const invoices = useMemo(() => [...(t?.invoice ?? [])].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)), [t]);
  const chartRows = useMemo(() => invoices.map(inv => ({
    name: inv.invoice_number,
    days: daysUntil(inv.due_date) ?? 0,
    paid: inv.payment_status === 'settled',
  })), [invoices]);
  if (!t) return <Loading error={error} />;

  const openHolds = t.hold.filter(h => h.status === 'open');
  const unpaid = invoices.filter(i => i.payment_status !== 'settled');
  const dueSoon = unpaid.filter(i => {
    const n = daysUntil(i.due_date);
    return n != null && n <= 14;
  });
  const paid = invoices.filter(i => i.payment_status === 'settled');
  const lessons = [...new Map(openHolds.map(h => [h.code, h])).values()];
  const featuredId = unpaid.find(i => openHolds.some(h => h.revision_id === i.active_revision_id))?.id;

  const shown = invoices.filter(inv => {
    if (!q.trim()) return true;
    const sup = t.supplier.find(s => s.id === inv.supplier_id);
    return `${sup?.name ?? ''} ${inv.invoice_number}`.toLowerCase().includes(q.trim().toLowerCase());
  });

  return (
    <div className="board">
      <div className="board-head">
        <div>
          <h1>Bills</h1>
          <p className="lede">Clear them before the due date.</p>
        </div>
        <input
          className="search"
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search a supplier or number"
          aria-label="Search bills"
        />
      </div>

      <div className="pipe">
        <div className="pipe-cell"><span>Need a person</span><b>{unpaid.length}</b></div>
        <div className="pipe-cell"><span>Due in 14 days</span><b>{dueSoon.length}</b></div>
        <div className="pipe-cell"><span>Cleared</span><b>{paid.length}</b></div>
      </div>

      {chartRows.length > 0 && (
        <section className="sheet pad">
          <div className="card-kicker">Timeline</div>
          <h2>Days left to clear</h2>
          <DueChart rows={chartRows} />
        </section>
      )}

      {shown.length === 0 ? (
        <div className="sheet empty">No bills match that.</div>
      ) : (
        <div className="tiles">
          {shown.map(inv => {
            const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
            const sup = t.supplier.find(s => s.id === inv.supplier_id);
            const pur = t.purchase.find(p => p.id === inv.purchase_id);
            const proj = t.project?.find(p => p.id === pur?.project_id);
            const holds = openHolds.filter(h => h.revision_id === inv.active_revision_id);
            const next = nextStep(inv, holds);
            const due = dueWord(inv.due_date);
            const featured = inv.id === featuredId;
            return (
              <Link key={inv.id} href={`/invoices/${inv.id}`} className={`tile${featured ? ' featured' : ''}`}>
                <div className="tile-top">
                  <div className="avatar">{(sup?.name ?? '?').slice(0, 1)}</div>
                  {inv.payment_status === 'settled'
                    ? <span className="chip ok">Cleared</span>
                    : <span className={`chip ${due.tone}`}>{due.label}</span>}
                </div>
                <div className="tile-name">{sup?.name ?? inv.supplier_id}</div>
                <div className="small muted">{inv.invoice_number} · {proj?.name ?? 'No job'}</div>
                <div className="tile-amt">{money(rev?.balance_requested_cents)}</div>
                <p className="tile-story">{billStory(inv, holds)}</p>
                <div className="tile-next">
                  {next.role ? `${ROLE_LABEL[next.role] ?? next.role} · ${next.action}` : next.action}
                </div>
              </Link>
            );
          })}

          <section className="tile lime">
            <div className="card-kicker">Learning</div>
            <h2>What we caught</h2>
            {lessons.length === 0 ? (
              <p className="small">Nothing is blocking.</p>
            ) : (
              <ul className="learn-list">
                {lessons.slice(0, 4).map(h => (
                  <li key={h.id}>
                    <strong>{HOLD_LABEL[h.code] ?? h.code}</strong>
                    <div className="small">{HOLD_DETAIL[h.code] ?? h.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
