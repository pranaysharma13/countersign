"""Typed wrappers for every reducer in docs/CONTRACT.md §4 and §9.4.

This is the ONLY place that knows argument order. All other Python code calls these.
`request_id` is added by the store. Keep in sync with CONTRACT.md (version v2.1).
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


# 9.4 Supplier invoices: setup and records
def set_authority(s: Store, identity_hex: str, role: str, limit_cents: int, project_scope: str = "*") -> Result:
    return s.call("admin", "set_authority", identity_hex, role, limit_cents, project_scope)


def upsert_supplier(s: Store, role: str, id: str, name: str, email_domain: str, phone_on_file: str, crs_ref: str, status: str = "active") -> Result:
    return s.call(role, "upsert_supplier", id, name, email_domain, phone_on_file, crs_ref, status)


def upsert_supplier_contact(
    s: Store, role: str, id: str, supplier_id: str, name: str, email: str, phone: str, title: str, pre_established: bool,
) -> Result:
    return s.call(role, "upsert_supplier_contact", id, supplier_id, name, email, phone, title, pre_established)


def add_payee_profile(
    s: Store, role: str, id: str, supplier_id: str, version: int, account_ref: str, last4: str, bank_name: str, requested_via: str,
) -> Result:
    return s.call(role, "add_payee_profile", id, supplier_id, version, account_ref, last4, bank_name, requested_via)


def record_document(s: Store, id: str, kind: str, source_file_id: str, sha256: str, filename: str, pages: int) -> Result:
    return s.call("sync", "record_document", id, kind, source_file_id, sha256, filename, pages)


def add_fragment(
    s: Store, role: str, id: str, document_id: str, page: int, email_message_id: str, line_start: int, line_end: int, text: str,
) -> Result:
    return s.call(role, "add_fragment", id, document_id, page, email_message_id, line_start, line_end, text)


def record_email(
    s: Store, id: str, thread_id: str, document_id: str, from_address: str, to_addresses: str, subject: str,
    original_sent_at_iso: str, ingested_at_iso: str, body_fragment_id: str,
) -> Result:
    return s.call("sync", "record_email", id, thread_id, document_id, from_address, to_addresses, subject,
                  original_sent_at_iso, ingested_at_iso, body_fragment_id)


def record_extraction_run(
    s: Store, id: str, document_id: str, mode: str, model: str, prompt_version: str, status: str, error: str, fields: Any,
) -> Result:
    return s.call("agent", "record_extraction_run", id, document_id, mode, model, prompt_version, status, error, _j(fields))


def upsert_purchase(
    s: Store, role: str, id: str, supplier_id: str, project_id: str, description: str, unit: str, po_number: str,
    quote_document_id: str, po_document_id: str, status: str = "open",
) -> Result:
    return s.call(role, "upsert_purchase", id, supplier_id, project_id, description, unit, po_number,
                  quote_document_id, po_document_id, status)


def record_term(
    s: Store, role: str, id: str, purchase_id: str, code: str, label: str, amount_cents: int, quantity_milli: int,
    text: str, scope: Any, effective_from: str, effective_to: str, status: str, source_fragment_ids: Any, version: int,
) -> Result:
    return s.call(role, "record_term", id, purchase_id, code, label, amount_cents, quantity_milli, text, _j(scope),
                  effective_from, effective_to, status, _j(source_fragment_ids), version)


def record_deposit(s: Store, role: str, id: str, purchase_id: str, supplier_id: str, amount_cents: int, status: str, transfer_ref: str) -> Result:
    return s.call(role, "record_deposit", id, purchase_id, supplier_id, amount_cents, status, transfer_ref)


# 9.4 Amendments
def propose_change_request(
    s: Store, role: str, id: str, purchase_id: str, kind: str, description: str, amount_cents: int, rate_cents: int,
    rate_unit: str, scope: Any, effective_from: str, original_sent_at_iso: str, ingested_at_iso: str,
    classification: str, supplier_acceptance: str, source_fragment_ids: Any,
) -> Result:
    return s.call(role, "propose_change_request", id, purchase_id, kind, description, amount_cents, rate_cents, rate_unit,
                  _j(scope), effective_from, original_sent_at_iso, ingested_at_iso, classification, supplier_acceptance,
                  _j(source_fragment_ids))


def record_supplier_acceptance(s: Store, role: str, change_request_id: str, supplier_acceptance: str, fragment_ids: Any) -> Result:
    return s.call(role, "record_supplier_acceptance", change_request_id, supplier_acceptance, _j(fragment_ids))


def decide_change_request(s: Store, role: str, id: str, approve: bool, note: str = "") -> Result:
    return s.call(role, "decide_change_request", id, approve, note)


# 9.4 Invoices and assessment
def record_invoice(
    s: Store, role: str, id: str, supplier_id: str, purchase_id: str, invoice_number: str, invoice_date: str,
    due_date: str, currency: str = "USD",
) -> Result:
    return s.call(role, "record_invoice", id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, currency)


def record_invoice_revision(
    s: Store, role: str, id: str, invoice_id: str, revision: int, document_id: str, gross_cents: int,
    deposit_shown_cents: int, balance_requested_cents: int, supersedes_revision_id: str = "",
) -> Result:
    return s.call(role, "record_invoice_revision", id, invoice_id, revision, document_id, gross_cents, deposit_shown_cents,
                  balance_requested_cents, supersedes_revision_id)


def record_invoice_line(
    s: Store, role: str, id: str, revision_id: str, kind: str, description: str, quantity_milli: int, unit: str,
    unit_price_cents: int, amount_cents: int, linked_term_id: str, linked_change_request_id: str, source_fragment_ids: Any,
) -> Result:
    return s.call(role, "record_invoice_line", id, revision_id, kind, description, quantity_milli, unit, unit_price_cents,
                  amount_cents, linked_term_id, linked_change_request_id, _j(source_fragment_ids))


def record_assessment(
    s: Store, id: str, revision_id: str, version: int, fingerprint: str, policy_version: str, claimed_cents: int,
    authorised_cents: int, pending_cents: int, variance_cents: int, deposit_available_cents: int,
    proposed_payment_cents: int, commercial_status: str, summary: str, details: Any, next_action: str,
) -> Result:
    return s.call("agent", "record_assessment", id, revision_id, version, fingerprint, policy_version, claimed_cents,
                  authorised_cents, pending_cents, variance_cents, deposit_available_cents, proposed_payment_cents,
                  commercial_status, summary, _j(details), next_action)


def open_hold(s: Store, role: str, id: str, revision_id: str, code: str, amount_cents: int, reason: str, evidence: Any) -> Result:
    return s.call(role, "open_hold", id, revision_id, code, amount_cents, reason, _j(evidence))


def resolve_hold(s: Store, role: str, id: str, note: str) -> Result:
    return s.call(role, "resolve_hold", id, note)


# 9.4 People in the loop
def attest_receipt(
    s: Store, id: str, invoice_id: str, scope: str, quantity_milli: int, unit: str, reason: str, role: str = "receiver",
) -> Result:
    return s.call(role, "attest_receipt", id, invoice_id, scope, quantity_milli, unit, reason)


def decide_payee_profile(s: Store, role: str, id: str, approve: bool, verified_via_contact_id: str, note: str = "") -> Result:
    return s.call(role, "decide_payee_profile", id, approve, verified_via_contact_id, note)


# 9.4 Clarifications
def draft_outbox(s: Store, id: str, invoice_id: str, to_contact_id: str, subject: str, body: str, role: str = "agent") -> Result:
    return s.call(role, "draft_outbox", id, invoice_id, to_contact_id, subject, body)
