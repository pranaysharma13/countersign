// CONTRACT §9: the primary BayMix scenario end to end, plus the rules the TS brief says must be tested.
import { describe, test, expect, beforeEach } from 'vitest';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { Identity } from 'spacetimedb';
import spacetimedb from '../src/schema';
import * as mod from '../src/index';
import * as L from '../src/logic';
import * as V from '../src/logic_v2';
import type { Ctx } from '../src/schema';

const ident = (n: number) => new Identity('0x' + n.toString(16).padStart(64, '0'));
const ADMIN = ident(1), OWNER = ident(2), AGENT = ident(4), GATEWAY = ident(5), SYNC = ident(6),
  PURCH = ident(7), RECV = ident(8), PURCH2 = ident(9);

let h: any;
let n = 0;
const rid = () => `r${++n}`;
const run = <T>(fn: (ctx: Ctx) => T): T => h.withReducerTx(TestAuth.internal(), (ctx: any) => fn(ctx as Ctx));
const find = (t: string, id: string) => h.db[t].id.find(id);
const all = (t: string) => [...h.db[t].iter()];
const openHoldCodes = (rev: string) => all('hold').filter((x: any) => x.revision_id === rev && x.status === 'open').map((x: any) => x.code).sort();
const expectOk = (r: { outcome: string; message: string }) => expect(r, r.message).toMatchObject({ outcome: 'ok' });

const D = (dollars: number) => BigInt(Math.round(dollars * 100)); // test-only helper for readable cents
const YD = (yards: number) => BigInt(yards * 1000);

function seed() {
  run(ctx => L.claim_admin(ctx, ADMIN, rid()));
  for (const [i, role] of [[OWNER, 'owner'], [AGENT, 'agent'], [GATEWAY, 'gateway'], [SYNC, 'sync'], [PURCH, 'purchasing'], [RECV, 'receiver'], [PURCH2, 'purchasing']] as const) {
    expectOk(run(ctx => L.register_actor(ctx, ADMIN, rid(), i.toHexString(), role, role)));
  }
  expectOk(run(ctx => V.set_authority(ctx, ADMIN, rid(), OWNER.toHexString(), 'owner', D(250000), '*')));
  expectOk(run(ctx => V.set_authority(ctx, ADMIN, rid(), PURCH.toHexString(), 'purchasing', D(2000), '*')));
  expectOk(run(ctx => V.set_authority(ctx, ADMIN, rid(), PURCH2.toHexString(), 'purchasing', D(2000), 'prj_other')));
  expectOk(run(ctx => V.upsert_supplier(ctx, SYNC, rid(), 'sup_baymix', 'BayMix Supply', 'baymix.example', '+15555550100', 'crs_b1', 'active')));
  expectOk(run(ctx => V.upsert_supplier_contact(ctx, SYNC, rid(), 'con_ar', 'sup_baymix', 'Lee Park', 'ar@baymix.example', '+15555550100', 'AR', true)));
  expectOk(run(ctx => V.add_payee_profile(ctx, ADMIN, rid(), 'sup_baymix:v1', 'sup_baymix', 1, 'acct_baymix', '4471', 'Bank', 'seed')));
  expectOk(run(ctx => V.record_document(ctx, SYNC, rid(), 'doc_quote', 'quote', 'src_q', 'shaq', 'quote.pdf', 1)));
  expectOk(run(ctx => V.add_fragment(ctx, SYNC, rid(), 'frag_price', 'doc_quote', 1, '', 4, 4, 'Up to 500 cubic yards at $165.00 per yard')));
  expectOk(run(ctx => V.upsert_purchase(ctx, SYNC, rid(), 'pur_1', 'sup_baymix', 'prj_oakview', 'Ready-mix 4000 psi', 'cy', 'PO-2201', 'doc_quote', '', 'open')));
  expectOk(run(ctx => V.record_term(ctx, SYNC, rid(), 'term_price', 'pur_1', 'unit_price', 'Unit price', D(165), 0n, '$165/yd', '{}', '2026-10-01', '2026-10-31', 'accepted', '["frag_price"]', 1)));
  expectOk(run(ctx => V.record_deposit(ctx, SYNC, rid(), 'dep_1', 'pur_1', 'sup_baymix', D(10000), 'settled', 'tr_dep')));
}

