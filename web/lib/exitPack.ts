import type { Row, Tables } from './client.ts';
import { isSandbox } from './format.ts';

export interface ExitBill {
  id: string;
  number: string;
  supplierId: string;
  due: string;
  payment: string;
  commercial: string;
  receipt: string;
  payee: string;
  askedCents: number;
}

export interface ExitHold {
  id: string;
  invoiceId: string;
  code: string;
  status: string;
  cents: number;
}

export interface ExitAudit {
  at: string;
  requestId: string;
  role: string;
  action: string;
  entity: string;
  outcome: string;
  reason: string;
}

export interface ExitPack {
  company: string;
  note: string;
  exportedAt: string;
  bills: ExitBill[];
  holds: ExitHold[];
  audits: ExitAudit[];
}

function s(v: unknown): string {
  return v == null ? '' : String(v);
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function buildExitPack(t: Tables, at = new Date().toISOString()): ExitPack {
  const invoices = (t.invoice ?? []).filter(i => !isSandbox(i));
  const ids = new Set(invoices.map(i => String(i.id)));
  const revs = new Map<string, Row>();
  for (const r of t.invoice_revision ?? []) {
    const inv = invoices.find(i => i.id === r.invoice_id && i.active_revision_id === r.id);
    if (inv) revs.set(String(inv.id), r);
  }
  const bills: ExitBill[] = invoices.map(inv => {
    const id = String(inv.id);
    const rev = revs.get(id);
    return {
      id,
      number: s(inv.invoice_number),
      supplierId: s(inv.supplier_id),
      due: s(inv.due_date),
      payment: s(inv.payment_status),
      commercial: s(inv.commercial_status),
      receipt: s(inv.receipt_status),
      payee: s(inv.payee_status),
      askedCents: n(rev?.balance_requested_cents),
    };
  });
  const revToInv = new Map<string, string>();
  for (const inv of invoices) revToInv.set(String(inv.active_revision_id), String(inv.id));
  const holds: ExitHold[] = (t.hold ?? [])
    .filter(h => revToInv.has(String(h.revision_id)))
    .map(h => ({
      id: s(h.id),
      invoiceId: revToInv.get(String(h.revision_id)) ?? '',
      code: s(h.code),
      status: s(h.status),
      cents: n(h.amount_cents ?? h.cents),
    }));
  const audits: ExitAudit[] = (t.audit_log ?? [])
    .filter(a => ids.has(s(a.entity_id)) || [...ids].some(id => s(a.entity_id).includes(id)))
    .map(a => ({
      at: s(a.at),
      requestId: s(a.request_id),
      role: s(a.actor_role),
      action: s(a.action),
      entity: s(a.entity_id),
      outcome: s(a.outcome),
      reason: s(a.reason),
    }));
  return {
    company: 'Marlow & Finch Builders · fictional books',
    note: 'Integer cents. Sandbox bills omitted. Bank last-4 is not in this pack. before_json and after_json stay in the live audit download per bill.',
    exportedAt: at,
    bills,
    holds,
    audits,
  };
}

export function exitFilename(iso: string): string {
  const day = iso.slice(0, 10) || 'books';
  return `marlow-finch-${day}.json`;
}
