import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPERATING_CENTS, OWNER_DRAW_CENTS, WORKING_CAPITAL_CENTS, WIRE_DUAL_CENTS,
  addBusinessDays, achWindow, buildTreasury, dollarsToCents, namesMatch, nessieId, payeeNameOk,
} from './banks.ts';

test('operating cash is integer cents and ties to draws', () => {
  assert.equal(OPERATING_CENTS, 9_240_000);
  assert.equal(OWNER_DRAW_CENTS + WORKING_CAPITAL_CENTS, OPERATING_CENTS);
});

test('Nessie dollars become cents only at the edge', () => {
  assert.equal(dollarsToCents(92400), 9_240_000);
  assert.equal(dollarsToCents('4180.00'), 418_000);
  assert.equal(dollarsToCents(''), 0);
});

test('nessie ids are stable 24-hex', () => {
  const a = nessieId('acct_company_operating');
  assert.equal(a, nessieId('acct_company_operating'));
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(nessieId('acct_cedar_v1'), a);
});

test('ACH settles the next business day', () => {
  assert.equal(addBusinessDays('2026-10-27', 1), '2026-10-28');
  assert.equal(addBusinessDays('2026-10-30', 1), '2026-11-02');
  const w = achWindow('2026-10-27');
  assert.equal(w.settles, '2026-10-28');
  assert.equal(w.cutoffHour, 15);
});

test('a pending email change must look like the supplier', () => {
  assert.equal(payeeNameOk('verified', 'Northline Rebar', 'Ridge Credit Union'), true);
  assert.equal(payeeNameOk('pending', 'Northline Rebar', 'Harbor Wire Bank'), false);
  assert.equal(namesMatch('Harbor Pack Crating', 'Harbor Wire Bank'), true);
});

test('treasury rec is zero on the fixture and a new last-4 stays held', () => {
  const snap = buildTreasury({
    invoice: [{
      id: 'inv_nl441', supplier_id: 'sup_northline', payment_status: 'unpaid',
      active_revision_id: 'rev_nl', payee_status: 'change_pending', receipt_status: 'verified',
    }],
    invoice_revision: [{ id: 'rev_nl', balance_requested_cents: 250_000 }],
    hold: [{ revision_id: 'rev_nl', status: 'open', code: 'PAYEE_CHANGE_PENDING', amount_cents: 0 }],
    supplier: [{ id: 'sup_northline', name: 'Northline Rebar' }],
    payee_profile: [
      { id: 'sup_northline:v1', supplier_id: 'sup_northline', status: 'verified', bank_name: 'Ridge Credit Union', last4: '4188', account_ref: 'acct_northline_v1' },
      { id: 'sup_northline:v2', supplier_id: 'sup_northline', status: 'pending', bank_name: 'Harbor Wire Bank', last4: '7703', account_ref: 'requested_northline_7703' },
    ],
  });
  assert.equal(snap.diffCents, 0);
  assert.equal(snap.bankCents, OPERATING_CENTS);
  assert.equal(snap.readyCount, 0);
  assert.equal(snap.payees.find(p => p.last4 === '7703')?.nameMatch, false);
  assert.ok(snap.controls.find(c => c.id === 'call' && !c.ok));
  assert.equal(WIRE_DUAL_CENTS, 1_000_000);
});
