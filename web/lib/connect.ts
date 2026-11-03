import type { BooksHealth } from './books.ts';
import { booksLine } from './books.ts';

/** What a later ERP may read and write. Mail still never owns the bank last-4. */
export const ERP_SCOPES: { id: string; dir: 'read' | 'write' | 'never'; name: string; note: string }[] = [
  { id: 'vendors', dir: 'read', name: 'Vendors', note: 'Names, contacts already on the quote, accounts on file.' },
  { id: 'po', dir: 'read', name: 'Purchase orders', note: 'Caps, jobs, quoted prices. The order owns the ceiling.' },
  { id: 'invoices', dir: 'read', name: 'Invoices', note: 'What they asked, as posted in the ERP.' },
  { id: 'receipts', dir: 'read', name: 'Receipts', note: 'Only if site also attested in this app. A goods receipt in the ERP is another pipe.' },
  { id: 'holds', dir: 'write', name: 'Holds', note: 'Open a hold. Never clear one. Clearing is a person.' },
  { id: 'assess', dir: 'write', name: 'Assessments', note: 'Claimed, authorised, pending. Integer cents. Fingerprinted.' },
  { id: 'pay', dir: 'write', name: 'Proposed payments', note: 'Same request_id cannot pay twice. Dana still says yes.' },
  { id: 'bank', dir: 'never', name: 'Bank last-4 from mail', note: 'The account on file owns where to pay. Mail does not.' },
  { id: 'closed', dir: 'never', name: 'A closed month', note: 'A post into a locked period is refused. The ERP remains the lock.' },
];

export const SANDBOX_CHECKS: { id: string; title: string; ask: string }[] = [
  { id: 'master', title: 'Vendors and orders', ask: 'Pull the vendor list and open POs without rewriting them.' },
  { id: 'closed', title: 'Closed period', ask: 'A post into a locked month comes back refused, with a reason.' },
  { id: 'retry', title: 'Failed post', ask: 'The same request_id retries as already done. No second payment.' },
  { id: 'partial', title: 'Partial order', ask: 'A bill over the cap is held. The ERP quantity does not get averaged.' },
  { id: 'volume', title: 'Month-end volume', ask: 'The desk still names who acts when twenty bills arrive at once.' },
];

export function connectorLine(h: BooksHealth): string {
  return `No ERP connector is live. ${booksLine(h)} A later NetSuite or Sage hook is another pipe with this owns list, not a dump into a prompt.`;
}

export function scopeOk(): boolean {
  return ERP_SCOPES.some(s => s.dir === 'never' && s.id === 'bank')
    && ERP_SCOPES.filter(s => s.dir === 'write').every(s => s.id !== 'bank');
}
