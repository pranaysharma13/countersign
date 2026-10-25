import type { Row } from './client';

// Money is integer cents end to end; formatting is the only place it becomes text.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (cents: number | null | undefined) => (cents == null ? '—' : usd.format(cents / 100));
export const qty = (milli: number, unit: string) =>
  `${(milli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit === 'cy' ? 'yd³' : unit}`;

export function ceilingCopy(evidenceJson: string, fallback: string): string {
  let ev: Record<string, unknown> = {};
  try { ev = JSON.parse(evidenceJson || '{}'); } catch { ev = {}; }
  const billed = Number(ev.this_invoice_milli) || 0;
  const cap = Number(ev.ceiling_milli) || 0;
  const unit = String(ev.unit || '');
  if (billed > 0 && cap > 0 && unit) {
    return `The purchase order allows ${qty(cap, unit)}. This invoice bills ${qty(billed, unit)}.`;
  }
  return fallback;
}
const PLURAL_SKIP = new Set(['cy', 'yd³', 'each', 'ea', 'lot', 'ls']);
function units(n: string, unit: string): string {
  const u = unit === 'cy' ? 'yd³' : unit;
  return `${n} ${n === '1' || PLURAL_SKIP.has(u) || u.endsWith('s') ? u : `${u}s`}`;
}

export function plainCalc(raw: string): string {
  const m = raw.match(/^Allowed ([\d.,]+) (\S+) x (\$[\d,.]+) \(accepted unit price\) = (\$[\d,.]+); billed ([\d.,]+) (\S+) x (\$[\d,.]+) = (\$[\d,.]+)$/);
  if (!m) return raw;
  const [, aq, au, ap, at, bq, bu, bp, bt] = m;
  if (aq === bq && au === bu && ap === bp && at === bt) {
    return `${units(bq, bu)} × ${bp} = ${bt}, at the quoted price.`;
  }
  return `Billed ${units(bq, bu)} × ${bp} = ${bt}. The quote allows ${units(aq, au)} × ${ap} = ${at}.`;
}

export function plainTerms(raw: string): string {
  return raw.replace(/Quote terms:\s*"\d+\.\s*[^.]+\.\s*([^"]+)"/, 'The quote says: “$1”');
}

export const when = (micros: number) =>
  new Date(micros / 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const time = (micros: number) =>
  new Date(micros / 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const day = (iso: string) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

export function daysUntil(iso: string, now = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function dueWord(iso: string): { label: string; tone: 'ok' | 'hold' | 'stop' | 'idle' } {
  const n = daysUntil(iso);
  if (n == null) return { label: 'No due date', tone: 'idle' };
  if (n < 0) return { label: `${-n} day${n === -1 ? '' : 's'} late`, tone: 'stop' };
  if (n === 0) return { label: 'Due today', tone: 'stop' };
  if (n <= 14) return { label: `Due in ${n} day${n === 1 ? '' : 's'}`, tone: 'hold' };
  return { label: `Due ${day(iso)}`, tone: 'idle' };
}
export const ids = (json: string): string[] => {
  try {
    const v = JSON.parse(json || '[]');
    if (Array.isArray(v)) return v.map(String);
    if (v && typeof v === 'object' && Array.isArray(v.fragment_ids)) return v.fragment_ids.map(String);
    return [];
  } catch { return []; }
};
export const parse = <T,>(json: string, fallback: T): T => { try { return JSON.parse(json) as T; } catch { return fallback; } };

/** Assessment details: the old local seed stored a line array; Python's seed stores `{ lines: [...] }` with `description`. */
export interface AssessmentLine {
  line_id: string; line: string; claimed_cents: number; accepted_cents: number; pending_cents: number; variance_cents: number;
  calculation: string; fragment_ids: string[]; status: string; uncertainty?: string;
}
export function assessmentLines(detailsJson: string): AssessmentLine[] {
  const raw = parse<unknown>(detailsJson, []);
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { lines?: unknown }).lines)
    ? (raw as { lines: unknown[] }).lines : []);
  return rows.map((row) => {
    const l = (row && typeof row === 'object') ? row as Record<string, unknown> : {};
    const status = String(l.status ?? '');
    return {
      line_id: String(l.line_id ?? ''),
      line: String(l.line ?? l.description ?? ''),
      claimed_cents: Number(l.claimed_cents) || 0,
      accepted_cents: Number(l.accepted_cents) || 0,
      pending_cents: Number(l.pending_cents) || 0,
      variance_cents: Number(l.variance_cents) || 0,
      calculation: String(l.calculation ?? ''),
      fragment_ids: Array.isArray(l.fragment_ids) ? l.fragment_ids.map(String) : [],
      status: status === 'variance' ? 'under_review' : status,
      uncertainty: l.uncertainty ? String(l.uncertainty) : undefined,
    };
  });
}

/** Judge submissions from the Sneak page land on this fictional supplier; they are not the company's bills. */
export const SANDBOX_SUPPLIER = 'sup_sandbox';
export const isSandbox = (inv: { supplier_id?: unknown }) => inv.supplier_id === SANDBOX_SUPPLIER;

