// Countersign SpacetimeDB module entry. Reducer names and parameter ORDER follow
// docs/CONTRACT.md §4 exactly: Python calls reducers with positional JSON arrays.
// Bodies live in logic.ts (this file may only export spacetime exports).
import { t } from 'spacetimedb/server';
import spacetimedb from './schema';
import * as L from './logic';
import * as V from './logic_v2';

export default spacetimedb;

const s = t.string;

// ---- 4.1 Setup ----
export const claim_admin = spacetimedb.reducer({ request_id: s() },
  (ctx, a) => { L.claim_admin(ctx, ctx.sender, a.request_id); });

export const register_actor = spacetimedb.reducer(
  { request_id: s(), identity_hex: s(), role: s(), display_name: s() },
  (ctx, a) => { L.register_actor(ctx, ctx.sender, a.request_id, a.identity_hex, a.role, a.display_name); });

// ---- 4.2 Records ----
export const upsert_company = spacetimedb.reducer(
  { request_id: s(), id: s(), name: s(), owner_name: s(), state: s(), bank_account_ref: s(), bank_last4: s() },
  (ctx, a) => { L.upsert_company(ctx, ctx.sender, a.request_id, a.id, a.name, a.owner_name, a.state, a.bank_account_ref, a.bank_last4); });

export const upsert_project = spacetimedb.reducer(
  { request_id: s(), id: s(), name: s(), address: s(), status: s() },
  (ctx, a) => { L.upsert_project(ctx, ctx.sender, a.request_id, a.id, a.name, a.address, a.status); });

export const upsert_sub = spacetimedb.reducer(
  {
    request_id: s(), id: s(), name: s(), trade: s(), license_number: s(), license_state: s(),
    contact_email: s(), email_domain: s(), phone_on_file: s(), bank_account_ref: s(), bank_last4: s(),
    bank_owner_name: s(), crs_ref: s(), status: s(),
  },
  (ctx, a) => {
    L.upsert_sub(ctx, ctx.sender, a.request_id, a.id, a.name, a.trade, a.license_number, a.license_state,
      a.contact_email, a.email_domain, a.phone_on_file, a.bank_account_ref, a.bank_last4, a.bank_owner_name,
      a.crs_ref, a.status);
  });

export const upsert_contract = spacetimedb.reducer(
  {
    request_id: s(), id: s(), sub_id: s(), project_id: s(), title: s(), original_value_cents: t.i64(),
    retainage_bps: t.u32(), payment_terms_days: t.u32(), lien_waiver_rule: s(), bank_change_clause: s(),
    source_file_id: s(),
  },
  (ctx, a) => {
    L.upsert_contract(ctx, ctx.sender, a.request_id, a.id, a.sub_id, a.project_id, a.title, a.original_value_cents,
      a.retainage_bps, a.payment_terms_days, a.lien_waiver_rule, a.bank_change_clause, a.source_file_id);
  });

export const upsert_contract_line = spacetimedb.reducer(
  { request_id: s(), id: s(), contract_id: s(), code: s(), description: s(), scheduled_value_cents: t.i64() },
  (ctx, a) => { L.upsert_contract_line(ctx, ctx.sender, a.request_id, a.id, a.contract_id, a.code, a.description, a.scheduled_value_cents); });

export const confirm_contract = spacetimedb.reducer({ request_id: s(), contract_id: s() },
  (ctx, a) => { L.confirm_contract(ctx, ctx.sender, a.request_id, a.contract_id); });

export const record_source_file = spacetimedb.reducer(
  {
    request_id: s(), id: s(), kind: s(), filename: s(), sha256: s(), received_at_iso: s(),
    from_address: s(), subject: s(), storage_path: s(),
  },
  (ctx, a) => {
    L.record_source_file(ctx, ctx.sender, a.request_id, a.id, a.kind, a.filename, a.sha256, a.received_at_iso,
      a.from_address, a.subject, a.storage_path);
  });

