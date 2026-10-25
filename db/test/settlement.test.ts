// CONTRACT §9.9 v2.2 settlement decisions, rule for rule with core/tests/test_supplier_settlement.py. The opening state
// and the "BayMix won't correct" path are replayed from the seeds Python records on its reference (the agent's
// reassessments included); the people's and the gateway's calls are made here.
import { describe, test, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { Identity } from 'spacetimedb';
import spacetimedb from '../src/schema';
import * as mod from '../src/index';
import * as L from '../src/logic';
import * as V from '../src/logic_v2';
import { REDUCER_ARGS } from '../src/reducer_args';
import type { Ctx } from '../src/schema';

const ROLES = { admin: 1, owner: 2, bookkeeper: 3, agent: 4, gateway: 5, sync: 6, purchasing: 7, receiver: 8 } as const;
type Role = keyof typeof ROLES;
const ID = Object.fromEntries(Object.entries(ROLES).map(([r, n]) => [r, new Identity('0x' + n.toString(16).padStart(64, '0'))])) as Record<Role, Identity>;
const FNS: Record<string, (...a: any[]) => { outcome: string; message: string }> = { ...L, ...V } as any;
const SEEDS = resolve(__dirname, '../../data/seeds');

const INV = 'inv_bm23104', REV1 = 'rev_bm23104_r1';
const PRICE = 'ln_bm23104_r1_1', WEEKEND = 'ln_bm23104_r1_2', WAITING = 'ln_bm23104_r1_3';
const AR = 'ctc_baymix_ar';
const holdId = (code: string, rev = REV1) => `hold_${rev}_${code.toLowerCase()}`;

let h: any;
let n = 0;
const run = <T>(fn: (ctx: Ctx) => T): T => h.withReducerTx(TestAuth.internal(), (ctx: any) => fn(ctx as Ctx));
const call = (role: Role, reducer: string, ...args: unknown[]) => run(ctx => FNS[reducer](ctx, ID[role], `t${++n}`, ...args));
const all = (t: string) => [...h.db[t].iter()] as any[];
const find = (t: string, id: string) => h.db[t].id.find(id);
const expectOk = (r: { outcome: string; message: string }) => expect(r, r.message).toMatchObject({ outcome: 'ok' });

function replay(name: string) {
  for (const c of JSON.parse(readFileSync(resolve(SEEDS, name), 'utf8')) as { role: Role; reducer: string; args: Record<string, unknown> }[]) {
    const args = REDUCER_ARGS[c.reducer].slice(1).map(name => {
      const raw = c.args[name];
      const v = typeof raw === 'string' && raw.startsWith('<identity:') ? ID[raw.slice(10, -1) as Role].toHexString() : raw;
      return (name.endsWith('_cents') || name.endsWith('_milli')) && v != null ? BigInt(v as any) : v;
    });
    const r = call(c.role, c.reducer, ...args);
    expect(['ok', 'duplicate'], `${name} ${c.reducer}: ${r.message}`).toContain(r.outcome);
  }
}

const latestFp = (rev = REV1) => all('assessment').filter(a => a.revision_id === rev).sort((a, b) => b.version - a.version)[0].fingerprint;
const decide = (id: string, line: string, decision: string, cents: bigint, o: { note?: string; contact?: string; fp?: string; role?: Role } = {}) =>
  call(o.role ?? 'owner', 'decide_disputed_line', id, line, decision, cents,
    o.fp ?? latestFp(), o.contact ?? (decision === 'pay_agreed_dispute_rest' ? AR : ''), o.note ?? "BayMix won't correct; pay what was agreed");
const deniedAudit = (action: string, entity_id: string) =>
  all('audit_log').some(a => a.action === action && a.outcome === 'denied' && a.entity_id === entity_id);

beforeEach(() => {
  h = createModuleTestHarness(spacetimedb, mod);
  n = 0;
  expectOk(run(ctx => L.claim_admin(ctx, ID.admin, 't0')));  // as the reset does before loading the seed
  replay('baymix_opening.json');
});

describe("BayMix won't correct (§9.9)", () => {
  test('pay agreed, dispute the rest: $73,700 paid, partially settled, $3,725 still open', () => {
    replay('baymix_wont_correct.json');
    expect(find('hold', holdId('PRICE_VARIANCE')).status).toBe('disputed');
    expect(find('hold', holdId('PROPOSED_CHARGE')).status).toBe('disputed');
    expect(find('invoice', INV).commercial_status).toBe('partially_disputed');
    const notices = all('settlement_decision').map(d => find('outbox', d.outbox_id));
    expect(notices.map(o => o.subject).sort()).toEqual([
      'Invoice BM-23104: paying the agreed amount, $225.00 disputed',
      'Invoice BM-23104: paying the agreed amount, $3,500.00 disputed',
    ]);
    expect(notices.every(o => o.status === 'sent' && o.simulated && !o.body.includes("won't correct"))).toBe(true);  // the note stays internal

    const p = all('proposal').find(x => x.work_item_id === `wi_${INV}` && x.status === 'pending');
    expect(p.amount_cents).toBe(7370000n);
    expectOk(call('owner', 'approve_supplier_payment', p.id, latestFp(), 'Agreed part'));  // disputed holds don't block approval
    expectOk(call('gateway', 'start_payment', p.id));
    expectOk(call('gateway', 'record_payment', p.id, 'tr_1', 'sent', ''));
    const inv = find('invoice', INV);
    expect(inv.payment_status).toBe('partially_settled');
    expect(inv.next_action).toContain('$3,725.00 still disputed');
    expect(find('payment_approval', `appr_${p.id}`).status).toBe('used');
    const open = all('settlement_decision').filter(d => d.status === 'active').reduce((t, d) => t + d.amount_cents, 0n);
    expect(open).toBe(372500n);
  });

  test('an unsent notice blocks approval and start_payment', () => {
    replay('baymix_wont_correct.json');
    const p = all('proposal').find(x => x.work_item_id === `wi_${INV}` && x.status === 'pending');
    const ob = find('outbox', 'ob_dec_bm_price');
    run(ctx => ctx.db.outbox.id.update({ ...ob, status: 'approved' }));  // as if the notice never went out
    const r = call('owner', 'approve_supplier_payment', p.id, latestFp(), 'Agreed part');
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('notice to supplier not sent');
    run(ctx => ctx.db.outbox.id.update({ ...ob, status: 'sent' }));
    expectOk(call('owner', 'approve_supplier_payment', p.id, latestFp(), 'Agreed part'));
    run(ctx => ctx.db.outbox.id.update({ ...ob, status: 'approved' }));
    expect(call('gateway', 'start_payment', p.id).outcome).toBe('denied');
    expect(find('payment_approval', `appr_${p.id}`).status).toBe('stale');
  });
});

describe('decide_disputed_line', () => {
  test('accept_as_billed creates the settlement change request and resolves the hold', () => {
    expectOk(decide('dec_wait', WAITING, 'accept_as_billed', 22500n, { note: 'Trucks really waited' }));
    expect(find('hold', holdId('PROPOSED_CHARGE')).status).toBe('resolved');
    const cr = find('change_request', 'cr_dec_wait');
    expect(cr).toMatchObject({ kind: 'settlement', amount_cents: 22500n, classification: 'AUTHORISED_FIXED', supplier_acceptance: 'accepted',
      internal_status: 'approved', decided_by_role: 'owner', requested_by_identity: '' });
    expect(JSON.parse(cr.scope_json)).toEqual({ invoice_line_id: WAITING, settlement_decision_id: 'dec_wait' });
    expect(find('settlement_decision', 'dec_wait')).toMatchObject({ outbox_id: '', status: 'active', amount_cents: 22500n });
    expect(find('job', 'job_reassess_dec_wait')).toMatchObject({ kind: 'reassess_invoice', assignee_role: 'agent', status: 'queued' });
  });

  test('pay_agreed_dispute_rest drafts the notice and disputes the hold', () => {
    expectOk(decide('dec_price', PRICE, 'pay_agreed_dispute_rest', 350000n));
    expect(find('hold', holdId('PRICE_VARIANCE')).status).toBe('disputed');
    expect(find('outbox', 'ob_dec_price')).toMatchObject({ status: 'draft', simulated: true, created_by_role: 'owner', to_contact_id: AR });
  });

  test('only the owner decides', () => {
    expect(decide('d', PRICE, 'pay_agreed_dispute_rest', 350000n, { role: 'purchasing' }).outcome).toBe('denied');
  });

  test('a stale fingerprint is denied and logged', () => {
    const r = decide('dec_x', PRICE, 'pay_agreed_dispute_rest', 350000n, { fp: 'fp_old' });
    expect(r).toMatchObject({ outcome: 'denied', message: 'the assessment changed; review it again' });
    expect(deniedAudit('decide_disputed_line', 'dec_x')).toBe(true);
    expect(find('settlement_decision', 'dec_x')).toBeFalsy();
    expect(find('outbox', 'ob_dec_x')).toBeFalsy();
  });

  test('accept_as_billed above the caller\'s limit is denied; pay agreed has no limit check', () => {
    expectOk(call('admin', 'set_authority', ID.owner.toHexString(), 'owner', 100000n, '*'));  // $1,000
    const r = decide('dec_price', PRICE, 'accept_as_billed', 350000n);
    expect(r.outcome).toBe('denied');
    expect(r.message).toContain('above your approval limit');
    expect(deniedAudit('decide_disputed_line', 'dec_price')).toBe(true);
    expect(find('hold', holdId('PRICE_VARIANCE')).status).toBe('open');
    expectOk(decide('dec_price', PRICE, 'pay_agreed_dispute_rest', 350000n));
  });

  test('invalid decisions change nothing', () => {
    expectOk(call('sync', 'upsert_supplier', 'sup_other', 'Other Aggregate Co', 'other-agg.example', '(510) 555-0170', '', 'active'));
    expectOk(call('sync', 'upsert_supplier_contact', 'ctc_other', 'sup_other', 'Pat Doe', 'pat@other-agg.example', '(510) 555-0171', 'AR', true));
    const audits = all('audit_log').length;
    const cases = [
      decide('d1', PRICE, 'pay_agreed_dispute_rest', 349999n),  // not the disputed amount
      decide('d2', WEEKEND, 'pay_agreed_dispute_rest', 120000n),  // agreed, not disputed
      decide('d3', PRICE, 'pay_agreed_dispute_rest', 350000n, { note: '  ' }),
      decide('d4', PRICE, 'pay_agreed_dispute_rest', 350000n, { contact: 'ctc_other' }),
      decide('d5', PRICE, 'accept_as_billed', 350000n, { contact: AR }),
      decide('d6', PRICE, 'split_the_difference', 350000n),
      decide('d7', 'ln_nope', 'pay_agreed_dispute_rest', 350000n),
    ];
    expect(cases.map(r => r.outcome)).toEqual(Array(cases.length).fill('invalid'));
    expect(all('audit_log').length).toBe(audits);
    expect(all('settlement_decision')).toEqual([]);
    expectOk(decide('d8', PRICE, 'pay_agreed_dispute_rest', 350000n));
    expect(decide('d9', PRICE, 'accept_as_billed', 350000n).outcome).toBe('invalid');  // the line already has a decision
    expect(decide('d8', PRICE, 'pay_agreed_dispute_rest', 350000n).outcome).toBe('duplicate');
  });

  test('propose_change_request cannot create a settlement', () => {
    const r = call('agent', 'propose_change_request', 'cr_fake', 'pur_baymix_oak', 'settlement', 'Settle it', 350000n, 0n, '', '{}', '', '', '',
      'PROPOSED', 'none', '["frag_bm_inv_23104_r1_p1_l11"]');
    expect(r.outcome).toBe('invalid');
  });
});

describe('resolve_hold and corrections (§9.9)', () => {
  test.each(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING'])(
    'resolve_hold on %s is denied and logged, open or disputed', code => {
      const id = holdId(code);
      if (!find('hold', id)) expectOk(call('agent', 'open_hold', id, REV1, code, 100n, `${code} for the test`, '{}'));
      const r = call('owner', 'resolve_hold', id, 'Looks fine to me');
      expect(r.outcome).toBe('denied');
      expect(r.message).toContain('deciding each disputed line');
      expect(deniedAudit('resolve_hold', id)).toBe(true);
      expect(find('hold', id).status).toBe('open');
    });

  test('a disputed hold is still never resolved by hand', () => {
    replay('baymix_wont_correct.json');
    expect(call('owner', 'resolve_hold', holdId('PRICE_VARIANCE'), 'done').outcome).toBe('denied');
  });

  test('a corrected revision supersedes the decisions and the disputed holds', () => {
    replay('baymix_wont_correct.json');
    replay('baymix_correction.json');
    expect(all('settlement_decision').map(d => d.status)).toEqual(['superseded', 'superseded']);
    expect(find('hold', holdId('PRICE_VARIANCE')).status).toBe('superseded');
    expect(find('hold', holdId('PROPOSED_CHARGE')).status).toBe('superseded');
    expect(find('invoice', INV).active_revision_id).toBe('rev_bm23104_r2');
  });
});
