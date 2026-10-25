"""Typed wrappers for every reducer in docs/CONTRACT.md §4.

This is the ONLY place that knows argument order. All other Python code calls these.
`request_id` is added by the store. Keep in sync with CONTRACT.md (version v1).
"""

from __future__ import annotations

from typing import Any

from .store import Result, Store, dumps


def _j(value: Any) -> str:
    return value if isinstance(value, str) else dumps(value)


# 4.1 Setup
def claim_admin(s: Store) -> Result:
    return s.call("admin", "claim_admin")


def register_actor(s: Store, identity_hex: str, role: str, display_name: str) -> Result:
    return s.call("admin", "register_actor", identity_hex, role, display_name)


# 4.2 Records
def upsert_company(s: Store, role: str, id: str, name: str, owner_name: str, state: str, bank_account_ref: str, bank_last4: str) -> Result:
    return s.call(role, "upsert_company", id, name, owner_name, state, bank_account_ref, bank_last4)


def upsert_project(s: Store, role: str, id: str, name: str, address: str, status: str = "active") -> Result:
    return s.call(role, "upsert_project", id, name, address, status)


def upsert_sub(
    s: Store, role: str, id: str, name: str, trade: str, license_number: str, license_state: str,
    contact_email: str, email_domain: str, phone_on_file: str, bank_account_ref: str, bank_last4: str,
    bank_owner_name: str, crs_ref: str, status: str,
) -> Result:
    return s.call(role, "upsert_sub", id, name, trade, license_number, license_state, contact_email, email_domain,
                  phone_on_file, bank_account_ref, bank_last4, bank_owner_name, crs_ref, status)


def upsert_contract(
    s: Store, role: str, id: str, sub_id: str, project_id: str, title: str, original_value_cents: int,
    retainage_bps: int, payment_terms_days: int, lien_waiver_rule: str, bank_change_clause: str, source_file_id: str,
) -> Result:
    return s.call(role, "upsert_contract", id, sub_id, project_id, title, original_value_cents, retainage_bps,
                  payment_terms_days, lien_waiver_rule, bank_change_clause, source_file_id)


def upsert_contract_line(s: Store, role: str, id: str, contract_id: str, code: str, description: str, scheduled_value_cents: int) -> Result:
    return s.call(role, "upsert_contract_line", id, contract_id, code, description, scheduled_value_cents)


def confirm_contract(s: Store, role: str, contract_id: str) -> Result:
    return s.call(role, "confirm_contract", contract_id)


def record_source_file(
    s: Store, id: str, kind: str, filename: str, sha256: str, received_at_iso: str, from_address: str, subject: str, storage_path: str,
) -> Result:
    return s.call("sync", "record_source_file", id, kind, filename, sha256, received_at_iso, from_address, subject, storage_path)


def record_bill(
    s: Store, role: str, id: str, sub_id: str, contract_id: str, source_file_id: str, invoice_number: str,
    bill_date: str, due_date: str, period_label: str, amount_cents: int, retainage_cents: int,
    remit_bank_name: str, remit_account_ref: str, remit_account_last4: str, from_address: str,
    has_lien_waiver: bool, extracted_json: Any,
) -> Result:
    return s.call(role, "record_bill", id, sub_id, contract_id, source_file_id, invoice_number, bill_date, due_date,
                  period_label, amount_cents, retainage_cents, remit_bank_name, remit_account_ref,
                  remit_account_last4, from_address, has_lien_waiver, _j(extracted_json))


def record_bill_line(
    s: Store, role: str, id: str, bill_id: str, contract_line_code: str, description: str,
    this_period_cents: int, previous_cents: int, percent_complete_bps: int,
) -> Result:
    return s.call(role, "record_bill_line", id, bill_id, contract_line_code, description, this_period_cents,
                  previous_cents, percent_complete_bps)


def record_bank_snapshot(s: Store, role: str, id: str, account_ref: str, balance_cents: int, as_of_iso: str) -> Result:
    return s.call(role, "record_bank_snapshot", id, account_ref, balance_cents, as_of_iso)


def post_journal(s: Store, role: str, journal_id: str, entry_date: str, memo: str, ref_type: str, ref_id: str, lines: list[dict[str, Any]]) -> Result:
    return s.call(role, "post_journal", journal_id, entry_date, memo, ref_type, ref_id, _j(lines))


# 4.3 Work
def create_work_item(s: Store, role: str, id: str, kind: str, entity_id: str, origin: str, summary: str) -> Result:
    return s.call(role, "create_work_item", id, kind, entity_id, origin, summary)