export const record_bill = spacetimedb.reducer(
  {
    request_id: s(), id: s(), sub_id: s(), contract_id: s(), source_file_id: s(), invoice_number: s(),
    bill_date: s(), due_date: s(), period_label: s(), amount_cents: t.i64(), retainage_cents: t.i64(),
    remit_bank_name: s(), remit_account_ref: s(), remit_account_last4: s(), from_address: s(),
    has_lien_waiver: t.bool(), extracted_json: s(),
  },
  (ctx, a) => {
    L.record_bill(ctx, ctx.sender, a.request_id, a.id, a.sub_id, a.contract_id, a.source_file_id, a.invoice_number,
      a.bill_date, a.due_date, a.period_label, a.amount_cents, a.retainage_cents, a.remit_bank_name,
      a.remit_account_ref, a.remit_account_last4, a.from_address, a.has_lien_waiver, a.extracted_json);
  });

export const record_bill_line = spacetimedb.reducer(
  {
    request_id: s(), id: s(), bill_id: s(), contract_line_code: s(), description: s(),
    this_period_cents: t.i64(), previous_cents: t.i64(), percent_complete_bps: t.u32(),
  },
  (ctx, a) => {
    L.record_bill_line(ctx, ctx.sender, a.request_id, a.id, a.bill_id, a.contract_line_code, a.description,
      a.this_period_cents, a.previous_cents, a.percent_complete_bps);
  });

export const record_bank_snapshot = spacetimedb.reducer(
  { request_id: s(), id: s(), account_ref: s(), balance_cents: t.i64(), as_of_iso: s() },
  (ctx, a) => { L.record_bank_snapshot(ctx, ctx.sender, a.request_id, a.id, a.account_ref, a.balance_cents, a.as_of_iso); });

export const post_journal = spacetimedb.reducer(
  { request_id: s(), journal_id: s(), entry_date: s(), memo: s(), ref_type: s(), ref_id: s(), lines_json: s() },
  (ctx, a) => { L.post_journal(ctx, ctx.sender, a.request_id, a.journal_id, a.entry_date, a.memo, a.ref_type, a.ref_id, a.lines_json); });

// ---- 4.3 Work ----
export const create_work_item = spacetimedb.reducer(
  { request_id: s(), id: s(), kind: s(), entity_id: s(), origin: s(), summary: s() },
  (ctx, a) => { L.create_work_item(ctx, ctx.sender, a.request_id, a.id, a.kind, a.entity_id, a.origin, a.summary); });

export const set_work_item_state = spacetimedb.reducer(
  { request_id: s(), id: s(), state: s(), note: s() },
  (ctx, a) => { L.set_work_item_state(ctx, ctx.sender, a.request_id, a.id, a.state, a.note); });

export const log_agent_step = spacetimedb.reducer(
  { request_id: s(), work_item_id: s(), kind: s(), title: s(), detail_json: s() },
  (ctx, a) => { L.log_agent_step(ctx, ctx.sender, a.request_id, a.work_item_id, a.kind, a.title, a.detail_json); });

export const record_check = spacetimedb.reducer(
  { request_id: s(), work_item_id: s(), check_code: s(), status: s(), summary: s(), evidence_json: s(), source: s() },
  (ctx, a) => {
    L.record_check(ctx, ctx.sender, a.request_id, a.work_item_id, a.check_code, a.status, a.summary, a.evidence_json, a.source);
  });

export const propose = spacetimedb.reducer(
  {
    request_id: s(), id: s(), work_item_id: s(), kind: s(), amount_cents: t.i64(), payee_sub_id: s(),
    payee_account_ref: s(), reason: s(), evidence_json: s(),
  },
  (ctx, a) => {
    L.propose(ctx, ctx.sender, a.request_id, a.id, a.work_item_id, a.kind, a.amount_cents, a.payee_sub_id,
      a.payee_account_ref, a.reason, a.evidence_json);
  });

export const decide_proposal = spacetimedb.reducer(
  { request_id: s(), proposal_id: s(), approve: t.bool(), note: s() },
  (ctx, a) => { L.decide_proposal(ctx, ctx.sender, a.request_id, a.proposal_id, a.approve, a.note); });

export const cancel_proposal = spacetimedb.reducer(
  { request_id: s(), id: s(), note: s() },
  (ctx, a) => { L.cancel_proposal(ctx, ctx.sender, a.request_id, a.id, a.note); });

// ---- 4.4 Payments ----
export const start_payment = spacetimedb.reducer({ request_id: s(), proposal_id: s() },
  (ctx, a) => { L.start_payment(ctx, ctx.sender, a.request_id, a.proposal_id); });

