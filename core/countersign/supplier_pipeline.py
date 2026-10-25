"""v2 job handlers (CONTRACT §9.5): read documents, record what they establish, reassess, send.

Claude interprets (step C; labelled fixtures until then); this module decides how documents link
and when an invoice is reassessed. Linking never guesses: an email goes to its supplier's single
open purchase, an invoice to the purchase with its PO number; anything ambiguous goes to review.
Every handler is idempotent, so a retried or re-claimed job never duplicates a record.
"""

from __future__ import annotations

import json
from typing import Any

from . import reducers as R
from .clarify import record_draft
from .commercial import Assessment, assess, bundle_from_store, record
from .config import settings
from .extractions import (NotYet, find_fixture, purchase_id_for, record_email_extraction, record_invoice_extraction,
                          record_purchase, validated, values)
from .ids import hold_id, sha8
from .money import fmt
from .store import Store, one


__all__ = ["NotYet", "process_document", "reassess", "reassess_stale", "send_outbox", "give_up_document"]


def ai_mode() -> str:
    return settings.ai_mode


def _step(store: Store, invoice_id: str, kind: str, title: str, detail: Any = None) -> None:
    R.log_agent_step(store, f"wi_{invoice_id}", kind, title, detail or {})


def needs_review(store: Store, document_id: str, reason: str) -> dict[str, Any]:
    """Put the document in front of a person: an `invalid` run sets document.status = needs_review
    (the module and the reference agree on that), with the reason as its error."""
    R.record_extraction_run(store, f"run_{document_id.removeprefix('doc_')}_review_{sha8(reason)}", document_id,
                            ai_mode(), "none", "", "invalid", f"Needs review: {reason}", {})
    return {"document_id": document_id, "status": "needs_review", "reason": reason}


def _extraction(store: Store, document_id: str) -> dict[str, Any] | None:
    if ai_mode() != "fixture":
        return None
    return find_fixture(document_id)


def _ok_runs(store: Store, kind: str) -> list[dict[str, Any]]:
    out = []
    for run in store.rows("extraction_run", status="ok"):
        ext = json.loads(run["fields_json"] or "{}")
        if ext.get("document_kind") == kind:
            out.append(ext)
    return out


def _purchase(store: Store, ext: dict[str, Any]) -> dict[str, Any]:
    """A quote and its PO arrive in either order; the purchase is recorded once both are read."""
    v = values(ext)
    if ext["document_kind"] == "quote":
        quote = ext
        po = next((p for p in _ok_runs(store, "po") if values(p).get("incorporates_quote") == v.get("quote_number")), None)
    else:
        po = ext
        quote = next((q for q in _ok_runs(store, "quote") if values(q).get("quote_number") == v.get("incorporates_quote")), None)
    if quote is None or po is None:
        return {"status": "waiting", "needs": "po" if po is None else "quote"}
    purchase_id = record_purchase(store, quote, po, purchase_id_for(store, quote, po))
    return {"status": "recorded", "purchase_id": purchase_id}


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].strip(" >").lower() if "@" in address else ""


def _email(store: Store, ext: dict[str, Any]) -> dict[str, Any]:
    msg = one(store, "email_message", document_id=ext["document_id"]) or {}
    domains = [_domain(msg.get("from_address", ""))] + [_domain(a) for a in msg.get("to_addresses", "").split(",")]
    supplier = next((s for d in domains for s in store.rows("supplier") if d and s["email_domain"] == d), None)
    if supplier is None:
        return needs_review(store, ext["document_id"], "the email isn't from or to a supplier on file")
    if not ext.get("change_requests") and not ext.get("acceptances"):
        claims = ext.get("internal_approval_claims", [])
        return {"status": "nothing_to_record", "ignored_approval_claims": len(claims)}
    open_ = [p for p in store.rows("purchase", supplier_id=supplier["id"]) if p["status"] != "closed"]
    if not open_:
        raise NotYet(f"no purchase on file yet for {supplier['name']}")
    if len(open_) > 1:
        return needs_review(store, ext["document_id"],
                            f"{supplier['name']} has {len(open_)} open purchases; a person decides which one this email is about")
    claims = record_email_extraction(store, ext, open_[0]["id"])
    return {"status": "recorded", "purchase_id": open_[0]["id"], "change_requests": len(ext.get("change_requests", [])),
            "acceptances": len(ext.get("acceptances", [])), "ignored_approval_claims": len(claims)}


