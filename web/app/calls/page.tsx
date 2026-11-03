'use client';
import Link from 'next/link';
import { DeskCall } from '@/components/DeskCall';
import { Loading } from '@/components/parts';
import { PayeeCall } from '@/components/PayeeCall';
import { VoiceRecord } from '@/components/VoiceRecord';
import { useTables, type Row, type Tables } from '@/lib/client';
import { isDeskHold } from '@/lib/deskCall';
import { HOLD_LABEL, isSandbox, money } from '@/lib/format';

function arOf(t: Tables, supplierId: unknown): Row | undefined {
  const rows = (t.supplier_contact ?? []).filter(c => c.supplier_id === supplierId && c.pre_established);
  return rows.find(c => /receivable/i.test(String(c.title ?? ''))) ?? rows[0];
}

export default function Calls() {
  const { data: t, error } = useTables([
    'invoice', 'invoice_revision', 'supplier', 'hold', 'payee_profile', 'supplier_contact',
  ]);
  if (!t) return <Loading error={error} />;

  const waitingBank = t.invoice.filter(inv => {
    const holds = t.hold.filter(h => h.status === 'open' && h.revision_id === inv.active_revision_id);
    return holds.some(h => h.code === 'PAYEE_CHANGE_PENDING');
  });
  const waitingDesk = t.invoice.filter(inv => {
    if (isSandbox(inv)) return false;
    const holds = t.hold.filter(h => h.status === 'open' && h.revision_id === inv.active_revision_id);
    return holds.some(h => isDeskHold(String(h.code)));
  });

  return (
    <div className="office">
      <header className="head">
        <div>
          <p className="card-kicker">Number on file only</p>
          <h1>Calls</h1>
          <p className="lede">
            Watch Clerk call a mock company about a hold, or pick up as the person on file for a new account.
            Clerk uses the number already on the quote. This screen cannot pay.
          </p>
        </div>
      </header>

      {waitingDesk.map(inv => {
        const sup = t.supplier.find(s => s.id === inv.supplier_id);
        const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
        const hold = t.hold.find(h => h.status === 'open' && h.revision_id === inv.active_revision_id && isDeskHold(String(h.code)));
        const ar = arOf(t, inv.supplier_id);
        if (!hold || !ar) return null;
        return (
          <section key={String(inv.id)} className="call-desk" data-invoice-id={String(inv.id)} data-hold={String(hold.code)}>
            <div className="call-desk-meta">
              <p className="card-kicker">Watch this call</p>
              <h2>{sup?.name ?? 'Supplier'}</h2>
              <p className="small muted">
                {inv.invoice_number} · {money(rev?.balance_requested_cents)} · {HOLD_LABEL[String(hold.code)] ?? 'Hold'}
                {' · '}<Link href={`/invoices/${inv.id}`}>Open the bill</Link>
              </p>
            </div>
            <DeskCall
              invoiceId={String(inv.id)}
              invoiceNumber={String(inv.invoice_number)}
              supplier={String(sup?.name ?? 'Supplier')}
              contactName={String(ar.name)}
              contactPhone={String(ar.phone ?? '')}
              holdCode={String(hold.code)}
              extraCents={Number(hold.amount_cents) || 0}
            />
          </section>
        );
      })}

      {waitingBank.map(inv => {
        const sup = t.supplier.find(s => s.id === inv.supplier_id);
        const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
        const pending = t.payee_profile.filter(p => p.supplier_id === inv.supplier_id && p.status === 'pending');
        const oldLast4 = String(t.payee_profile.find(p => p.supplier_id === inv.supplier_id && p.status === 'verified')?.last4 ?? '');
        const hold = t.hold.find(h => h.status === 'open' && h.revision_id === inv.active_revision_id && h.code === 'PAYEE_CHANGE_PENDING');
        return (
          <section key={String(inv.id)} className="call-desk" data-invoice-id={String(inv.id)} data-hold={hold ? String(hold.code) : ''}>
            <div className="call-desk-meta">
              <p className="card-kicker">You pick up</p>
              <h2>{sup?.name ?? 'Supplier'}</h2>
              <p className="small muted">
                {inv.invoice_number} · {money(rev?.balance_requested_cents)} · {HOLD_LABEL.PAYEE_CHANGE_PENDING}
                {' · '}<Link href={`/invoices/${inv.id}`}>Open the bill</Link>
              </p>
            </div>
            {pending.map(p => (
              <PayeeCall
                key={String(p.id)}
                invoiceId={String(inv.id)}
                invoiceNumber={String(inv.invoice_number)}
                supplier={String(sup?.name ?? 'Supplier')}
                oldLast4={oldLast4}
                profile={p}
                t={t}
              />
            ))}
            <VoiceRecord invoiceId={String(inv.id)} bare />
          </section>
        );
      })}

      {waitingDesk.length === 0 && waitingBank.length === 0 && (
        <section className="sheet pad">
          <p className="small muted" style={{ margin: 0 }}>Nothing is waiting on a call.</p>
        </section>
      )}

      <section className="sheet pad">
        <h2>How the mismatch call works</h2>
        <ol className="how-call">
          <li>Clerk dials the number already on the quote. Cartesia speaks. The other end is a mock company, not a real phone.</li>
          <li>They catch up, then the supplier tries to keep the extra: the old quote next month, waived fuel, a split.</li>
          <li>Clerk will not take a deal from the call. The hold stays until a credit or a revised invoice is on this bill.</li>
          <li>You watch the transcript. Clerk still cannot pay.</li>
        </ol>
      </section>
    </div>
  );
}