export const record_payment = spacetimedb.reducer(
  { request_id: s(), proposal_id: s(), nessie_transfer_id: s(), status: s(), error: s() },
  (ctx, a) => { L.record_payment(ctx, ctx.sender, a.request_id, a.proposal_id, a.nessie_transfer_id, a.status, a.error); });

// ---- 4.5 Jobs ----
export const enqueue_job = spacetimedb.reducer(
  { request_id: s(), id: s(), kind: s(), payload_json: s() },
  (ctx, a) => { L.enqueue_job(ctx, ctx.sender, a.request_id, a.id, a.kind, a.payload_json); });

export const claim_job = spacetimedb.reducer({ request_id: s(), job_id: s() },
  (ctx, a) => { L.claim_job(ctx, ctx.sender, a.request_id, a.job_id); });

export const finish_job = spacetimedb.reducer(
  { request_id: s(), job_id: s(), ok: t.bool(), result_json: s(), error: s() },
  (ctx, a) => { L.finish_job(ctx, ctx.sender, a.request_id, a.job_id, a.ok, a.result_json, a.error); });

// ---- 4.6-4.9 (P1) and §9 v2 — parameter order = CONTRACT ----
export const request_bank_change = spacetimedb.reducer(
  { request_id: s(), id: s(), sub_id: s(), new_account_ref: s(), new_last4: s(), new_owner_name: s(), requested_via: s() },
  (ctx, a) => { L.request_bank_change(ctx, ctx.sender, a.request_id, a.id, a.sub_id, a.new_account_ref, a.new_last4, a.new_owner_name, a.requested_via); });
export const record_verification = spacetimedb.reducer(
  { request_id: s(), id: s(), bank_change_id: s(), method: s(), result: s(), detail: s() },
  (ctx, a) => { L.record_verification(ctx, ctx.sender, a.request_id, a.id, a.bank_change_id, a.method, a.result, a.detail); });
export const upsert_change_order = spacetimedb.reducer(
  { request_id: s(), id: s(), contract_id: s(), number: s(), description: s(), amount_cents: t.i64() },
  (ctx, a) => { L.upsert_change_order(ctx, ctx.sender, a.request_id, a.id, a.contract_id, a.number, a.description, a.amount_cents); });
export const decide_change_order = spacetimedb.reducer(
  { request_id: s(), id: s(), approve: t.bool(), note: s() },
  (ctx, a) => { L.decide_change_order(ctx, ctx.sender, a.request_id, a.id, a.approve, a.note); });
export const propose_policy = spacetimedb.reducer(
  { request_id: s(), id: s(), scope: s(), sub_id: s(), rule_code: s(), params_json: s(), description: s(), evidence_json: s() },
  (ctx, a) => { L.propose_policy(ctx, ctx.sender, a.request_id, a.id, a.scope, a.sub_id, a.rule_code, a.params_json, a.description, a.evidence_json); });
export const decide_policy = spacetimedb.reducer(
  { request_id: s(), id: s(), approve: t.bool(), note: s() },
  (ctx, a) => { L.decide_policy(ctx, ctx.sender, a.request_id, a.id, a.approve, a.note); });
export const ask_question = spacetimedb.reducer(
  { request_id: s(), id: s(), work_item_id: s(), to_role: s(), text: s(), options_json: s() },
  (ctx, a) => { L.ask_question(ctx, ctx.sender, a.request_id, a.id, a.work_item_id, a.to_role, a.text, a.options_json); });
export const answer_question = spacetimedb.reducer(
  { request_id: s(), id: s(), answer: s() },
  (ctx, a) => { L.answer_question(ctx, ctx.sender, a.request_id, a.id, a.answer); });
export const ask_why = spacetimedb.reducer(
  { request_id: s(), id: s(), work_item_id: s(), text: s() },
  (ctx, a) => { L.ask_why(ctx, ctx.sender, a.request_id, a.id, a.work_item_id, a.text); });
export const post_chat_answer = spacetimedb.reducer(
  { request_id: s(), id: s(), work_item_id: s(), text: s(), citations_json: s() },
  (ctx, a) => { L.post_chat_answer(ctx, ctx.sender, a.request_id, a.id, a.work_item_id, a.text, a.citations_json); });
