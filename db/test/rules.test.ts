import { describe, test, expect, beforeEach } from 'vitest';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { Identity } from 'spacetimedb';
import spacetimedb from '../src/schema';
import * as mod from '../src/index';
import * as L from '../src/logic';
import type { Ctx } from '../src/schema';

const ident = (n: number) => new Identity('0x' + n.toString(16).padStart(64, '0'));
const ADMIN = ident(1), OWNER = ident(2), BOOK = ident(3), AGENT = ident(4), GATEWAY = ident(5), SYNC = ident(6), JUDGE = ident(99);

let h: ReturnType<typeof createModuleTestHarness<any>>;
let n = 0;
const rid = () => `req_${++n}`;
const run = <T>(fn: (ctx: Ctx) => T): T => h.withReducerTx(TestAuth.internal(), ctx => fn(ctx as unknown as Ctx));
const rows = (table: string) => [...(h.db as any)[table].iter()];
const deniedAudits = () => rows('audit_log').filter((r: any) => r.outcome === 'denied');

const ACCT = 'nessie_acct_framing';

function seed() {
  run(ctx => L.claim_admin(ctx, ADMIN, rid()));
  for (const [i, role] of [[OWNER, 'owner'], [BOOK, 'bookkeeper'], [AGENT, 'agent'], [GATEWAY, 'gateway'], [SYNC, 'sync']] as const) {
    run(ctx => L.register_actor(ctx, ADMIN, rid(), i.toHexString(), role, role));
  }
  run(ctx => L.upsert_project(ctx, SYNC, rid(), 'prj_oak', 'Oak St remodel', '1 Oak St', 'active'));
  run(ctx => L.upsert_sub(ctx, SYNC, rid(), 'sub_framing', 'Ridgeline Framing', 'framing', 'CA123', 'CA',
    'ap@ridgelineframing.example', 'ridgelineframing.example', '+15555550101', ACCT, '4471', 'Ridgeline Framing LLC', 'crs_1', 'active'));
  run(ctx => L.upsert_contract(ctx, SYNC, rid(), 'ctr_framing', 'sub_framing', 'prj_oak', 'Framing', 12000000n, 1000, 30,
    'conditional_progress_each_bill', 'Bank changes need written notice and a callback.', ''));
  run(ctx => L.confirm_contract(ctx, OWNER, rid(), 'ctr_framing'));
  run(ctx => L.record_bill(ctx, SYNC, rid(), 'bill_1', 'sub_framing', 'ctr_framing', '', 'INV-1042', '2026-10-01', '2026-10-31',
    'Oct', 4200000n, 420000n, 'Bank', ACCT, '4471', 'ap@ridgelineframing.example', true, '{}'));
  run(ctx => L.create_work_item(ctx, SYNC, rid(), 'wi_1', 'bill', 'bill_1', 'seed', 'Ridgeline Oct bill'));
  run(ctx => L.set_work_item_state(ctx, AGENT, rid(), 'wi_1', 'investigating', ''));
}

const proposePayment = (who = AGENT, account = ACCT, id = 'prop_1') =>
  run(ctx => L.propose(ctx, who, rid(), id, 'wi_1', 'payment', 3780000n, 'sub_framing', account, 'All checks pass', '[]'));
const proposeHold = (id = 'hold_1') =>
  run(ctx => L.propose(ctx, AGENT, rid(), id, 'wi_1', 'hold', 3780000n, 'sub_framing', ACCT, 'Bank mismatch', '[]'));
const item = () => (h.db as any).work_item.id.find('wi_1');

beforeEach(() => { h = createModuleTestHarness(spacetimedb, mod); n = 0; seed(); });

describe('module loads', () => {
  test('seed works and every setup call succeeded', () => {
    expect(rows('request_result').every((r: any) => r.outcome === 'ok')).toBe(true);
    expect(item().state).toBe('investigating');
  });
});

