"""The clarification to the supplier, as a deterministic template (Claude drafts it from step C).

It explains each disputed line against what was agreed, says which charges are correct, and asks
for a corrected invoice or an agreed credit. It never says we'll pay less. Drafts go to the
simulated outbox; a person approves sending.
"""

from __future__ import annotations

from typing import Any

from . import reducers as R
from .commercial import Assessment, InvoiceBundle, LineResult, effective_classification
from .money import fmt, fmt_qty
from .store import Store
from .world import Company

SIGNATURE = f"{Company().name}, Accounts Payable"


def recipient(store: Store, supplier_id: str) -> dict[str, Any] | None:
    """Accounts receivable on file, else the first contact that was on file before any dispute."""
    on_file = sorted((c for c in store.rows("supplier_contact", supplier_id=supplier_id) if c["pre_established"]),
                     key=lambda c: c["id"])
    return next((c for c in on_file if "receivable" in c["title"].lower()), on_file[0] if on_file else None)


def outbox_id(revision_id: str) -> str:
    return f"ob_{revision_id.removeprefix('rev_')}_clarify"


def _base_price(b: InvoiceBundle) -> int | None:
    terms = [t for t in b.terms if t["code"] == "unit_price" and t["status"] == "accepted"]
    repriced = any(c["kind"] == "price_change" and effective_classification(c).startswith("AUTHORISED") for c in b.change_requests)
    return None if not terms or repriced else int(max(terms, key=lambda t: t["version"])["amount_cents"])


def _point(b: InvoiceBundle, r: LineResult) -> str:
    row = next(l for l in b.lines if l["id"] == r.line_id)
    unit = row["unit"]
    if r.kind == "material" and r.variance_cents:
        base = _base_price(b)
        agreed = (f"The accepted price is {fmt(base)} per {unit} ({fmt(r.accepted_cents)})" if base is not None
                  else f"The agreed amount is {fmt(r.accepted_cents)}")
        return (f"{r.description}: billed {fmt_qty(int(row['quantity_milli']), unit)} at {fmt(int(row['unit_price_cents']))} "
                f"({fmt(r.claimed_cents)}). {agreed}, and price changes need mutual written agreement; we have no "
                f"agreed change on file. Difference: {fmt(r.variance_cents)}.")
    if r.variance_cents:
        return f"{r.description}: billed {fmt(r.claimed_cents)}, agreed {fmt(r.accepted_cents)}. Difference: {fmt(r.variance_cents)}."
    if r.hold_code == "USAGE_EVIDENCE_MISSING":
        return (f"{r.description} ({fmt(r.pending_cents)}): the rate is agreed, but we have no record of the "
                f"{fmt_qty(int(row['quantity_milli']), unit)} billed. Please send the record that supports it.")
    if r.classification == "DECLINED":
        return f"{r.description} ({fmt(r.pending_cents)}): this charge was declined."
    if r.hold_code == "PROPOSED_CHARGE":
        return (f"{r.description} ({fmt(r.pending_cents)}): mentioned as possible, but never agreed in writing before "
                "the work, as the quote's terms require.")
    return f"{r.description} ({fmt(r.pending_cents)}): {r.uncertainty}"


def draft(b: InvoiceBundle, a: Assessment, contact: dict[str, Any]) -> tuple[str, str] | None:
    """(subject, body), or None when there's nothing to ask."""
    disputed = [r for r in a.lines if r.variance_cents or r.pending_cents]
    if not disputed:
        return None
    inv = b.invoice
    n = len(disputed)
    lines_dont = f"{n} line{'s' if n != 1 else ''} {'do' if n != 1 else 'does'}n't match what we agreed"
    subject = f"Invoice {inv['invoice_number']}: {lines_dont}"
    kept = [r for r in a.lines if r.kind != "material" and r.status == "accepted"]
    body = [f"Hello {contact['name']},", "",
            f"Thanks for invoice {inv['invoice_number']} dated {inv['invoice_date']} ({fmt(a.claimed_cents)}). We checked it "
            f"against the quote, purchase order and emails on file, and {lines_dont}:", ""]
    body += [f"{i}. {_point(b, r)}" for i, r in enumerate(disputed, start=1)]
    if kept:
        body += ["", "These lines are correct: " + "; ".join(f"{r.description} ({fmt(r.accepted_cents)})" for r in kept) + "."]
    body += ["", f"Please send a corrected invoice or an agreed credit memo for the {fmt(a.under_review_cents)} in question. "
                 "We'll keep your original invoice on file and process the corrected one as soon as it arrives.",
             "", "Thanks,", SIGNATURE]
    return subject, "\n".join(body) + "\n"


def record_draft(store: Store, b: InvoiceBundle, a: Assessment) -> str | None:
    """Draft the clarification in the simulated outbox. Returns its id, or None if there's nothing to ask."""
    contact = recipient(store, b.invoice["supplier_id"])
    message = draft(b, a, contact) if contact else None
    if message is None:
        return None
    ob = outbox_id(a.revision_id)
    res = R.draft_outbox(store, ob, b.invoice["id"], contact["id"], *message)
    if not res.ok:
        raise RuntimeError(f"draft_outbox: {res.outcome} {res.message}")
    return ob