export const record_score_run = spacetimedb.reducer(
  { request_id: s(), id: s(), status: s(), totals_json: s() },
  (ctx, a) => { L.record_score_run(ctx, ctx.sender, a.request_id, a.id, a.status, a.totals_json); });
export const record_score_case = spacetimedb.reducer(
  { request_id: s(), id: s(), run_id: s(), attack_type: s(), expected: s(), actual: s(), correct: t.bool(), amount_cents: t.i64(), work_item_id: s() },
  (ctx, a) => { L.record_score_case(ctx, ctx.sender, a.request_id, a.id, a.run_id, a.attack_type, a.expected, a.actual, a.correct, a.amount_cents, a.work_item_id); });
export const set_authority = spacetimedb.reducer(
  { request_id: s(), identity_hex: s(), role: s(), limit_cents: t.i64(), project_scope: s() },
  (ctx, a) => { V.set_authority(ctx, ctx.sender, a.request_id, a.identity_hex, a.role, a.limit_cents, a.project_scope); });
export const upsert_supplier = spacetimedb.reducer(
  { request_id: s(), id: s(), name: s(), email_domain: s(), phone_on_file: s(), crs_ref: s(), status: s() },
  (ctx, a) => { V.upsert_supplier(ctx, ctx.sender, a.request_id, a.id, a.name, a.email_domain, a.phone_on_file, a.crs_ref, a.status); });
export const upsert_supplier_contact = spacetimedb.reducer(
  { request_id: s(), id: s(), supplier_id: s(), name: s(), email: s(), phone: s(), title: s(), pre_established: t.bool() },
  (ctx, a) => { V.upsert_supplier_contact(ctx, ctx.sender, a.request_id, a.id, a.supplier_id, a.name, a.email, a.phone, a.title, a.pre_established); });
export const add_payee_profile = spacetimedb.reducer(
  { request_id: s(), id: s(), supplier_id: s(), version: t.u32(), account_ref: s(), last4: s(), bank_name: s(), requested_via: s() },
  (ctx, a) => { V.add_payee_profile(ctx, ctx.sender, a.request_id, a.id, a.supplier_id, a.version, a.account_ref, a.last4, a.bank_name, a.requested_via); });
export const record_document = spacetimedb.reducer(
  { request_id: s(), id: s(), kind: s(), source_file_id: s(), sha256: s(), filename: s(), pages: t.u32() },
  (ctx, a) => { V.record_document(ctx, ctx.sender, a.request_id, a.id, a.kind, a.source_file_id, a.sha256, a.filename, a.pages); });
export const add_fragment = spacetimedb.reducer(
  { request_id: s(), id: s(), document_id: s(), page: t.u32(), email_message_id: s(), line_start: t.u32(), line_end: t.u32(), text: s() },
  (ctx, a) => { V.add_fragment(ctx, ctx.sender, a.request_id, a.id, a.document_id, a.page, a.email_message_id, a.line_start, a.line_end, a.text); });
export const record_email = spacetimedb.reducer(
  { request_id: s(), id: s(), thread_id: s(), document_id: s(), from_address: s(), to_addresses: s(), subject: s(), original_sent_at_iso: s(), ingested_at_iso: s(), body_fragment_id: s() },
  (ctx, a) => { V.record_email(ctx, ctx.sender, a.request_id, a.id, a.thread_id, a.document_id, a.from_address, a.to_addresses, a.subject, a.original_sent_at_iso, a.ingested_at_iso, a.body_fragment_id); });
export const record_extraction_run = spacetimedb.reducer(
  { request_id: s(), id: s(), document_id: s(), mode: s(), model: s(), prompt_version: s(), status: s(), error: s(), fields_json: s() },
  (ctx, a) => { V.record_extraction_run(ctx, ctx.sender, a.request_id, a.id, a.document_id, a.mode, a.model, a.prompt_version, a.status, a.error, a.fields_json); });
export const upsert_purchase = spacetimedb.reducer(
  { request_id: s(), id: s(), supplier_id: s(), project_id: s(), description: s(), unit: s(), po_number: s(), quote_document_id: s(), po_document_id: s(), status: s() },
  (ctx, a) => { V.upsert_purchase(ctx, ctx.sender, a.request_id, a.id, a.supplier_id, a.project_id, a.description, a.unit, a.po_number, a.quote_document_id, a.po_document_id, a.status); });