describe('separation of duties', () => {
  test('agent can never approve', () => {
    proposePayment();
    const r = run(ctx => L.decide_proposal(ctx, AGENT, rid(), 'prop_1', true, ''));
    expect(r.outcome).toBe('denied');
    expect((h.db as any).proposal.id.find('prop_1').status).toBe('pending');
  });

  test('bookkeeper cannot approve payments', () => {
    proposePayment();
    expect(run(ctx => L.decide_proposal(ctx, BOOK, rid(), 'prop_1', true, '')).outcome).toBe('denied');
  });

  test('owner approves -> item approved and a pay job for the gateway', () => {
    proposePayment();
    expect(run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'prop_1', true, 'ok')).outcome).toBe('ok');
    expect(item().state).toBe('approved');
    const job = (h.db as any).job.id.find('job_pay_prop_1');
    expect(job.assignee_role).toBe('gateway');
  });

  test('nobody can decide their own proposal', () => {
    // Make the owner the proposer by registering the owner's identity as agent is not possible,
    // so simulate: a proposal row whose proposer is the owner.
    proposePayment();
    run(ctx => { const p = ctx.db.proposal.id.find('prop_1')!; ctx.db.proposal.id.update({ ...p, proposed_by_identity: OWNER.toHexString() }); });
    expect(run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'prop_1', true, '')).outcome).toBe('denied');
  });

  test('only the gateway records payments', () => {
    proposePayment();
    run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'prop_1', true, ''));
    expect(run(ctx => L.start_payment(ctx, AGENT, rid(), 'prop_1')).outcome).toBe('denied');
    expect(run(ctx => L.record_payment(ctx, OWNER, rid(), 'prop_1', 't1', 'sent', '')).outcome).toBe('denied');
    expect(run(ctx => L.start_payment(ctx, GATEWAY, rid(), 'prop_1')).outcome).toBe('ok');
    expect(run(ctx => L.record_payment(ctx, GATEWAY, rid(), 'prop_1', 't1', 'sent', '')).outcome).toBe('ok');
    expect(item().state).toBe('paid');
    expect(run(ctx => L.record_payment(ctx, GATEWAY, rid(), 'prop_1', 't1', 'sent', '')).outcome).toBe('duplicate');
  });
});

describe('payee and bank rules', () => {
  test('payment to an account that does not match the sub on file is denied', () => {
    const r = proposePayment(AGENT, 'nessie_acct_scammer');
    expect(r.outcome).toBe('denied');
    expect(item().state).toBe('investigating');
  });

  test('bank fields cannot change through upsert_sub (quiet bank edit)', () => {
    const r = run(ctx => L.upsert_sub(ctx, SYNC, rid(), 'sub_framing', 'Ridgeline Framing', 'framing', 'CA123', 'CA',
      'ap@ridgelineframing.example', 'ridgelineframing.example', '+15555550101', 'nessie_acct_scammer', '9921', 'Someone', 'crs_1', 'active'));
    expect(r.outcome).toBe('denied');
    expect((h.db as any).sub.id.find('sub_framing').bank_account_ref).toBe(ACCT);
    expect(deniedAudits().some((a: any) => a.reason.includes('quiet bank edit'))).toBe(true);
  });

  test('confirmed contract cannot be edited', () => {
    const r = run(ctx => L.upsert_contract(ctx, AGENT, rid(), 'ctr_framing', 'sub_framing', 'prj_oak', 'Framing', 99999999n, 0, 30, 'none', '', ''));
    expect(r.outcome).toBe('denied');
  });
});

describe('holds', () => {
  test('pay anyway is denied when a hard-stop check failed', () => {
    run(ctx => L.record_check(ctx, AGENT, rid(), 'wi_1', 'bank_mismatch', 'fail', 'Remit-to account ending 9921 is not the account on file (4471)', '{}', 'contract'));
    proposeHold();
    expect(item().state).toBe('held');
    const r = run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'hold_1', false, 'just pay it'));
    expect(r.outcome).toBe('denied');
    expect(r.message).toMatch(/^Can't pay: .*Start a bank change verification instead\.$/);
    expect(item().state).toBe('held');
  });

  test('pay anyway on a soft check -> override_requested and a job for the agent', () => {
    run(ctx => L.record_check(ctx, AGENT, rid(), 'wi_1', 'lien_waiver_missing', 'fail', 'No lien waiver', '{}', 'document'));
    proposeHold();
    expect(run(ctx => L.decide_proposal(ctx, OWNER, rid(), 'hold_1', false, 'waiver is coming')).outcome).toBe('ok');
    expect(item().state).toBe('override_requested');
    expect((h.db as any).job.id.find('job_override_hold_1').assignee_role).toBe('agent');
    // agent may now propose payment despite the soft failure
    expect(proposePayment(AGENT, ACCT, 'prop_2').outcome).toBe('ok');
  });

  test('agent cannot walk away from a hold', () => {
    proposeHold();
    expect(run(ctx => L.set_work_item_state(ctx, AGENT, rid(), 'wi_1', 'investigating', '')).outcome).toBe('denied');
    expect(proposePayment(AGENT, ACCT, 'prop_9').outcome).toBe('denied');
    expect(run(ctx => L.cancel_proposal(ctx, AGENT, rid(), 'hold_1', '')).outcome).toBe('denied');
  });

  test('a failed check cannot be rewritten as pass', () => {
    run(ctx => L.record_check(ctx, AGENT, rid(), 'wi_1', 'duplicate', 'fail', 'Same invoice as INV-1041', '{}', 'history'));
    expect(run(ctx => L.record_check(ctx, AGENT, rid(), 'wi_1', 'duplicate', 'pass', 'fine', '{}', 'history')).outcome).toBe('denied');
  });

  test('fail safe: an errored check blocks a payment proposal', () => {
    run(ctx => L.record_check(ctx, AGENT, rid(), 'wi_1', 'crs_liens_judgments', 'error', 'CRS timed out', '{}', 'crs'));
    expect(proposePayment().outcome).toBe('denied');
  });

  test('agent can only move items to its allowed states', () => {
    expect(run(ctx => L.set_work_item_state(ctx, AGENT, rid(), 'wi_1', 'approved', '')).outcome).toBe('denied');
    expect(run(ctx => L.set_work_item_state(ctx, AGENT, rid(), 'wi_1', 'paid', '')).outcome).toBe('denied');
  });
});

