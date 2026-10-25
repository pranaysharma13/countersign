// LOCAL DEMO BACKEND — runs the real module in-process (spacetimedb test harness), seeded with the
// SPEC §8 BayMix scenario. Used by the web app when no SpacetimeDB server is reachable, and as an
// offline fallback for judging. A small stand-in worker plays the agent, the gateway and the supplier
// (all clearly labeled simulated). It is NOT the Python agent; with a live server, Python does this.
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { Identity, Timestamp } from 'spacetimedb';
import spacetimedb from '../src/schema';
import * as mod from '../src/index';
import * as L from '../src/logic';
import * as V from '../src/logic_v2';
import { REDUCER_ARGS } from '../src/reducer_args';
export { REDUCER_ARGS };
import type { Ctx } from '../src/schema';

export const PERSONAS = {
  admin: { n: 1, name: 'Setup script' },
  owner: { n: 2, name: 'Dana Marlow' },
  bookkeeper: { n: 3, name: 'Sam Okafor' },
  agent: { n: 4, name: 'Countersign agent' },
  gateway: { n: 5, name: 'Payment gateway' },
  sync: { n: 6, name: 'Intake' },
  purchasing: { n: 7, name: 'Jordan Reyes' },
  receiver: { n: 8, name: 'Ana Ruiz' },
} as const;
export type Persona = keyof typeof PERSONAS;
const ident = (n: number) => new Identity('0x' + n.toString(16).padStart(64, '0'));
const ID = Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, ident(v.n)])) as Record<Persona, Identity>;
const FNS: Record<string, (...a: any[]) => { outcome: string; message: string }> = { ...L, ...V } as any;

const D = (dollars: number) => BigInt(Math.round(dollars * 100));
const YD = (y: number) => BigInt(y * 1000);
const j = (v: unknown) => JSON.stringify(v);

export class LocalBackend {
  private h: any;
  private n = 0;
  private clockMicros = BigInt(Date.UTC(2026, 9, 23, 16, 5)) * 1000n; // Oct 23, 9:05 AM PT

  constructor() { this.reset(); }

  reset() {
    this.h = createModuleTestHarness(spacetimedb, mod);
    this.n = 0;
    this.seed();
  }

  private tick() {
    this.clockMicros += 7_000_000n;
    this.h.clock.set(new Timestamp(this.clockMicros));
  }

  private callAs(p: Persona, reducer: string, ...args: unknown[]) {
    const fn = FNS[reducer];
    if (!fn) throw new Error(`unknown reducer ${reducer}`);
    this.tick();
    const rid = `local_${++this.n}`;
    return this.h.withReducerTx(TestAuth.internal(), (ctx: Ctx) => fn(ctx, ID[p], rid, ...args));
  }

  private must(p: Persona, reducer: string, ...args: unknown[]) {
    const r = this.callAs(p, reducer, ...args);
    if (r.outcome !== 'ok' && r.outcome !== 'duplicate') throw new Error(`seed ${reducer}: ${r.outcome} ${r.message}`);
    return r;
  }

  /** Called by the web app: positional args (request_id excluded), like the HTTP API. */
  call(persona: Persona, reducer: string, args: unknown[]) {
    const names = REDUCER_ARGS[reducer];
    if (!names) return { outcome: 'invalid', message: `unknown reducer ${reducer}` };
    const typed = args.map((v, i) => {
      const name = names[i + 1] ?? '';
      return (name.endsWith('_cents') || name.endsWith('_milli')) && v !== null && v !== undefined ? BigInt(v as any) : v;
    });
    const r = this.callAs(persona, reducer, ...typed);
    this.work(); // stand-in worker reacts to the new state
    return r;
  }