export const record_term = spacetimedb.reducer(
  { request_id: s(), id: s(), purchase_id: s(), code: s(), label: s(), amount_cents: t.i64(), quantity_milli: t.i64(), text: s(), scope_json: s(), effective_from: s(), effective_to: s(), status: s(), source_fragment_ids_json: s(), version: t.u32() },
  (ctx, a) => { V.record_term(ctx, ctx.sender, a.request_id, a.id, a.purchase_id, a.code, a.label, a.amount_cents, a.quantity_milli, a.text, a.scope_json, a.effective_from, a.effective_to, a.status, a.source_fragment_ids_json, a.version); });
export const record_deposit = spacetimedb.reducer(
  { request_id: s(), id: s(), purchase_id: s(), supplier_id: s(), amount_cents: t.i64(), status: s(), transfer_ref: s() },
  (ctx, a) => { V.record_deposit(ctx, ctx.sender, a.request_id, a.id, a.purchase_id, a.supplier_id, a.amount_cents, a.status, a.transfer_ref); });
export const propose_change_request = spacetimedb.reducer(
  { request_id: s(), id: s(), purchase_id: s(), kind: s(), description: s(), amount_cents: t.i64(), rate_cents: t.i64(), rate_unit: s(), scope_json: s(), effective_from: s(), original_sent_at_iso: s(), ingested_at_iso: s(), classification: s(), supplier_acceptance: s(), source_fragment_ids_json: s() },
  (ctx, a) => { V.propose_change_request(ctx, ctx.sender, a.request_id, a.id, a.purchase_id, a.kind, a.description, a.amount_cents, a.rate_cents, a.rate_unit, a.scope_json, a.effective_from, a.original_sent_at_iso, a.ingested_at_iso, a.classification, a.supplier_acceptance, a.source_fragment_ids_json); });
export const record_supplier_acceptance = spacetimedb.reducer(
  { request_id: s(), change_request_id: s(), supplier_acceptance: s(), fragment_ids_json: s() },
  (ctx, a) => { V.record_supplier_acceptance(ctx, ctx.sender, a.request_id, a.change_request_id, a.supplier_acceptance, a.fragment_ids_json); });
export const decide_change_request = spacetimedb.reducer(
  { request_id: s(), id: s(), approve: t.bool(), note: s() },
  (ctx, a) => { V.decide_change_request(ctx, ctx.sender, a.request_id, a.id, a.approve, a.note); });
export const record_invoice = spacetimedb.reducer(
  { request_id: s(), id: s(), supplier_id: s(), purchase_id: s(), invoice_number: s(), invoice_date: s(), due_date: s(), currency: s() },
  (ctx, a) => { V.record_invoice(ctx, ctx.sender, a.request_id, a.id, a.supplier_id, a.purchase_id, a.invoice_number, a.invoice_date, a.due_date, a.currency); });
export const record_invoice_revision = spacetimedb.reducer(
  { request_id: s(), id: s(), invoice_id: s(), revision: t.u32(), document_id: s(), gross_cents: t.i64(), deposit_shown_cents: t.i64(), balance_requested_cents: t.i64(), supersedes_revision_id: s() },
  (ctx, a) => { V.record_invoice_revision(ctx, ctx.sender, a.request_id, a.id, a.invoice_id, a.revision, a.document_id, a.gross_cents, a.deposit_shown_cents, a.balance_requested_cents, a.supersedes_revision_id); });
export const record_invoice_line = spacetimedb.reducer(
  { request_id: s(), id: s(), revision_id: s(), kind: s(), description: s(), quantity_milli: t.i64(), unit: s(), unit_price_cents: t.i64(), amount_cents: t.i64(), linked_term_id: s(), linked_change_request_id: s(), source_fragment_ids_json: s() },
  (ctx, a) => { V.record_invoice_line(ctx, ctx.sender, a.request_id, a.id, a.revision_id, a.kind, a.description, a.quantity_milli, a.unit, a.unit_price_cents, a.amount_cents, a.linked_term_id, a.linked_change_request_id, a.source_fragment_ids_json); });