def _invoice(store: Store, ext: dict[str, Any]) -> dict[str, Any]:
    po_number = values(ext).get("po_number")
    matches = [p for p in store.rows("purchase") if p["po_number"] == po_number] if po_number else []
    if not po_number:
        return needs_review(store, ext["document_id"], "the invoice shows no PO number; it's never linked by guesswork")
    if not matches:
        raise NotYet(f"no purchase with PO number {po_number} on file yet")
    if len(matches) > 1:
        return needs_review(store, ext["document_id"], f"{len(matches)} purchases have PO number {po_number}")
    invoice_id, revision_id = record_invoice_extraction(store, ext, matches[0]["id"])
    _step(store, invoice_id, "plan", f"Read {ext['document_id']} ({ext.get('mode', 'live')} extraction) and linked it to "
          f"PO {po_number}", {"revision_id": revision_id, "label": ext.get("label", "")})
    return {"status": "recorded", "invoice_id": invoice_id, "revision_id": revision_id, **reassess(store, invoice_id)}


def process_document(store: Store, document_id: str) -> dict[str, Any]:
    if one(store, "document", id=document_id) is None:
        return {"status": "needs_review", "reason": f"unknown document {document_id}"}
    ext = _extraction(store, document_id)
    if ext is None:
        return needs_review(store, document_id, "no labelled extraction for this document (AI_MODE=fixture)"
                            if ai_mode() == "fixture" else "live extraction isn't available")
    problems = validated(store, ext)
    if problems:  # nothing from an extraction with bad evidence is recorded
        return {"document_id": document_id, "status": "needs_review", "problems": problems}
    handler = {"quote": _purchase, "po": _purchase, "email": _email, "invoice": _invoice}.get(ext["document_kind"])
    if handler is None:
        return needs_review(store, document_id, f"a {ext['document_kind']} document isn't something Countersign records")
    return {"document_id": document_id, **handler(store, ext)}


def give_up_document(store: Store, document_id: str, error: str) -> None:
    """Out of retries, whatever the document type: it goes to review, and an invoice revision it backs
    gets EXTRACTION_REVIEW."""
    needs_review(store, document_id, f"gave up after retries ({error})")
    for rev in store.rows("invoice_revision", document_id=document_id, status="active"):
        R.open_hold(store, "agent", hold_id(rev["id"], "EXTRACTION_REVIEW"), rev["id"], "EXTRACTION_REVIEW", 0,
                    f"Reading this document failed after retries ({error}). A person needs to check it.", {"document_id": document_id})


def _summary(a: Assessment, assessment_id: str, outbox_id: str | None) -> dict[str, Any]:
    return {"assessment_id": assessment_id, "commercial_status": a.commercial_status, "claimed_cents": a.claimed_cents,
            "authorised_cents": a.authorised_cents, "under_review_cents": a.under_review_cents,
            "proposed_payment_cents": a.proposed_payment_cents, "holds": a.hold_amounts(), "outbox_id": outbox_id}


def reassess(store: Store, invoice_id: str, force: bool = False) -> dict[str, Any]:
    """Assess the active revision; record it only if an input changed (or `force`). Drafts the
    clarification when there are differences (one per revision)."""
    b = bundle_from_store(store, invoice_id)
    a = assess(b)
    latest = max(store.rows("assessment", revision_id=a.revision_id), key=lambda r: r["version"], default=None)
    if latest is not None and latest["fingerprint"] == a.fingerprint and not force:
        return {"status": "unchanged", "assessment_id": latest["id"]}
    assessment_id = record(store, a)
    outbox = record_draft(store, b, a) if a.commercial_status == "differences_under_review" else None
    _step(store, invoice_id, "decision", a.summary, {"assessment_id": assessment_id, "holds": a.hold_amounts(),
                                                      "next_action": a.next_action})
    if outbox:
        _step(store, invoice_id, "tool_result", f"Drafted a clarification to the supplier for {fmt(a.under_review_cents)} "
              "(simulated outbox, waiting for a person to send it)", {"outbox_id": outbox})
    return {"status": "assessed", **_summary(a, assessment_id, outbox)}


def reassess_stale(store: Store) -> list[str]:
    """Reassess every open invoice whose inputs changed since its last assessment (a receipt
    attestation, an in-app decision, a new email...). Returns the invoice ids reassessed."""
    done = []
    for inv in store.rows("invoice"):
        if inv["active_revision_id"] and inv["payment_status"] not in {"settled", "partially_settled"}:
            if reassess(store, inv["id"]).get("status") == "assessed":
                done.append(inv["id"])
    return done


def send_outbox(store: Store, outbox_id: str) -> dict[str, Any]:
    """Simulated delivery: nothing leaves the laptop. The row says `simulated = true`."""
    ob = one(store, "outbox", id=outbox_id)
    if ob is None:
        raise ValueError(f"unknown outbox message {outbox_id}")
    if ob["status"] == "sent":
        return {"outbox_id": outbox_id, "status": "already sent"}
    res = R.mark_outbox(store, outbox_id, "sent", f"simulated-{outbox_id}")
    if not res.ok:
        raise RuntimeError(f"mark_outbox: {res.outcome} {res.message}")
    return {"outbox_id": outbox_id, "status": "sent", "delivery": "simulated", "to": ob["to_address"]}
