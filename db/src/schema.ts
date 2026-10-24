// Tables for the Countersign module. Built exactly to docs/CONTRACT.md §3.
// Column order is declaration order. Names are snake_case and never converted.
import { schema, table, t, CaseConversionPolicy } from 'spacetimedb/server';
import type { InferSchema, ReducerCtx } from 'spacetimedb/server';

// ---------- 3.1 System ----------

export const actor = table({ name: 'actor', public: true }, {
  identity: t.identity().primaryKey(),
  role: t.string(),
  display_name: t.string(),
  created_at: t.timestamp(),
});

export const request_result = table({ name: 'request_result', public: true }, {
  request_id: t.string().primaryKey(),
  reducer: t.string(),
  caller_role: t.string(),
  outcome: t.string(),
  message: t.string(),
  created_at: t.timestamp(),
});

export const audit_log = table({ name: 'audit_log', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  at: t.timestamp(),
  request_id: t.string(),
  actor_role: t.string(),
  actor_identity: t.string(),
  action: t.string(),
  entity_type: t.string(),
  entity_id: t.string().index('btree'),
  outcome: t.string(),
  reason: t.string(),
  before_json: t.string(),
  after_json: t.string(),
});

export const job = table({ name: 'job', public: true }, {
  id: t.string().primaryKey(),
  kind: t.string(),
  assignee_role: t.string(),
  payload_json: t.string(),
  status: t.string().index('btree'),
  requested_by: t.string(),
  claimed_by: t.string(),
  result_json: t.string(),
  error: t.string(),
  created_at: t.timestamp(),
  updated_at: t.timestamp(),
});

export const config = table({ name: 'config', public: true }, {
  key: t.string().primaryKey(),
  value: t.string(),
});

// ---------- 3.2 Records ----------

export const company = table({ name: 'company', public: true }, {
  id: t.string().primaryKey(),
  name: t.string(),
  owner_name: t.string(),
  state: t.string(),
  bank_account_ref: t.string(),
  bank_last4: t.string(),
});

export const project = table({ name: 'project', public: true }, {
  id: t.string().primaryKey(),
  name: t.string(),
  address: t.string(),
  status: t.string(),
});

export const sub = table({ name: 'sub', public: true }, {
  id: t.string().primaryKey(),
  name: t.string(),
  trade: t.string(),
  license_number: t.string(),
  license_state: t.string(),
  contact_email: t.string(),
  email_domain: t.string(),
  phone_on_file: t.string(),
  bank_account_ref: t.string(),
  bank_last4: t.string(),
  bank_owner_name: t.string(),
  crs_ref: t.string(),
  status: t.string(),
  created_at: t.timestamp(),
});

export const contract = table({ name: 'contract', public: true }, {
  id: t.string().primaryKey(),
  sub_id: t.string().index('btree'),
  project_id: t.string(),
  title: t.string(),
  original_value_cents: t.i64(),
  retainage_bps: t.u32(),
  payment_terms_days: t.u32(),
  lien_waiver_rule: t.string(),
  bank_change_clause: t.string(),
  source_file_id: t.string(),
  status: t.string(),
  confirmed_by_role: t.string(),
});

export const contract_line = table({ name: 'contract_line', public: true }, {
  id: t.string().primaryKey(),
  contract_id: t.string().index('btree'),
  code: t.string(),
  description: t.string(),
  scheduled_value_cents: t.i64(),
});

export const change_order = table({ name: 'change_order', public: true }, {
  id: t.string().primaryKey(),
  contract_id: t.string().index('btree'),
  number: t.string(),
  description: t.string(),
  amount_cents: t.i64(),
  status: t.string(),
  decided_by_role: t.string(),
});

export const source_file = table({ name: 'source_file', public: true }, {
  id: t.string().primaryKey(),
  kind: t.string(),
  filename: t.string(),
  sha256: t.string(),
  received_at_iso: t.string(),
  from_address: t.string(),
  subject: t.string(),
  storage_path: t.string(),
});

export const bill = table({ name: 'bill', public: true }, {
  id: t.string().primaryKey(),
  sub_id: t.string().index('btree'),
  contract_id: t.string(),
  source_file_id: t.string(),
  invoice_number: t.string(),
  bill_date: t.string(),
  due_date: t.string(),
  period_label: t.string(),
  amount_cents: t.i64(),
  retainage_cents: t.i64(),
  remit_bank_name: t.string(),
  remit_account_ref: t.string(),
  remit_account_last4: t.string(),
  from_address: t.string(),
  has_lien_waiver: t.bool(),
  extracted_json: t.string(),
});

export const bill_line = table({ name: 'bill_line', public: true }, {
  id: t.string().primaryKey(),
  bill_id: t.string().index('btree'),
  contract_line_code: t.string(),
  description: t.string(),
  this_period_cents: t.i64(),
  previous_cents: t.i64(),
  percent_complete_bps: t.u32(),
});

