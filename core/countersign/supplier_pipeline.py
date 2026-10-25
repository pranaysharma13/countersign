"""v2 job handlers (CONTRACT §9.5): read documents, record what they establish, reassess, send.

Claude interprets (AI_MODE=live) or a labelled fixture stands in (AI_MODE=fixture); this module decides
how documents link and when an invoice is reassessed. Linking never guesses: an email goes to its
supplier's single open purchase, an invoice to the purchase with its PO number; anything ambiguous goes
to review. Every handler is idempotent, so a retried or re-claimed job never duplicates a record, and
a live retry reuses what Claude already read instead of calling it again.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import live_extract
from . import reducers as R
from . import sandbox
from .clarify import outbox_id, record_draft
from .commercial import Assessment, InvoiceBundle, assess, bundle_from_store, record
from .config import settings
from .extractions import (NotYet, find_fixture, purchase_id_for, record_email_extraction, record_invoice_extraction,
                          record_purchase, validated, values)
from .ids import hold_id, sha8
from .injection import scan_document
from .money import fmt
from .store import Store, one

__all__ = ["NotYet", "process_document", "reassess", "reassess_stale", "send_outbox", "give_up_document", "propose_payment"]


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


# ---------------------------------------------------------------- who is this about, what's still being read


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].strip(" >").lower() if "@" in address else ""


def _email_supplier(store: Store, msg: dict[str, Any]) -> dict[str, Any] | None:
    domains = [_domain(msg.get("from_address", ""))] + [_domain(a) for a in msg.get("to_addresses", "").split(",")]
    return next((s for d in domains for s in store.rows("supplier") if d and s["email_domain"] == d), None)


def _reading(store: Store) -> list[dict[str, Any]]:
    """process_document jobs not finished yet (queued, waiting out a backoff, or claimed)."""
    return [j for j in store.rows("job", kind="process_document") if j["status"] in {"queued", "claimed"}]


def _doc_of(job: dict[str, Any]) -> str:
    return json.loads(job.get("payload_json") or "{}").get("document_id", "")


def being_read(store: Store, supplier_id: str, exclude: str = "") -> list[str]:
    """Documents still being read that may be from this supplier: its emails, and uploads whose sender
    isn't known yet."""
    supplier = one(store, "supplier", id=supplier_id) or {}
    out = []
    for job in _reading(store):
        doc_id = _doc_of(job)
        if not doc_id or doc_id == exclude:
            continue
        msg = one(store, "email_message", document_id=doc_id)
        if msg is not None:
            if (_email_supplier(store, msg) or {}).get("id") == supplier_id:
                out.append(doc_id)
            continue
        doc = one(store, "document", id=doc_id) or {}
        sender = _domain((one(store, "source_file", id=doc.get("source_file_id", "")) or {}).get("from_address", ""))
        if not sender or sender == supplier.get("email_domain"):
            out.append(doc_id)
    return out


def _earlier_unread_emails(store: Store, document_id: str) -> list[str]:
    mine = one(store, "job", id=f"job_doc_{document_id}")
    if mine is None:
        return []
    return [_doc_of(j) for j in _reading(store)
            if j["created_at"] < mine["created_at"] and one(store, "email_message", document_id=_doc_of(j)) is not None]


def _on_file(store: Store, supplier_id: str | None = None) -> list[str]:
    """Change requests on file, one line each, starting with the ref Claude may link to."""
    purchases = {p["id"] for p in store.rows("purchase") if supplier_id is None or p["supplier_id"] == supplier_id}
    lines = []
    for cr in sorted(store.rows("change_request"), key=lambda c: c["id"]):
        if cr["purchase_id"] in purchases and cr["kind"] != "settlement":  # an owner's settlement is never linkable
            price = (f"flat {fmt(int(cr['amount_cents']))}" if int(cr["amount_cents"])
                     else f"{fmt(int(cr['rate_cents']))}/{cr['rate_unit']}" if int(cr["rate_cents"]) else "no amount stated")
            lines.append(f"{cr['id'].removeprefix('cr_')}: {cr['description']} | {price} | supplier "
                         f"{cr['supplier_acceptance']} | ours {cr['internal_status']}")
    return lines


# ---------------------------------------------------------------- extraction (fixture or live)