  state(tables: string[]) {
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      const tbl = this.h.db[t];
      if (!tbl) continue;
      out[t] = [...tbl.iter()].map(toJson);
    }
    return out;
  }

  // ---------------------------------------------------------------- stand-in worker (simulated)

  private q = (table: string) => [...this.h.db[table].iter()] as any[];

  private step(kind: string, title: string, detail: unknown = {}) {
    this.callAs('agent', 'log_agent_step', 'wi_inv_1042', kind, title, j(detail));
  }

  private work() {
    for (let guard = 0; guard < 10; guard++) {
      const job = this.q('job').find(x => x.status === 'queued' && ['send_outbox', 'pay_supplier'].includes(x.kind));
      if (job) { this.runJob(job); continue; }
      if (this.maybePropose()) continue;
      break;
    }
  }

  private runJob(job: any) {
    this.callAs(job.assignee_role, 'claim_job', job.id);
    const payload = JSON.parse(job.payload_json);
    if (job.kind === 'send_outbox') {
      this.callAs('sync', 'mark_outbox', payload.outbox_id, 'sent', `simulated-${payload.outbox_id}`);
      this.supplierCorrects();
    } else if (job.kind === 'pay_supplier') {
      this.settle(payload.proposal_id);
    }
    this.callAs(job.assignee_role, 'finish_job', job.id, true, '{}', '');
  }

  /** Simulated supplier reply (SPEC §8 resolution): agree to $165, remove waiting, send corrected invoice. */
  private supplierCorrects() {
    if (this.h.db.invoice_revision.id.find('rev_1042_2')) return;
    this.must('sync', 'record_document', 'doc_reply', 'email', 'src_reply', 'sha_reply', 'reply.eml', 1);
    this.must('sync', 'add_fragment', 'frag_reply', 'doc_reply', 0, 'em_reply', 1, 3,
      'You are right, the price is fixed at $165.00 through Oct 31 and no waiting time was agreed. Corrected invoice BM-1042-R attached. (SIMULATED SUPPLIER REPLY)');
    this.must('sync', 'record_email', 'em_reply', 'thr_clarify', 'doc_reply', 'ar@baymix.example', 'ap@marlowfinch.example',
      'RE: Invoice BM-1042: price and waiting charge', '2026-10-24T10:12:00-07:00', '2026-10-24T10:12:30-07:00', 'frag_reply');
    this.must('sync', 'record_document', 'doc_inv2', 'invoice', 'src_inv2', 'sha_inv2', 'BM-1042-R.pdf', 1);
    for (const [id, line, text] of [
      ['frag_r_l1', 14, 'Ready-mix 4000 psi   500.000 cy   @ $165.00   $82,500.00'],
      ['frag_r_l2', 15, 'Weekend delivery Oct 11   $1,200.00'],
      ['frag_r_tot', 19, 'Total $83,700.00 · Less deposit received ($10,000.00) · Balance due $73,700.00'],
    ] as const) this.must('sync', 'add_fragment', id, 'doc_inv2', 1, '', line, line, text);
    this.must('agent', 'record_extraction_run', 'ext_inv2', 'doc_inv2', 'fixture', 'fixture', 'extract-v1', 'ok', '', '{}');
    this.must('sync', 'record_invoice_revision', 'rev_1042_2', 'inv_1042', 2, 'doc_inv2', D(83700), D(10000), D(73700), 'rev_1042_1');
    this.must('agent', 'record_invoice_line', 'r2_l1', 'rev_1042_2', 'material', 'Ready-mix 4000 psi', YD(500), 'cy', D(165), D(82500), 'term_price', '', j(['frag_r_l1']));
    this.must('agent', 'record_invoice_line', 'r2_l2', 'rev_1042_2', 'extra', 'Weekend delivery Oct 11', 0n, '', 0n, D(1200), '', 'cr_weekend', j(['frag_r_l2']));
    this.step('thought', 'Corrected invoice BM-1042-R received; it supersedes the original (same invoice number, same supplier, sent in reply to our clarification).');
    this.must('agent', 'record_assessment', 'as_1042_2_v1', 'rev_1042_2', 1, 'fp_1042_2_v1', 'policy-2026-10', D(83700), D(83700), 0n, 0n,
      D(10000), D(73700), 'matches', 'Corrected invoice matches what was agreed: $82,500 material at $165/yd + $1,200 authorised weekend charge. Deposit $10,000 applied once.',
      j([
        { line: 'Ready-mix 4000 psi', claimed_cents: 8250000, accepted_cents: 8250000, pending_cents: 0, calculation: '500.000 cy × $165.00 = $82,500.00 (agreed price)', fragment_ids: ['frag_r_l1', 'frag_q_price'], status: 'accepted' },
        { line: 'Weekend delivery Oct 11', claimed_cents: 120000, accepted_cents: 120000, pending_cents: 0, calculation: 'Fixed charge, approved by purchasing within $2,000 limit, accepted by BayMix', fragment_ids: ['frag_r_l2', 'frag_wk1', 'frag_wk2', 'frag_wk3'], status: 'accepted' },
        { line: 'Deposit', claimed_cents: -1000000, accepted_cents: -1000000, pending_cents: 0, calculation: '$10,000 deposit settled Oct 3; applied once', fragment_ids: ['frag_q_dep', 'frag_r_tot'], status: 'accepted' },
      ]), 'Waiting for receipt confirmation');
    this.step('decision', 'Commercial terms now match. Payment still needs the superintendent to confirm receipt.', {});
  }

  /** The agent proposes payment once nothing but its own decision is missing. */
  private maybePropose(): boolean {
    const inv = this.h.db.invoice.id.find('inv_1042');
    if (!inv || !inv.active_revision_id || inv.payment_status !== 'not_ready') return false;
    if (inv.receipt_status !== 'manually_confirmed') return false;
    const holds = this.q('hold').filter(x => x.revision_id === inv.active_revision_id && x.status === 'open' && x.code !== 'APPROVAL_STALE');
    if (holds.length) return false;
    const pending = this.q('proposal').some(p => p.work_item_id === 'wi_inv_1042' && p.status === 'pending' && p.kind === 'supplier_payment');
    if (pending) return false;
    const as = this.q('assessment').filter(a => a.revision_id === inv.active_revision_id).sort((a, b) => b.version - a.version)[0];
    const payee = this.q('payee_profile').find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
    if (!as || !payee) return false;
    const id = `pp_${inv.active_revision_id}_${as.version}`;
    if (this.h.db.proposal.id.find(id)) return false;
    const r = this.callAs('agent', 'propose_supplier_payment', id, inv.id, inv.active_revision_id, as.id, as.proposed_payment_cents,
      D(10000), payee.id);
    this.step('decision', `Proposed paying $${(Number(as.proposed_payment_cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} for the controller's approval`, { proposal_id: id, outcome: r.outcome });
    return r.outcome === 'ok';
  }

  /** Simulated gateway: Nessie-style settlement once, deposit applied once, balanced journals. */
  private settle(proposal_id: string) {
    const s = this.callAs('gateway', 'start_payment', proposal_id);
    if (s.outcome !== 'ok') { this.step('error', 'Gateway refused to start the payment', s); return; }
    this.callAs('gateway', 'record_deposit_allocation', 'da_1042', 'dep_2201', 'inv_1042', D(10000));
    this.callAs('gateway', 'record_payment', proposal_id, `nessie_sim_${proposal_id}`, 'sent', '');
    const post = (id: string, ref: string, memo: string, lines: [string, number, number][]) =>
      this.callAs('gateway', 'post_journal', id, '2026-10-24', memo, ref, 'inv_1042',
        j(lines.map(([account, d, c]) => ({ account, debit_cents: d, credit_cents: c }))));
    post('jr_1042_bill', 'invoice', 'BayMix BM-1042-R accepted, receipt attested', [['job_material_cost:prj_oakview', 8370000, 0], ['accounts_payable', 0, 8370000]]);
    post('jr_1042_dep', 'invoice', 'Deposit applied to BM-1042-R', [['accounts_payable', 1000000, 0], ['supplier_prepayment', 0, 1000000]]);
    post('jr_1042_pay', 'payment', 'Settlement of BM-1042-R (simulated Nessie)', [['accounts_payable', 7370000, 0], ['cash', 0, 7370000]]);
  }

  // ---------------------------------------------------------------- seed: SPEC §8 opening state

  private seed() {
    this.h.clock.set(new Timestamp(this.clockMicros));
    this.must('admin', 'claim_admin');
    for (const p of Object.keys(PERSONAS) as Persona[]) {
      if (p !== 'admin') this.must('admin', 'register_actor', ID[p].toHexString(), p, PERSONAS[p].name);
    }
    // No authority row = no approval authority, so the owner gets an explicit one too.
    this.must('admin', 'set_authority', ID.owner.toHexString(), 'owner', D(250000), '*');
    this.must('admin', 'set_authority', ID.purchasing.toHexString(), 'purchasing', D(2000), '*');
    this.must('sync', 'upsert_company', 'co_mf', 'Marlow & Finch Builders', 'Dana Marlow', 'CA', 'acct_mf_operating', '0042');
    this.must('sync', 'upsert_project', 'prj_oakview', 'Oakview Lane Fourplex', '1200 Oakview Ln (fictional)', 'active');
    this.must('sync', 'upsert_supplier', 'sup_baymix', 'BayMix Supply', 'baymix.example', '+1 555-010-0100', 'crs_test_business_1', 'active');
    this.must('sync', 'upsert_supplier_contact', 'con_lee', 'sup_baymix', 'Lee Park', 'ar@baymix.example', '+1 555-010-0100', 'Accounts receivable', true);
    this.must('sync', 'upsert_supplier_contact', 'con_priya', 'sup_baymix', 'Priya Shah', 'priya@baymix.example', '+1 555-010-0111', 'Sales', true);
    this.must('admin', 'add_payee_profile', 'sup_baymix:v1', 'sup_baymix', 1, 'acct_baymix_sim', '4471', 'Pacific Coast Bank (fictional)', 'seed');

    // Documents and their immutable source fragments.
    const doc = (id: string, kind: string, file: string, pages: number) => this.must('sync', 'record_document', id, kind, `src_${id}`, `sha_${id}`, file, pages);
    const frag = (id: string, d: string, page: number, line: number, text: string, email = '') => this.must('sync', 'add_fragment', id, d, page, email, line, line, text);
    doc('doc_quote', 'quote', 'BayMix-Quote-Q-7781.pdf', 2);
    frag('frag_q_price', 'doc_quote', 1, 12, 'Ready-mix concrete, 4000 psi: $165.00 per cubic yard, up to 500 cubic yards.');
    frag('frag_q_valid', 'doc_quote', 1, 14, 'Prices fixed through October 31, 2026.');
    frag('frag_q_dep', 'doc_quote', 1, 18, 'Deposit: $10,000 due on acceptance, applied against the final invoice.');
    frag('frag_q_change', 'doc_quote', 2, 3, 'Price changes require mutual written agreement.');
    frag('frag_q_extra', 'doc_quote', 2, 5, 'Extra charges (weekend delivery, standby or waiting time) apply only when agreed in writing before the work.');
    doc('doc_po', 'po', 'PO-2201.pdf', 1);
    frag('frag_po_line', 'doc_po', 1, 8, 'PO-2201 · BayMix Supply · Ready-mix 4000 psi · 500 cy @ $165.00 · $82,500.00');
    frag('frag_po_ack', 'doc_po', 1, 22, 'Acknowledged for BayMix Supply, Oct 1, 2026: Priya Shah');

    const email = (id: string, thread: string, from: string, to: string, subject: string, sent: string, fragId: string, text: string) => {
      doc(`doc_${id}`, 'email', `${id}.eml`, 1);
      frag(fragId, `doc_${id}`, 0, 1, text, id);
      this.must('sync', 'record_email', id, thread, `doc_${id}`, from, to, subject, sent, sent, fragId);
    };
    email('em_wk1', 'thr_weekend', 'priya@baymix.example', 'purchasing@marlowfinch.example', 'Saturday pour Oct 11', '2026-10-08T09:14:00-07:00',
      'frag_wk1', 'We can deliver Saturday Oct 11 for the slab pour. Weekend delivery is a flat $1,200.');
    email('em_wk2', 'thr_weekend', 'purchasing@marlowfinch.example', 'priya@baymix.example', 'RE: Saturday pour Oct 11', '2026-10-08T11:02:00-07:00',
      'frag_wk2', 'Approved: weekend delivery at $1,200 for the Oct 11 pour. Approval recorded in our system.');
    email('em_wk3', 'thr_weekend', 'priya@baymix.example', 'purchasing@marlowfinch.example', 'RE: RE: Saturday pour Oct 11', '2026-10-08T11:40:00-07:00',
      'frag_wk3', 'Confirmed, $1,200 weekend delivery on Oct 11.');
    email('em_wait', 'thr_wait', 'dispatch@baymix.example', 'site@marlowfinch.example', 'Pour schedule', '2026-10-15T07:30:00-07:00',
      'frag_wait', 'Heads up: waiting charges may apply if trucks are held on site.');

    for (const d of ['doc_quote', 'doc_po', 'doc_em_wk1', 'doc_em_wk2', 'doc_em_wk3', 'doc_em_wait']) {
      this.must('agent', 'record_extraction_run', `ext_${d}`, d, 'fixture', 'fixture', 'extract-v1', 'ok', '', '{}');
    }

    // The purchase: accepted quote + acknowledged PO.
    this.must('sync', 'upsert_purchase', 'pur_2201', 'sup_baymix', 'prj_oakview', 'Ready-mix concrete, 4000 psi', 'cy', 'PO-2201', 'doc_quote', 'doc_po', 'open');
    const term = (id: string, code: string, label: string, amt: bigint, qty: bigint, text: string, frags: string[], to = '2026-10-31') =>
      this.must('sync', 'record_term', id, 'pur_2201', code, label, amt, qty, text, '{}', '2026-10-01', to, 'accepted', j(frags), 1);
    term('term_price', 'unit_price', 'Unit price', D(165), 0n, '$165.00 per cubic yard', ['frag_q_price', 'frag_po_line']);
    term('term_qty', 'max_quantity', 'Maximum quantity', 0n, YD(500), 'Up to 500 cubic yards', ['frag_q_price', 'frag_po_line']);
    term('term_valid', 'valid_through', 'Price valid through', 0n, 0n, 'Fixed through Oct 31, 2026', ['frag_q_valid']);
    term('term_change', 'price_change_rule', 'Price changes', 0n, 0n, 'Require mutual written agreement', ['frag_q_change']);
    term('term_extra', 'extra_charge_rule', 'Extra charges', 0n, 0n, 'Only when agreed in writing before the work', ['frag_q_extra']);
    term('term_dep', 'deposit', 'Deposit', D(10000), 0n, '$10,000 on acceptance, applied to the final invoice', ['frag_q_dep']);
    this.must('sync', 'record_deposit', 'dep_2201', 'pur_2201', 'sup_baymix', D(10000), 'settled', 'nessie_sim_dep_2201');
    this.must('sync', 'post_journal', 'jr_2201_dep', '2026-10-03', 'Deposit to BayMix for PO-2201 (simulated Nessie)', 'deposit', 'pur_2201',
      j([{ account: 'supplier_prepayment', debit_cents: 1000000, credit_cents: 0 }, { account: 'cash', debit_cents: 0, credit_cents: 1000000 }]));

    // Amendments: weekend charge (legit, approved within limit) and waiting (only proposed).
    this.must('sync', 'propose_change_request', 'cr_weekend', 'pur_2201', 'extra_charge', 'Weekend delivery, Oct 11 pour', D(1200), 0n, '',
      j({ deliveries: ['Oct 11'] }), '2026-10-11', '2026-10-08T09:14:00-07:00', '2026-10-08T09:15:00-07:00', 'PROPOSED', 'proposed', j(['frag_wk1']));
    this.must('purchasing', 'decide_change_request', 'cr_weekend', true, 'Weekend pour needed for schedule');
    this.must('sync', 'record_supplier_acceptance', 'cr_weekend', 'accepted', j(['frag_wk3']));
    this.must('sync', 'propose_change_request', 'cr_waiting', 'pur_2201', 'extra_charge', 'Waiting time', 0n, 250n, 'min',
      '{}', '', '2026-10-15T07:30:00-07:00', '2026-10-15T07:31:00-07:00', 'PROPOSED', 'none', j(['frag_wait']));

    // The Oct 23 invoice.
    doc('doc_inv1', 'invoice', 'BayMix-BM-1042.pdf', 1);
    frag('frag_i_l1', 'doc_inv1', 1, 14, 'Ready-mix 4000 psi   500.000 cy   @ $172.00   $86,000.00');
    frag('frag_i_l2', 'doc_inv1', 1, 15, 'Weekend delivery Oct 11   $1,200.00');
    frag('frag_i_l3', 'doc_inv1', 1, 16, 'Waiting time   90 min   @ $2.50   $225.00');
    frag('frag_i_tot', 'doc_inv1', 1, 19, 'Total $87,425.00 · Less deposit received ($10,000.00) · Balance due $77,425.00');
    this.must('sync', 'record_invoice', 'inv_1042', 'sup_baymix', 'pur_2201', 'BM-1042', '2026-10-23', '2026-11-22', 'USD');
    this.must('sync', 'record_invoice_revision', 'rev_1042_1', 'inv_1042', 1, 'doc_inv1', D(87425), D(10000), D(77425), '');
    this.must('agent', 'set_work_item_state', 'wi_inv_1042', 'reading', 'Invoice BM-1042 arrived');
    this.step('plan', 'Read BM-1042, link it to PO-2201 and its terms, compare every line with what was agreed', { mode: 'fixture' });
    this.must('agent', 'record_extraction_run', 'ext_inv1', 'doc_inv1', 'fixture', 'fixture', 'extract-v1', 'ok', '', '{}');
    this.step('tool_call', 'get_invoice_bundle(inv_1042)', { documents: ['doc_inv1', 'doc_quote', 'doc_po'] });
    this.must('agent', 'record_invoice_line', 'r1_l1', 'rev_1042_1', 'material', 'Ready-mix 4000 psi', YD(500), 'cy', D(172), D(86000), 'term_price', '', j(['frag_i_l1']));
    this.must('agent', 'record_invoice_line', 'r1_l2', 'rev_1042_1', 'extra', 'Weekend delivery Oct 11', 0n, '', 0n, D(1200), '', 'cr_weekend', j(['frag_i_l2']));
    this.must('agent', 'record_invoice_line', 'r1_l3', 'rev_1042_1', 'waiting', 'Waiting time', 90000n, 'min', 250n, D(225), '', 'cr_waiting', j(['frag_i_l3']));
    this.must('agent', 'set_work_item_state', 'wi_inv_1042', 'investigating', '');
    this.step('tool_call', 'run_check(price_terms)', {});
    this.step('tool_result', '$172.00/yd billed; agreed $165.00/yd, fixed through Oct 31; changes need mutual written agreement; none on file', { fragment_ids: ['frag_i_l1', 'frag_q_price', 'frag_q_valid', 'frag_q_change'] });
    this.step('tool_call', 'run_check(extra_charges)', {});
    this.step('tool_result', 'Weekend $1,200: approved by Jordan Reyes within the $2,000 limit and accepted by BayMix. Waiting $225: only "may apply"; no agreement, no usage evidence.', {});

    const hold = (id: string, code: string, amt: number, reason: string, frags: string[]) =>
      this.must('agent', 'open_hold', id, 'rev_1042_1', code, D(amt), reason, j(frags));
    hold('h_1042_price', 'PRICE_VARIANCE', 3500, 'Billed $172.00/yd; the agreed price is $165.00/yd for all 500 yd ($3,500 difference). No accepted price change.', ['frag_i_l1', 'frag_q_price', 'frag_q_change']);
    hold('h_1042_wait', 'PROPOSED_CHARGE', 225, 'Waiting time was only proposed ("may apply"), never accepted.', ['frag_i_l3', 'frag_wait', 'frag_q_extra']);
    hold('h_1042_usage', 'USAGE_EVIDENCE_MISSING', 225, 'No evidence of 90 minutes of waiting. Countersign does not invent usage.', ['frag_i_l3']);
    hold('h_1042_recv', 'RECEIPT_NOT_VERIFIED', 0, 'Nobody has confirmed receipt of 500 cy yet.', []);

    this.must('agent', 'record_assessment', 'as_1042_1_v1', 'rev_1042_1', 1, 'fp_1042_1_v1', 'policy-2026-10', D(87425), D(83700), D(225), D(3500),
      D(10000), D(73700), 'differences_under_review',
      '$3,725 under review: a $3,500 price difference and a $225 waiting charge. The $1,200 weekend charge is authorised. Deposit $10,000 to apply once.',
      j([
        { line: 'Ready-mix 4000 psi', claimed_cents: 8600000, accepted_cents: 8250000, pending_cents: 0, variance_cents: 350000, calculation: '500.000 cy × $172.00 = $86,000.00 billed; 500.000 cy × $165.00 = $82,500.00 agreed', fragment_ids: ['frag_i_l1', 'frag_q_price', 'frag_q_valid', 'frag_q_change', 'frag_po_line'], status: 'under_review' },
        { line: 'Weekend delivery Oct 11', claimed_cents: 120000, accepted_cents: 120000, pending_cents: 0, variance_cents: 0, calculation: 'Fixed $1,200: proposed Oct 8, approved by purchasing ($2,000 limit), accepted by BayMix', fragment_ids: ['frag_i_l2', 'frag_wk1', 'frag_wk2', 'frag_wk3'], status: 'accepted' },
        { line: 'Waiting time', claimed_cents: 22500, accepted_cents: 0, pending_cents: 22500, variance_cents: 0, calculation: '90 min × $2.50 = $225.00 billed; no agreement and no usage evidence', fragment_ids: ['frag_i_l3', 'frag_wait', 'frag_q_extra'], status: 'pending', uncertainty: 'Usage not proven; kept pending, not rejected' },
        { line: 'Deposit', claimed_cents: -1000000, accepted_cents: -1000000, pending_cents: 0, variance_cents: 0, calculation: '$10,000 deposit settled Oct 3; applied once', fragment_ids: ['frag_q_dep', 'frag_i_tot'], status: 'accepted' },
      ]), 'Ask BayMix for a corrected invoice');

    this.must('agent', 'draft_outbox', 'ob_1042_1', 'inv_1042', 'con_lee', 'Invoice BM-1042: price and waiting charge',
      'Hi Lee,\n\nThanks for invoice BM-1042. Two lines don\'t match what we agreed:\n\n1. Ready-mix is billed at $172.00/yd. Quote Q-7781 and PO-2201 set $165.00/yd for up to 500 yd, fixed through Oct 31, and price changes need mutual written agreement. We have no agreed change on file.\n2. Waiting time ($225). Your Oct 15 note said waiting charges "may apply", but we never agreed to them and have no record of trucks waiting.\n\nThe $1,200 weekend delivery is correct.\n\nCould you send a corrected invoice, or point us to the agreement we may have missed?\n\nThanks,\nMarlow & Finch Builders');
    this.step('decision', 'Held: $3,725 under review. Drafted a clarification to BayMix for purchasing to review and send.', { holds: ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'RECEIPT_NOT_VERIFIED'] });
  }
}

function toJson(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = plain(v);
  return out;
}

/** Rows hold bigint, Timestamp and Identity values; turn them into JSON-safe numbers and hex strings. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object') {
    const o = v as any;
    if (typeof o.microsSinceUnixEpoch === 'bigint') return Number(o.microsSinceUnixEpoch);
    if (typeof o.toHexString === 'function') return o.toHexString();
    if (Array.isArray(v)) return v.map(plain);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

let singleton: LocalBackend | null = null;
export function localBackend() {
  if (!singleton) singleton = new LocalBackend();
  return singleton;
}
