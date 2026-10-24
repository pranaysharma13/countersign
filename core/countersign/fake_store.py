"""In-memory reference implementation of the SpacetimeDB module (docs/CONTRACT.md v1).

Used for Python tests and for running the pipeline before the real module is up
(STORE_BACKEND=fake). It also documents, in runnable form, what the TypeScript
module must enforce. Identities are simplified to role names here.

Discipline: every reducer validates fully BEFORE mutating, so a Denied/Invalid
never leaves a half-applied change (the real module gets this from transactions).
"""

from __future__ import annotations

import copy
import json
import time
from typing import Any, Callable

from .store import Result, StoreError, dumps

HARD_STOP_CHECKS = {"bank_mismatch", "quiet_bank_edit", "license", "crs_identity"}
AGENT_STATE_TARGETS = {"reading", "investigating", "needs_info", "failed"}

JOB_KINDS: dict[str, tuple[set[str] | None, str]] = {
    # kind: (who may enqueue (None = anyone), assignee)
    "process_bill": ({"sync"}, "agent"),
    "process_upload": ({"owner", "bookkeeper", "sync"}, "sync"),
    "read_contract": ({"owner", "bookkeeper", "sync"}, "agent"),
    "scam_submit": (None, "sync"),
    "legit_submit": (None, "sync"),
    "answer_why": (set(), "agent"),
    "prepare_override_payment": (set(), "agent"),
    "pay_proposal": (set(), "gateway"),
    "resume_work_item": (set(), "agent"),
    "scorecard_run": ({"owner", "bookkeeper"}, "sync"),
    "compromised_agent_demo": ({"owner"}, "agent"),
    "reset_demo": ({"owner"}, "sync"),
}

PUBLIC_QUEUE_LIMIT = 3


class Denied(Exception):
    def __init__(self, message: str, entity_type: str = "", entity_id: str = ""):
        super().__init__(message)
        self.message, self.entity_type, self.entity_id = message, entity_type, entity_id


class Invalid(Exception):
    pass


def _now() -> int:
    return time.time_ns() // 1000


ALLOWED: dict[str, set[str] | None] = {
    "claim_admin": None,
    "register_actor": {"admin"},
    "upsert_company": {"sync", "admin"},
    "upsert_project": {"sync", "admin"},
    "upsert_sub": {"sync", "admin"},
    "upsert_contract": {"sync", "agent"},
    "upsert_contract_line": {"sync", "agent"},
    "confirm_contract": {"owner", "bookkeeper"},
    "record_source_file": {"sync"},
    "record_bill": {"sync", "agent"},
    "record_bill_line": {"sync", "agent"},
    "record_bank_snapshot": {"sync", "gateway"},
    "post_journal": {"sync", "gateway"},
    "create_work_item": {"sync", "agent"},
    "set_work_item_state": {"agent"},
    "log_agent_step": {"agent"},
    "record_check": {"agent"},
    "propose": {"agent"},
    "decide_proposal": {"owner", "bookkeeper"},
    "cancel_proposal": {"agent", "owner"},
    "start_payment": {"gateway"},
    "record_payment": {"gateway"},
    "enqueue_job": None,
    "claim_job": None,
    "finish_job": None,
    "request_bank_change": {"sync", "agent"},
    "record_verification": {"agent"},
    "upsert_change_order": {"sync", "agent"},
    "decide_change_order": {"owner"},
    "propose_policy": {"agent"},
    "decide_policy": {"bookkeeper"},
    "ask_question": {"agent"},
    "answer_question": {"owner", "bookkeeper"},
    "ask_why": {"owner", "bookkeeper"},
    "post_chat_answer": {"agent"},
    "record_score_run": {"sync"},
    "record_score_case": {"sync"},
}

AUTO_INC = {"audit_log", "agent_step", "ledger_line"}


