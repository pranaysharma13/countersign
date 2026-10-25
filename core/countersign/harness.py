"""Build CheckContexts straight from the demo world (no store). Used by tests and
quick offline scorecard runs. The live pipeline builds the same shapes from the store.
"""

from __future__ import annotations

from typing import Any

from .checks import CheckContext
from .integrations import crs, license
from .world import BillDoc, World


def bill_dict(doc: BillDoc) -> dict[str, Any]:
    return {
        "id": doc.id, "sub_id": doc.sub_id, "vendor_name": doc.vendor_name, "vendor_license": doc.vendor_license,
        "contract_id": doc.contract_id, "invoice_number": doc.invoice_number, "bill_date": doc.bill_date,
        "due_date": doc.due_date, "period_label": doc.period_label, "amount_cents": doc.amount_cents,
        "retainage_cents": doc.retainage_cents, "remit_bank_name": doc.remit_bank_name, "remit_routing": doc.remit_routing,
        "remit_account_last4": doc.remit_account_last4, "from_address": doc.from_address,
        "has_lien_waiver": doc.has_lien_waiver,
    }


def line_dicts(doc: BillDoc) -> list[dict[str, Any]]:
    return [{"contract_line_code": l.code, "description": l.description, "this_period_cents": l.this_period_cents,
             "previous_cents": l.previous_cents, "percent_complete_bps": l.percent_complete_bps} for l in doc.lines]


def sub_dict(world: World, sub_id: str) -> dict[str, Any] | None:
    if not sub_id:
        return None
    s = world.sub(sub_id)
    return {"id": s.id, "name": s.name, "license_number": s.license_number, "email_domain": s.email_domain,
            "bank_account_ref": s.bank_account_ref, "bank_last4": s.bank_last4, "bank_name": s.bank_name,
            "routing": s.routing, "crs_ref": s.crs_ref, "status": "active"}


def context_for(world: World, doc: BillDoc, prior: list[BillDoc], doc_text: str = "",
                balance_cents: int | None = None, committed_cents: int = 0) -> CheckContext:
    contract = next((c for c in world.contracts if c.id == doc.contract_id), None)
    sub = sub_dict(world, doc.sub_id)
    return CheckContext(
        bill=bill_dict(doc),
        lines=line_dicts(doc),
        sub=sub,
        contract=None if contract is None else {"id": contract.id, "retainage_bps": contract.retainage_bps,
                                                "lien_waiver_rule": contract.lien_waiver_rule},
        contract_lines=[] if contract is None else [{"code": l.code, "scheduled_value_cents": l.scheduled_cents} for l in contract.lines],
        change_orders=[{"number": co.number, "description": co.description, "amount_cents": co.amount_cents,
                        "status": "approved" if co.approved else "pending"}
                       for co in world.change_orders if co.contract_id == doc.contract_id],
        prior_bills=[{**bill_dict(p), "lines": line_dicts(p)} for p in prior if p.sub_id == doc.sub_id and p.id != doc.id],
        doc_text=doc_text or doc.hidden_text,
        email_body=doc.email_body,
        subject=doc.subject,
        license=license.lookup(sub["license_number"] if sub else (doc.vendor_license or "0000000")),
        crs=crs.business_report(sub["crs_ref"]) if sub else {"liens": [], "judgments": [], "bankruptcies": [], "not_found": True},
        balance_cents=balance_cents,
        committed_cents=committed_cents,
    )
