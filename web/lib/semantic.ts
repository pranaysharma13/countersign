import type { Tables } from './client';
import { HOLD_LABEL, isSandbox, money, nextStep } from './format';
import type { Treasury } from './banks';

export interface SemanticNode {
  '@type': string;
  '@id': string;
  [key: string]: unknown;
}

export function booksGraph(t: Tables, treasury?: Treasury): { '@context': string; '@graph': SemanticNode[] } {
  const invoices = (t.invoice ?? []).filter(i => !isSandbox(i));
  const org: SemanticNode = {
    '@type': 'Organization',
    '@id': 'https://clerk.local/org/marlow-finch',
    name: 'Marlow & Finch Builders',
    email: 'ap@marlowfinch.example',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '1418 Oakview Ln',
      addressLocality: 'Fremont',
      addressRegion: 'CA',
      addressCountry: 'US',
    },
  };
  const project: SemanticNode = {
    '@type': 'Project',
    '@id': 'https://clerk.local/job/oakview',
    name: 'Oakview Lane Fourplex',
    sponsor: { '@id': org['@id'] },
  };
  const bank: SemanticNode | null = treasury ? {
    '@type': 'BankAccount',
    '@id': `https://clerk.local/bank/${treasury.operating.ref}`,
    name: treasury.operating.nickname,
    identifier: treasury.operating.nessieId,
    accountId: `····${treasury.operating.last4}`,
    currency: 'USD',
    amount: { '@type': 'MonetaryAmount', currency: 'USD', value: (treasury.operating.cents / 100).toFixed(2) },
  } : null;

  const bills: SemanticNode[] = invoices.map(inv => {
    const rev = (t.invoice_revision ?? []).find(r => r.id === inv.active_revision_id);
    const sup = (t.supplier ?? []).find(s => s.id === inv.supplier_id);
    const holds = (t.hold ?? []).filter(h => h.status === 'open' && h.revision_id === inv.active_revision_id);
    const next = nextStep(inv, holds);
    const payee = (t.payee_profile ?? []).find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
    const cents = Number(rev?.balance_requested_cents) || 0;
    return {
      '@type': 'Invoice',
      '@id': `https://clerk.local/invoices/${inv.id}`,
      identifier: String(inv.invoice_number),
      accountId: String(inv.id),
      customer: { '@id': org['@id'] },
      provider: { '@type': 'Organization', name: String(sup?.name ?? 'Supplier'), identifier: String(inv.supplier_id) },
      paymentDueDate: String(inv.due_date || ''),
      dateIssued: String(inv.invoice_date || ''),
      totalPaymentDue: { '@type': 'MonetaryAmount', currency: 'USD', value: (cents / 100).toFixed(2) },
      paymentStatus: String(inv.payment_status),
      confirmationNumber: payee ? `····${payee.last4}` : '',
      description: holds[0] ? (HOLD_LABEL[String(holds[0].code)] ?? String(holds[0].code)) : 'Looks right',
      potentialAction: next.action,
      additionalProperty: [
        { '@type': 'PropertyValue', name: 'nextRole', value: next.role || '' },
        { '@type': 'PropertyValue', name: 'holdCodes', value: holds.map(h => String(h.code)).join(',') },
        { '@type': 'PropertyValue', name: 'askedCents', value: String(cents) },
        { '@type': 'PropertyValue', name: 'formatted', value: money(cents) },
      ],
    };
  });

  return {
    '@context': 'https://schema.org',
    '@graph': [org, project, ...(bank ? [bank] : []), ...bills],
  };
}
