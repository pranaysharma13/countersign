"""Fixture accounting for supplier invoices (CONTRACT §9.6): simplified accrual, no receiving accrual.

The PO creates no entry. Journal ids are deterministic, so posting twice is refused by the module
("journal already posted"), and the bill is posted once per invoice, never per revision: a
correction never re-posts the original claim.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import reducers as R
from .store import Result, Store

CASH, AP, PREPAYMENT = "cash", "accounts_payable", "supplier_prepayment"


def material_cost(project_id: str) -> str:
    return f"job_material_cost:{project_id}"


@dataclass(frozen=True)
class Journal:
    id: str
    entry_date: str
    memo: str
    ref_type: str  # bill | payment (CONTRACT §3.2)
    ref_id: str
    lines: tuple[dict[str, Any], ...]


def _pair(debit: str, credit: str, cents: int) -> tuple[dict[str, Any], ...]:
    if cents <= 0:
        raise ValueError("journal amounts are positive integer cents")
    return ({"account": debit, "debit_cents": cents, "credit_cents": 0},
            {"account": credit, "debit_cents": 0, "credit_cents": cents})


def deposit_settled(deposit_id: str, amount_cents: int, entry_date: str) -> Journal:
    return Journal(f"jrnl_dep_{deposit_id}", entry_date, "Supplier deposit settled (simulated)", "payment", deposit_id,
                   _pair(PREPAYMENT, CASH, amount_cents))


def bill_accepted(invoice_id: str, revision_id: str, project_id: str, gross_cents: int, entry_date: str) -> Journal:
    return Journal(f"jrnl_bill_{invoice_id}", entry_date, f"Supplier invoice accepted ({revision_id}), receipt attested",
                   "bill", invoice_id, _pair(material_cost(project_id), AP, gross_cents))


def deposit_applied(invoice_id: str, deposit_id: str, amount_cents: int, entry_date: str) -> Journal:
    return Journal(f"jrnl_depapply_{invoice_id}_{deposit_id}", entry_date, "Deposit applied to invoice", "bill", invoice_id,
                   _pair(AP, PREPAYMENT, amount_cents))


def settlement(ref_id: str, amount_cents: int, entry_date: str) -> Journal:
    return Journal(f"jrnl_pay_{ref_id}", entry_date, "Supplier balance settled (simulated)", "payment", ref_id,
                   _pair(AP, CASH, amount_cents))


def post(store: Store, role: str, j: Journal) -> Result:
    return R.post_journal(store, role, j.id, j.entry_date, j.memo, j.ref_type, j.ref_id, list(j.lines))


def balances(ledger_lines: list[dict[str, Any]]) -> dict[str, int]:
    """Debit minus credit per account."""
    out: dict[str, int] = {}
    for l in ledger_lines:
        out[l["account"]] = out.get(l["account"], 0) + int(l["debit_cents"]) - int(l["credit_cents"])
    return out
