'use client';
import { useState } from 'react';
import { call, newId, type CallResult, type Row, type Tables } from '@/lib/client';
import { day, HOLD_LABEL, qty, ROLE_LABEL, when } from '@/lib/format';
import { fileHref } from '@/lib/files';

type Tone = 'ok' | 'hold' | 'stop' | 'idle' | 'act';
const STATUS: Record<string, Record<string, [string, Tone]>> = {
  commercial: {
    pending: ['Being checked', 'idle'], matches: ['Matches what was agreed', 'ok'],
    differences_under_review: ['Differences under review', 'hold'], contract_review: ['Contract review', 'hold'],
  },
  receipt: { not_required: ['Not required', 'ok'], required: ['Not confirmed', 'hold'], manually_confirmed: ['Confirmed (manual)', 'ok'] },
  payee: { verified: ['Verified', 'ok'], change_pending: ['Bank change unverified', 'stop'], unverified: ['Unverified', 'stop'] },
  approval: { none: ['Not approved', 'idle'], approved: ['Approved', 'ok'], stale: ['Out of date', 'hold'], rejected: ['Rejected', 'stop'] },
  payment: { not_ready: ['Not ready', 'idle'], ready: ['Ready to pay', 'act'], submitted: ['Settling', 'act'], settled: ['Paid', 'ok'], failed: ['Failed', 'stop'] },
};

export function Status({ kind, value }: { kind: keyof typeof STATUS; value: string }) {
  const [label, tone] = STATUS[kind]?.[value] ?? [value, 'idle'];
  return <span className={`st ${tone}`}>{label}</span>;
}

export function StatusStrip({ inv }: { inv: Row }) {
  const cells: [string, keyof typeof STATUS, string][] = [
    ['Commercial', 'commercial', inv.commercial_status], ['Receipt', 'receipt', inv.receipt_status],
    ['Payee', 'payee', inv.payee_status], ['Approval', 'approval', inv.approval_status], ['Payment', 'payment', inv.payment_status],
  ];
  return (
    <div className="statuses" role="list" aria-label="Invoice statuses">
      {cells.map(([k, kind, v]) => (
        <div key={k} role="listitem"><div className="k">{k}</div><Status kind={kind} value={v} /></div>
      ))}
    </div>
  );
}

export function HoldChips({ holds }: { holds: Row[] }) {
  if (!holds.length) return <span className="muted small">No open holds</span>;
  return <>{holds.map(h => (
    <span key={h.id} className={`chip ${['PAYEE_CHANGE_PENDING', 'PROMPT_INJECTION'].includes(h.code) ? 'stop' : ''}`} title={h.reason}>
      {HOLD_LABEL[h.code] ?? h.code}
    </span>
  ))}</>;
}

/** Where a fragment came from, in words: "Quote, page 1, line 12" / "Email from …, Oct 8". */
export function sourceOf(frag: Row, t: Tables): string {
  const doc = t.document?.find(d => d.id === frag.document_id);
  if (frag.email_message_id) {
    const em = t.email_message?.find(e => e.id === frag.email_message_id);
    return em ? `Email from ${em.from_address}, ${day(em.original_sent_at_iso)}` : 'Email';
  }
  const kind = ({ quote: 'Quote', po: 'Purchase order', invoice: 'Invoice', terms: 'Terms' } as Record<string, string>)[doc?.kind] ?? 'Document';
  return `${kind} ${doc?.filename ?? ''}, page ${frag.page}, line ${frag.line_start}`;
}