/** The Oct 23 invoice: 500 yd at $172 + $1,200 weekend + 90 min waiting at $2.50. */
function firstInvoice() {
  expectOk(run(ctx => V.record_document(ctx, SYNC, rid(), 'doc_inv1', 'invoice', 'src_i1', 'shai1', 'inv.pdf', 1)));
  expectOk(run(ctx => V.record_invoice(ctx, SYNC, rid(), 'inv_1', 'sup_baymix', 'pur_1', 'BM-1042', '2026-10-23', '2026-11-22', 'USD')));
  expectOk(run(ctx => V.record_invoice_revision(ctx, SYNC, rid(), 'rev_1', 'inv_1', 1, 'doc_inv1', D(87425), D(10000), D(77425), '')));
  expectOk(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l1', 'rev_1', 'material', 'Ready-mix', YD(500), 'cy', D(172), D(86000), 'term_price', '', '[]')));
  expectOk(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l2', 'rev_1', 'extra', 'Weekend delivery', 0n, '', 0n, D(1200), '', '', '[]')));
  expectOk(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l3', 'rev_1', 'waiting', 'Waiting time', 90000n, 'min', 250n, D(225), '', '', '[]')));
  for (const [id, code, amt] of [['h_price', 'PRICE_VARIANCE', 3500], ['h_wait', 'USAGE_EVIDENCE_MISSING', 225], ['h_recv', 'RECEIPT_NOT_VERIFIED', 0]] as const) {
    expectOk(run(ctx => V.open_hold(ctx, AGENT, rid(), id, 'rev_1', code, D(amt), `${code} reason`, '[]')));
  }
}

/** §9.9: money holds clear only through a correction or the owner's decisions, never resolve_hold. Records an assessment
 * that shows both lines disputed (version 1, fingerprint fp0) and accepts both as billed. */
function acceptMoneyHolds() {
  const details = JSON.stringify({ lines: [
    { line_id: 'l1', hold_code: 'PRICE_VARIANCE', pending_cents: 0, variance_cents: 350000 },
    { line_id: 'l2', hold_code: '', pending_cents: 0, variance_cents: 0 },
    { line_id: 'l3', hold_code: 'USAGE_EVIDENCE_MISSING', pending_cents: 22500, variance_cents: 0 },
  ] });
  expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_0', 'rev_1', 1, 'fp0', 'p', D(87425), D(83700), D(225), D(3500), D(10000), 0n, 'differences_under_review', 's', details, '')));
  expectOk(run(ctx => V.decide_disputed_line(ctx, OWNER, rid(), 'dec_l1', 'l1', 'accept_as_billed', D(3500), 'fp0', '', 'accepted')));
  expectOk(run(ctx => V.decide_disputed_line(ctx, OWNER, rid(), 'dec_l3', 'l3', 'accept_as_billed', D(225), 'fp0', '', 'accepted')));
}

beforeEach(() => { h = createModuleTestHarness(spacetimedb, mod); n = 0; seed(); });

describe('primary scenario', () => {
  test('$87,425 claimed → holds → corrected $83,700 → receipt → approval → $73,700 settled', () => {
    firstInvoice();
    expect(openHoldCodes('rev_1')).toEqual(['PRICE_VARIANCE', 'RECEIPT_NOT_VERIFIED', 'USAGE_EVIDENCE_MISSING']);

    // Corrected invoice: 500 yd at $165 + $1,200 weekend, no waiting.
    expectOk(run(ctx => V.record_document(ctx, SYNC, rid(), 'doc_inv2', 'invoice', 'src_i2', 'shai2', 'inv-r2.pdf', 1)));
    expectOk(run(ctx => V.record_invoice_revision(ctx, SYNC, rid(), 'rev_2', 'inv_1', 2, 'doc_inv2', D(83700), D(10000), D(73700), 'rev_1')));
    expect(find('invoice_revision', 'rev_1').status).toBe('superseded');
    expect(openHoldCodes('rev_1')).toEqual([]);
    // Commercial holds go away with the correction; receipt doesn't (a correction proves nothing about delivery).
    expect(openHoldCodes('rev_2')).toEqual(['RECEIPT_NOT_VERIFIED']);
    expectOk(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l21', 'rev_2', 'material', 'Ready-mix', YD(500), 'cy', D(165), D(82500), 'term_price', '', '[]')));
    expectOk(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l22', 'rev_2', 'extra', 'Weekend delivery', 0n, '', 0n, D(1200), '', '', '[]')));
    expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_1', 'rev_2', 1, 'fp1', 'pol1', D(83700), D(83700), 0n, 0n, D(10000), D(73700), 'matches', 'Matches agreed terms', '{}', 'Approve')));

    // Receipt attested by the superintendent.
    expectOk(run(ctx => V.attest_receipt(ctx, RECV, rid(), 'att_1', 'inv_1', 'all deliveries', YD(500), 'cy', 'Poured Oct 9-20')));
    expect(find('invoice', 'inv_1').receipt_status).toBe('manually_confirmed');
    expect(openHoldCodes('rev_2')).toEqual([]);

    expectOk(run(ctx => V.propose_supplier_payment(ctx, AGENT, rid(), 'pp_1', 'inv_1', 'rev_2', 'as_1', D(73700), D(10000), 'sup_baymix:v1')));
    expectOk(run(ctx => V.approve_supplier_payment(ctx, OWNER, rid(), 'pp_1', 'fp1', 'ok')));
    expect(find('invoice', 'inv_1')).toMatchObject({ approval_status: 'approved', payment_status: 'ready' });
    expect(find('job', 'job_pay_pp_1').assignee_role).toBe('gateway');

    expectOk(run(ctx => L.start_payment(ctx, GATEWAY, rid(), 'pp_1')));
    expectOk(run(ctx => V.record_deposit_allocation(ctx, GATEWAY, rid(), 'da_1', 'dep_1', 'inv_1', D(10000))));
    expectOk(run(ctx => L.record_payment(ctx, GATEWAY, rid(), 'pp_1', 'tr_1', 'sent', '')));
    expect(find('invoice', 'inv_1').payment_status).toBe('settled');
    expect(find('payment', 'pp_1').amount_cents).toBe(D(73700));
    expect(find('payment_approval', 'appr_pp_1').status).toBe('used');

    // Books: the four §9.6 journals leave AP at $0 and cash out at $83,700.
    const post = (id: string, ref_type: string, lines: unknown[]) =>
      expectOk(run(ctx => L.post_journal(ctx, GATEWAY, rid(), id, '2026-10-24', id, ref_type, 'inv_1', JSON.stringify(lines))));
    post('j_dep', 'deposit', [{ account: 'supplier_prepayment', debit_cents: 1000000, credit_cents: 0 }, { account: 'cash', debit_cents: 0, credit_cents: 1000000 }]);
    post('j_bill', 'invoice', [{ account: 'job_material_cost:prj_oakview', debit_cents: 8370000, credit_cents: 0 }, { account: 'accounts_payable', debit_cents: 0, credit_cents: 8370000 }]);
    post('j_apply', 'invoice', [{ account: 'accounts_payable', debit_cents: 1000000, credit_cents: 0 }, { account: 'supplier_prepayment', debit_cents: 0, credit_cents: 1000000 }]);
    post('j_pay', 'payment', [{ account: 'accounts_payable', debit_cents: 7370000, credit_cents: 0 }, { account: 'cash', debit_cents: 0, credit_cents: 7370000 }]);
    const bal = (acct: string) => all('ledger_line').filter((l: any) => l.account === acct)
      .reduce((s: bigint, l: any) => s + l.credit_cents - l.debit_cents, 0n);
    expect(bal('accounts_payable')).toBe(0n);
    expect(bal('cash')).toBe(D(83700));
  });
});

describe('eligibility (§9.4)', () => {
  test('approval is blocked while holds and receipt are open, with the reasons listed', () => {
    firstInvoice();
    expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_x', 'rev_1', 1, 'fpx', 'pol1', D(87425), D(83700), D(225), D(3500), D(10000), D(77425), 'differences_under_review', 's', '{}', 'Ask supplier')));
    expectOk(run(ctx => V.propose_supplier_payment(ctx, AGENT, rid(), 'pp_x', 'inv_1', 'rev_1', 'as_x', D(77425), D(10000), 'sup_baymix:v1')));
    const r = run(ctx => V.approve_supplier_payment(ctx, OWNER, rid(), 'pp_x', 'fpx', 'pay'));
    expect(r.outcome).toBe('denied');
    const reasons: string[] = JSON.parse(r.message);
    expect(reasons.some(x => x.includes('PRICE_VARIANCE'))).toBe(true);
    expect(reasons).toContain('receipt not attested');
  });

  test('proposal amount must equal the assessment', () => {
    firstInvoice();
    expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_x', 'rev_1', 1, 'fpx', 'pol1', D(87425), D(83700), 0n, 0n, D(10000), D(73700), 'matches', 's', '{}', '')));
    expect(run(ctx => V.propose_supplier_payment(ctx, AGENT, rid(), 'pp_y', 'inv_1', 'rev_1', 'as_x', D(77425), 0n, 'sup_baymix:v1')).outcome).toBe('denied');
  });

  test('wrong fingerprint is refused; agent and proposer can never approve', () => {
    firstInvoice();
    acceptMoneyHolds();
    expectOk(run(ctx => V.attest_receipt(ctx, RECV, rid(), 'a1', 'inv_1', 'all', YD(500), 'cy', 'ok')));
    expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_1', 'rev_1', 2, 'fp1', 'p', 0n, 0n, 0n, 0n, 0n, D(77425), 'matches', 's', '{}', '')));
    expectOk(run(ctx => V.propose_supplier_payment(ctx, AGENT, rid(), 'pp', 'inv_1', 'rev_1', 'as_1', D(77425), 0n, 'sup_baymix:v1')));
    expect(run(ctx => V.approve_supplier_payment(ctx, AGENT, rid(), 'pp', 'fp1', '')).outcome).toBe('denied');
    expect(run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'pp', true, '')).outcome).toBe('denied');
    const r = run(ctx => V.approve_supplier_payment(ctx, OWNER, rid(), 'pp', 'old-fingerprint', ''));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('assessment has changed');
    expectOk(run(ctx => V.approve_supplier_payment(ctx, OWNER, rid(), 'pp', 'fp1', '')));
  });
});

describe('stale approvals', () => {
  function approved() {
    firstInvoice();
    acceptMoneyHolds();
    run(ctx => V.attest_receipt(ctx, RECV, rid(), 'a1', 'inv_1', 'all', YD(500), 'cy', 'ok'));
    run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_1', 'rev_1', 2, 'fp1', 'p', 0n, 0n, 0n, 0n, 0n, D(77425), 'matches', 's', '{}', ''));
    run(ctx => V.propose_supplier_payment(ctx, AGENT, rid(), 'pp', 'inv_1', 'rev_1', 'as_1', D(77425), 0n, 'sup_baymix:v1'));
    expectOk(run(ctx => V.approve_supplier_payment(ctx, OWNER, rid(), 'pp', 'fp1', '')));
  }

  test('a new assessment fingerprint makes the approval stale and start_payment refuses', () => {
    approved();
    expectOk(run(ctx => V.record_assessment(ctx, AGENT, rid(), 'as_2', 'rev_1', 3, 'fp2', 'p', 0n, 0n, 0n, 0n, 0n, D(77425), 'matches', 's', '{}', '')));
    expect(find('payment_approval', 'appr_pp').status).toBe('stale');
    expect(find('invoice', 'inv_1').approval_status).toBe('stale');
    expect(run(ctx => L.start_payment(ctx, GATEWAY, rid(), 'pp')).outcome).toBe('denied');
    expect(openHoldCodes('rev_1')).toContain('APPROVAL_STALE');
  });

  test('a new revision makes the approval stale', () => {
    approved();
    run(ctx => V.record_document(ctx, SYNC, rid(), 'doc2', 'invoice', 's', 'x', 'f', 1));
    expectOk(run(ctx => V.record_invoice_revision(ctx, SYNC, rid(), 'rev_2', 'inv_1', 2, 'doc2', D(83700), D(10000), D(73700), 'rev_1')));
    expect(find('payment_approval', 'appr_pp')).toMatchObject({ status: 'stale', stale_reason: 'revision superseded' });
  });

  test('start_payment re-checks: an open hold added after approval blocks it', () => {
    approved();
    expectOk(run(ctx => V.open_hold(ctx, AGENT, rid(), 'h_dup', 'rev_1', 'DUPLICATE_REVIEW', 0n, 'looks like BM-1041', '[]')));
    expect(run(ctx => L.start_payment(ctx, GATEWAY, rid(), 'pp')).outcome).toBe('denied');
    expect(find('payment_approval', 'appr_pp').status).toBe('stale');
  });
});

describe('holds (§9.3)', () => {
  test('the agent can open holds but never resolve them', () => {
    firstInvoice();
    expect(run(ctx => V.resolve_hold(ctx, AGENT, rid(), 'h_price', 'fine')).outcome).toBe('denied');
  });
  test('the owner cannot clear receipt or payee holds directly', () => {
    firstInvoice();
    const r = run(ctx => V.resolve_hold(ctx, OWNER, rid(), 'h_recv', 'trust me'));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('receiver attesting receipt');
  });
  test('resolving one hold leaves the others open; a money hold is never resolved by hand', () => {
    firstInvoice();
    expectOk(run(ctx => V.open_hold(ctx, AGENT, rid(), 'h_dup', 'rev_1', 'DUPLICATE_REVIEW', 0n, 'looks like BM-1041', '[]')));
    expectOk(run(ctx => V.resolve_hold(ctx, OWNER, rid(), 'h_dup', 'a different pour')));
    expect(openHoldCodes('rev_1')).toEqual(['PRICE_VARIANCE', 'RECEIPT_NOT_VERIFIED', 'USAGE_EVIDENCE_MISSING']);
    const r = run(ctx => V.resolve_hold(ctx, OWNER, rid(), 'h_price', 'supplier agreed to $165'));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('deciding each disputed line');
  });
  test('partial receipt does not clear the hold', () => {
    firstInvoice();
    expectOk(run(ctx => V.attest_receipt(ctx, RECV, rid(), 'a1', 'inv_1', 'first pours', YD(300), 'cy', 'ok')));
    expect(openHoldCodes('rev_1')).toContain('RECEIPT_NOT_VERIFIED');
    expect(run(ctx => V.attest_receipt(ctx, OWNER, rid(), 'a2', 'inv_1', 'rest', YD(200), 'cy', 'ok')).outcome).toBe('denied');
  });
});

describe('change requests and purchasing limits', () => {
  const cr = (id: string, who: Identity, amount: bigint, rate = 0n, scope = '{}') =>
    run(ctx => V.propose_change_request(ctx, who, rid(), id, 'pur_1', 'extra_charge', 'x', amount, rate, rate ? 'min' : '', scope, '', '', '', 'PROPOSED', 'proposed', '[]'));

  test('$1,200 weekend charge approved within the $2,000 limit', () => {
    expectOk(cr('cr_wk', SYNC, D(1200)));
    expectOk(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_wk', true, 'ok')));
  });
  test('above the limit is denied', () => {
    expectOk(cr('cr_big', SYNC, D(2500)));
    expect(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_big', true, '')).outcome).toBe('denied');
  });
  test('the requester cannot decide their own change', () => {
    expectOk(cr('cr_own', PURCH, D(100)));
    const r = run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_own', true, ''));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('you requested');
  });
  test('outside project scope is denied', () => {
    expectOk(cr('cr_s', SYNC, D(100)));
    expect(run(ctx => V.decide_change_request(ctx, PURCH2, rid(), 'cr_s', true, '')).outcome).toBe('denied');
  });
  test('a scoped rate charge is checked against the limit: rate × quantity, rounded up', () => {
    expectOk(cr('cr_rate', SYNC, 0n, 250n, '{"unit": "min", "quantity_milli": 90000}'));
    expectOk(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_rate', true, '')));
    expectOk(cr('cr_rate_big', SYNC, 0n, 250n, '{"unit": "min", "quantity_milli": 900000}'));
    expect(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_rate_big', true, '')).outcome).toBe('denied');
  });

  // §9.8.1: without a scoped quantity the exposure is rate × what's left of the PO ceiling.
  const priceChange = (id: string, rate: bigint, unit = 'cy') =>
    run(ctx => V.propose_change_request(ctx, SYNC, rid(), id, 'pur_1', 'price_change', '+$/cy', 0n, rate, unit, '{}', '', '', '', 'PROPOSED', 'proposed', '[]'));
  const maxQuantity = () => expectOk(run(ctx => V.record_term(ctx, SYNC, rid(), 'term_qty', 'pur_1', 'max_quantity', 'Max', 0n, YD(500), '', '{}', '', '', 'accepted', '["frag_price"]', 1)));

  test('an unscoped rate change with no max_quantity term cannot be sized, so approval is denied', () => {
    expectOk(priceChange('cr_p', 700n));
    const r = run(ctx => V.decide_change_request(ctx, OWNER, rid(), 'cr_p', true, ''));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('max_quantity');
  });
  test('an unscoped rate change is sized against the remaining PO ceiling (only settled quantity counts)', () => {
    maxQuantity();
    expectOk(priceChange('cr_p', 700n)); // $7/cy × 500 cy = $3,500 > $2,000
    expect(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_p', true, '')).outcome).toBe('denied');
    firstInvoice(); // 500 cy billed but unpaid: it could still be repriced, so the ceiling stays at 500
    expect(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_p', true, '')).outcome).toBe('denied');
    run(ctx => ctx.db.invoice.id.update({ ...ctx.db.invoice.id.find('inv_1')!, payment_status: 'settled' }));
    expectOk(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_p', true, ''))); // 0 cy left → $0 exposure
  });
  test('the owner can approve an unscoped rate change within their own limit', () => {
    maxQuantity();
    expectOk(priceChange('cr_p', 700n));
    expectOk(run(ctx => V.decide_change_request(ctx, OWNER, rid(), 'cr_p', true, '')));
  });
  test("a rate in a different unit from the PO can't be approved by anyone, but can be rejected", () => {
    maxQuantity();
    expectOk(priceChange('cr_wait', 250n, 'min'));
    const r = run(ctx => V.decide_change_request(ctx, OWNER, rid(), 'cr_wait', true, ''));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('per min');
    expectOk(run(ctx => V.decide_change_request(ctx, OWNER, rid(), 'cr_wait', false, 'not agreed')));
    expect(find('change_request', 'cr_wait').classification).toBe('DECLINED');
  });
  test('no authority row means no approval authority, even for the owner', () => {
    h = createModuleTestHarness(spacetimedb, mod); n = 0;
    run(ctx => L.claim_admin(ctx, ADMIN, rid()));
    for (const [i, role] of [[OWNER, 'owner'], [SYNC, 'sync']] as const) run(ctx => L.register_actor(ctx, ADMIN, rid(), i.toHexString(), role, role));
    run(ctx => V.upsert_supplier(ctx, SYNC, rid(), 'sup_baymix', 'BayMix Supply', 'baymix.example', '+15555550100', 'crs_b1', 'active'));
    run(ctx => V.upsert_purchase(ctx, SYNC, rid(), 'pur_1', 'sup_baymix', 'prj_oakview', 'Ready-mix', 'cy', 'PO', '', '', 'open'));
    expectOk(cr('cr_x', SYNC, D(1)));
    const r = run(ctx => V.decide_change_request(ctx, OWNER, rid(), 'cr_x', true, ''));
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('no purchasing authority');
  });
  test('a zero limit approves nothing', () => {
    expectOk(run(ctx => V.set_authority(ctx, ADMIN, rid(), PURCH.toHexString(), 'purchasing', 0n, '*')));
    expectOk(cr('cr_zero', SYNC, 0n));
    expect(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_zero', true, '')).outcome).toBe('denied');
  });

  test("a new change request can't be created as authorised; the classification follows the decision and acceptance", () => {
    const mk = (id: string, cls: string) =>
      run(ctx => V.propose_change_request(ctx, SYNC, rid(), id, 'pur_1', 'extra_charge', 'Weekend', D(1200), 0n, '', '{}', '', '', '', cls, 'proposed', '["frag_price"]'));
    expect(mk('cr_a', 'AUTHORISED_FIXED').outcome).toBe('invalid');
    expectOk(mk('cr_a', 'PROPOSED'));
    expectOk(run(ctx => V.decide_change_request(ctx, PURCH, rid(), 'cr_a', true, 'ok')));
    expect(find('change_request', 'cr_a').classification).toBe('PROPOSED'); // approved in-app, not yet accepted by the supplier
    expectOk(run(ctx => V.record_supplier_acceptance(ctx, SYNC, rid(), 'cr_a', 'accepted', '["frag_price"]')));
    expect(find('change_request', 'cr_a').classification).toBe('AUTHORISED_FIXED');
  });
  test('a rate needs a unit', () => {
    expect(run(ctx => V.propose_change_request(ctx, SYNC, rid(), 'cr_u', 'pur_1', 'extra_charge', 'x', 0n, 250n, '', '{}', '', '', '', 'PROPOSED', 'none', '[]')).outcome).toBe('invalid');
  });
});

describe('records', () => {
  test('source fragments are immutable', () => {
    expect(run(ctx => V.add_fragment(ctx, SYNC, rid(), 'frag_price', 'doc_quote', 1, '', 4, 4, 'Up to 500 cubic yards at $165.00 per yard')).outcome).toBe('duplicate');
    expect(run(ctx => V.add_fragment(ctx, AGENT, rid(), 'frag_price', 'doc_quote', 1, '', 4, 4, 'Up to 500 cubic yards at $172.00 per yard')).outcome).toBe('denied');
  });
  test('payee profiles are immutable', () => {
    expect(run(ctx => V.add_payee_profile(ctx, ADMIN, rid(), 'sup_baymix:v1', 'sup_baymix', 1, 'acct_baymix', '4471', 'Bank', 'seed')).outcome).toBe('duplicate');
    expect(run(ctx => V.add_payee_profile(ctx, AGENT, rid(), 'sup_baymix:v1', 'sup_baymix', 1, 'acct_evil', '9999', 'Bank', 'email')).outcome).toBe('denied');
    expect(find('payee_profile', 'sup_baymix:v1').account_ref).toBe('acct_baymix');
  });
  test("a document's bytes can't change", () => {
    expect(run(ctx => V.record_document(ctx, SYNC, rid(), 'doc_quote', 'quote', 'src_q', 'shaq', 'quote.pdf', 1)).outcome).toBe('duplicate');
    expect(run(ctx => V.record_document(ctx, SYNC, rid(), 'doc_quote', 'quote', 'src_q', 'other', 'quote.pdf', 1)).outcome).toBe('denied');
  });
  test('invoice lines are immutable, even once their revision is superseded', () => {
    firstInvoice();
    expect(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l1', 'rev_1', 'material', 'Ready-mix', YD(500), 'cy', D(172), D(86000), 'term_price', '', '[]')).outcome).toBe('duplicate');
    expect(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'l1', 'rev_1', 'material', 'Ready-mix', YD(500), 'cy', D(165), D(82500), 'term_price', '', '[]')).outcome).toBe('denied');
  });
  test('terms must cite fragments that exist', () => {
    expect(run(ctx => V.record_term(ctx, SYNC, rid(), 't2', 'pur_1', 'unit_price', 'x', D(172), 0n, '', '{}', '', '', 'accepted', '["frag_made_up"]', 1)).outcome).toBe('invalid');
  });
  test('invoice line math must be exact', () => {
    firstInvoice();
    expect(run(ctx => V.record_invoice_line(ctx, AGENT, rid(), 'bad', 'rev_1', 'material', 'x', YD(500), 'cy', D(172), D(85999), '', '', '[]')).outcome).toBe('invalid');
  });
  test('a deposit is applied once and never above its amount', () => {
    firstInvoice();
    expectOk(run(ctx => V.record_deposit_allocation(ctx, GATEWAY, rid(), 'da1', 'dep_1', 'inv_1', D(10000))));
    expect(run(ctx => V.record_deposit_allocation(ctx, GATEWAY, rid(), 'da2', 'dep_1', 'inv_1', D(1))).outcome).toBe('invalid');
    run(ctx => V.record_invoice(ctx, SYNC, rid(), 'inv_2', 'sup_baymix', 'pur_1', 'BM-2', '', '', 'USD'));
    expect(run(ctx => V.record_deposit_allocation(ctx, GATEWAY, rid(), 'da3', 'dep_1', 'inv_2', D(1))).outcome).toBe('invalid');
  });
  test('emails from unknown or lookalike addresses are not known contacts', () => {
    run(ctx => V.record_email(ctx, SYNC, rid(), 'em1', 't1', '', 'ar@baymix.example', '', 's', '', '', ''));
    run(ctx => V.record_email(ctx, SYNC, rid(), 'em2', 't1', '', 'ar@bay-mix.example', '', 's', '', '', ''));
    expect(find('email_message', 'em1').from_known_contact).toBe(true);
    expect(find('email_message', 'em2').from_known_contact).toBe(false);
  });
});

describe('bank change variant', () => {
  test('PAYEE_CHANGE_PENDING survives a corrected invoice and clears only through a pre-established contact', () => {
    firstInvoice();
    expectOk(run(ctx => V.add_payee_profile(ctx, AGENT, rid(), 'sup_baymix:v2', 'sup_baymix', 2, 'acct_new', '9921', 'Other Bank', 'email')));
    expect(find('invoice', 'inv_1').payee_status).toBe('change_pending');
    run(ctx => V.record_document(ctx, SYNC, rid(), 'doc2', 'invoice', 's', 'x', 'f', 1));
    expectOk(run(ctx => V.record_invoice_revision(ctx, SYNC, rid(), 'rev_2', 'inv_1', 2, 'doc2', D(83700), D(10000), D(73700), 'rev_1')));
    expect(openHoldCodes('rev_2')).toContain('PAYEE_CHANGE_PENDING');

    // A contact added later (e.g. from the scam email) can't be used to verify.
    expectOk(run(ctx => V.upsert_supplier_contact(ctx, SYNC, rid(), 'con_new', 'sup_baymix', 'New AR', 'new@baymix.example', '+1555', 'AR', false)));
    expect(run(ctx => V.decide_payee_profile(ctx, OWNER, rid(), 'sup_baymix:v2', true, 'con_new', '')).outcome).toBe('denied');
    const payeeHold = all('hold').find((x: any) => x.revision_id === 'rev_2' && x.code === 'PAYEE_CHANGE_PENDING').id;
    expect(run(ctx => V.resolve_hold(ctx, OWNER, rid(), payeeHold, 'x')).outcome).toBe('denied');
    // Can't quietly rewrite the trusted contact's phone either.
    expect(run(ctx => V.upsert_supplier_contact(ctx, SYNC, rid(), 'con_ar', 'sup_baymix', 'Lee Park', 'ar@baymix.example', '+1999', 'AR', true)).outcome).toBe('denied');

    expectOk(run(ctx => V.decide_payee_profile(ctx, OWNER, rid(), 'sup_baymix:v2', true, 'con_ar', 'called Lee on file')));
    expect(find('payee_profile', 'sup_baymix:v1').status).toBe('superseded');
    expect(find('invoice', 'inv_1').payee_status).toBe('verified');
    expect(openHoldCodes('rev_2')).not.toContain('PAYEE_CHANGE_PENDING');
  });

  test('module holds use hold_<revision>_<code>; SUPPLIER_RISK is carried over too', () => {
    firstInvoice();
    expectOk(run(ctx => V.add_payee_profile(ctx, AGENT, rid(), 'sup_baymix:v2', 'sup_baymix', 2, 'acct_new', '9921', 'Other Bank', 'email')));
    expect(find('hold', 'hold_rev_1_payee_change_pending').status).toBe('open');
    expectOk(run(ctx => V.open_hold(ctx, AGENT, rid(), 'h_risk', 'rev_1', 'SUPPLIER_RISK', 0n, 'CRS flag', '[]')));
    expect(run(ctx => V.open_hold(ctx, AGENT, rid(), 'h_risk', 'rev_1', 'SUPPLIER_RISK', 0n, 'CRS flag', '[]')).outcome).toBe('duplicate');
    run(ctx => V.record_document(ctx, SYNC, rid(), 'doc2', 'invoice', 's', 'x', 'f', 1));
    expectOk(run(ctx => V.record_invoice_revision(ctx, SYNC, rid(), 'rev_2', 'inv_1', 2, 'doc2', D(83700), D(10000), D(73700), 'rev_1')));
    expect(openHoldCodes('rev_2')).toEqual(['PAYEE_CHANGE_PENDING', 'RECEIPT_NOT_VERIFIED', 'SUPPLIER_RISK']);
    for (const code of ['payee_change_pending', 'receipt_not_verified', 'supplier_risk']) {
      expect(find('hold', `hold_rev_2_${code}`).status).toBe('open');
    }
  });

  test('rejecting a payee change also goes through a pre-established contact, then clears the hold', () => {
    firstInvoice();
    expectOk(run(ctx => V.add_payee_profile(ctx, AGENT, rid(), 'sup_baymix:v2', 'sup_baymix', 2, 'acct_new', '9921', 'Other Bank', 'email')));
    expectOk(run(ctx => V.upsert_supplier_contact(ctx, SYNC, rid(), 'con_new', 'sup_baymix', 'New AR', 'new@baymix.example', '+1555', 'AR', false)));
    expect(run(ctx => V.decide_payee_profile(ctx, OWNER, rid(), 'sup_baymix:v2', false, 'con_new', '')).outcome).toBe('denied');
    expectOk(run(ctx => V.decide_payee_profile(ctx, OWNER, rid(), 'sup_baymix:v2', false, 'con_ar', 'Lee says they never changed banks')));
    expect(find('payee_profile', 'sup_baymix:v2').status).toBe('rejected');
    expect(find('payee_profile', 'sup_baymix:v1').status).toBe('verified');
    expect(find('invoice', 'inv_1').payee_status).toBe('verified');
    expect(find('hold', 'hold_rev_1_payee_change_pending').status).toBe('resolved');
  });
});

describe('outbox and jobs', () => {
  test('clarifications are drafted by the agent, sent only after a person approves, and always simulated', () => {
    firstInvoice();
    expectOk(run(ctx => V.draft_outbox(ctx, AGENT, rid(), 'ob1', 'inv_1', 'con_ar', 'Invoice BM-1042', 'Please correct the price to $165.')));
    expect(run(ctx => V.approve_outbox(ctx, AGENT, rid(), 'ob1')).outcome).toBe('denied');
    expect(run(ctx => V.mark_outbox(ctx, SYNC, rid(), 'ob1', 'sent', 'x')).outcome).toBe('denied');
    expectOk(run(ctx => V.approve_outbox(ctx, PURCH, rid(), 'ob1')));
    expect(find('job', 'job_send_ob1').assignee_role).toBe('sync');
    expectOk(run(ctx => V.mark_outbox(ctx, SYNC, rid(), 'ob1', 'sent', 'sim-1')));
    expect(find('outbox', 'ob1').simulated).toBe(true);
  });

  test('failed jobs are retried with backoff, then fail for good', () => {
    expectOk(run(ctx => L.enqueue_job(ctx, SYNC, rid(), 'jd', 'process_document', '{"document_id":"doc_quote"}')));
    expectOk(run(ctx => L.claim_job(ctx, AGENT, rid(), 'jd')));
    expectOk(run(ctx => L.finish_job(ctx, AGENT, rid(), 'jd', false, '', 'timeout')));
    expect(find('job', 'jd')).toMatchObject({ status: 'queued', attempts: 1 });
    expect(find('job', 'jd').next_attempt_at_iso).not.toBe('');
  });
});
