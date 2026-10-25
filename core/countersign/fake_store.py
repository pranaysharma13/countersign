"""In-memory reference implementation of the SpacetimeDB module (docs/CONTRACT.md v2.1).

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
from datetime import datetime, timezone
from typing import Any, Callable

from .ids import hold_id
from .money import extend_up, fmt
from .store import Result, StoreError, dumps

ROLES = {"admin", "owner", "bookkeeper", "agent", "gateway", "sync", "purchasing", "receiver"}
HARD_STOP_CHECKS = {"bank_mismatch", "quiet_bank_edit", "license", "crs_identity"}
AGENT_STATE_TARGETS = {"reading", "investigating", "needs_info", "failed"}

# v2 (CONTRACT §9)
DOCUMENT_KINDS = {"quote", "terms", "po", "invoice", "email", "other"}
DOC_STATUS_AFTER_RUN = {"ok": "extracted", "invalid": "needs_review", "failed": "failed"}  # as the module does
TERM_CODES = {"unit_price", "max_quantity", "valid_through", "deposit", "payment_terms", "price_change_rule",
              "extra_charge_rule", "fuel_surcharge_rule"}
CHANGE_KINDS = {"extra_charge", "price_change", "quantity_change"}
AUTHORISED = {"AUTHORISED_FIXED", "AUTHORISED_RATE_USAGE_MISSING"}
CLASSIFICATIONS = AUTHORISED | {"PROPOSED", "DECLINED", "AMBIGUOUS", "UNRELATED"}
SUPPLIER_ACCEPTANCE = {"none", "proposed", "accepted", "declined"}
LINE_KINDS = {"material", "extra", "waiting", "fuel", "tax", "freight", "other"}
COMMERCIAL_STATUSES = {"pending", "matches", "differences_under_review", "contract_review"}
OWNER_RESOLVABLE_HOLDS = {"PRICE_VARIANCE", "PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING", "PO_CEILING", "DUPLICATE_REVIEW",
                          "EXTRACTION_REVIEW", "CONTRACT_REVIEW", "PROMPT_INJECTION", "SUPPLIER_RISK"}
HOLD_CODES = OWNER_RESOLVABLE_HOLDS | {"RECEIPT_NOT_VERIFIED", "PAYEE_CHANGE_PENDING", "APPROVAL_STALE"}
CARRIED_HOLDS = {"RECEIPT_NOT_VERIFIED", "PAYEE_CHANGE_PENDING", "SUPPLIER_RISK"}  # a correction can't clear these (§9.8)
HOLD_PATHS = {"RECEIPT_NOT_VERIFIED": "the superintendent attests receipt",
              "PAYEE_CHANGE_PENDING": "the owner verifies the payee change through a contact on file",
              "APPROVAL_STALE": "the owner approves the payment again"}


def _classify(cr: dict[str, Any]) -> str:
    """The stored classification follows the decision records; only they can make a change authorised."""
    if cr["internal_status"] == "rejected" or cr["supplier_acceptance"] == "declined":
        return "DECLINED"
    if cr["internal_status"] == "approved" and cr["supplier_acceptance"] == "accepted":
        return "AUTHORISED_RATE_USAGE_MISSING" if cr["kind"] == "extra_charge" and cr["rate_cents"] else "AUTHORISED_FIXED"
    return "PROPOSED" if cr["classification"] in AUTHORISED else cr["classification"]

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
    # v2 (CONTRACT §9.5)
    "process_document": ({"sync", "owner", "purchasing"}, "agent"),
    "reassess_invoice": ({"sync", "agent", "owner"}, "agent"),
    "send_outbox": (set(), "sync"),
    "pay_supplier": (set(), "gateway"),
    "sneak_charge": (None, "sync"),
    "due_scan": ({"owner", "sync"}, "sync"),
}

PUBLIC_QUEUE_LIMIT = 3
JOB_LEASE_MS = 5 * 60 * 1000  # a claimed job can be re-claimed after 5 minutes (worker restart)
MAX_JOB_ATTEMPTS = 3  # then the job stays failed; backoff 10 s, 20 s, ...


class Denied(Exception):
    def __init__(self, message: str, entity_type: str = "", entity_id: str = ""):
        super().__init__(message)
        self.message, self.entity_type, self.entity_id = message, entity_type, entity_id


class Invalid(Exception):
    pass


def _now() -> int:
    return time.time_ns() // 1000


def iso_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso_ms(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


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
    # v2 (CONTRACT §9.4)
    "set_authority": {"admin"},
    "upsert_supplier": {"sync", "admin"},
    "upsert_supplier_contact": {"sync", "admin"},
    "add_payee_profile": {"sync", "agent", "admin"},
    "record_document": {"sync"},
    "add_fragment": {"sync", "agent"},
    "record_email": {"sync"},
    "record_extraction_run": {"agent"},
    "upsert_purchase": {"sync", "agent"},
    "record_term": {"sync", "agent"},
    "record_deposit": {"sync", "gateway"},
    "propose_change_request": {"agent", "sync", "purchasing"},
    "record_supplier_acceptance": {"agent", "sync"},
    "decide_change_request": {"purchasing", "owner"},
    "record_invoice": {"sync", "agent"},
    "record_invoice_revision": {"sync", "agent"},
    "record_invoice_line": {"sync", "agent"},
    "record_assessment": {"agent"},
    "open_hold": {"agent", "sync"},
    "resolve_hold": {"owner"},
    "attest_receipt": {"receiver"},
    "decide_payee_profile": {"owner"},
    "draft_outbox": {"agent"},
    "approve_outbox": {"purchasing", "owner"},
    "mark_outbox": {"sync"},
    "propose_supplier_payment": {"agent"},
    "approve_supplier_payment": {"owner"},
    "reject_supplier_payment": {"owner"},
    "record_deposit_allocation": {"gateway"},
}

AUTO_INC = {"audit_log", "agent_step", "ledger_line"}


class FakeStore:
    def __init__(self) -> None:
        self.tables: dict[str, dict[Any, dict[str, Any]]] = {}
        self._seq: dict[str, int] = {}
        self.admin_claimed = False
        self.clock_offset_ms = 0

    def now_ms(self) -> int:
        """The module's clock (tests move it with `advance` to expire leases and backoffs)."""
        return time.time_ns() // 1_000_000 + self.clock_offset_ms

    def advance(self, seconds: float) -> None:
        self.clock_offset_ms += int(seconds * 1000)

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
        caller = role if role in ROLES else "public"
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

    @staticmethod
    def _json_obj(raw: str, name: str) -> dict[str, Any]:
        try:
            value = json.loads(raw or "{}")
        except json.JSONDecodeError as e:
            raise Invalid(f"{name}: {e}") from e
        if not isinstance(value, dict):
            raise Invalid(f"{name} must be a JSON object")
        return value

    def _need_fragments(self, ids_json: str, required: bool) -> list[str]:
        try:
            ids = json.loads(ids_json or "[]")
        except json.JSONDecodeError as e:
            raise Invalid(f"fragment ids: {e}") from e
        self._need(isinstance(ids, list) and all(isinstance(i, str) for i in ids), "fragment ids must be a JSON list of strings")
        self._need(bool(ids) or not required, "at least one source fragment is required")
        missing = [i for i in ids if self._get("source_fragment", i) is None]
        self._need(not missing, f"unknown source fragment(s): {', '.join(missing)}")
        return ids

    def _module_hold(self, rid: str, role: str, action: str, revision_id: str, code: str, amount_cents: int,
                     reason: str, evidence: Any) -> None:
        """A hold the module opens itself (CONTRACT §9.8 id convention). Reopens it if it was closed."""
        hid = hold_id(revision_id, code)
        existing = self._get("hold", hid)
        if existing and existing["status"] == "open":
            return
        self._upsert(rid, role, action, "hold", dict(
            id=hid, revision_id=revision_id, code=code, status="open", amount_cents=amount_cents, reason=reason,
            evidence_json=evidence if isinstance(evidence, str) else dumps(evidence), opened_by_role=role,
            resolved_by_role="", resolution_note="", created_at=_now(), resolved_at_iso=""))

    def _resolve_holds(self, rid: str, role: str, action: str, revision_id: str, code: str, note: str) -> None:
        for h in list(self._t("hold").values()):
            if h["revision_id"] == revision_id and h["code"] == code and h["status"] == "open":
                self._update(rid, role, action, "hold", h["id"], {
                    "status": "resolved", "resolved_by_role": role, "resolution_note": note,
                    "resolved_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S")}, note)

    def _make_stale(self, rid: str, role: str, action: str, approval_id: str, reason: str) -> None:
        """The module's makeStale: approval stale, invoice back to the owner, APPROVAL_STALE on the active
        revision for the approval's amount, and the approved proposal cancelled."""
        ap = self._get("payment_approval", approval_id)
        if ap is None or ap["status"] != "active":
            return
        self._update(rid, role, action, "payment_approval", approval_id, {"status": "stale", "stale_reason": reason}, reason)
        inv = self._get("invoice", ap["invoice_id"])
        if inv is not None:
            self._update(rid, role, action, "invoice", inv["id"], {
                "approval_status": "stale", "payment_status": "not_ready", "next_owner_role": "owner",
                "next_action": "Re-approve: the approved payment is out of date", "updated_at": _now()}, reason)
            self._module_hold(rid, role, action, inv["active_revision_id"] or ap["revision_id"], "APPROVAL_STALE",
                              ap["amount_cents"], f"Approval is stale: {reason}", {"approval_ids": [approval_id]})
        prop = self._get("proposal", ap["proposal_id"])
        if prop is not None and prop["status"] == "approved":
            self._update(rid, role, action, "proposal", prop["id"], {"status": "cancelled", "decision_note": f"approval stale: {reason}"},
                         reason)

    def _stale_approvals(self, rid: str, role: str, action: str, invoice_id: str, reason: str,
                         keep: Callable[[dict[str, Any]], bool] = lambda a: False) -> None:
        for a in list(self._t("payment_approval").values()):
            if a["invoice_id"] == invoice_id and a["status"] == "active" and not keep(a):
                self._make_stale(rid, role, action, a["id"], reason)

    # -- supplier payments (CONTRACT §9.4): the module's eligibility rules
    @staticmethod
    def _ref(p: dict[str, Any]) -> dict[str, Any] | None:
        try:
            ref = json.loads(p.get("evidence_json") or "")
        except json.JSONDecodeError:
            return None
        return ref if isinstance(ref, dict) and isinstance(ref.get("invoice_id"), str) else None

    def _verified_profile(self, supplier_id: str) -> dict[str, Any] | None:
        return next(iter(self.rows("payee_profile", supplier_id=supplier_id, status="verified")), None)

    def _latest_assessment(self, revision_id: str) -> dict[str, Any] | None:
        return max(self.rows("assessment", revision_id=revision_id), key=lambda a: a["version"], default=None)

    def _deposit_remaining(self, purchase_id: str) -> int:
        total = used = 0
        for d in self._t("deposit").values():
            if d["purchase_id"] == purchase_id and d["status"] == "settled":
                total += int(d["amount_cents"])
                used += sum(int(a["amount_cents"]) for a in self._t("deposit_allocation").values() if a["deposit_id"] == d["id"])
        return total - used

    def _blocked_reasons(self, proposal_id: str, expected_fingerprint: str | None) -> list[str]:
        """§9.4's six eligibility rules; empty = eligible."""
        p = self._get("proposal", proposal_id)
        ref = self._ref(p) if p else None
        if p is None or ref is None:
            return ["proposal not found"]
        inv = self._get("invoice", ref["invoice_id"])
        if inv is None:
            return ["invoice not found"]
        reasons = []
        if inv["active_revision_id"] != ref["revision_id"]:
            reasons.append("the invoice has a newer revision")
        for h in self._t("hold").values():  # APPROVAL_STALE is what a new approval clears, so it doesn't block one
            if h["revision_id"] == ref["revision_id"] and h["status"] == "open" and (h["code"] != "APPROVAL_STALE" or expected_fingerprint is None):
                reasons.append(f"open hold {h['code']}: {h['reason']}")
        if inv["receipt_status"] not in {"manually_confirmed", "not_required"}:
            reasons.append("receipt not attested")
        verified = self._verified_profile(inv["supplier_id"])
        if verified is None or verified["id"] != ref["payee_profile_id"]:
            reasons.append("payee is not the supplier's current verified account")
        if verified is not None and p["payee_account_ref"] != verified["account_ref"]:
            reasons.append("payee account does not match the verified profile")
        latest = self._latest_assessment(ref["revision_id"])
        approval = self._get("payment_approval", f"appr_{proposal_id}")
        fp = expected_fingerprint if expected_fingerprint is not None else (approval or {}).get("assessment_fingerprint", "")
        if latest is None or latest["fingerprint"] != fp:
            reasons.append("the assessment has changed since this was proposed")
        if latest is not None and latest["proposed_payment_cents"] != p["amount_cents"]:
            reasons.append("amount differs from the latest assessment")
        alloc = int(ref.get("deposit_allocation_cents") or 0)
        if alloc > 0 and alloc > self._deposit_remaining(inv["purchase_id"]):
            reasons.append("deposit allocation exceeds the remaining deposit")
        return reasons

    def _on_supplier_payment(self, rid: str, role: str, action: str, proposal_id: str, phase: str) -> None:
        ref = self._ref(self._get("proposal", proposal_id) or {})
        if ref is None:
            return
        self._update(rid, role, action, "invoice", ref["invoice_id"], {
            "payment_status": phase, "updated_at": _now(),
            "next_owner_role": "" if phase == "settled" else "owner" if phase == "failed" else "gateway",
            "next_action": "Paid" if phase == "settled" else "Payment failed; review" if phase == "failed" else "Settling"})
        ap = self._get("payment_approval", f"appr_{proposal_id}")
        if phase == "settled" and ap is not None and ap["status"] == "active":
            self._update(rid, role, action, "payment_approval", ap["id"], {"status": "used"})

    def _payee_status(self, supplier_id: str) -> str:
        if self.rows("payee_profile", supplier_id=supplier_id, status="pending"):
            return "change_pending"
        return "verified" if self.rows("payee_profile", supplier_id=supplier_id, status="verified") else "unverified"

    def _receipt_covered(self, invoice: dict[str, Any]) -> bool:
        needed: dict[str, int] = {}
        for l in self._t("invoice_line").values():
            if l["revision_id"] == invoice["active_revision_id"] and l["kind"] == "material":
                needed[l["unit"]] = needed.get(l["unit"], 0) + int(l["quantity_milli"])
        attested: dict[str, int] = {}
        for a in self._t("receipt_attestation").values():
            if a["invoice_id"] == invoice["id"]:
                attested[a["unit"]] = attested.get(a["unit"], 0) + int(a["quantity_milli"])
        return bool(needed) and all(attested.get(u, 0) >= q for u, q in needed.items())

    def _open_invoices(self, supplier_id: str) -> list[dict[str, Any]]:
        return [i for i in self._t("invoice").values() if i["supplier_id"] == supplier_id and i["payment_status"] != "settled"]

    def _active_material_milli(self, invoice: dict[str, Any], unit: str) -> int:
        return sum(int(l["quantity_milli"]) for l in self._t("invoice_line").values()
                   if l["revision_id"] == invoice["active_revision_id"] and l["kind"] == "material" and l["unit"] == unit)

    def _remaining_ceiling(self, purchase: dict[str, Any]) -> int | None:
        terms = [t for t in self._t("term").values()
                 if t["purchase_id"] == purchase["id"] and t["code"] == "max_quantity" and t["status"] == "accepted"]
        if not terms:
            return None
        ceiling = int(max(terms, key=lambda t: t["version"])["quantity_milli"])
        # Only paid-for quantity is used up: an unscoped price change could still reach an unpaid invoice.
        paid = sum(self._active_material_milli(inv, purchase["unit"]) for inv in self._t("invoice").values()
                   if inv["purchase_id"] == purchase["id"] and inv["payment_status"] == "settled")
        return max(ceiling - paid, 0)

    def _exposure(self, cr: dict[str, Any], purchase: dict[str, Any]) -> tuple[int | None, str]:
        """Money an approval commits (CONTRACT §9.8.1). None = can't be sized, so it can't be approved."""
        fixed = int(cr["amount_cents"])
        if not cr["rate_cents"]:
            return fixed, ""
        scope = json.loads(cr["scope_json"] or "{}")
        unit = scope.get("unit") or purchase["unit"]
        if unit != cr["rate_unit"]:
            return None, f"the rate is per {cr['rate_unit']} but the quantity is in {unit}"
        qty = scope.get("quantity_milli")
        if qty is None:
            qty = self._remaining_ceiling(purchase)  # worst case: the rest of the PO
            if qty is None:
                return None, "no scoped quantity and no accepted max_quantity term"
        return fixed + extend_up(int(qty), int(cr["rate_cents"])), ""

    def _enqueue(self, rid: str, role: str, job_id: str, kind: str, payload: Any) -> None:
        assignee = JOB_KINDS[kind][1]
        self._upsert(rid, role, "enqueue_job", "job", {
            "id": job_id, "kind": kind, "assignee_role": assignee,
            "payload_json": payload if isinstance(payload, str) else dumps(payload), "status": "queued",
            "requested_by": role, "claimed_by": "", "result_json": "", "error": "",
            "created_at": _now(), "updated_at": _now(), "attempts": 0, "next_attempt_at_iso": "", "lease_expires_at_iso": "",
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

    def _r_register_actor(self, rid: str, caller: str, identity_hex: str, role: str, display_name: str) -> None:
        self._need(role in ROLES - {"admin"}, f"bad role {role}")
        self._put("actor", {"identity": identity_hex, "role": role, "display_name": display_name, "created_at": _now()}, "identity")

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
        self._need(kind in {"bill", "bank_change", "contract_onboarding", "supplier_invoice"}, "bad kind")
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
        if p["kind"] == "supplier_payment":
            raise Denied("supplier payments are approved with approve_supplier_payment", "proposal", proposal_id)
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
        if p["status"] != "approved":
            raise Denied(f"proposal is {p['status']}, not approved", "proposal", proposal_id)
        if p["kind"] == "supplier_payment":  # re-check every bound value; a mismatch makes the approval stale
            ap = self._get("payment_approval", f"appr_{proposal_id}")
            reasons = (["no active approval for this payment"] if ap is None or ap["status"] != "active"
                       else self._blocked_reasons(proposal_id, ap["assessment_fingerprint"]))
            if ap is not None and p["amount_cents"] != ap["amount_cents"]:
                reasons.append("amount changed since approval")
            if reasons:
                if ap is not None:
                    self._make_stale(rid, role, "start_payment", ap["id"], "; ".join(reasons))
                raise Denied(json.dumps(reasons), "proposal", proposal_id)  # like the module: the stale marking stays
            self._on_supplier_payment(rid, role, "start_payment", proposal_id, "submitted")
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
        if p["kind"] == "supplier_payment":
            self._on_supplier_payment(rid, role, "record_payment", proposal_id, "settled" if status == "sent" else "failed")
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
        now = self.now_ms()
        lease_expired = j["status"] == "claimed" and bool(j["lease_expires_at_iso"]) and parse_iso_ms(j["lease_expires_at_iso"]) <= now
        if j["status"] != "queued" and not lease_expired:
            raise Denied(f"job is {j['status']}", "job", job_id)
        if j["next_attempt_at_iso"] and parse_iso_ms(j["next_attempt_at_iso"]) > now:
            raise Denied(f"job can't be retried before {j['next_attempt_at_iso']}", "job", job_id)
        self._update(rid, role, "claim_job", "job", job_id, {
            "status": "claimed", "claimed_by": role, "updated_at": _now(), "attempts": j["attempts"] + 1,
            "lease_expires_at_iso": iso_ms(now + JOB_LEASE_MS)}, "re-claimed after lease expired" if lease_expired else "")

    def _r_finish_job(self, rid, role, job_id, ok, result_json, error):
        j = self._get("job", job_id)
        self._need(j is not None, "unknown job")
        if j["claimed_by"] != role or j["status"] != "claimed":
            raise Denied("only the claimer can finish a claimed job", "job", job_id)
        retry = not ok and j["attempts"] < MAX_JOB_ATTEMPTS
        nxt = iso_ms(self.now_ms() + 10_000 * 2 ** (j["attempts"] - 1)) if retry else ""
        self._update(rid, role, "finish_job", "job", job_id, {
            "status": "done" if ok else "queued" if retry else "failed", "result_json": result_json, "error": error,
            "updated_at": _now(), "next_attempt_at_iso": nxt, "claimed_by": "" if retry else j["claimed_by"],
            "lease_expires_at_iso": ""})

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

    # ------------------------------------------------------------------ 9.4 setup and records
    def _r_set_authority(self, rid, caller, identity_hex, role, limit_cents, project_scope):
        self._need(role in ROLES - {"admin"}, f"bad role {role}")
        self._need(isinstance(limit_cents, int) and limit_cents >= 0, "limit_cents must be integer cents >= 0")
        self._need(bool(project_scope), "project_scope is '*' or a project id")
        before = copy.deepcopy(self._get("authority", identity_hex))
        row = self._put("authority", dict(identity=identity_hex, role=role, limit_cents=limit_cents,
                                          project_scope=project_scope), "identity")
        self._audit(rid, caller, "set_authority", "authority", identity_hex, "ok", "", before, row)

    def _r_upsert_supplier(self, rid, role, id, name, email_domain, phone_on_file, crs_ref, status):
        self._need(status in {"active", "on_hold", "blocked"}, "bad status")
        existing = self._get("supplier", id)
        self._upsert(rid, role, "upsert_supplier", "supplier", dict(
            id=id, name=name, email_domain=email_domain.lower(), phone_on_file=phone_on_file, crs_ref=crs_ref,
            status=status, created_at=(existing or {}).get("created_at", _now())))

    def _r_upsert_supplier_contact(self, rid, role, id, supplier_id, name, email, phone, title, pre_established):
        self._need(self._get("supplier", supplier_id) is not None, "unknown supplier")
        existing = self._get("supplier_contact", id)
        if existing is not None:
            if pre_established and not existing["pre_established"]:
                raise Denied("a contact can only be pre-established when it is first set up", "supplier_contact", id)
            if existing["pre_established"] and (existing["email"], existing["phone"]) != (email.lower(), phone):
                raise Denied("a pre-established contact's email and phone can't change: payee changes are verified "
                             "through them", "supplier_contact", id)
        self._upsert(rid, role, "upsert_supplier_contact", "supplier_contact", dict(
            id=id, supplier_id=supplier_id, name=name, email=email.lower(), phone=phone, title=title,
            pre_established=bool(pre_established)))

    def _r_add_payee_profile(self, rid, role, id, supplier_id, version, account_ref, last4, bank_name, requested_via):
        self._need(self._get("supplier", supplier_id) is not None, "unknown supplier")
        self._need(id == f"{supplier_id}:v{version}", "payee profile id must be <supplier_id>:v<version>")
        self._need(requested_via in {"seed", "email", "portal"}, "bad requested_via")
        self._need(len(last4) == 4 and last4.isdigit(), "last4 must be 4 digits")
        fields = dict(supplier_id=supplier_id, version=version, account_ref=account_ref, last4=last4,
                      bank_name=bank_name, requested_via=requested_via)
        existing = self._get("payee_profile", id)
        if existing is not None:
            if all(existing[k] == v for k, v in fields.items()):
                return ("duplicate", "payee profile exists")
            raise Denied("payee profiles are immutable; add a new version", "payee_profile", id)
        seeded = role == "admin" and requested_via == "seed"
        if seeded and self.rows("payee_profile", supplier_id=supplier_id, status="verified"):
            raise Invalid("supplier already has a verified payee profile")
        self._upsert(rid, role, "add_payee_profile", "payee_profile", dict(
            id=id, **fields, status="verified" if seeded else "pending", verified_by_role="admin" if seeded else "",
            verified_via_contact_id="", created_at=_now()))
        if not seeded:
            for inv in self._open_invoices(supplier_id):
                self._update(rid, role, "add_payee_profile", "invoice", inv["id"],
                             {"payee_status": "change_pending", "updated_at": _now()})
                if inv["active_revision_id"]:
                    self._module_hold(rid, role, "add_payee_profile", inv["active_revision_id"], "PAYEE_CHANGE_PENDING", 0,
                                      f"New payee account ending {last4} requested via {requested_via}. Verify it by "
                                      "calling a contact already on file.", {"payee_profile_id": id})
        return None

    def _r_record_document(self, rid, role, id, kind, source_file_id, sha256, filename, pages):
        self._need(kind in DOCUMENT_KINDS, f"bad document kind {kind}")
        self._need(len(sha256) == 64, "sha256 must be 64 hex characters")
        existing = self._get("document", id)
        if existing is not None:
            if existing["sha256"] == sha256:
                return ("duplicate", "document exists")
            raise Denied("a document's bytes can't change; record a new document", "document", id)
        self._upsert(rid, role, "record_document", "document", dict(
            id=id, kind=kind, source_file_id=source_file_id, sha256=sha256, filename=filename, pages=pages,
            status="received", created_at=_now()))
        return None

    def _r_add_fragment(self, rid, role, id, document_id, page, email_message_id, line_start, line_end, text):
        existing = self._get("source_fragment", id)
        if existing is not None:
            if existing["text"] == text:
                return ("duplicate", "fragment exists")
            raise Denied("source fragments are immutable", "source_fragment", id)
        self._need(self._get("document", document_id) is not None, "unknown document")
        self._need(bool(text.strip()), "fragment text is empty")
        self._need(0 <= line_start <= line_end, "bad line range")
        self._upsert(rid, role, "add_fragment", "source_fragment", dict(
            id=id, document_id=document_id, page=page, email_message_id=email_message_id, line_start=line_start,
            line_end=line_end, text=text, created_at=_now()))
        return None

    def _r_record_email(self, rid, role, id, thread_id, document_id, from_address, to_addresses, subject,
                        original_sent_at_iso, ingested_at_iso, body_fragment_id):
        self._need(self._get("document", document_id) is not None, "unknown document")
        self._need(not body_fragment_id or self._get("source_fragment", body_fragment_id) is not None, "unknown body fragment")
        known = any(c["email"] == from_address.strip().lower() for c in self._t("supplier_contact").values())
        self._upsert(rid, role, "record_email", "email_message", dict(
            id=id, thread_id=thread_id, document_id=document_id, from_address=from_address, to_addresses=to_addresses,
            subject=subject, original_sent_at_iso=original_sent_at_iso, ingested_at_iso=ingested_at_iso,
            body_fragment_id=body_fragment_id, from_known_contact=known))

    def _r_record_extraction_run(self, rid, role, id, document_id, mode, model, prompt_version, status, error, fields_json):
        self._need(self._get("document", document_id) is not None, "unknown document")
        self._need(mode in {"live", "fixture"}, "mode must be live or fixture")
        self._need(status in DOC_STATUS_AFTER_RUN, "bad extraction status")
        self._upsert(rid, role, "record_extraction_run", "extraction_run", dict(
            id=id, document_id=document_id, mode=mode, model=model, prompt_version=prompt_version, status=status,
            error=error, fields_json=fields_json, created_at=_now()))
        self._update(rid, role, "record_extraction_run", "document", document_id, {"status": DOC_STATUS_AFTER_RUN[status]})

    def _r_upsert_purchase(self, rid, role, id, supplier_id, project_id, description, unit, po_number,
                           quote_document_id, po_document_id, status):
        self._need(self._get("supplier", supplier_id) is not None, "unknown supplier")
        self._need(self._get("project", project_id) is not None, "unknown project")
        self._need(status in {"open", "contract_review", "closed"}, "bad status")
        self._need(bool(unit), "unit is required")
        existing = self._get("purchase", id)
        self._upsert(rid, role, "upsert_purchase", "purchase", dict(
            id=id, supplier_id=supplier_id, project_id=project_id, description=description, unit=unit, currency="USD",
            po_number=po_number, quote_document_id=quote_document_id, po_document_id=po_document_id, status=status,
            created_at=(existing or {}).get("created_at", _now())))

    def _r_record_term(self, rid, role, id, purchase_id, code, label, amount_cents, quantity_milli, text, scope_json,
                       effective_from, effective_to, status, source_fragment_ids_json, version):
        self._need(self._get("purchase", purchase_id) is not None, "unknown purchase")
        self._need(code in TERM_CODES, f"bad term code {code}")
        self._need(status in {"accepted", "proposed", "declined", "superseded"}, "bad term status")
        self._need(isinstance(amount_cents, int) and isinstance(quantity_milli, int),
                   "money is integer cents and quantities integer thousandths")
        self._json_obj(scope_json, "scope_json")
        self._need_fragments(source_fragment_ids_json, required=True)
        self._upsert(rid, role, "record_term", "term", dict(
            id=id, purchase_id=purchase_id, code=code, label=label, amount_cents=amount_cents,
            quantity_milli=quantity_milli, text=text, scope_json=scope_json, effective_from=effective_from,
            effective_to=effective_to, status=status, source_fragment_ids_json=source_fragment_ids_json, version=version))

    def _r_record_deposit(self, rid, role, id, purchase_id, supplier_id, amount_cents, status, transfer_ref):
        p = self._get("purchase", purchase_id)
        self._need(p is not None and p["supplier_id"] == supplier_id, "unknown purchase for this supplier")
        self._need(status in {"approved", "settled"}, "bad deposit status")
        self._need(isinstance(amount_cents, int) and amount_cents > 0, "amount must be positive integer cents")
        existing = self._get("deposit", id)
        if existing is not None and existing["amount_cents"] != amount_cents:
            raise Denied("a deposit's amount can't change", "deposit", id)
        self._upsert(rid, role, "record_deposit", "deposit", dict(
            id=id, purchase_id=purchase_id, supplier_id=supplier_id, amount_cents=amount_cents, status=status,
            transfer_ref=transfer_ref, approved_by_role=role, created_at=(existing or {}).get("created_at", _now())))

    # ------------------------------------------------------------------ 9.4 amendments
    def _r_propose_change_request(self, rid, role, id, purchase_id, kind, description, amount_cents, rate_cents,
                                  rate_unit, scope_json, effective_from, original_sent_at_iso, ingested_at_iso,
                                  classification, supplier_acceptance, source_fragment_ids_json):
        self._need(self._get("purchase", purchase_id) is not None, "unknown purchase")
        self._need(kind in CHANGE_KINDS, f"bad change kind {kind}")
        self._need(classification in CLASSIFICATIONS - AUTHORISED,
                   "a new change request can't be authorised; only the in-app decision and supplier acceptance make it so")
        self._need(supplier_acceptance in SUPPLIER_ACCEPTANCE, "bad supplier_acceptance")
        self._need(isinstance(amount_cents, int) and isinstance(rate_cents, int) and amount_cents >= 0 and rate_cents >= 0,
                   "amounts must be non-negative integer cents")
        self._need(not rate_cents or bool(rate_unit), "a rate needs a unit")
        self._json_obj(scope_json, "scope_json")
        self._need_fragments(source_fragment_ids_json, required=role != "purchasing")
        if self._get("change_request", id):
            return ("duplicate", "change request exists")
        self._upsert(rid, role, "propose_change_request", "change_request", dict(
            id=id, purchase_id=purchase_id, kind=kind, description=description, amount_cents=amount_cents,
            rate_cents=rate_cents, rate_unit=rate_unit, scope_json=scope_json, effective_from=effective_from,
            original_sent_at_iso=original_sent_at_iso, ingested_at_iso=ingested_at_iso, classification=classification,
            supplier_acceptance=supplier_acceptance, supplier_acceptance_fragment_ids_json="[]",
            requested_by_identity=role, internal_status="pending", decided_by_identity="", decided_by_role="",
            decision_note="", source_fragment_ids_json=source_fragment_ids_json, created_at=_now()))
        return None

    def _r_record_supplier_acceptance(self, rid, role, change_request_id, supplier_acceptance, fragment_ids_json):
        cr = self._get("change_request", change_request_id)
        self._need(cr is not None, "unknown change request")
        self._need(supplier_acceptance in SUPPLIER_ACCEPTANCE, "bad supplier_acceptance")
        ids = self._need_fragments(fragment_ids_json, required=supplier_acceptance in {"accepted", "declined"})
        changes: dict[str, Any] = {"supplier_acceptance": supplier_acceptance, "supplier_acceptance_fragment_ids_json": dumps(ids)}
        changes["classification"] = _classify({**cr, **changes})
        self._update(rid, role, "record_supplier_acceptance", "change_request", change_request_id, changes)

    def _r_decide_change_request(self, rid, role, id, approve, note):
        cr = self._get("change_request", id)
        self._need(cr is not None, "unknown change request")
        self._need(cr["internal_status"] == "pending", f"change request is already {cr['internal_status']}")
        if cr["requested_by_identity"] == role:
            raise Denied("can't decide a change you requested", "change_request", id)
        purchase = self._get("purchase", cr["purchase_id"])
        auth = self._get("authority", role) or {"limit_cents": 0, "project_scope": ""}
        if auth["project_scope"] not in {"*", purchase["project_id"]}:
            raise Denied(f"no purchasing authority on {purchase['project_id']}", "change_request", id)
        if approve:
            exposure, why = self._exposure(cr, purchase)
            if exposure is None:
                raise Denied(f"can't size this change ({why}); scope it to a quantity first", "change_request", id)
            if exposure > auth["limit_cents"] or auth["limit_cents"] == 0:
                raise Denied(f"{fmt(exposure)} is above your approval limit of {fmt(auth['limit_cents'])}", "change_request", id)
        changes: dict[str, Any] = {"internal_status": "approved" if approve else "rejected", "decided_by_identity": role,
                                   "decided_by_role": role, "decision_note": note}
        changes["classification"] = _classify({**cr, **changes})
        self._update(rid, role, "decide_change_request", "change_request", id, changes, note)

    # ------------------------------------------------------------------ 9.4 invoices and assessment
    @staticmethod
    def _next_owner(inv: dict[str, Any], commercial_status: str) -> str:
        if commercial_status == "pending":
            return "agent"
        if commercial_status in {"differences_under_review", "contract_review"}:
            return "purchasing"
        return "receiver" if inv["receipt_status"] == "required" else "owner"

    def _r_record_invoice(self, rid, role, id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, currency):
        self._need(self._get("supplier", supplier_id) is not None, "unknown supplier")
        p = self._get("purchase", purchase_id) if purchase_id else None
        self._need(not purchase_id or (p is not None and p["supplier_id"] == supplier_id), "unknown purchase for this supplier")
        self._need(bool(invoice_number), "invoice number is required")
        self._need(len(currency) == 3, "currency is a 3-letter code")
        if self._get("invoice", id):
            return ("duplicate", "invoice exists")
        self._upsert(rid, role, "record_invoice", "invoice", dict(
            id=id, supplier_id=supplier_id, purchase_id=purchase_id, invoice_number=invoice_number,
            invoice_date=invoice_date, due_date=due_date, currency=currency.upper(), active_revision_id="",
            commercial_status="pending", receipt_status="required", payee_status=self._payee_status(supplier_id),
            approval_status="none", payment_status="not_ready", next_owner_role="agent",
            next_action="Assess against the purchase terms", updated_at=_now()))
        if not self._get("work_item", f"wi_{id}"):
            self._upsert(rid, role, "record_invoice", "work_item", dict(
                id=f"wi_{id}", kind="supplier_invoice", entity_id=id, origin="upload", state="new",
                summary=f"Invoice {invoice_number}", risk_level="low", created_at=_now(), updated_at=_now()))
        return None

    def _r_record_invoice_revision(self, rid, role, id, invoice_id, revision, document_id, gross_cents, deposit_shown_cents,
                                   balance_requested_cents, supersedes_revision_id):
        if self._get("invoice_revision", id):
            return ("duplicate", "revision exists")
        inv = self._get("invoice", invoice_id)
        self._need(inv is not None, "unknown invoice")
        self._need(self._get("document", document_id) is not None, "unknown document")
        self._need(all(isinstance(v, int) for v in (revision, gross_cents, deposit_shown_cents, balance_requested_cents)),
                   "money is integer cents")
        if supersedes_revision_id:
            self._need(supersedes_revision_id == inv["active_revision_id"], "a correction must supersede the invoice's active revision")
            self._need(revision > self._get("invoice_revision", supersedes_revision_id)["revision"],
                       "a correction needs a higher revision number")
        else:
            self._need(not inv["active_revision_id"], "the invoice already has an active revision; a new one must supersede it")
        self._upsert(rid, role, "record_invoice_revision", "invoice_revision", dict(
            id=id, invoice_id=invoice_id, revision=revision, document_id=document_id, gross_cents=gross_cents,
            deposit_shown_cents=deposit_shown_cents, balance_requested_cents=balance_requested_cents,
            supersedes_revision_id=supersedes_revision_id, status="active", created_at=_now()))
        if supersedes_revision_id:
            note = f"superseded by revision {revision} ({id})"
            self._update(rid, role, "record_invoice_revision", "invoice_revision", supersedes_revision_id, {"status": "superseded"}, note)
            for h in list(self._t("hold").values()):
                if h["revision_id"] == supersedes_revision_id and h["status"] == "open":
                    self._update(rid, role, "record_invoice_revision", "hold", h["id"], {"status": "superseded", "resolution_note": note}, note)
                    if h["code"] in CARRIED_HOLDS:
                        self._module_hold(rid, role, "record_invoice_revision", id, h["code"], h["amount_cents"], h["reason"],
                                          h["evidence_json"])
        self._update(rid, role, "record_invoice_revision", "invoice", invoice_id, {
            "active_revision_id": id, "commercial_status": "pending", "payment_status": "not_ready", "next_owner_role": "agent",
            "next_action": "Assess this revision against the purchase terms", "updated_at": _now()})
        if supersedes_revision_id:
            self._stale_approvals(rid, role, "record_invoice_revision", invoice_id, "revision superseded")
        return None

    def _r_record_invoice_line(self, rid, role, id, revision_id, kind, description, quantity_milli, unit, unit_price_cents,
                               amount_cents, linked_term_id, linked_change_request_id, source_fragment_ids_json):
        fields = dict(revision_id=revision_id, kind=kind, description=description, quantity_milli=quantity_milli, unit=unit,
                      unit_price_cents=unit_price_cents, amount_cents=amount_cents, linked_term_id=linked_term_id,
                      linked_change_request_id=linked_change_request_id, source_fragment_ids_json=source_fragment_ids_json)
        existing = self._get("invoice_line", id)
        if existing is not None:
            if all(existing[k] == v for k, v in fields.items()):
                return ("duplicate", "line exists")
            raise Denied("invoice lines are immutable; record a corrected revision", "invoice_line", id)
        rev = self._get("invoice_revision", revision_id)
        self._need(rev is not None and rev["status"] == "active", "lines can only be added to an active revision")
        self._need(kind in LINE_KINDS, f"bad line kind {kind}")
        self._need(all(isinstance(v, int) for v in (quantity_milli, unit_price_cents, amount_cents)),
                   "money is integer cents and quantities integer thousandths")
        if quantity_milli and unit_price_cents:
            self._need(quantity_milli * unit_price_cents == amount_cents * 1000,
                       f"{quantity_milli} x {unit_price_cents} / 1000 is not {amount_cents} (exact integer math)")
        self._need(not quantity_milli or bool(unit), "a quantity needs a unit")
        self._need(not linked_term_id or self._get("term", linked_term_id) is not None, "unknown term")
        self._need(not linked_change_request_id or self._get("change_request", linked_change_request_id) is not None,
                   "unknown change request")
        self._need_fragments(source_fragment_ids_json, required=True)
        self._upsert(rid, role, "record_invoice_line", "invoice_line", dict(id=id, **fields))
        inv = self._get("invoice", rev["invoice_id"])
        if kind == "material" and inv["receipt_status"] == "manually_confirmed" and not self._receipt_covered(inv):
            self._update(rid, role, "record_invoice_line", "invoice", inv["id"], {"receipt_status": "required", "updated_at": _now()},
                         "billed quantity is above the attested receipt")
        return None

    def _r_record_assessment(self, rid, role, id, revision_id, version, fingerprint, policy_version, claimed_cents,
                             authorised_cents, pending_cents, variance_cents, deposit_available_cents,
                             proposed_payment_cents, commercial_status, summary, details_json, next_action):
        if self._get("assessment", id):
            return ("duplicate", "assessment exists")
        rev = self._get("invoice_revision", revision_id)
        self._need(rev is not None and rev["status"] == "active", "only the active revision can be assessed")
        self._need(commercial_status in COMMERCIAL_STATUSES, "bad commercial_status")
        self._need(all(isinstance(v, int) for v in (claimed_cents, authorised_cents, pending_cents, variance_cents,
                                                    deposit_available_cents, proposed_payment_cents)), "money is integer cents")
        self._need(proposed_payment_cents >= 0, "proposed payment can't be negative")
        self._need(bool(fingerprint) and bool(policy_version), "fingerprint and policy_version are required")
        try:
            json.loads(details_json or "null")
        except json.JSONDecodeError as e:
            raise Invalid(f"details_json: {e}") from e
        self._upsert(rid, role, "record_assessment", "assessment", dict(
            id=id, revision_id=revision_id, version=version, fingerprint=fingerprint, policy_version=policy_version,
            claimed_cents=claimed_cents, authorised_cents=authorised_cents, pending_cents=pending_cents,
            variance_cents=variance_cents, deposit_available_cents=deposit_available_cents,
            proposed_payment_cents=proposed_payment_cents, commercial_status=commercial_status, summary=summary,
            details_json=details_json, next_action=next_action, created_at=_now()))
        inv = self._get("invoice", rev["invoice_id"])
        self._update(rid, role, "record_assessment", "invoice", inv["id"], {
            "commercial_status": commercial_status, "next_action": next_action,
            "next_owner_role": self._next_owner(inv, commercial_status), "updated_at": _now()})
        self._stale_approvals(rid, role, "record_assessment", inv["id"], "the assessment changed after the payment was approved",
                              keep=lambda a: a["assessment_fingerprint"] == fingerprint)
        return None

    def _r_open_hold(self, rid, role, id, revision_id, code, amount_cents, reason, evidence_json):
        if self._get("hold", id):
            return ("duplicate", "hold exists")
        rev = self._get("invoice_revision", revision_id)
        self._need(rev is not None and rev["status"] == "active", "holds go on the active revision")
        self._need(code in HOLD_CODES, f"bad hold code {code}")
        self._need(isinstance(amount_cents, int) and amount_cents >= 0, "amount must be non-negative integer cents")
        self._need(bool(reason.strip()), "a hold needs a reason")
        self._upsert(rid, role, "open_hold", "hold", dict(
            id=id, revision_id=revision_id, code=code, status="open", amount_cents=amount_cents, reason=reason,
            evidence_json=evidence_json, opened_by_role=role, resolved_by_role="", resolution_note="", created_at=_now(),
            resolved_at_iso=""))
        return None

    def _r_resolve_hold(self, rid, role, id, note):
        h = self._get("hold", id)
        self._need(h is not None, "unknown hold")
        self._need(h["status"] == "open", f"hold is {h['status']}")
        if h["code"] not in OWNER_RESOLVABLE_HOLDS:
            raise Denied(f"{h['code']} can't be resolved by hand; it clears when {HOLD_PATHS[h['code']]}", "hold", id)
        self._need(bool(note.strip()), "a note is required to resolve a hold")
        self._update(rid, role, "resolve_hold", "hold", id, {"status": "resolved", "resolved_by_role": role, "resolution_note": note,
                                                             "resolved_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S")}, note)

    # ------------------------------------------------------------------ 9.4 people in the loop
    def _r_attest_receipt(self, rid, role, id, invoice_id, scope, quantity_milli, unit, reason):
        if self._get("receipt_attestation", id):
            return ("duplicate", "attestation exists")
        inv = self._get("invoice", invoice_id)
        self._need(inv is not None, "unknown invoice")
        self._need(isinstance(quantity_milli, int) and quantity_milli > 0, "quantity must be positive integer thousandths")
        self._need(bool(unit), "unit is required")
        self._need(bool(reason.strip()), "say how you know it was received")
        self._upsert(rid, role, "attest_receipt", "receipt_attestation", dict(
            id=id, invoice_id=invoice_id, scope=scope, quantity_milli=quantity_milli, unit=unit, reason=reason,
            label="MANUALLY_CONFIRMED", attested_by_identity=role, attested_by_role=role, created_at=_now()))
        if inv["active_revision_id"] and self._receipt_covered(inv):
            self._resolve_holds(rid, role, "attest_receipt", inv["active_revision_id"], "RECEIPT_NOT_VERIFIED",
                                f"Receipt attested by the {role} (MANUALLY_CONFIRMED, not machine-verified)")
            confirmed = {**inv, "receipt_status": "manually_confirmed"}
            self._update(rid, role, "attest_receipt", "invoice", invoice_id, {
                "receipt_status": "manually_confirmed", "next_owner_role": self._next_owner(confirmed, inv["commercial_status"]),
                "updated_at": _now()})
        return None

    def _r_decide_payee_profile(self, rid, role, id, approve, verified_via_contact_id, note):
        prof = self._get("payee_profile", id)
        self._need(prof is not None, "unknown payee profile")
        self._need(prof["status"] == "pending", f"payee profile is {prof['status']}")
        contact = self._get("supplier_contact", verified_via_contact_id)
        if contact is None or contact["supplier_id"] != prof["supplier_id"] or not contact["pre_established"]:
            raise Denied("verify through a contact that was on file before this request, never one from the request itself",
                         "payee_profile", id)
        sup = prof["supplier_id"]
        if approve:
            for old in self.rows("payee_profile", supplier_id=sup, status="verified"):
                self._update(rid, role, "decide_payee_profile", "payee_profile", old["id"], {"status": "superseded"}, f"replaced by {id}")
        self._update(rid, role, "decide_payee_profile", "payee_profile", id, {
            "status": "verified" if approve else "rejected", "verified_by_role": role if approve else "",
            "verified_via_contact_id": verified_via_contact_id}, note)
        still_pending = bool(self.rows("payee_profile", supplier_id=sup, status="pending"))
        resolution = note or (f"Payee change verified via {contact['name']}" if approve
                              else f"Payee change rejected after calling {contact['name']}; the verified account stands")
        for inv in self._open_invoices(sup):
            if approve:  # approvals bound to the old account can't pay the new one
                self._stale_approvals(rid, role, "decide_payee_profile", inv["id"], f"payee changed to {id}",
                                      keep=lambda a: a["payee_profile_id"] == id)
            if not still_pending and inv["active_revision_id"]:
                self._resolve_holds(rid, role, "decide_payee_profile", inv["active_revision_id"], "PAYEE_CHANGE_PENDING", resolution)
            self._update(rid, role, "decide_payee_profile", "invoice", inv["id"], {"payee_status": self._payee_status(sup),
                                                                                    "updated_at": _now()})

    # ------------------------------------------------------------------ 9.4 clarifications
    def _r_draft_outbox(self, rid, role, id, invoice_id, to_contact_id, subject, body):
        if self._get("outbox", id):
            return ("duplicate", "outbox message exists")
        inv = self._get("invoice", invoice_id)
        self._need(inv is not None, "unknown invoice")
        contact = self._get("supplier_contact", to_contact_id)
        self._need(contact is not None and contact["supplier_id"] == inv["supplier_id"],
                   "the recipient must be a contact of the invoice's supplier")
        self._need(bool(subject.strip()) and bool(body.strip()), "subject and body are required")
        self._upsert(rid, role, "draft_outbox", "outbox", dict(
            id=id, invoice_id=invoice_id, to_contact_id=to_contact_id, to_address=contact["email"], subject=subject,
            body=body, status="draft", simulated=True, created_by_role=role, approved_by_role="", delivery_ref="",
            created_at=_now()))
        self._update(rid, role, "draft_outbox", "invoice", invoice_id, {
            "next_owner_role": "purchasing", "next_action": "Review and send the clarification to the supplier", "updated_at": _now()})
        return None

    def _r_approve_outbox(self, rid, role, id):
        o = self._get("outbox", id)
        self._need(o is not None, "unknown outbox message")
        self._need(o["status"] == "draft", f"outbox message is {o['status']}")
        self._update(rid, role, "approve_outbox", "outbox", id, {"status": "approved", "approved_by_role": role})
        self._enqueue(rid, role, f"job_send_{id}", "send_outbox", {"outbox_id": id})
        self._update(rid, role, "approve_outbox", "invoice", o["invoice_id"], {
            "next_owner_role": "supplier", "next_action": "Waiting for the supplier to reply", "updated_at": _now()})

    def _r_mark_outbox(self, rid, role, id, status, delivery_ref):
        self._need(status in {"sent", "failed"}, "status must be sent or failed")
        o = self._get("outbox", id)
        self._need(o is not None, "unknown outbox message")
        if o["status"] != "approved":
            raise Denied(f"outbox message is {o['status']}, not approved", "outbox", id)
        self._update(rid, role, "mark_outbox", "outbox", id, {"status": status, "delivery_ref": delivery_ref})

    # ------------------------------------------------------------------ 9.4 payment
    def _r_propose_supplier_payment(self, rid, role, id, invoice_id, revision_id, assessment_id, amount_cents,
                                    deposit_allocation_cents, payee_profile_id):
        self._need(isinstance(amount_cents, int) and amount_cents > 0, "amount_cents must be above zero")
        self._need(isinstance(deposit_allocation_cents, int) and deposit_allocation_cents >= 0, "deposit_allocation_cents can't be negative")
        inv, rev = self._get("invoice", invoice_id), self._get("invoice_revision", revision_id)
        a, payee = self._get("assessment", assessment_id), self._get("payee_profile", payee_profile_id)
        self._need(inv is not None and rev is not None and rev["invoice_id"] == invoice_id, "invoice and revision do not match")
        self._need(a is not None and a["revision_id"] == revision_id, "assessment is not for this revision")
        self._need(payee is not None and payee["supplier_id"] == inv["supplier_id"], "payee profile is not the supplier's")
        if self._get("proposal", id):
            return ("duplicate", "proposal exists")
        if amount_cents != a["proposed_payment_cents"]:
            raise Denied(f"amount {amount_cents} must equal the assessment's proposed payment {a['proposed_payment_cents']}", "proposal", id)
        wi_id = f"wi_{invoice_id}"
        for other in list(self._t("proposal").values()):
            if other["work_item_id"] == wi_id and other["status"] == "pending":
                self._update(rid, role, "propose_supplier_payment", "proposal", other["id"],
                             {"status": "cancelled", "decision_note": f"superseded by {id}"}, f"superseded by {id}")
        ref = {"invoice_id": invoice_id, "revision_id": revision_id, "assessment_id": assessment_id,
               "deposit_allocation_cents": str(deposit_allocation_cents), "payee_profile_id": payee_profile_id}
        self._upsert(rid, role, "propose_supplier_payment", "proposal", dict(
            id=id, work_item_id=wi_id, kind="supplier_payment", amount_cents=amount_cents, payee_sub_id=inv["supplier_id"],
            payee_account_ref=payee["account_ref"], reason=a["summary"], evidence_json=dumps(ref), status="pending",
            proposed_by_role=role, proposed_by_identity=role, decided_by_role="", decided_by_identity="", decision_note="",
            created_at=_now(), decided_at_iso=""))
        self._update(rid, role, "propose_supplier_payment", "invoice", invoice_id, {
            "next_owner_role": "owner", "next_action": "Review and approve the payment", "updated_at": _now()})
        wi = self._get("work_item", wi_id)
        if wi is not None and wi["state"] in {"new", "reading", "investigating", "needs_info", "held", "proposed"}:
            self._set_state(rid, role, "propose_supplier_payment", wi_id, "proposed", a["summary"])
        return None

    def _r_approve_supplier_payment(self, rid, role, proposal_id, expected_fingerprint, note):
        p = self._get("proposal", proposal_id)
        self._need(p is not None and p["kind"] == "supplier_payment", f"supplier payment proposal {proposal_id} not found")
        if p["proposed_by_identity"] == role:
            raise Denied("you can't approve your own proposal", "proposal", proposal_id)
        self._need(p["status"] == "pending", f"proposal is {p['status']}, not pending")
        reasons = self._blocked_reasons(proposal_id, expected_fingerprint)
        if reasons:
            raise Denied(json.dumps(reasons), "proposal", proposal_id)
        ref = self._ref(p)
        latest = self._latest_assessment(ref["revision_id"])
        before = copy.deepcopy(self._get("payment_approval", f"appr_{proposal_id}"))
        approval = dict(id=f"appr_{proposal_id}", proposal_id=proposal_id, invoice_id=ref["invoice_id"], revision_id=ref["revision_id"],
                        amount_cents=p["amount_cents"], deposit_allocation_cents=int(ref.get("deposit_allocation_cents") or 0),
                        payee_profile_id=ref["payee_profile_id"], assessment_fingerprint=latest["fingerprint"],
                        policy_version=latest["policy_version"], approved_by_identity=role, status="active", stale_reason="",
                        created_at=_now())
        self._put("payment_approval", approval)
        self._audit(rid, role, "approve_supplier_payment", "payment_approval", approval["id"], "ok", note, before, approval)
        self._update(rid, role, "approve_supplier_payment", "proposal", proposal_id, {
            "status": "approved", "decided_by_role": role, "decided_by_identity": role, "decision_note": note,
            "decided_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S")}, note)
        self._resolve_holds(rid, role, "approve_supplier_payment", ref["revision_id"], "APPROVAL_STALE", "new approval")
        self._update(rid, role, "approve_supplier_payment", "invoice", ref["invoice_id"], {
            "approval_status": "approved", "payment_status": "ready", "next_owner_role": "gateway",
            "next_action": "Settle the payment", "updated_at": _now()})
        self._set_state(rid, role, "approve_supplier_payment", p["work_item_id"], "approved", note)
        self._enqueue(rid, role, f"job_pay_{proposal_id}", "pay_supplier", {"proposal_id": proposal_id})

    def _r_reject_supplier_payment(self, rid, role, proposal_id, note):
        p = self._get("proposal", proposal_id)
        self._need(p is not None and p["kind"] == "supplier_payment", f"supplier payment proposal {proposal_id} not found")
        self._need(p["status"] == "pending", f"proposal is {p['status']}, not pending")
        self._update(rid, role, "reject_supplier_payment", "proposal", proposal_id, {
            "status": "rejected", "decided_by_role": role, "decided_by_identity": role, "decision_note": note,
            "decided_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S")}, note)
        ref = self._ref(p)
        if ref is not None:
            self._update(rid, role, "reject_supplier_payment", "invoice", ref["invoice_id"], {
                "approval_status": "rejected", "next_owner_role": "agent", "next_action": f"Owner rejected: {note}", "updated_at": _now()})
        self._set_state(rid, role, "reject_supplier_payment", p["work_item_id"], "rejected", note)

    def _r_record_deposit_allocation(self, rid, role, id, deposit_id, invoice_id, amount_cents):
        self._need(isinstance(amount_cents, int) and amount_cents > 0, "amount_cents must be above zero")
        d = self._get("deposit", deposit_id)
        self._need(d is not None, f"deposit {deposit_id} not found")
        self._need(d["status"] == "settled", f"deposit {deposit_id} is not settled")
        self._need(self._get("invoice", invoice_id) is not None, f"invoice {invoice_id} not found")
        if self._get("deposit_allocation", id):
            return ("duplicate", "allocation exists")
        used = 0
        for a in self._t("deposit_allocation").values():
            if a["deposit_id"] == deposit_id:
                self._need(a["invoice_id"] != invoice_id, f"deposit {deposit_id} is already applied to invoice {invoice_id}")
                used += int(a["amount_cents"])
        self._need(used + amount_cents <= d["amount_cents"], f"allocation would exceed the deposit: {used} + {amount_cents} > {d['amount_cents']}")
        self._upsert(rid, role, "record_deposit_allocation", "deposit_allocation", dict(
            id=id, deposit_id=deposit_id, invoice_id=invoice_id, amount_cents=amount_cents, created_at=_now()))
        return None
