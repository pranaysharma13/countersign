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
  CONTRACT_REVIEW: 'Contract review', PRICE_VARIANCE: 'Price differs from agreed', PROPOSED_CHARGE: 'Charge only proposed',
  USAGE_EVIDENCE_MISSING: 'No usage evidence', PO_CEILING: 'Over the PO limit', DUPLICATE_REVIEW: 'Possible duplicate',
  EXTRACTION_REVIEW: 'Needs a human read', RECEIPT_NOT_VERIFIED: 'Receipt not confirmed', PAYEE_CHANGE_PENDING: 'Bank change unverified',
  APPROVAL_STALE: 'Approval out of date', PROMPT_INJECTION: 'Hidden instructions found', SUPPLIER_RISK: 'Supplier risk',
};
export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', purchasing: 'Purchasing', receiver: 'Superintendent', bookkeeper: 'Bookkeeper', agent: 'Countersign',
  gateway: 'Payment gateway', sync: 'Intake', supplier: 'Supplier', admin: 'Setup', '': '—',
};