def _live(store: Store, document_id: str) -> dict[str, Any]:
    prior = [r for r in store.rows("extraction_run", document_id=document_id, status="ok") if r["mode"] == "live"]
    if prior:  # a retry (e.g. its PO arrived late) reuses what Claude already read
        return json.loads(max(prior, key=lambda r: (r["created_at"], r["id"]))["fields_json"])
    doc = one(store, "document", id=document_id) or {}
    frags = store.rows("source_fragment", document_id=document_id)
    if doc.get("kind") == "email":
        msg = one(store, "email_message", document_id=document_id) or {}
        supplier = _email_supplier(store, msg)
        if supplier is None:
            raise live_extract.ExtractionFailed("the email isn't from or to a supplier on file")
        return live_extract.read_email(document_id, msg, frags, _on_file(store, supplier["id"]),
                                       supplier["id"].removeprefix("sup_"))
    src = one(store, "source_file", id=doc.get("source_file_id", "")) or {}
    path = Path(src.get("storage_path") or "")
    if not src.get("storage_path") or not path.exists():
        raise live_extract.ExtractionFailed("the original file isn't stored, so it can't be read")
    data = path.read_bytes()
    kind, m1 = live_extract.classify_pdf(data, frags)
    if kind == "invoice":
        waiting = _earlier_unread_emails(store, document_id)
        if waiting:  # they may hold the change requests its lines bill
            raise NotYet(f"waiting for {len(waiting)} earlier email(s) to be read: {', '.join(waiting)}")
    return live_extract.extract_pdf(document_id, kind, data, frags, _on_file(store), [m1])


def _extraction(store: Store, document_id: str) -> dict[str, Any] | None:
    if ai_mode() == "fixture":
        return find_fixture(document_id) or sandbox.generated(document_id)
    return _live(store, document_id)


# ---------------------------------------------------------------- recording by kind


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


def _email(store: Store, ext: dict[str, Any]) -> dict[str, Any]:
    supplier = _email_supplier(store, one(store, "email_message", document_id=ext["document_id"]) or {})
    if supplier is None:
        return needs_review(store, ext["document_id"], "the email isn't from or to a supplier on file")
    changed = record_payee_changes(store, ext, supplier["id"])  # an email asking to pay a new account (SPEC §8)
    for profile_id in changed:
        last4 = (one(store, "payee_profile", id=profile_id) or {}).get("last4", "????")
        for inv in store.rows("invoice", supplier_id=supplier["id"]):
            if inv["active_revision_id"] and inv["payment_status"] not in {"settled", "partially_settled"}:
                _step(store, inv["id"], "decision", f"An email from {supplier['name']} asks to be paid into a new account "
                      f"ending {last4}; recorded it as a pending payee change. The owner verifies it by calling a contact "
                      "already on file.", {"payee_profile_id": profile_id, "document_id": ext["document_id"]})
    if not ext.get("change_requests") and not ext.get("acceptances"):
        claims = ext.get("internal_approval_claims", [])
        return {"status": "payee_change_pending" if changed else "nothing_to_record", "payee_profile_ids": changed,
                "ignored_approval_claims": len(claims)}
    open_ = [p for p in store.rows("purchase", supplier_id=supplier["id"]) if p["status"] != "closed"]
    if not open_:
        raise NotYet(f"no purchase on file yet for {supplier['name']}")
    if len(open_) > 1:
        return needs_review(store, ext["document_id"],
                            f"{supplier['name']} has {len(open_)} open purchases; a person decides which one this email is about")
    claims = record_email_extraction(store, ext, open_[0]["id"])
    return {"status": "recorded", "purchase_id": open_[0]["id"], "change_requests": len(ext.get("change_requests", [])),
            "acceptances": len(ext.get("acceptances", [])), "ignored_approval_claims": len(claims)}


def record_payee_changes(store: Store, ext: dict[str, Any], supplier_id: str) -> list[str]:
    """A document asking to be paid into a different account becomes a pending payee profile. The module
    then opens PAYEE_CHANGE_PENDING on the supplier's open invoices; only the owner can verify it, by
    calling a contact already on file. The same account again, or the verified one, records nothing."""
    added = []
    doc = one(store, "document", id=ext["document_id"]) or {}
    src = one(store, "source_file", id=doc.get("source_file_id", "")) or {}
    via = "email" if doc.get("kind") == "email" or src.get("kind") == "email" else "portal"
    for req in ext.get("payee_change_requests", []):
        last4 = str(req["last4"])
        profiles = store.rows("payee_profile", supplier_id=supplier_id)
        if any(p["last4"] == last4 and p["status"] in {"verified", "pending"} for p in profiles):
            continue
        version = max((int(p["version"]) for p in profiles), default=0) + 1
        profile_id = f"{supplier_id}:v{version}"
        res = R.add_payee_profile(store, "agent", profile_id, supplier_id, version,
                                  f"requested_{supplier_id.removeprefix('sup_')}_{last4}", last4,
                                  str(req.get("bank_name") or ""), via)
        if not res.ok:
            raise RuntimeError(f"add_payee_profile {profile_id}: {res.outcome} {res.message}")
        added.append(profile_id)
    return added