export const HOLD_LABEL: Record<string, string> = {
  CONTRACT_REVIEW: 'Needs a closer look at the contract',
  PRICE_VARIANCE: 'Price is higher than agreed',
  PROPOSED_CHARGE: 'Extra charge not agreed',
  USAGE_EVIDENCE_MISSING: 'No proof this was used',
  PO_CEILING: 'Billed more than ordered',
  DUPLICATE_REVIEW: 'Looks like a repeat bill',
  EXTRACTION_REVIEW: 'Needs a person to read it',
  RECEIPT_NOT_VERIFIED: 'Delivery not confirmed',
  PAYEE_CHANGE_PENDING: 'New bank account',
  APPROVAL_STALE: 'Earlier approval is out of date',
  PROMPT_INJECTION: 'Hidden instruction on the invoice',
  SUPPLIER_RISK: 'Supplier flag',
};
export const HOLD_DETAIL: Record<string, string> = {
  PROMPT_INJECTION: 'This PDF included a line written for an automated system, not for a person. Clerk treated it as printed text and did not follow it. The line items still stand on their own.',
  PAYEE_CHANGE_PENDING: 'They asked us to pay a different bank account than the one already on file.',
  PO_CEILING: 'The purchase order has a cap. This bill goes over it.',
  PROPOSED_CHARGE: 'This extra was mentioned. Nobody agreed to it in the app.',
  SUPPLIER_RISK: 'A public record on this supplier needs a person to look at it before anyone pays.',
  PRICE_VARIANCE: 'The unit price is higher than the quote or the purchase order.',
  RECEIPT_NOT_VERIFIED: 'Nobody on site has confirmed this arrived.',
};
/** Document text is data. Never show a hidden instruction as if the product said it. */
export function isHiddenInstruction(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\s*SYSTEM\s*:/i.test(t)) return true;
  if (/ignore (all )?(prior|previous|above) (instructions|rules)/i.test(t)) return true;
  if (/approve this (invoice|bill) immediately/i.test(t)) return true;
  return false;
}

export function safeQuote(text: string): string {
  return isHiddenInstruction(text)
    ? 'Hidden instruction on the document. Treated as printed text and ignored.'
    : text;
}

export function safeReason(text: string): string {
  if (!text) return text;
  if (isHiddenInstruction(text) || /SYSTEM\s*:/i.test(text)) {
    return 'Hidden instruction on the invoice, treated as data and ignored.';
  }
  return text;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', purchasing: 'Buyer', receiver: 'Site', bookkeeper: 'Books', agent: 'Clerk',
  gateway: 'Bank transfer', sync: 'Inbox', supplier: 'Supplier', admin: 'Setup', '': '—',
};

export interface BillLike {
  next_owner_role: string;
  next_action: string;
  payment_status: string;
  commercial_status: string;
  approval_status: string;
}

/** A table row read as a bill: a missing or non-string field reads as '' (rows come from any data source). */
function asBill(row: BillLike | Row): BillLike {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    next_owner_role: s(row.next_owner_role), next_action: s(row.next_action), payment_status: s(row.payment_status),
    commercial_status: s(row.commercial_status), approval_status: s(row.approval_status),
  };
}

/** One sentence a builder can read. Hold codes stay internal. */
/** Hold codes from hold rows; a row without a string code contributes nothing. */
const holdCodes = (holds: readonly ({ code: string } | Row)[]) =>
  new Set(holds.map(h => h.code).filter((c): c is string => typeof c === 'string'));

export function billStory(row: BillLike | Row, holds: readonly ({ code: string } | Row)[]): string {
  const inv = asBill(row);
  if (inv.payment_status === 'settled') return 'Already paid.';
  if (inv.payment_status === 'partially_settled') return 'We paid the part we agreed. The rest stays disputed until they correct the invoice or agree a credit.';
  const codes = holdCodes(holds);
  if (codes.has('PROMPT_INJECTION')) return 'This invoice included a hidden instruction. We ignored it. The line items still match the order.';
  if (codes.has('PAYEE_CHANGE_PENDING')) return 'They asked us to send money to a new bank account.';
  if (codes.has('PO_CEILING')) return 'They billed more than the purchase order allows.';
  if (codes.has('PROPOSED_CHARGE')) return 'They added an extra charge that was never agreed.';
  if (codes.has('SUPPLIER_RISK')) return 'A public-records flag is on this supplier.';
  if (codes.has('PRICE_VARIANCE')) return 'The price is higher than what was agreed.';
  if (codes.has('RECEIPT_NOT_VERIFIED')) return 'The job site has not confirmed the delivery yet.';
  if (inv.commercial_status === 'matches' && inv.approval_status === 'none') return 'Looks right. Waiting for the owner to approve.';
  return inv.next_action;
}

export function nextStep(row: BillLike | Row, holds: readonly ({ code: string } | Row)[]): { role: string; action: string } {
  const inv = asBill(row);
  if (inv.payment_status === 'settled') return { role: '', action: 'Nothing left to do.' };
  if (inv.payment_status === 'partially_settled') return { role: 'purchasing', action: 'Wait for a corrected invoice or an agreed credit for the disputed amount.' };
  const codes = holdCodes(holds);
  if (codes.has('PROMPT_INJECTION')) return { role: 'owner', action: 'Record that the hidden instruction was ignored, then review the line items.' };
  if (codes.has('SUPPLIER_RISK')) return { role: 'owner', action: 'Read the supplier flag before anyone pays.' };
  if (codes.has('PAYEE_CHANGE_PENDING')) return { role: 'owner', action: 'Call someone already on file. Confirm the new account.' };
  if (codes.has('PO_CEILING') || codes.has('PROPOSED_CHARGE') || codes.has('PRICE_VARIANCE')) {
    return { role: 'purchasing', action: 'Ask the supplier to correct the bill, or the owner can accept the extra.' };
  }
  if (codes.has('RECEIPT_NOT_VERIFIED')) return { role: 'receiver', action: 'Confirm what arrived on site.' };
  return { role: inv.next_owner_role, action: inv.next_action };
}