describe('ledger', () => {
  test('journal must balance', () => {
    const bad = JSON.stringify([{ account: 'cash', debit_cents: 0, credit_cents: 100 }, { account: 'accounts_payable', debit_cents: 90, credit_cents: 0 }]);
    expect(run(ctx => L.post_journal(ctx, GATEWAY, rid(), 'jrnl_1', '2026-10-24', 'pay', 'payment', 'prop_1', bad)).outcome).toBe('invalid');
    const good = JSON.stringify([{ account: 'cash', debit_cents: 0, credit_cents: 100 }, { account: 'accounts_payable', debit_cents: 100, credit_cents: 0 }]);
    expect(run(ctx => L.post_journal(ctx, GATEWAY, rid(), 'jrnl_1', '2026-10-24', 'pay', 'payment', 'prop_1', good)).outcome).toBe('ok');
    expect(rows('ledger_line').length).toBe(2);
  });
});

describe('request pattern', () => {
  test('duplicate request_id is a no-op', () => {
    const r1 = run(ctx => L.upsert_project(ctx, SYNC, 'same', 'prj_x', 'X', '', 'active'));
    const r2 = run(ctx => L.upsert_project(ctx, SYNC, 'same', 'prj_x', 'Y', '', 'active'));
    expect(r1.outcome).toBe('ok');
    expect(r2.outcome).toBe('duplicate');
    expect((h.db as any).project.id.find('prj_x').name).toBe('X');
  });

  test('denials leave an audit row and a request_result, and do not throw', () => {
    const before = deniedAudits().length;
    const r = run(ctx => L.upsert_project(ctx, JUDGE, 'judge_req', 'prj_y', 'Y', '', 'active'));
    expect(r.outcome).toBe('denied');
    expect(deniedAudits().length).toBe(before + 1);
    expect((h.db as any).request_result.request_id.find('judge_req').outcome).toBe('denied');
  });

  test('second admin claim is denied', () => {
    expect(run(ctx => L.claim_admin(ctx, JUDGE, rid())).outcome).toBe('denied');
  });
});

describe('jobs', () => {
  test('public can enqueue scams, max 3 queued', () => {
    for (let i = 0; i < 3; i++) {
      expect(run(ctx => L.enqueue_job(ctx, JUDGE, rid(), `job_s${i}`, 'scam_submit', '{}')).outcome).toBe('ok');
    }
    expect(run(ctx => L.enqueue_job(ctx, JUDGE, rid(), 'job_s4', 'scam_submit', '{}')).outcome).toBe('denied');
  });

  test('public cannot enqueue system jobs', () => {
    expect(run(ctx => L.enqueue_job(ctx, JUDGE, rid(), 'job_p', 'pay_proposal', '{"proposal_id":"x"}')).outcome).toBe('denied');
    expect(run(ctx => L.enqueue_job(ctx, OWNER, rid(), 'job_p2', 'pay_proposal', '{"proposal_id":"x"}')).outcome).toBe('denied');
  });

  test('claim and finish by the assignee only', () => {
    run(ctx => L.enqueue_job(ctx, JUDGE, rid(), 'job_a', 'scam_submit', '{}'));
    expect(run(ctx => L.claim_job(ctx, AGENT, rid(), 'job_a')).outcome).toBe('denied');
    expect(run(ctx => L.claim_job(ctx, SYNC, rid(), 'job_a')).outcome).toBe('ok');
    expect(run(ctx => L.finish_job(ctx, AGENT, rid(), 'job_a', true, '{}', '')).outcome).toBe('denied');
    expect(run(ctx => L.finish_job(ctx, SYNC, rid(), 'job_a', true, '{"work_item_id":"wi_1"}', '')).outcome).toBe('ok');
    expect((h.db as any).job.id.find('job_a').status).toBe('done');
  });
});
