// The local demo backend: seeded opening state, then the demo clicked through as the web app would.
import { test, expect } from 'vitest';
import { LocalBackend } from '../local/backend';

test('BayMix demo clicks through to $73,700 settled with AP at $0', () => {
  const b = new LocalBackend();
  const s = () => b.state(['invoice', 'hold', 'proposal', 'payment', 'ledger_line', 'invoice_revision', 'outbox', 'assessment']) as any;
  const openHolds = () => s().hold.filter((h: any) => h.status === 'open' && h.revision_id === s().invoice[0].active_revision_id).map((h: any) => h.code).sort();

  expect(s().invoice[0]).toMatchObject({ commercial_status: 'differences_under_review', receipt_status: 'required', payee_status: 'verified' });
  expect(openHolds()).toEqual(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'RECEIPT_NOT_VERIFIED', 'USAGE_EVIDENCE_MISSING']);
  expect(s().outbox[0].status).toBe('draft');

  // Purchasing sends the clarification → simulated supplier sends a corrected invoice.
  expect(b.call('purchasing', 'approve_outbox', ['ob_1042_1']).outcome).toBe('ok');
  expect(s().invoice[0].active_revision_id).toBe('rev_1042_2');
  expect(openHolds()).toEqual(['RECEIPT_NOT_VERIFIED']);

  // Owner can't skip the receipt; the superintendent confirms it.
  const recv = s().hold.find((h: any) => h.status === 'open' && h.code === 'RECEIPT_NOT_VERIFIED');
  expect(b.call('owner', 'resolve_hold', [recv.id, 'trust me']).outcome).toBe('denied');
  expect(b.call('receiver', 'attest_receipt', ['att_1', 'inv_1042', 'Pours Oct 9–20', 500000, 'cy', 'Checked against pour log']).outcome).toBe('ok');

  // The stand-in agent proposes $73,700; the owner approves with the fingerprint; the gateway settles.
  const p = s().proposal.find((x: any) => x.kind === 'supplier_payment' && x.status === 'pending');
  expect(p.amount_cents).toBe(7370000);
  const fp = s().assessment.find((a: any) => a.revision_id === 'rev_1042_2').fingerprint;
  const r = b.call('owner', 'approve_supplier_payment', [p.id, fp, 'Approved']);
  expect(r.outcome, r.message).toBe('ok');
  expect(s().invoice[0].payment_status).toBe('settled');
  expect(s().payment[0].amount_cents).toBe(7370000);
  const ap = s().ledger_line.filter((l: any) => l.account === 'accounts_payable').reduce((t: number, l: any) => t + l.credit_cents - l.debit_cents, 0);
  expect(ap).toBe(0);
});

test('reset restores the opening state', () => {
  const b = new LocalBackend();
  b.call('purchasing', 'approve_outbox', ['ob_1042_1']);
  b.reset();
  expect((b.state(['invoice']) as any).invoice[0].active_revision_id).toBe('rev_1042_1');
});