def _invoice(store: Store, ext: dict[str, Any], injected: list[str]) -> dict[str, Any]:
    po_number = values(ext).get("po_number")
    matches = [p for p in store.rows("purchase") if p["po_number"] == po_number] if po_number else []
    if not po_number:
        return needs_review(store, ext["document_id"], "the invoice shows no PO number; it's never linked by guesswork")
    if not matches:
        raise NotYet(f"no purchase with PO number {po_number} on file yet")
    if len(matches) > 1:
        return needs_review(store, ext["document_id"], f"{len(matches)} purchases have PO number {po_number}")
    invoice_id, revision_id = record_invoice_extraction(store, ext, matches[0]["id"])
    _step(store, invoice_id, "plan", f"Read {ext['document_id']} ({ext.get('label', ext.get('mode', ''))}) and linked it "
          f"to PO {po_number}", {"revision_id": revision_id, "model": ext.get("model", "fixture"),
                                 "latency_ms": ext.get("latency_ms")})
    for profile_id in record_payee_changes(store, ext, matches[0]["supplier_id"]):
        last4 = (one(store, "payee_profile", id=profile_id) or {}).get("last4", "????")
        _step(store, invoice_id, "decision", f"The invoice asks to be paid into a new account ending {last4}; recorded it as "
              "a pending payee change. The owner verifies it by calling a contact already on file.",
              {"payee_profile_id": profile_id})
    if injected:  # data, never instructions: flag it and keep going
        R.open_hold(store, "agent", hold_id(revision_id, "PROMPT_INJECTION"), revision_id, "PROMPT_INJECTION", 0,
                    f"The invoice contains text aimed at an automated system, treated as data and ignored: \"{injected[0][:160]}\"",
                    {"quotes": injected[:5]})
        _step(store, invoice_id, "decision", "Found instructions aimed at an automated system in the invoice; ignored them "
              "and opened PROMPT_INJECTION", {"quotes": injected[:5]})
    from .supplier_agent import investigate  # one Droid session per revision (or the scripted path)

    return {"status": "recorded", "invoice_id": invoice_id, "revision_id": revision_id,
            **investigate(store, invoice_id, reading=ext["document_id"])}


def process_document(store: Store, document_id: str) -> dict[str, Any]:
    if one(store, "document", id=document_id) is None:
        return {"status": "needs_review", "reason": f"unknown document {document_id}"}
    try:
        ext = _extraction(store, document_id)
    except live_extract.ExtractionFailed as e:  # refusal, 4xx, cut-off answer: a person reads it
        return needs_review(store, document_id, str(e))
    if ext is None:
        return needs_review(store, document_id, "no labelled extraction for this document (AI_MODE=fixture)")
    problems = validated(store, ext)
    if problems:  # nothing from an extraction with bad evidence is recorded
        return {"document_id": document_id, "status": "needs_review", "problems": problems}
    injected = scan_document(store, document_id) + [str(x) for x in ext.get("instructions_found", []) if str(x).strip()]
    kind = ext["document_kind"]
    if kind == "invoice":
        return {"document_id": document_id, **_invoice(store, ext, injected)}
    if injected:
        return needs_review(store, document_id, f"text aimed at an automated system, treated as data: \"{injected[0][:160]}\"")
    handler = {"quote": _purchase, "po": _purchase, "email": _email}.get(kind)
    if handler is None:
        return needs_review(store, document_id, f"a {kind} document isn't something Countersign records")
    return {"document_id": document_id, **handler(store, ext)}


def give_up_document(store: Store, document_id: str, error: str) -> None:
    """Out of retries, whatever the document type: it goes to review, and an invoice revision it backs
    gets EXTRACTION_REVIEW."""
    needs_review(store, document_id, f"gave up after retries ({error})")
    for rev in store.rows("invoice_revision", document_id=document_id, status="active"):
        R.open_hold(store, "agent", hold_id(rev["id"], "EXTRACTION_REVIEW"), rev["id"], "EXTRACTION_REVIEW", 0,
                    f"Reading this document failed after retries ({error}). A person needs to check it.", {"document_id": document_id})


# ---------------------------------------------------------------- assessment and the clarification


def _summary(a: Assessment, assessment_id: str, outbox: str | None) -> dict[str, Any]:
    return {"assessment_id": assessment_id, "commercial_status": a.commercial_status, "claimed_cents": a.claimed_cents,
            "authorised_cents": a.authorised_cents, "under_review_cents": a.under_review_cents,
            "proposed_payment_cents": a.proposed_payment_cents, "holds": a.hold_amounts(), "outbox_id": outbox}


