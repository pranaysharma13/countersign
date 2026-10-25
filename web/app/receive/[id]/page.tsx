'use client';
import Link from 'next/link';
import { use } from 'react';
import { useTables } from '@/lib/client';
import { qty, ROLE_LABEL } from '@/lib/format';
import { Loading, ReceiptForm, Status } from '@/components/parts';

const TABLES = ['invoice', 'invoice_revision', 'invoice_line', 'receipt_attestation', 'supplier', 'purchase', 'hold'];

export default function Receive({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: t, error } = useTables(TABLES);
  if (!t) return <Loading error={error} />;
  const inv = t.invoice.find(i => i.id === id);
  if (!inv) return <div className="empty">No invoice {id}. Check the <Link href="/">work queue</Link>.</div>;
  const rev = t.invoice_revision.find(r => r.id === inv.active_revision_id);
  const sup = t.supplier.find(s => s.id === inv.supplier_id);
  const material = t.invoice_line.filter(l => l.revision_id === rev?.id && l.kind === 'material');
  const billed = material.reduce((s, l) => s + l.quantity_milli, 0);

  return (
    <div className="stack receive">
      <div className="head">
        <div>
          <div className="small muted"><Link href={`/invoices/${id}`}>{sup?.name} · {inv.invoice_number}</Link></div>
          <h1>Confirm receipt</h1>
          <p className="lede">
            For the superintendent on site. This is a signed statement, labeled manually confirmed.
            Countersign cannot prove what was delivered.
            {billed > 0 && <> Billed on this invoice: <strong>{qty(billed, material[0]?.unit ?? 'cy')}</strong>.</>}
          </p>
        </div>
        <Status kind="receipt" value={inv.receipt_status} />
      </div>
      <p className="next"><strong>Acting as {ROLE_LABEL.receiver}.</strong> Switch the demo persona to Luis Ortega before confirming.</p>
      <ReceiptForm inv={inv} rev={rev} t={t} />
    </div>
  );
}
