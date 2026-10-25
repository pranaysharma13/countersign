'use client';
import { useState } from 'react';
import type { Row, Tables } from '@/lib/client';
import { day, HOLD_LABEL } from '@/lib/format';

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
          <div className="src">{sourceOf(shown, t)}</div>
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
