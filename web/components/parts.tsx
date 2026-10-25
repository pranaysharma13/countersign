'use client';
import { useState } from 'react';
import { call, newId, type CallResult, type Row, type Tables } from '@/lib/client';
import { day, HOLD_LABEL, qty, ROLE_LABEL, safeQuote, when } from '@/lib/format';
import { fileHref } from '@/lib/files';

type Tone = 'ok' | 'hold' | 'stop' | 'idle' | 'act';
const STATUS: Record<string, Record<string, [string, Tone]>> = {
  commercial: {
    pending: ['Checking', 'idle'], matches: ['Matches the order', 'ok'],
    differences_under_review: ['Does not match', 'hold'], contract_review: ['Needs a look', 'hold'],
  },
  receipt: { not_required: ['Not needed', 'ok'], required: ['Not confirmed', 'hold'], manually_confirmed: ['Confirmed', 'ok'] },
  payee: { verified: ['Checked', 'ok'], change_pending: ['New account', 'stop'], unverified: ['Not checked', 'stop'] },
  approval: { none: ['Waiting', 'idle'], approved: ['Approved', 'ok'], stale: ['Out of date', 'hold'], rejected: ['Rejected', 'stop'] },
  payment: { not_ready: ['Not yet', 'idle'], ready: ['Ready', 'act'], submitted: ['Sending', 'act'], settled: ['Paid', 'ok'], failed: ['Failed', 'stop'] },
};

export function Status({ kind, value }: { kind: keyof typeof STATUS; value: string }) {
  const [label, tone] = STATUS[kind]?.[value] ?? [value, 'idle'];
  return <span className={`st ${tone}`}>{label}</span>;
}

export function StatusStrip({ inv }: { inv: Row }) {
  const cells: [string, keyof typeof STATUS, string][] = [
    ['Order', 'commercial', inv.commercial_status], ['Delivery', 'receipt', inv.receipt_status],
    ['Bank', 'payee', inv.payee_status], ['Owner', 'approval', inv.approval_status], ['Paid', 'payment', inv.payment_status],
  ];
  return (
    <div className="statuses" role="list" aria-label="Bill status">
      {cells.map(([k, kind, v]) => (
        <div key={k} role="listitem"><div className="k">{k}</div><Status kind={kind} value={v} /></div>
      ))}
    </div>
  );
}

export function HoldChips({ holds }: { holds: Row[] }) {
  if (!holds.length) return <span className="muted small">Nothing blocking</span>;
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
  return `${kind}, page ${frag.page}`;
}

function chipLabel(f: Row, t: Tables): string {
  if (f.email_message_id) {
    const em = t.email_message?.find(e => e.id === f.email_message_id);
    return em ? `Email, ${day(em.original_sent_at_iso)}` : 'Email';
  }
  const kind = ({ quote: 'Quote', po: 'Purchase order', invoice: 'Invoice', terms: 'Terms' } as Record<string, string>)[t.document?.find(d => d.id === f.document_id)?.kind ?? ''] ?? 'Document';
  return `${kind}, p. ${f.page}`;
}

/** Evidence chips open the quoted source. Hidden instructions are never shown as product text. */
export function Evidence({ ids, t }: { ids: string[]; t: Tables }) {
  const [open, setOpen] = useState<string | null>(null);
  const frags = ids.map(id => t.source_fragment?.find(f => f.id === id)).filter(Boolean) as Row[];
  if (!frags.length) return null;
  const shown = frags.find(f => f.id === open);
  return (
    <div>
      <div className="ev">
        {frags.map(f => (
          <button key={f.id} type="button" aria-pressed={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}
            title={sourceOf(f, t)}>
            {chipLabel(f, t)}
          </button>
        ))}
      </div>
      {shown && (
        <div className="paper-open">
          <blockquote className="quote">
            “{safeQuote(String(shown.text || ''))}”
            <div className="src">{sourceOf(shown, t)}</div>
          </blockquote>
          <DocFrame doc={t.document?.find(d => d.id === shown.document_id)} page={shown.page} t={t} />
        </div>
      )}
    </div>
  );
}

export function DocFrame({ doc, page, t }: { doc?: Row; page?: number; t?: Tables }) {
  if (!doc) return null;
  const href = fileHref(doc, page);
  const isMail = doc.kind === 'email' || String(doc.filename || '').endsWith('.eml');
  if (isMail) {
    const body = t?.source_fragment?.find(f => f.document_id === doc.id && String(f.id).endsWith('_body'));
    return <div className="mail">{body?.text || 'Email on file.'}</div>;
  }
  if (!href) return <p className="small muted">Document preview is not available.</p>;
  return (
    <iframe
      className="doc-frame"
      src={href}
      title={String(doc.filename || 'Document')}
    />
  );
}

export function Papers({ docs, t }: { docs: Row[]; t: Tables }) {
  const items = docs.filter(Boolean);
  const [cur, setCur] = useState(items[0]?.id ?? '');
  const doc = items.find(d => d.id === cur) ?? items[0];
  if (!items.length) return null;
  return (
    <section className="sheet pad" aria-labelledby="papers">
      <h2 id="papers">Documents</h2>
      <div className="doc-tabs" role="tablist" aria-label="Documents on this bill">
        {items.map(d => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={doc?.id === d.id}
            className={doc?.id === d.id ? 'btn' : 'btn secondary'}
            onClick={() => setCur(d.id)}
          >
            {({ quote: 'Quote', po: 'Purchase order', invoice: 'Invoice', terms: 'Terms', email: 'Email' } as Record<string, string>)[d.kind] ?? d.kind}
          </button>
        ))}
      </div>
      <DocFrame doc={doc} t={t} />
    </section>
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
      <h2 id="receipt">Delivery</h2>
      {billed > 0 && <p className="small muted" style={{ marginTop: 0 }}>They billed: {qty(billed, unit)}</p>}
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
          <button className="btn secondary" type="submit" disabled={!q || !reason.trim()} style={{ alignSelf: 'flex-end' }}>Confirm what arrived</button>
        </form>
      )}
      <Outcome r={result} />
    </section>
  );
}