export const record_assessment = spacetimedb.reducer(
  { request_id: s(), id: s(), revision_id: s(), version: t.u32(), fingerprint: s(), policy_version: s(), claimed_cents: t.i64(), authorised_cents: t.i64(), pending_cents: t.i64(), variance_cents: t.i64(), deposit_available_cents: t.i64(), proposed_payment_cents: t.i64(), commercial_status: s(), summary: s(), details_json: s(), next_action: s() },
  (ctx, a) => { V.record_assessment(ctx, ctx.sender, a.request_id, a.id, a.revision_id, a.version, a.fingerprint, a.policy_version, a.claimed_cents, a.authorised_cents, a.pending_cents, a.variance_cents, a.deposit_available_cents, a.proposed_payment_cents, a.commercial_status, a.summary, a.details_json, a.next_action); });
export const open_hold = spacetimedb.reducer(
  { request_id: s(), id: s(), revision_id: s(), code: s(), amount_cents: t.i64(), reason: s(), evidence_json: s() },
  (ctx, a) => { V.open_hold(ctx, ctx.sender, a.request_id, a.id, a.revision_id, a.code, a.amount_cents, a.reason, a.evidence_json); });
export const resolve_hold = spacetimedb.reducer(
  { request_id: s(), id: s(), note: s() },
  (ctx, a) => { V.resolve_hold(ctx, ctx.sender, a.request_id, a.id, a.note); });
export const attest_receipt = spacetimedb.reducer(
  { request_id: s(), id: s(), invoice_id: s(), scope: s(), quantity_milli: t.i64(), unit: s(), reason: s() },
  (ctx, a) => { V.attest_receipt(ctx, ctx.sender, a.request_id, a.id, a.invoice_id, a.scope, a.quantity_milli, a.unit, a.reason); });
export const decide_payee_profile = spacetimedb.reducer(
  { request_id: s(), id: s(), approve: t.bool(), verified_via_contact_id: s(), note: s() },
  (ctx, a) => { V.decide_payee_profile(ctx, ctx.sender, a.request_id, a.id, a.approve, a.verified_via_contact_id, a.note); });
export const draft_outbox = spacetimedb.reducer(
  { request_id: s(), id: s(), invoice_id: s(), to_contact_id: s(), subject: s(), body: s() },
  (ctx, a) => { V.draft_outbox(ctx, ctx.sender, a.request_id, a.id, a.invoice_id, a.to_contact_id, a.subject, a.body); });
export const approve_outbox = spacetimedb.reducer(
  { request_id: s(), id: s() },
  (ctx, a) => { V.approve_outbox(ctx, ctx.sender, a.request_id, a.id); });
export const mark_outbox = spacetimedb.reducer(
  { request_id: s(), id: s(), status: s(), delivery_ref: s() },
  (ctx, a) => { V.mark_outbox(ctx, ctx.sender, a.request_id, a.id, a.status, a.delivery_ref); });
export const propose_supplier_payment = spacetimedb.reducer(
  { request_id: s(), id: s(), invoice_id: s(), revision_id: s(), assessment_id: s(), amount_cents: t.i64(), deposit_allocation_cents: t.i64(), payee_profile_id: s() },
  (ctx, a) => { V.propose_supplier_payment(ctx, ctx.sender, a.request_id, a.id, a.invoice_id, a.revision_id, a.assessment_id, a.amount_cents, a.deposit_allocation_cents, a.payee_profile_id); });
export const approve_supplier_payment = spacetimedb.reducer(
  { request_id: s(), proposal_id: s(), expected_fingerprint: s(), note: s() },
  (ctx, a) => { V.approve_supplier_payment(ctx, ctx.sender, a.request_id, a.proposal_id, a.expected_fingerprint, a.note); });
export const reject_supplier_payment = spacetimedb.reducer(
  { request_id: s(), proposal_id: s(), note: s() },
  (ctx, a) => { V.reject_supplier_payment(ctx, ctx.sender, a.request_id, a.proposal_id, a.note); });
export const record_deposit_allocation = spacetimedb.reducer(
  { request_id: s(), id: s(), deposit_id: s(), invoice_id: s(), amount_cents: t.i64() },
  (ctx, a) => { V.record_deposit_allocation(ctx, ctx.sender, a.request_id, a.id, a.deposit_id, a.invoice_id, a.amount_cents); });
