// Countersign SpacetimeDB module entry. Reducer names and parameter ORDER follow
// docs/CONTRACT.md §4 exactly: Python calls reducers with positional JSON arrays.
// Bodies live in logic.ts (this file may only export spacetime exports).
import { t } from 'spacetimedb/server';
import spacetimedb from './schema';
import * as L from './logic';

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