def _maybe_draft(store: Store, b: InvoiceBundle, a: Assessment, reading: str) -> str | None:
    """Draft the clarification once per revision, and only when nothing else from this supplier is still
    being read: the reply should cover everything we know. The sweep drafts it once they're done."""
    if a.commercial_status != "differences_under_review" or one(store, "outbox", id=outbox_id(a.revision_id)):
        return None
    if being_read(store, b.invoice["supplier_id"], exclude=reading):
        return None
    outbox = record_draft(store, b, a)
    if outbox:
        _step(store, b.invoice["id"], "tool_result", f"Drafted a clarification to the supplier for "
              f"{fmt(a.under_review_cents)} (simulated outbox, waiting for a person to send it)", {"outbox_id": outbox})
    return outbox


def propose_payment(store: Store, b: InvoiceBundle, a: Assessment, assessment_id: str) -> str | None:
    """Propose exactly what the assessment proposes, to the supplier's verified account, with the deposit it
    applies. One proposal per assessment (the module cancels older pending ones and denies any other
    amount). The owner approves it in the app; eligibility is the module's."""
    if a.proposed_payment_cents <= 0:
        return None
    payee = next((p for p in b.payee_profiles if p["status"] == "verified"), None)
    if payee is None:
        return None
    proposal_id = f"prop_{assessment_id.removeprefix('asm_')}"
    if one(store, "proposal", id=proposal_id):
        return None
    res = R.propose_supplier_payment(store, proposal_id, b.invoice["id"], a.revision_id, assessment_id, a.proposed_payment_cents,
                                     a.deposit_applied_cents, payee["id"])
    if not res.ok:
        _step(store, b.invoice["id"], "error", f"Couldn't propose the payment: {res.outcome} {res.message}")
        return None
    _step(store, b.invoice["id"], "decision", f"Proposed paying {fmt(a.proposed_payment_cents)} to the verified account ending "
          f"{payee['last4']} ({fmt(a.deposit_applied_cents)} deposit applied); waiting for the owner's approval",
          {"proposal_id": proposal_id, "assessment_id": assessment_id})
    return proposal_id


def reassess(store: Store, invoice_id: str, force: bool = False, reading: str = "", act: bool = True) -> dict[str, Any]:
    """Assess the active revision; record it only if an input changed (or `force`). `reading` is the
    document whose job is calling, so it doesn't count as still being read. With `act`, code also drafts
    the clarification and proposes the payment; without it (a Droid session follows) only the numbers
    and holds are recorded."""
    b = bundle_from_store(store, invoice_id)
    a = assess(b)
    latest = max(store.rows("assessment", revision_id=a.revision_id), key=lambda r: r["version"], default=None)
    if latest is not None and latest["fingerprint"] == a.fingerprint and not force:
        return {"status": "unchanged", "assessment_id": latest["id"],
                "outbox_id": _maybe_draft(store, b, a, reading) if act else None}
    assessment_id = record(store, a)
    _step(store, invoice_id, "decision", a.summary, {"assessment_id": assessment_id, "holds": a.hold_amounts(),
                                                      "next_action": a.next_action})
    proposal = propose_payment(store, b, a, assessment_id) if act else None
    outbox = _maybe_draft(store, b, a, reading) if act else None
    return {"status": "assessed", "proposal_id": proposal, **_summary(a, assessment_id, outbox)}


def reassess_stale(store: Store) -> list[str]:
    """Reassess every open invoice whose inputs changed since its last assessment (a receipt
    attestation, an in-app decision, a new email...), and draft clarifications that were waiting for
    other documents. Returns the invoice ids reassessed."""
    done = []
    for inv in store.rows("invoice"):
        if inv["active_revision_id"] and inv["payment_status"] not in {"settled", "partially_settled"}:
            if reassess(store, inv["id"]).get("status") == "assessed":
                done.append(inv["id"])
    return done


def send_outbox(store: Store, outbox_id_: str) -> dict[str, Any]:
    """Simulated delivery: nothing leaves the laptop. The row says `simulated = true`."""
    ob = one(store, "outbox", id=outbox_id_)
    if ob is None:
        raise ValueError(f"unknown outbox message {outbox_id_}")
    if ob["status"] == "sent":
        return {"outbox_id": outbox_id_, "status": "already sent"}
    res = R.mark_outbox(store, outbox_id_, "sent", f"simulated-{outbox_id_}")
    if not res.ok:
        raise RuntimeError(f"mark_outbox: {res.outcome} {res.message}")
    return {"outbox_id": outbox_id_, "status": "sent", "delivery": "simulated", "to": ob["to_address"]}