class FakeStore:
    def __init__(self) -> None:
        self.tables: dict[str, dict[Any, dict[str, Any]]] = {}
        self._seq: dict[str, int] = {}
        self.admin_claimed = False

    # ------------------------------------------------------------------ plumbing
    def _t(self, name: str) -> dict[Any, dict[str, Any]]:
        return self.tables.setdefault(name, {})

    def _get(self, table: str, pk: Any) -> dict[str, Any] | None:
        return self._t(table).get(pk)

    def _put(self, table: str, row: dict[str, Any], pk_field: str = "id") -> dict[str, Any]:
        if table in AUTO_INC:
            self._seq[table] = self._seq.get(table, 0) + 1
            row = {"id": self._seq[table], **row}
        self._t(table)[row[pk_field]] = row
        return row

    def rows(self, table: str, **filters: Any) -> list[dict[str, Any]]:
        out = []
        for row in self._t(table).values():
            if all(row.get(k) == v for k, v in filters.items()):
                out.append(copy.deepcopy(row))
        return out

    def _audit(self, rid: str, role: str, action: str, entity_type: str, entity_id: str, outcome: str,
               reason: str = "", before: Any = None, after: Any = None) -> None:
        self._put("audit_log", {
            "at": _now(), "request_id": rid, "actor_role": role, "actor_identity": role, "action": action,
            "entity_type": entity_type, "entity_id": entity_id, "outcome": outcome, "reason": reason,
            "before_json": dumps(before) if before is not None else "", "after_json": dumps(after) if after is not None else "",
        })

    def _result(self, rid: str, reducer: str, role: str, outcome: str, message: str = "") -> Result:
        self._put("request_result", {"request_id": rid, "reducer": reducer, "caller_role": role, "outcome": outcome,
                                      "message": message, "created_at": _now()}, pk_field="request_id")
        return Result(rid, outcome, message)

    def call(self, role: str, reducer: str, *args: Any, request_id: str | None = None) -> Result:
        from .ids import request_id as new_rid

        rid = request_id or new_rid()
        if rid in self._t("request_result"):
            return Result(rid, "duplicate", "")
        handler: Callable[..., tuple[str, str] | None] | None = getattr(self, f"_r_{reducer}", None)
        if handler is None:
            raise StoreError(f"unknown reducer {reducer}")
        caller = role if role in {"admin", "owner", "bookkeeper", "agent", "gateway", "sync"} else "public"
        allowed = ALLOWED.get(reducer)
        if allowed is not None and caller not in allowed:
            msg = f"role '{caller}' may not call {reducer}"
            self._audit(rid, caller, reducer, "", "", "denied", msg)
            return self._result(rid, reducer, caller, "denied", msg)
        try:
            ret = handler(rid, caller, *args)
        except Denied as d:
            self._audit(rid, caller, reducer, d.entity_type, d.entity_id, "denied", d.message)
            return self._result(rid, reducer, caller, "denied", d.message)
        except Invalid as e:
            return self._result(rid, reducer, caller, "invalid", str(e))
        except TypeError as e:  # wrong arg count = a contract bug, like a reducer throwing
            raise StoreError(f"{reducer}: {e}") from e
        outcome, message = ret if ret else ("ok", "")
        return self._result(rid, reducer, caller, outcome, message)

    def _upsert(self, rid: str, role: str, action: str, table: str, row: dict[str, Any]) -> None:
        before = copy.deepcopy(self._get(table, row["id"]))
        merged = {**(before or {}), **row}
        self._put(table, merged)
        self._audit(rid, role, action, table, row["id"], "ok", "", before, merged)

    def _update(self, rid: str, role: str, action: str, table: str, pk: Any, changes: dict[str, Any], reason: str = "") -> None:
        row = self._get(table, pk)
        assert row is not None
        before = copy.deepcopy(row)
        row.update(changes)
        self._audit(rid, role, action, table, str(pk), "ok", reason, before, copy.deepcopy(row))

    @staticmethod
    def _need(cond: bool, msg: str) -> None:
        if not cond:
            raise Invalid(msg)

    def _enqueue(self, rid: str, role: str, job_id: str, kind: str, payload: Any) -> None:
        assignee = JOB_KINDS[kind][1]
        self._upsert(rid, role, "enqueue_job", "job", {
            "id": job_id, "kind": kind, "assignee_role": assignee,
            "payload_json": payload if isinstance(payload, str) else dumps(payload), "status": "queued",
            "requested_by": role, "claimed_by": "", "result_json": "", "error": "",
            "created_at": _now(), "updated_at": _now(),
        })

    def _set_state(self, rid: str, role: str, action: str, wi_id: str, state: str, note: str = "") -> None:
        self._update(rid, role, action, "work_item", wi_id, {"state": state, "updated_at": _now()}, note)

    # ------------------------------------------------------------------ 4.1 setup
    def _r_claim_admin(self, rid: str, role: str) -> tuple[str, str] | None:
        if self.admin_claimed:
            raise Denied("admin already claimed", "actor", "")
        self.admin_claimed = True
        self._put("actor", {"identity": "admin", "role": "admin", "display_name": "setup", "created_at": _now()}, "identity")
        return None

    def _r_register_actor(self, rid: str, role: str, identity_hex: str, new_role: str, display_name: str) -> None:
        self._need(new_role in {"owner", "bookkeeper", "agent", "gateway", "sync"}, f"bad role {new_role}")
        self._put("actor", {"identity": identity_hex, "role": new_role, "display_name": display_name, "created_at": _now()}, "identity")

    # ------------------------------------------------------------------ 4.2 records
    def _r_upsert_company(self, rid, role, id, name, owner_name, state, bank_account_ref, bank_last4):
        self._upsert(rid, role, "upsert_company", "company", dict(id=id, name=name, owner_name=owner_name, state=state,
                                                                  bank_account_ref=bank_account_ref, bank_last4=bank_last4))

    def _r_upsert_project(self, rid, role, id, name, address, status):
        self._need(status in {"active", "closed"}, "bad status")
        self._upsert(rid, role, "upsert_project", "project", dict(id=id, name=name, address=address, status=status))

    def _r_upsert_sub(self, rid, role, id, name, trade, license_number, license_state, contact_email, email_domain,
                      phone_on_file, bank_account_ref, bank_last4, bank_owner_name, crs_ref, status):
        self._need(status in {"onboarding", "active", "blocked"}, "bad status")
        existing = self._get("sub", id)
        if existing is not None:
            for field, new in (("bank_account_ref", bank_account_ref), ("bank_last4", bank_last4), ("bank_owner_name", bank_owner_name)):
                if existing[field] != new:
                    raise Denied(f"quiet bank edit blocked: {field} can only change through a verified bank change", "sub", id)
        self._upsert(rid, role, "upsert_sub", "sub", dict(
            id=id, name=name, trade=trade, license_number=license_number, license_state=license_state,
            contact_email=contact_email, email_domain=email_domain, phone_on_file=phone_on_file,
            bank_account_ref=bank_account_ref, bank_last4=bank_last4, bank_owner_name=bank_owner_name,
            crs_ref=crs_ref, status=status, created_at=(existing or {}).get("created_at", _now())))

    def _r_upsert_contract(self, rid, role, id, sub_id, project_id, title, original_value_cents, retainage_bps,
                           payment_terms_days, lien_waiver_rule, bank_change_clause, source_file_id):
        existing = self._get("contract", id)
        if existing and existing["status"] == "confirmed":
            raise Denied("contract is confirmed and can't be edited", "contract", id)
        self._need(lien_waiver_rule in {"conditional_progress_each_bill", "none"}, "bad lien_waiver_rule")
        self._need(original_value_cents >= 0 and 0 <= retainage_bps <= 10000, "bad amounts")
        self._upsert(rid, role, "upsert_contract", "contract", dict(
            id=id, sub_id=sub_id, project_id=project_id, title=title, original_value_cents=original_value_cents,
            retainage_bps=retainage_bps, payment_terms_days=payment_terms_days, lien_waiver_rule=lien_waiver_rule,
            bank_change_clause=bank_change_clause, source_file_id=source_file_id, status="draft", confirmed_by_role=""))

    def _r_upsert_contract_line(self, rid, role, id, contract_id, code, description, scheduled_value_cents):
        c = self._get("contract", contract_id)
        self._need(c is not None, "unknown contract")
        if c["status"] == "confirmed":
            raise Denied("contract is confirmed and can't be edited", "contract", contract_id)
        self._upsert(rid, role, "upsert_contract_line", "contract_line", dict(
            id=id, contract_id=contract_id, code=code, description=description, scheduled_value_cents=scheduled_value_cents))

    def _r_confirm_contract(self, rid, role, contract_id):
        self._need(self._get("contract", contract_id) is not None, "unknown contract")
        self._update(rid, role, "confirm_contract", "contract", contract_id, {"status": "confirmed", "confirmed_by_role": role})

    def _r_record_source_file(self, rid, role, id, kind, filename, sha256, received_at_iso, from_address, subject, storage_path):
        self._upsert(rid, role, "record_source_file", "source_file", dict(
            id=id, kind=kind, filename=filename, sha256=sha256, received_at_iso=received_at_iso,
            from_address=from_address, subject=subject, storage_path=storage_path))

    def _r_record_bill(self, rid, role, id, sub_id, contract_id, source_file_id, invoice_number, bill_date, due_date,
                       period_label, amount_cents, retainage_cents, remit_bank_name, remit_account_ref,
                       remit_account_last4, from_address, has_lien_waiver, extracted_json):
        self._need(isinstance(amount_cents, int) and isinstance(retainage_cents, int), "amounts must be integer cents")
        self._upsert(rid, role, "record_bill", "bill", dict(
            id=id, sub_id=sub_id, contract_id=contract_id, source_file_id=source_file_id, invoice_number=invoice_number,
            bill_date=bill_date, due_date=due_date, period_label=period_label, amount_cents=amount_cents,
            retainage_cents=retainage_cents, remit_bank_name=remit_bank_name, remit_account_ref=remit_account_ref,
            remit_account_last4=remit_account_last4, from_address=from_address, has_lien_waiver=has_lien_waiver,
            extracted_json=extracted_json))

    def _r_record_bill_line(self, rid, role, id, bill_id, contract_line_code, description, this_period_cents,
                            previous_cents, percent_complete_bps):
        self._upsert(rid, role, "record_bill_line", "bill_line", dict(
            id=id, bill_id=bill_id, contract_line_code=contract_line_code, description=description,
            this_period_cents=this_period_cents, previous_cents=previous_cents, percent_complete_bps=percent_complete_bps))

    def _r_record_bank_snapshot(self, rid, role, id, account_ref, balance_cents, as_of_iso):
        self._upsert(rid, role, "record_bank_snapshot", "bank_snapshot",
                     dict(id=id, account_ref=account_ref, balance_cents=balance_cents, as_of_iso=as_of_iso))

    def _r_post_journal(self, rid, role, journal_id, entry_date, memo, ref_type, ref_id, lines_json):
        try:
            lines = json.loads(lines_json)
        except json.JSONDecodeError as e:
            raise Invalid(f"lines_json: {e}") from e
        self._need(len(lines) >= 2, "a journal needs at least two lines")
        debit = credit = 0
        for ln in lines:
            d, c = int(ln.get("debit_cents", 0)), int(ln.get("credit_cents", 0))
            self._need((d > 0) != (c > 0) and d >= 0 and c >= 0, "each line needs exactly one positive side")
            debit, credit = debit + d, credit + c
        self._need(debit == credit, f"journal doesn't balance: debits {debit} != credits {credit}")
        self._need(not self.rows("ledger_line", journal_id=journal_id), "journal already posted")
        for ln in lines:
            self._put("ledger_line", dict(journal_id=journal_id, entry_date=entry_date, memo=memo, ref_type=ref_type,
                                          ref_id=ref_id, account=ln["account"], debit_cents=int(ln.get("debit_cents", 0)),
                                          credit_cents=int(ln.get("credit_cents", 0))))
        self._audit(rid, role, "post_journal", "journal", journal_id, "ok", "", None, lines)

    # ------------------------------------------------------------------ 4.3 work
    def _r_create_work_item(self, rid, role, id, kind, entity_id, origin, summary):
        self._need(kind in {"bill", "bank_change", "contract_onboarding"}, "bad kind")
        if self._get("work_item", id):
            return ("duplicate", "work item exists")
        self._upsert(rid, role, "create_work_item", "work_item", dict(
            id=id, kind=kind, entity_id=entity_id, origin=origin, state="new", summary=summary, risk_level="low",
            created_at=_now(), updated_at=_now()))
        return None

    def _r_set_work_item_state(self, rid, role, id, state, note):
        self._need(self._get("work_item", id) is not None, "unknown work item")
        if state not in AGENT_STATE_TARGETS:
            raise Denied(f"agent may not set state '{state}'", "work_item", id)
        self._set_state(rid, role, "set_work_item_state", id, state, note)

    def _r_log_agent_step(self, rid, role, work_item_id, kind, title, detail_json):
        self._need(kind in {"plan", "tool_call", "tool_result", "thought", "decision", "error"}, "bad step kind")
        self._put("agent_step", dict(work_item_id=work_item_id, at=_now(), kind=kind, title=title, detail_json=detail_json))

    def _r_record_check(self, rid, role, work_item_id, check_code, status, summary, evidence_json, source):
        self._need(status in {"pass", "fail", "warn", "error", "skipped"}, "bad check status")
        self._upsert(rid, role, "record_check", "check_result", dict(
            id=f"{work_item_id}:{check_code}", work_item_id=work_item_id, check_code=check_code, status=status,
            summary=summary, evidence_json=evidence_json, source=source, at=_now()))
        if status == "fail":
            wi = self._get("work_item", work_item_id)
            if wi:
                wi["risk_level"] = "high" if check_code in HARD_STOP_CHECKS else max(wi["risk_level"], "medium", key=["low", "medium", "high"].index)

    def _r_propose(self, rid, role, id, work_item_id, kind, amount_cents, payee_sub_id, payee_account_ref, reason, evidence_json):
        wi = self._get("work_item", work_item_id)
        self._need(wi is not None, "unknown work item")
        self._need(kind in {"payment", "hold"}, "propose kind must be payment or hold")
        if kind == "payment":
            sub = self._get("sub", payee_sub_id)
            if sub is None or sub["status"] != "active":
                raise Denied("payee is not an active sub", "proposal", id)
            bill = self._get("bill", wi["entity_id"]) or {}
            contract = self._get("contract", bill.get("contract_id", ""))
            if contract is None or contract["status"] != "confirmed":
                raise Denied("contract is not confirmed", "proposal", id)
            if payee_account_ref != sub["bank_account_ref"]:
                raise Denied("payee account doesn't match the account on file", "proposal", id)
            self._need(amount_cents > 0, "amount must be positive")
        for p in self._t("proposal").values():
            if p["work_item_id"] == work_item_id and p["status"] == "pending":
                self._update(rid, role, "propose", "proposal", p["id"], {"status": "cancelled"}, "superseded")
        self._upsert(rid, role, "propose", "proposal", dict(
            id=id, work_item_id=work_item_id, kind=kind, amount_cents=amount_cents, payee_sub_id=payee_sub_id,
            payee_account_ref=payee_account_ref, reason=reason, evidence_json=evidence_json, status="pending",
            proposed_by_role=role, proposed_by_identity=role, decided_by_role="", decided_by_identity="",
            decision_note="", created_at=_now(), decided_at_iso=""))
        self._set_state(rid, role, "propose", work_item_id, "proposed" if kind == "payment" else "held", reason)

    def _r_decide_proposal(self, rid, role, proposal_id, approve, note):
        p = self._get("proposal", proposal_id)
        self._need(p is not None, "unknown proposal")
        self._need(p["status"] == "pending", f"proposal is {p['status']}")
        if p["proposed_by_identity"] == role:
            raise Denied("can't decide your own proposal", "proposal", proposal_id)
        if p["kind"] in {"payment", "hold", "bank_change"} and role != "owner":
            raise Denied("only the owner decides payments, holds and bank changes", "proposal", proposal_id)
        wi_id = p["work_item_id"]
        decided = {"decided_by_role": role, "decided_by_identity": role, "decision_note": note,
                   "decided_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S")}
        if p["kind"] == "payment":
            self._update(rid, role, "decide_proposal", "proposal", proposal_id, {"status": "approved" if approve else "rejected", **decided})
            self._set_state(rid, role, "decide_proposal", wi_id, "approved" if approve else "rejected", note)
            if approve:
                self._enqueue(rid, role, f"job_pay_{proposal_id}", "pay_proposal", {"proposal_id": proposal_id})
        elif p["kind"] == "hold":
            if approve:
                self._update(rid, role, "decide_proposal", "proposal", proposal_id, {"status": "approved", **decided})
                self._set_state(rid, role, "decide_proposal", wi_id, "closed_held", note)
            else:
                failed = [c for c in self._t("check_result").values()
                          if c["work_item_id"] == wi_id and c["status"] == "fail" and c["check_code"] in HARD_STOP_CHECKS]
                if failed:
                    raise Denied(f"Can't pay: {failed[0]['summary']}. Start a bank change verification instead.", "proposal", proposal_id)
                self._update(rid, role, "decide_proposal", "proposal", proposal_id, {"status": "rejected", **decided})
                self._set_state(rid, role, "decide_proposal", wi_id, "override_requested", note)
                self._enqueue(rid, role, f"job_override_{proposal_id}", "prepare_override_payment", {"work_item_id": wi_id, "note": note})
        elif p["kind"] == "bank_change":
            bc = self._get("bank_change", self._get("work_item", wi_id)["entity_id"]) or {}
            if approve:
                passed = {v["method"] for v in self._t("verification").values()
                          if v["bank_change_id"] == bc.get("id") and v["result"] == "pass"}
                missing = {"callback_phone_on_file", "crs_idv"} - passed
                if missing:
                    raise Denied(f"bank change needs passing verification: {', '.join(sorted(missing))}", "proposal", proposal_id)
                sub = self._get("sub", bc["sub_id"])
                self._update(rid, role, "decide_proposal", "sub", sub["id"], {
                    "bank_account_ref": bc["new_account_ref"], "bank_last4": bc["new_last4"],
                    "bank_owner_name": bc["new_owner_name"]}, "verified bank change")
                self._update(rid, role, "decide_proposal", "bank_change", bc["id"], {"status": "approved"})
            else:
                self._update(rid, role, "decide_proposal", "bank_change", bc["id"], {"status": "rejected"})
            self._update(rid, role, "decide_proposal", "proposal", proposal_id, {"status": "approved" if approve else "rejected", **decided})
            self._set_state(rid, role, "decide_proposal", wi_id, "closed_held" if not approve else "approved", note)

    def _r_cancel_proposal(self, rid, role, id, note):
        p = self._get("proposal", id)
        self._need(p is not None and p["status"] == "pending", "only pending proposals can be cancelled")
        self._update(rid, role, "cancel_proposal", "proposal", id, {"status": "cancelled", "decision_note": note})

    # ------------------------------------------------------------------ 4.4 payments
    def _r_start_payment(self, rid, role, proposal_id):
        p = self._get("proposal", proposal_id)
        self._need(p is not None, "unknown proposal")
        if p["status"] not in {"approved", "executing"}:
            raise Denied(f"proposal is {p['status']}, not approved", "proposal", proposal_id)
        self._update(rid, role, "start_payment", "proposal", proposal_id, {"status": "executing"})
        self._set_state(rid, role, "start_payment", p["work_item_id"], "paying")

    def _r_record_payment(self, rid, role, proposal_id, nessie_transfer_id, status, error):
        p = self._get("proposal", proposal_id)
        self._need(p is not None, "unknown proposal")
        self._need(status in {"sent", "failed"}, "bad payment status")
        if self._get("payment", proposal_id):
            return ("duplicate", "payment already recorded")
        if p["status"] not in {"approved", "executing"}:
            raise Denied(f"proposal is {p['status']}, not approved", "proposal", proposal_id)
        self._upsert(rid, role, "record_payment", "payment", dict(
            id=proposal_id, proposal_id=proposal_id, nessie_transfer_id=nessie_transfer_id, amount_cents=p["amount_cents"],
            payee_account_ref=p["payee_account_ref"], status=status, error=error, at=_now()))
        self._update(rid, role, "record_payment", "proposal", proposal_id, {"status": "executed" if status == "sent" else "failed"})
        self._set_state(rid, role, "record_payment", p["work_item_id"], "paid" if status == "sent" else "failed", error)
        return None

    # ------------------------------------------------------------------ 4.5 jobs
    def _r_enqueue_job(self, rid, role, id, kind, payload_json):
        self._need(kind in JOB_KINDS, f"unknown job kind {kind}")
        allowed, _ = JOB_KINDS[kind]
        if allowed is not None and role not in allowed:
            raise Denied(f"role '{role}' may not enqueue {kind}", "job", id)
        if role == "public":
            queued = [j for j in self._t("job").values() if j["requested_by"] == "public" and j["status"] == "queued"]
            if len(queued) >= PUBLIC_QUEUE_LIMIT:
                raise Denied("too many queued requests; wait for the last ones to finish", "job", id)
        if self._get("job", id):
            return ("duplicate", "job exists")
        self._enqueue(rid, role, id, kind, payload_json)
        return None

    def _r_claim_job(self, rid, role, job_id):
        j = self._get("job", job_id)
        self._need(j is not None, "unknown job")
        if j["assignee_role"] != role:
            raise Denied(f"job is assigned to {j['assignee_role']}", "job", job_id)
        if j["status"] != "queued":
            raise Denied(f"job is {j['status']}", "job", job_id)
        self._update(rid, role, "claim_job", "job", job_id, {"status": "claimed", "claimed_by": role, "updated_at": _now()})

    def _r_finish_job(self, rid, role, job_id, ok, result_json, error):
        j = self._get("job", job_id)
        self._need(j is not None, "unknown job")
        if j["claimed_by"] != role or j["status"] != "claimed":
            raise Denied("only the claimer can finish a claimed job", "job", job_id)
        self._update(rid, role, "finish_job", "job", job_id, {"status": "done" if ok else "failed", "result_json": result_json,
                                                             "error": error, "updated_at": _now()})

    # ------------------------------------------------------------------ 4.6 bank changes
    def _r_request_bank_change(self, rid, role, id, sub_id, new_account_ref, new_last4, new_owner_name, requested_via):
        self._need(self._get("sub", sub_id) is not None, "unknown sub")
        self._upsert(rid, role, "request_bank_change", "bank_change", dict(
            id=id, sub_id=sub_id, new_account_ref=new_account_ref, new_last4=new_last4, new_owner_name=new_owner_name,
            requested_via=requested_via, status="pending", created_at=_now()))
        wi_id = f"wi_{id}"
        self._upsert(rid, role, "request_bank_change", "work_item", dict(
            id=wi_id, kind="bank_change", entity_id=id, origin="inbox", state="held", risk_level="high",
            summary=f"Bank change requested for {sub_id}", created_at=_now(), updated_at=_now()))
        self._upsert(rid, role, "request_bank_change", "proposal", dict(
            id=f"prop_{id}", work_item_id=wi_id, kind="bank_change", amount_cents=0, payee_sub_id=sub_id,
            payee_account_ref=new_account_ref, reason="Bank change requested; needs verification", evidence_json="[]", status="pending",
            proposed_by_role=role, proposed_by_identity=role, decided_by_role="", decided_by_identity="", decision_note="",
            created_at=_now(), decided_at_iso=""))

    def _r_record_verification(self, rid, role, id, bank_change_id, method, result, detail):
        self._need(method in {"callback_phone_on_file", "crs_idv"} and result in {"pass", "fail"}, "bad verification")
        self._upsert(rid, role, "record_verification", "verification", dict(
            id=id, bank_change_id=bank_change_id, method=method, result=result, detail=detail, at=_now()))

    # ------------------------------------------------------------------ 4.7 change orders
    def _r_upsert_change_order(self, rid, role, id, contract_id, number, description, amount_cents):
        self._upsert(rid, role, "upsert_change_order", "change_order", dict(
            id=id, contract_id=contract_id, number=number, description=description, amount_cents=amount_cents,
            status=(self._get("change_order", id) or {}).get("status", "pending"), decided_by_role=""))

    def _r_decide_change_order(self, rid, role, id, approve, note):
        self._need(self._get("change_order", id) is not None, "unknown change order")
        self._update(rid, role, "decide_change_order", "change_order", id,
                     {"status": "approved" if approve else "rejected", "decided_by_role": role}, note)

    # ------------------------------------------------------------------ 4.8 policies, questions, chat
    def _r_propose_policy(self, rid, role, id, scope, sub_id, rule_code, params_json, description, evidence_json):
        self._upsert(rid, role, "propose_policy", "policy", dict(
            id=id, scope=scope, sub_id=sub_id, rule_code=rule_code, params_json=params_json, description=description,
            evidence_json=evidence_json, status="proposed", proposed_by_role=role, decided_by_role=""))

    def _r_decide_policy(self, rid, role, id, approve, note):
        self._need(self._get("policy", id) is not None, "unknown policy")
        self._update(rid, role, "decide_policy", "policy", id, {"status": "approved" if approve else "rejected", "decided_by_role": role}, note)

    def _r_ask_question(self, rid, role, id, work_item_id, to_role, text, options_json):
        self._upsert(rid, role, "ask_question", "question", dict(
            id=id, work_item_id=work_item_id, to_role=to_role, text=text, options_json=options_json, status="open",
            answer="", answered_by_role=""))
        self._set_state(rid, role, "ask_question", work_item_id, "needs_info", text)

    def _r_answer_question(self, rid, role, id, answer):
        q = self._get("question", id)
        self._need(q is not None and q["status"] == "open", "no open question")
        if q["to_role"] != role:
            raise Denied(f"question is for {q['to_role']}", "question", id)
        self._update(rid, role, "answer_question", "question", id, {"status": "answered", "answer": answer, "answered_by_role": role})
        self._enqueue(rid, role, f"job_resume_{id}", "resume_work_item", {"work_item_id": q["work_item_id"], "question_id": id})

    def _r_ask_why(self, rid, role, id, work_item_id, text):
        self._upsert(rid, role, "ask_why", "chat_message", dict(
            id=id, work_item_id=work_item_id, author_role=role, text=text, citations_json="[]", at=_now()))
        self._enqueue(rid, role, f"job_why_{id}", "answer_why", {"work_item_id": work_item_id, "message_id": id})

    def _r_post_chat_answer(self, rid, role, id, work_item_id, text, citations_json):
        self._upsert(rid, role, "post_chat_answer", "chat_message", dict(
            id=id, work_item_id=work_item_id, author_role="agent", text=text, citations_json=citations_json, at=_now()))

    # ------------------------------------------------------------------ 4.9 scorecard
    def _r_record_score_run(self, rid, role, id, status, totals_json):
        existing = self._get("score_run", id)
        self._upsert(rid, role, "record_score_run", "score_run", dict(
            id=id, status=status, totals_json=totals_json, started_at=(existing or {}).get("started_at", _now())))

    def _r_record_score_case(self, rid, role, id, run_id, attack_type, expected, actual, correct, amount_cents, work_item_id):
        self._upsert(rid, role, "record_score_case", "score_case", dict(
            id=id, run_id=run_id, attack_type=attack_type, expected=expected, actual=actual, correct=correct,
            amount_cents=amount_cents, work_item_id=work_item_id))
