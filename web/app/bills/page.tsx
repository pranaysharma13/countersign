'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTables } from '@/lib/client';
import { isSandbox, money, nextWho, HOLD_LABEL, HOLD_DETAIL, billStory, nextStep, daysUntil, dueWord } from '@/lib/format';
import { personaOf } from '@/lib/personas';
import { usePersona } from '@/lib/usePersona';
import { Loading } from '@/components/parts';
import { DueChart } from '@/components/DueChart';
import { Hear } from '@/components/Hear';
import { HonestStrip, useHonestSnap } from '@/components/Honest';
import { queueSpeech } from '@/lib/voice';

const TURN: Record<string, { title: string; lede: string; none: string }> = {
  owner: { title: 'Your turn', lede: 'Approve, reject, or record a review only you can record.', none: 'Nothing needs Dana right now.' },
  purchasing: { title: 'Your turn', lede: 'Send the supplier a correction on these bills.', none: 'No bill needs to go back to a supplier.' },
  receiver: { title: 'Your turn', lede: 'Confirm what arrived on Oakview.', none: 'Every delivery on these bills is confirmed.' },
  bookkeeper: { title: 'Every bill', lede: 'You can read everything. You cannot approve or pay.', none: 'No bills yet.' },
};

export default function Bills() {
  const { data: t, error } = useTables(['invoice', 'invoice_revision', 'supplier', 'purchase', 'project', 'hold', 'payee_profile']);
  const persona = usePersona();
  const honest = useHonestSnap();
  const [q, setQ] = useState('');
  const everything = useMemo(() => [...(t?.invoice ?? [])].sort((a, b) => (a.due_date < b.due_date ? -1 : 1)), [t]);
  const invoices = useMemo(() => everything.filter(i => !isSandbox(i)), [everything]);
  const chartRows = useMemo(() => invoices.map(inv => ({
    name: inv.invoice_number,
    days: daysUntil(inv.due_date) ?? 0,
    paid: inv.payment_status === 'settled',
  })), [invoices]);
  if (!t || !persona) return <Loading error={error} />;
  type Bill = (typeof invoices)[number];

  const unpaid = invoices.filter(i => i.payment_status !== 'settled');
  const unpaidRevs = new Set(everything.filter(i => i.payment_status !== 'settled').map(i => i.active_revision_id));
  const openHolds = t.hold.filter(h => h.status === 'open' && unpaidRevs.has(h.revision_id));
  const companyRevs = new Set(unpaid.map(i => i.active_revision_id));
  const holdsOf = (inv: Bill) => openHolds.filter(h => h.revision_id === inv.active_revision_id);
  const dueSoon = unpaid.filter(i => {
    const n = daysUntil(i.due_date);
    return n != null && n <= 14;
  });
  const paid = invoices.filter(i => i.payment_status === 'settled');
  const lessons = [...new Map(openHolds.filter(h => companyRevs.has(h.revision_id)).map(h => [h.code, h])).values()];
  const readOnly = persona === 'bookkeeper';
  const isMine = (inv: Bill) => readOnly || (inv.payment_status !== 'settled' && nextStep(inv, holdsOf(inv)).role === persona);
  const mineCount = unpaid.filter(isMine).length;
  const turn = TURN[persona] ?? TURN.owner;
  const me = personaOf(persona);

  const matches = (inv: Bill) => {
    if (!q.trim()) return true;
    const sup = t.supplier.find(s => s.id === inv.supplier_id);
    return `${sup?.name ?? ''} ${inv.invoice_number}`.toLowerCase().includes(q.trim().toLowerCase());
  };
  const shown = invoices.filter(matches);
  const sandbox = everything.filter(i => isSandbox(i) && matches(i));
  const mine = shown.filter(isMine);
  const others = shown.filter(inv => !isMine(inv));
  const featuredId = mine.find(i => holdsOf(i).length > 0)?.id;

  const tile = (inv: Bill) => {
    const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
    const sup = t.supplier.find(s => s.id === inv.supplier_id);
    const pur = t.purchase.find(p => p.id === inv.purchase_id);
    const proj = t.project?.find(p => p.id === pur?.project_id);
    const holds = holdsOf(inv);
    const next = nextStep(inv, holds);
    const due = dueWord(inv.due_date);
    const payee = (t.payee_profile ?? []).find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
    return (
      <Link
        key={inv.id}
        href={`/invoices/${inv.id}`}
        className={`tile${inv.id === featuredId ? ' featured' : ''}`}
        itemScope
        itemType="https://schema.org/Invoice"
        data-invoice-id={String(inv.id)}
        data-invoice-number={String(inv.invoice_number)}
        data-supplier={String(sup?.name ?? '')}
        data-cents={Number(rev?.balance_requested_cents) || 0}
        data-hold={holds[0] ? String(holds[0].code) : ''}
        data-next-role={next.role || ''}
        data-payment-status={String(inv.payment_status)}
        data-last4={payee ? String(payee.last4) : ''}
      >
        <div className="tile-top">
          <div className="avatar">{(sup?.name ?? '?').slice(0, 1)}</div>
          {inv.payment_status === 'settled'
            ? <span className="chip ok">Cleared</span>
            : <span className={`chip ${due.tone}`}>{due.label}</span>}
        </div>
        <div className="tile-name" itemProp="provider">{sup?.name ?? inv.supplier_id}</div>
        <div className="small muted"><span itemProp="identifier">{inv.invoice_number}</span> · {proj?.name ?? 'No job'}{payee ? ` · ····${payee.last4}` : ''}</div>
        <div className="tile-amt" itemProp="totalPaymentDue">{money(rev?.balance_requested_cents)}</div>
        <p className="tile-story">{billStory(inv, holds)}</p>
        <div className="tile-next">
          {next.role ? `${nextWho(next.role)} · ${next.action}` : next.action}
          {inv.payment_status !== 'settled' && (() => {
            const age = daysUntil(inv.invoice_date);
            return age != null && age < 0 ? ` · Waiting ${-age} day${age === -1 ? '' : 's'}` : '';
          })()}
        </div>
      </Link>
    );
  };

  return (
    <div className="board">
      <div className="board-head">
        <div>
          <h1>{me ? `${me.name.split(' ')[0]}’s bills` : 'Bills'}</h1>
          <p className="lede">{turn.lede}</p>
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Hear
            label="Hear my queue"
            text={queueSpeech(
              (persona === 'bookkeeper' ? unpaid.filter(matches) : mine.filter(i => i.payment_status !== 'settled'))
                .slice(0, 8)
                .map(inv => {
                  const next = nextStep(inv, holdsOf(inv));
                  const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
                  return {
                    supplier: String(t.supplier.find(s => s.id === inv.supplier_id)?.name ?? 'Supplier'),
                    number: String(inv.invoice_number),
                    who: next.role ? nextWho(next.role) : 'Someone',
                    action: next.action,
                    amount: money(rev?.balance_requested_cents),
                  };
                }),
              turn.none,
            )}
          />
          <input
            className="search"
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search a supplier or number"
            aria-label="Search bills"
          />
        </div>
      </div>

      {honest && <HonestStrip snap={honest} />}

      <div className="pipe">
        <div className="pipe-cell"><span>{readOnly ? 'Not paid yet' : 'Your turn'}</span><b>{readOnly ? unpaid.length : mineCount}</b></div>
        <div className="pipe-cell"><span>Due in 14 days</span><b>{dueSoon.length}</b></div>
        <div className="pipe-cell"><span>Cleared</span><b>{paid.length}</b></div>
      </div>

      {shown.length === 0 ? (
        <div className="sheet empty">No bills match that.</div>
      ) : (
        <>
          <h2 className="tiles-head">{turn.title}</h2>
          {mine.length === 0 ? <div className="sheet empty">{turn.none}</div> : <div className="tiles">{mine.map(tile)}</div>}
          {others.length > 0 && (
            <>
              <h2 className="tiles-head">Everything else</h2>
              <div className="tiles">{others.map(tile)}</div>
            </>
          )}
        </>
      )}

      {sandbox.length > 0 && (
        <>
          <h2 className="tiles-head">Judge sandbox ({sandbox.length})</h2>
          <p className="small muted" style={{ margin: 0 }}>Charges submitted on the Sneak page. Not the company&apos;s bills, so they are left out of the counts above and on the home page.</p>
          <div className="tiles">{sandbox.map(tile)}</div>
        </>
      )}

      {chartRows.length > 0 && (
        <section className="sheet pad">
          <div className="card-kicker">Timeline</div>
          <h2>Days left to clear</h2>
          <DueChart rows={chartRows} />
        </section>
      )}

      <section className="tile lime learn">
        <div className="card-kicker">Open holds</div>
        <h2>Why these bills stopped</h2>
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
  );
}