export const bank_snapshot = table({ name: 'bank_snapshot', public: true }, {
  id: t.string().primaryKey(),
  account_ref: t.string(),
  balance_cents: t.i64(),
  as_of_iso: t.string(),
});

export const ledger_line = table({ name: 'ledger_line', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  journal_id: t.string().index('btree'),
  entry_date: t.string(),
  memo: t.string(),
  ref_type: t.string(),
  ref_id: t.string(),
  account: t.string(),
  debit_cents: t.i64(),
  credit_cents: t.i64(),
});

// ---------- 3.3 Work ----------

export const work_item = table({ name: 'work_item', public: true }, {
  id: t.string().primaryKey(),
  kind: t.string(),
  entity_id: t.string(),
  origin: t.string(),
  state: t.string().index('btree'),
  summary: t.string(),
  risk_level: t.string(),
  created_at: t.timestamp(),
  updated_at: t.timestamp(),
});

export const agent_step = table({ name: 'agent_step', public: true }, {
  id: t.u64().primaryKey().autoInc(),
  work_item_id: t.string().index('btree'),
  at: t.timestamp(),
  kind: t.string(),
  title: t.string(),
  detail_json: t.string(),
});

export const check_result = table({ name: 'check_result', public: true }, {
  id: t.string().primaryKey(),
  work_item_id: t.string().index('btree'),
  check_code: t.string(),
  status: t.string(),
  summary: t.string(),
  evidence_json: t.string(),
  source: t.string(),
  at: t.timestamp(),
});

export const proposal = table({ name: 'proposal', public: true }, {
  id: t.string().primaryKey(),
  work_item_id: t.string().index('btree'),
  kind: t.string(),
  amount_cents: t.i64(),
  payee_sub_id: t.string(),
  payee_account_ref: t.string(),
  reason: t.string(),
  evidence_json: t.string(),
  status: t.string(),
  proposed_by_role: t.string(),
  proposed_by_identity: t.string(),
  decided_by_role: t.string(),
  decided_by_identity: t.string(),
  decision_note: t.string(),
  created_at: t.timestamp(),
  decided_at_iso: t.string(),
});

export const payment = table({ name: 'payment', public: true }, {
  id: t.string().primaryKey(),
  proposal_id: t.string(),
  nessie_transfer_id: t.string(),
  amount_cents: t.i64(),
  payee_account_ref: t.string(),
  status: t.string(),
  error: t.string(),
  at: t.timestamp(),
});

export const bank_change = table({ name: 'bank_change', public: true }, {
  id: t.string().primaryKey(),
  sub_id: t.string(),
  new_account_ref: t.string(),
  new_last4: t.string(),
  new_owner_name: t.string(),
  requested_via: t.string(),
  status: t.string(),
  created_at: t.timestamp(),
});

export const verification = table({ name: 'verification', public: true }, {
  id: t.string().primaryKey(),
  bank_change_id: t.string().index('btree'),
  method: t.string(),
  result: t.string(),
  detail: t.string(),
  at: t.timestamp(),
});

export const policy = table({ name: 'policy', public: true }, {
  id: t.string().primaryKey(),
  scope: t.string(),
  sub_id: t.string(),
  rule_code: t.string(),
  params_json: t.string(),
  description: t.string(),
  evidence_json: t.string(),
  status: t.string(),
  proposed_by_role: t.string(),
  decided_by_role: t.string(),
});

export const question = table({ name: 'question', public: true }, {
  id: t.string().primaryKey(),
  work_item_id: t.string(),
  to_role: t.string(),
  text: t.string(),
  options_json: t.string(),
  status: t.string(),
  answer: t.string(),
  answered_by_role: t.string(),
});

export const chat_message = table({ name: 'chat_message', public: true }, {
  id: t.string().primaryKey(),
  work_item_id: t.string().index('btree'),
  author_role: t.string(),
  text: t.string(),
  citations_json: t.string(),
  at: t.timestamp(),
});

export const score_run = table({ name: 'score_run', public: true }, {
  id: t.string().primaryKey(),
  status: t.string(),
  totals_json: t.string(),
  started_at: t.timestamp(),
});

export const score_case = table({ name: 'score_case', public: true }, {
  id: t.string().primaryKey(),
  run_id: t.string().index('btree'),
  attack_type: t.string(),
  expected: t.string(),
  actual: t.string(),
  correct: t.bool(),
  amount_cents: t.i64(),
  work_item_id: t.string(),
});

const spacetimedb = schema(
  {
    actor, request_result, audit_log, job, config,
    company, project, sub, contract, contract_line, change_order, source_file,
    bill, bill_line, bank_snapshot, ledger_line,
    work_item, agent_step, check_result, proposal, payment, bank_change,
    verification, policy, question, chat_message, score_run, score_case,
  },
  { CASE_CONVERSION_POLICY: CaseConversionPolicy.None },
);

export default spacetimedb;
export type S = InferSchema<typeof spacetimedb>;
export type Ctx = ReducerCtx<S>;
