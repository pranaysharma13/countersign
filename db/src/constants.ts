// Enum lists from docs/CONTRACT.md. The module validates every string enum against these.

export const ROLES = ['admin', 'owner', 'bookkeeper', 'agent', 'gateway', 'sync', 'purchasing', 'receiver'] as const;
export type Role = (typeof ROLES)[number] | 'public';

export const SUB_STATUS = ['onboarding', 'active', 'blocked'];
export const PROJECT_STATUS = ['active', 'closed'];
export const LIEN_WAIVER_RULES = ['conditional_progress_each_bill', 'none'];
export const SOURCE_KINDS = ['email', 'upload', 'scam_page', 'legit_page', 'scorecard', 'seed', 'contract'];
export const LEDGER_REF_TYPES = ['bill', 'payment', 'seed', 'deposit', 'invoice'];

export const WORK_KINDS = ['bill', 'bank_change', 'contract_onboarding', 'supplier_invoice'];
export const ORIGINS = ['inbox', 'upload', 'scam_page', 'legit_page', 'scorecard', 'seed'];
export const STEP_KINDS = ['plan', 'tool_call', 'tool_result', 'thought', 'decision', 'error'];
export const CHECK_STATUS = ['pass', 'fail', 'warn', 'error', 'skipped'];
export const CHECK_SOURCES = ['contract', 'history', 'document', 'crs', 'nessie', 'apify', 'claude', 'audit'];

export const CHECK_CODES = [
  'bank_mismatch', 'quiet_bank_edit', 'license', 'crs_identity', 'crs_liens_judgments',
  'sender_domain', 'duplicate', 'overbilling', 'unapproved_change_order', 'lien_waiver_missing',
  'math_mismatch', 'split_bill', 'fake_owner_instruction', 'prompt_injection', 'cash_available',
];

// The owner can't override a hold when one of these checks failed (CONTRACT §3.4).
export const HARD_STOP_CHECKS = ['bank_mismatch', 'quiet_bank_edit', 'license', 'crs_identity'];

export const WORK_STATES = [
  'new', 'reading', 'investigating', 'proposed', 'approved', 'paying', 'paid',
  'held', 'closed_held', 'override_requested', 'rejected', 'needs_info', 'failed',
];

// set_work_item_state: the agent may only move items to these states...
export const AGENT_TARGET_STATES = ['reading', 'investigating', 'needs_info', 'failed'];
// ...and only out of these states. Anything else (held, proposed, approved, ...) would let the
// AI walk away from a hold or a decision.
export const AGENT_SOURCE_STATES = ['new', 'reading', 'investigating', 'needs_info'];

// propose(kind = payment) is only allowed from these states. Never from `held`.
export const PAYMENT_PROPOSE_FROM = ['investigating', 'override_requested'];
// propose(kind = hold) is allowed from any non-final state. The AI can always add a hold.
export const HOLD_PROPOSE_FROM = ['new', 'reading', 'investigating', 'needs_info', 'proposed', 'override_requested'];

// Job kinds (CONTRACT §4.5). `enqueue_by` = roles allowed to call enqueue_job for that kind;
// an empty list means the module creates the job itself and enqueue_job refuses it.
export const JOB_KINDS: Record<string, { enqueue_by: string[]; assignee: string }> = {
  process_bill: { enqueue_by: ['sync'], assignee: 'agent' },
  process_upload: { enqueue_by: ['owner', 'bookkeeper', 'sync'], assignee: 'sync' },
  read_contract: { enqueue_by: ['owner', 'bookkeeper', 'sync'], assignee: 'agent' },
  scam_submit: { enqueue_by: ['*'], assignee: 'sync' },
  legit_submit: { enqueue_by: ['*'], assignee: 'sync' },
  answer_why: { enqueue_by: [], assignee: 'agent' },
  prepare_override_payment: { enqueue_by: [], assignee: 'agent' },
  pay_proposal: { enqueue_by: [], assignee: 'gateway' },
  resume_work_item: { enqueue_by: [], assignee: 'agent' },
  scorecard_run: { enqueue_by: ['owner', 'bookkeeper'], assignee: 'sync' },
  compromised_agent_demo: { enqueue_by: ['owner'], assignee: 'agent' },
  reset_demo: { enqueue_by: ['owner'], assignee: 'sync' },
  // v2 (CONTRACT §9.5)
  process_document: { enqueue_by: ['sync', 'owner', 'purchasing'], assignee: 'agent' },
  reassess_invoice: { enqueue_by: ['sync', 'agent', 'owner'], assignee: 'agent' },
  send_outbox: { enqueue_by: [], assignee: 'sync' },
  pay_supplier: { enqueue_by: [], assignee: 'gateway' },
  sneak_charge: { enqueue_by: ['*'], assignee: 'sync' },
  due_scan: { enqueue_by: ['owner', 'sync'], assignee: 'sync' },
};
export const JOB_LEASE_MICROS = 5n * 60n * 1_000_000n; // a claimed job can be re-claimed after 5 minutes
export const PUBLIC_QUEUED_LIMIT = 3;
export const MAX_JOB_ATTEMPTS = 3;
