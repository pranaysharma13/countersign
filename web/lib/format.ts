// Money is integer cents end to end; formatting is the only place it becomes text.
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (cents: number | null | undefined) => (cents == null ? '—' : usd.format(cents / 100));
export const qty = (milli: number, unit: string) =>
  `${(milli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit === 'cy' ? 'yd³' : unit}`;
export const when = (micros: number) =>
  new Date(micros / 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const time = (micros: number) =>
  new Date(micros / 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const day = (iso: string) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
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
  line: string; claimed_cents: number; accepted_cents: number; pending_cents: number; variance_cents: number;
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
  PROMPT_INJECTION: 'Tried to trick the checker',
  SUPPLIER_RISK: 'Supplier flag',
};
export const HOLD_DETAIL: Record<string, string> = {
  PROMPT_INJECTION: 'They hid a line that said to approve the bill without looking. We treated it as words on a page and ignored it.',
  PAYEE_CHANGE_PENDING: 'They asked us to pay a different bank account than the one already on file.',
  PO_CEILING: 'The purchase order has a cap. This bill goes over it.',
  PROPOSED_CHARGE: 'This extra was mentioned. Nobody agreed to it in the app.',
  SUPPLIER_RISK: 'A public record on this supplier needs a person to look at it before anyone pays.',
  PRICE_VARIANCE: 'The unit price is higher than the quote or the purchase order.',
  RECEIPT_NOT_VERIFIED: 'Nobody on site has confirmed this arrived.',
};
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', purchasing: 'Buyer', receiver: 'Site', bookkeeper: 'Books', agent: 'Countersign',
  gateway: 'Bank transfer', sync: 'Inbox', supplier: 'Supplier', admin: 'Setup', '': '—',
};

export interface BillLike {
  next_owner_role: string;
  next_action: string;
  payment_status: string;
  commercial_status: string;
  approval_status: string;
}

/** One sentence a builder can read. Hold codes stay internal. */
export function billStory(inv: BillLike, holds: { code: string }[]): string {
  if (inv.payment_status === 'settled') return 'Already paid.';
  const codes = new Set(holds.map(h => h.code));
  if (codes.has('PROMPT_INJECTION')) return 'This invoice hid instructions for the checker. We ignored them.';
  if (codes.has('PAYEE_CHANGE_PENDING')) return 'They asked us to send money to a new bank account.';
  if (codes.has('PO_CEILING')) return 'They billed more than the purchase order allows.';
  if (codes.has('PROPOSED_CHARGE')) return 'They added an extra charge that was never agreed.';
  if (codes.has('SUPPLIER_RISK')) return 'A public-records flag is on this supplier.';
  if (codes.has('PRICE_VARIANCE')) return 'The price is higher than what was agreed.';
  if (codes.has('RECEIPT_NOT_VERIFIED')) return 'The job site has not confirmed the delivery yet.';
  if (inv.commercial_status === 'matches' && inv.approval_status === 'none') return 'Looks right. Waiting for the owner to approve.';
  return inv.next_action;
}

export function nextStep(inv: BillLike, holds: { code: string }[]): { role: string; action: string } {
  if (inv.payment_status === 'settled') return { role: '', action: 'Nothing left to do.' };
  const codes = new Set(holds.map(h => h.code));
  if (codes.has('PROMPT_INJECTION')) return { role: 'owner', action: 'Read what they hid, then decide whether to pay.' };
  if (codes.has('SUPPLIER_RISK')) return { role: 'owner', action: 'Read the supplier flag before anyone pays.' };
  if (codes.has('PAYEE_CHANGE_PENDING')) return { role: 'owner', action: 'Call someone already on file. Confirm the new account.' };
  if (codes.has('PO_CEILING') || codes.has('PROPOSED_CHARGE') || codes.has('PRICE_VARIANCE')) {
    return { role: 'purchasing', action: 'Ask the supplier to correct the bill, or the owner can accept the extra.' };
  }
  if (codes.has('RECEIPT_NOT_VERIFIED')) return { role: 'receiver', action: 'Confirm what arrived on site.' };
  return { role: inv.next_owner_role, action: inv.next_action };
}
