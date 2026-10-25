"""The gateway for supplier payments (the pay_supplier job, gateway role). Simulated: Nessie sandbox or mock.

1. Never pay the agreed part of a disputed invoice before the supplier has been told: every active
   "pay agreed, dispute the rest" notice must be sent (CONTRACT §9.9).
   Before paying, recompute the assessment fingerprint from the current rows. If it isn't the one the
   owner approved, don't pay: say which inputs changed (the sweep reassesses and the module makes the
   approval stale), or, if none did, report a fingerprint mismatch with the module.
2. start_payment (the module re-checks every bound value), then one Nessie transfer per idempotency key.
3. record_payment, the deposit allocation and the §9.6 journals. Every step is safe to repeat: a retry
   after a crash finds the payment already recorded and finishes the bookkeeping exactly once.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from typing import Any

from . import reducers as R
from . import supplier_ledger as L
from .commercial import (
    active_decisions,
    bundle_from_store,
    changed_inputs,
    fingerprint,
    input_digest,
)
from .integrations import nessie
from .money import fmt
from .store import Store, one

SIMULATED = "Nessie sandbox (simulated)"


class GatewayError(RuntimeError):
    pass


def _ok(res: R.Result, what: str) -> None:
    if not res.ok:
        raise GatewayError(f"{what}: {res.outcome} {res.message}")


def _timeline(store: Store, invoice_id: str, kind: str, title: str, detail: dict[str, Any]) -> None:
    # The timeline (agent_step) is written with the worker's agent role; only the agent may log steps.
    R.log_agent_step(store, f"wi_{invoice_id}", kind, title, detail)


def _approved_digest(store: Store, approval: dict[str, Any]) -> dict[str, Any] | None:
    rows = [a for a in store.rows("assessment", revision_id=approval["revision_id"])
            if a["fingerprint"] == approval["assessment_fingerprint"]]
    if not rows:
        return None
    details = json.loads(max(rows, key=lambda a: a["version"])["details_json"] or "{}")
    return details.get("inputs") if isinstance(details, dict) else None


def _inputs_unchanged(store: Store, invoice_id: str, approval: dict[str, Any]) -> dict[str, Any] | None:
    """None if the inputs still give the approved fingerprint; otherwise why not (and whether any input changed)."""
    b = bundle_from_store(store, invoice_id)
    now = fingerprint(b)
    if now == approval["assessment_fingerprint"]:
        return None
    before = _approved_digest(store, approval)
    changes = changed_inputs(before, input_digest(b)) if before is not None else []
    return {"approved_fingerprint": approval["assessment_fingerprint"], "current_fingerprint": now,
            "inputs_changed": bool(changes), "changes": changes, "mismatch": not changes}


def unsent_notices(store: Store, invoice_id: str) -> list[str]:
    return [d["outbox_id"] for d in active_decisions(store, invoice_id=invoice_id) if d["decision"] == "pay_agreed_dispute_rest"
            and (one(store, "outbox", id=d["outbox_id"]) or {}).get("status") != "sent"]


def _deposit_for(store: Store, purchase_id: str, invoice_id: str, amount: int) -> tuple[str, bool] | None:
    """The settled deposit to apply: (deposit id, already applied to this invoice)."""
    deposits = sorted((d for d in store.rows("deposit", purchase_id=purchase_id) if d["status"] == "settled"), key=lambda d: d["id"])
    for d in deposits:
        allocs = store.rows("deposit_allocation", deposit_id=d["id"])
        if any(a["invoice_id"] == invoice_id for a in allocs):
            return d["id"], True
    for d in deposits:
        used = sum(int(a["amount_cents"]) for a in store.rows("deposit_allocation", deposit_id=d["id"]))
        if int(d["amount_cents"]) - used >= amount:
            return d["id"], False
    return None


def _post(store: Store, journal: L.Journal) -> None:
    res = L.post(store, "gateway", journal)
    if not res.ok and "already posted" not in res.message:
        raise GatewayError(f"post_journal {journal.id}: {res.outcome} {res.message}")


def _finish(store: Store, p: dict[str, Any], ref: dict[str, Any], invoice: dict[str, Any]) -> dict[str, Any]:
    """After the transfer: apply the deposit and post the journals. Exactly once, however many times it runs."""
    today = date.today().isoformat()
    alloc = int(ref.get("deposit_allocation_cents") or 0)
    deposit_id = ""
    if alloc:
        found = _deposit_for(store, invoice["purchase_id"], invoice["id"], alloc)
        if found is None:
            raise GatewayError(f"no settled deposit with {fmt(alloc)} left to apply")
        deposit_id, applied = found
        if not applied:
            _ok(R.record_deposit_allocation(store, f"alloc_{deposit_id}_{invoice['id']}", deposit_id, invoice["id"], alloc),
                "deposit allocation")
    assessment = one(store, "assessment", id=ref["assessment_id"]) or {}
    purchase = one(store, "purchase", id=invoice["purchase_id"]) or {}
    _post(store, L.bill_accepted(invoice["id"], ref["revision_id"], purchase.get("project_id", "unassigned"),
                                 int(assessment.get("authorised_cents") or int(p["amount_cents"]) + alloc), today))
    if alloc:
        _post(store, L.deposit_applied(invoice["id"], deposit_id, alloc, today))
    _post(store, L.settlement(p["id"], int(p["amount_cents"]), today))
    return {"deposit_id": deposit_id, "deposit_applied_cents": alloc}


def pay_supplier(store: Store, proposal_id: str) -> dict[str, Any]:
    p = one(store, "proposal", id=proposal_id)
    if p is None or p["kind"] != "supplier_payment":
        raise GatewayError(f"unknown supplier payment {proposal_id}")
    ref = json.loads(p["evidence_json"])
    invoice = one(store, "invoice", id=ref["invoice_id"])
    if invoice is None:
        raise GatewayError(f"unknown invoice {ref['invoice_id']}")
    payment = one(store, "payment", id=proposal_id)
    recovered = False
    if payment is None:
        if p["status"] == "approved":
            approval = one(store, "payment_approval", id=f"appr_{proposal_id}")
            if approval is None or approval["status"] != "active":
                return {"status": "blocked", "reason": "no active approval for this payment"}
            unsent = unsent_notices(store, invoice["id"])
            if unsent:
                _timeline(store, invoice["id"], "error", "Didn't pay: the notice to the supplier about the disputed amount "
                          "hasn't been sent", {"outbox_ids": unsent})
                return {"status": "blocked", "reason": "blocked: notice to supplier not sent", "outbox_ids": unsent}
            changed = _inputs_unchanged(store, invoice["id"], approval)
            if changed is not None:
                if changed["mismatch"]:
                    print(f"FINGERPRINT MISMATCH with the module for {proposal_id}: no input changed, but the rows give "
                          f"{changed['current_fingerprint']} and the approval is bound to {changed['approved_fingerprint']}",
                          file=sys.stderr, flush=True)
                    title = "Didn't pay: fingerprint mismatch with the module (no input changed since approval)"
                else:
                    title = (f"Didn't pay: {len(changed['changes'])} input(s) changed since the owner approved "
                             f"({'; '.join(changed['changes'][:3])}); reassessing, then the owner approves again")
                _timeline(store, invoice["id"], "error", title, changed)
                return {"status": "blocked", **changed}
            res = R.start_payment(store, proposal_id)  # the module re-checks everything; a failure makes the approval stale
            if not res.ok:
                _timeline(store, invoice["id"], "error", f"Didn't pay: the module refused ({res.message[:200]})", {})
                return {"status": "blocked", "reason": res.message, "inputs_changed": False}
        elif p["status"] != "executing":
            return {"status": "not_payable", "proposal_status": p["status"]}
        company = store.rows("company")[0]
        try:
            transfer, recovered = nessie.pay_once(nessie.client(), company["bank_account_ref"], p["payee_account_ref"],
                                                  int(p["amount_cents"]), f"cs:{proposal_id}")
        except nessie.NessieError as e:
            _ok(R.record_payment(store, proposal_id, "", "failed", str(e)), "record payment")
            _timeline(store, invoice["id"], "error", f"Payment failed at the bank ({SIMULATED}): {e}", {})
            return {"status": "failed", "error": str(e), "bank": SIMULATED}
        _ok(R.record_payment(store, proposal_id, str(transfer["_id"]), "sent", ""), "record payment")
        payment = one(store, "payment", id=proposal_id)
    elif payment["status"] == "failed":
        return {"status": "failed", "error": payment["error"], "bank": SIMULATED}
    booked = _finish(store, p, ref, invoice)
    try:
        payer = store.rows("company")[0]["bank_account_ref"]
        R.record_bank_snapshot(store, "gateway", f"snap_{proposal_id}", payer, nessie.client().balance_cents(payer),
                               date.today().isoformat())
    except Exception:  # noqa: BLE001 - a balance snapshot is a nicety, never a reason to fail a settled payment
        pass
    _timeline(store, invoice["id"], "tool_result", f"Paid {fmt(int(p['amount_cents']))} to the account ending "
              f"{(one(store, 'payee_profile', id=ref['payee_profile_id']) or {}).get('last4', '????')} ({SIMULATED}); "
              f"deposit of {fmt(booked['deposit_applied_cents'])} applied; books posted",
              {"proposal_id": proposal_id, "transfer": payment["nessie_transfer_id"], "recovered": recovered})
    return {"status": "settled", "bank": SIMULATED, "simulated": True, "transfer_id": payment["nessie_transfer_id"],
            "recovered_after_timeout": recovered, "amount_cents": int(p["amount_cents"]), **booked}