/** Evidence chips: each opens the exact quoted source text. Nothing is paraphrased. */
export function Evidence({ ids, t }: { ids: string[]; t: Tables }) {
  const [open, setOpen] = useState<string | null>(null);
  const frags = ids.map(id => t.source_fragment?.find(f => f.id === id)).filter(Boolean) as Row[];
  if (!frags.length) return null;
  const shown = frags.find(f => f.id === open);
  return (
    <div>
      <div className="ev">
        {frags.map(f => {
          const label = f.email_message_id ? 'email' : (t.document?.find(d => d.id === f.document_id)?.kind ?? 'doc');
          return (
            <button key={f.id} type="button" aria-pressed={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}
              title={sourceOf(f, t)}>
              {label} {f.email_message_id ? day(t.email_message?.find(e => e.id === f.email_message_id)?.original_sent_at_iso ?? '') : `p${f.page}·L${f.line_start}`}
            </button>
          );
        })}
      </div>
      {shown && (
        <blockquote className="quote">
          “{shown.text}”
          <div className="src">
            {sourceOf(shown, t)}
            {(() => {
              const doc = t.document?.find(d => d.id === shown.document_id);
              const href = fileHref(doc?.source_file_id, shown.page);
              return href ? <> · <a href={href} target="_blank" rel="noreferrer">Open {doc?.filename ?? 'file'}</a></> : null;
            })()}
          </div>
        </blockquote>
      )}
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  return <div className="empty">{error ? `Can't load data: ${error}` : 'Loading…'}</div>;
}

export function Outcome({ r }: { r: { outcome: string; message: string } | null }) {
  if (!r) return null;
  if (r.outcome === 'ok' || r.outcome === 'duplicate') return <div className="notice ok" role="status">Done{r.message ? `: ${r.message}` : '.'}</div>;
  return <div className="notice stop" role="alert">Refused: {r.message}</div>;
}

/** Superintendent attestation. Same rules as the invoice case; also used on the phone receipt page. */
export function ReceiptForm({ inv, rev, t }: { inv: Row; rev?: Row; t: Tables }) {
  const material = t.invoice_line.filter(l => l.revision_id === rev?.id && l.kind === 'material');
  const billed = material.reduce((s, l) => s + l.quantity_milli, 0);
  const unit = material[0]?.unit ?? 'cy';
  const atts = t.receipt_attestation.filter(a => a.invoice_id === inv.id);
  const [q, setQ] = useState(billed ? String(billed / 1000) : '');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<CallResult | null>(null);
  return (
    <section className="sheet pad" aria-labelledby="receipt">
      <h2 id="receipt">Receipt</h2>
      <p className="small" style={{ marginTop: 0 }}>
        Countersign can&apos;t see what was delivered. Receipt is a signed statement by the superintendent, labeled as manually confirmed.
        {billed > 0 && <> Billed: <strong>{qty(billed, unit)}</strong>.</>}
      </p>
      {atts.map(a => (
        <div key={a.id} className="notice ok small" style={{ marginBottom: 8 }}>
          <strong>{String(a.label).replace('_', ' ').toLowerCase()}</strong>: {qty(a.quantity_milli, a.unit)} ({a.scope}). “{a.reason}” {ROLE_LABEL[a.attested_by_role]}, {when(a.created_at)}
        </div>
      ))}
      {inv.receipt_status !== 'manually_confirmed' && (
        <form className="row" onSubmit={async e => {
          e.preventDefault();
          setResult(await call('attest_receipt', {
            id: newId('att'), invoice_id: inv.id, scope: 'All deliveries on this invoice',
            quantity_milli: Math.round(Number(q) * 1000), unit, reason,
          }));
        }}>
          <label className="f" style={{ width: 130 }}>Quantity received
            <input type="number" min="0" step="0.001" value={q} onChange={e => setQ(e.target.value)} placeholder={billed ? String(billed / 1000) : ''} />
          </label>
          <label className="f" style={{ flex: 1, minWidth: 200 }}>How you know
            <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Checked against the pour log" />
          </label>
          <button className="btn secondary" type="submit" disabled={!q || !reason.trim()} style={{ alignSelf: 'flex-end' }}>Confirm receipt (superintendent)</button>
        </form>
      )}
      <Outcome r={result} />
    </section>
  );
}