def set_work_item_state(s: Store, id: str, state: str, note: str = "") -> Result:
    return s.call("agent", "set_work_item_state", id, state, note)


def log_agent_step(s: Store, work_item_id: str, kind: str, title: str, detail: Any = None) -> Result:
    return s.call("agent", "log_agent_step", work_item_id, kind, title, _j(detail if detail is not None else {}))


def record_check(s: Store, work_item_id: str, check_code: str, status: str, summary: str, evidence: Any, source: str) -> Result:
    return s.call("agent", "record_check", work_item_id, check_code, status, summary, _j(evidence), source)


def propose(
    s: Store, id: str, work_item_id: str, kind: str, amount_cents: int, payee_sub_id: str,
    payee_account_ref: str, reason: str, evidence: Any, role: str = "agent",
) -> Result:
    return s.call(role, "propose", id, work_item_id, kind, amount_cents, payee_sub_id, payee_account_ref, reason, _j(evidence))


def decide_proposal(s: Store, role: str, proposal_id: str, approve: bool, note: str = "") -> Result:
    return s.call(role, "decide_proposal", proposal_id, approve, note)


def cancel_proposal(s: Store, role: str, id: str, note: str = "") -> Result:
    return s.call(role, "cancel_proposal", id, note)


# 4.4 Payments
def start_payment(s: Store, proposal_id: str, role: str = "gateway") -> Result:
    return s.call(role, "start_payment", proposal_id)


def record_payment(s: Store, proposal_id: str, nessie_transfer_id: str, status: str, error: str = "", role: str = "gateway") -> Result:
    return s.call(role, "record_payment", proposal_id, nessie_transfer_id, status, error)


# 4.5 Jobs
def enqueue_job(s: Store, role: str, id: str, kind: str, payload: Any) -> Result:
    return s.call(role, "enqueue_job", id, kind, _j(payload))


def claim_job(s: Store, role: str, job_id: str) -> Result:
    return s.call(role, "claim_job", job_id)


def finish_job(s: Store, role: str, job_id: str, ok: bool, result: Any = None, error: str = "") -> Result:
    return s.call(role, "finish_job", job_id, ok, _j(result if result is not None else {}), error)


# 4.6 Bank changes
def request_bank_change(s: Store, role: str, id: str, sub_id: str, new_account_ref: str, new_last4: str, new_owner_name: str, requested_via: str) -> Result:
    return s.call(role, "request_bank_change", id, sub_id, new_account_ref, new_last4, new_owner_name, requested_via)


def record_verification(s: Store, id: str, bank_change_id: str, method: str, result: str, detail: str = "") -> Result:
    return s.call("agent", "record_verification", id, bank_change_id, method, result, detail)


# 4.7 Change orders
def upsert_change_order(s: Store, role: str, id: str, contract_id: str, number: str, description: str, amount_cents: int) -> Result:
    return s.call(role, "upsert_change_order", id, contract_id, number, description, amount_cents)


def decide_change_order(s: Store, role: str, id: str, approve: bool, note: str = "") -> Result:
    return s.call(role, "decide_change_order", id, approve, note)


# 4.8 Policies, questions, chat
def propose_policy(s: Store, id: str, scope: str, sub_id: str, rule_code: str, params: Any, description: str, evidence: Any) -> Result:
    return s.call("agent", "propose_policy", id, scope, sub_id, rule_code, _j(params), description, _j(evidence))


def decide_policy(s: Store, role: str, id: str, approve: bool, note: str = "") -> Result:
    return s.call(role, "decide_policy", id, approve, note)


def ask_question(s: Store, id: str, work_item_id: str, to_role: str, text: str, options: Any) -> Result:
    return s.call("agent", "ask_question", id, work_item_id, to_role, text, _j(options))


def answer_question(s: Store, role: str, id: str, answer: str) -> Result:
    return s.call(role, "answer_question", id, answer)


def ask_why(s: Store, role: str, id: str, work_item_id: str, text: str) -> Result:
    return s.call(role, "ask_why", id, work_item_id, text)


def post_chat_answer(s: Store, id: str, work_item_id: str, text: str, citations: Any) -> Result:
    return s.call("agent", "post_chat_answer", id, work_item_id, text, _j(citations))


# 4.9 Scorecard
def record_score_run(s: Store, id: str, status: str, totals: Any) -> Result:
    return s.call("sync", "record_score_run", id, status, _j(totals))


def record_score_case(
    s: Store, id: str, run_id: str, attack_type: str, expected: str, actual: str, correct: bool, amount_cents: int, work_item_id: str,
) -> Result:
    return s.call("sync", "record_score_case", id, run_id, attack_type, expected, actual, correct, amount_cents, work_item_id)
