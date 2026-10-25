"""What a document says, as structured fields with evidence, and how it's recorded.

Claude (live) or a labelled fixture (AI_MODE=fixture) produces an extraction; this module
only checks its evidence and records it through reducers. Every material value cites
fragments of its own document, its quote must appear in them after whitespace
normalization, and every money value must appear in its quote. Missing facts are null
with a reason. Anything else makes the run `invalid` and nothing from it is recorded.
Fixture files live in data/fixtures/; expected answers live elsewhere and are never read here.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from . import reducers as R
from .config import DATA_DIR
from .ids import sha8
from .money import fmt, fmt_qty
from .store import Result, Store, dumps, one
from .supplier_docs import normalize_ws

FIXTURE_DIR = DATA_DIR / "fixtures" / "baymix_primary" / "extractions"


class NotYet(RuntimeError):
    """Something this document depends on isn't on file yet (its purchase, the proposal it accepts...).
    The job fails and the module retries it; when retries run out, the document goes to review."""
EVIDENCE_LISTS = ("terms", "lines", "change_requests", "acceptances", "internal_approval_claims")


def load_fixture(document_id: str, fixture_dir: Path = FIXTURE_DIR) -> dict[str, Any]:
    ext = json.loads((fixture_dir / f"{document_id}.json").read_text())
    if ext.get("mode") != "fixture" or not str(ext.get("label", "")).startswith("FIXTURE"):
        raise ValueError(f"{document_id}: fixture extractions must be labelled as fixtures")
    return ext


def find_fixture(document_id: str, fixture_dir: Path = FIXTURE_DIR) -> dict[str, Any] | None:
    """The labelled extraction for this document, or None if there isn't one."""
    return load_fixture(document_id, fixture_dir) if (fixture_dir / f"{document_id}.json").exists() else None


def values(ext: dict[str, Any]) -> dict[str, Any]:
    return {k: f.get("value") for k, f in ext.get("fields", {}).items()}


def _money_values(item: dict[str, Any]) -> list[int]:
    return [v for k, v in item.items() if k.endswith("_cents") and isinstance(v, int) and not isinstance(v, bool) and v]


def evidence_problems(ext: dict[str, Any], fragment_texts: dict[str, str]) -> list[str]:
    """`fragment_texts`: id -> text for this document's fragments only (scope check)."""
    problems: list[str] = []

    def check(path: str, item: dict[str, Any], money: list[int], qty: int = 0) -> None:
        ids = item.get("fragments") or []
        if not ids:
            problems.append(f"{path}: no source fragment")
            return
        unknown = [i for i in ids if i not in fragment_texts]
        if unknown:
            problems.append(f"{path}: fragment(s) not in this document: {', '.join(unknown)}")
            return
        source = normalize_ws(" ".join(fragment_texts[i] for i in ids))
        quote = normalize_ws(str(item.get("quote", "")))
        if not quote or quote not in source:
            problems.append(f"{path}: quote doesn't match its fragments")
            return
        for cents in money:
            if fmt(cents) not in quote:
                problems.append(f"{path}: {fmt(cents)} doesn't appear in the quoted text")
        if qty and fmt_qty(qty) not in quote:
            problems.append(f"{path}: quantity {fmt_qty(qty)} doesn't appear in the quoted text")

    for name, field in ext.get("fields", {}).items():
        if field.get("value") is None:
            if not field.get("missing_reason"):
                problems.append(f"fields.{name}: null without a reason")
        else:
            v = field["value"]
            check(f"fields.{name}", field, [v] if name.endswith("_cents") and isinstance(v, int) else [])
    for key in EVIDENCE_LISTS:
        for i, item in enumerate(ext.get(key, [])):
            check(f"{key}[{i}]", item, _money_values(item), int(item.get("quantity_milli") or 0))
    return problems


def document_fragments(store: Store, document_id: str) -> dict[str, str]:
    return {f["id"]: f["text"] for f in store.rows("source_fragment", document_id=document_id)}


def record_run(store: Store, ext: dict[str, Any], problems: list[str], model: str = "fixture") -> Result:
    run_id = f"run_{ext['document_id'].removeprefix('doc_')}_{sha8(dumps(ext))}"
    return R.record_extraction_run(store, run_id, ext["document_id"], ext.get("mode", "live"), model,
                                   ext.get("prompt_version", ""), "invalid" if problems else "ok", "; ".join(problems), ext)


def validated(store: Store, ext: dict[str, Any]) -> list[str]:
    """Check evidence against the stored fragments and record the run. Returns the problems."""
    problems = evidence_problems(ext, document_fragments(store, ext["document_id"]))
    _ok(record_run(store, ext, problems), f"extraction run {ext['document_id']}")
    return problems


def _ok(res: Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"{what}: {res.outcome} {res.message}")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def term_id(purchase_id: str, code: str) -> str:
    return f"term_{purchase_id.removeprefix('pur_')}_{code}"


def change_request_id(ref: str) -> str:
    return f"cr_{ref}"


# ---------------------------------------------------------------- recording (deterministic linking)


def _named(store: Store, table: str, name: Any) -> dict[str, Any] | None:
    return next((r for r in store.rows(table) if r["name"].lower() == str(name).lower()), None)


def purchase_id_for(store: Store, quote: dict[str, Any], po: dict[str, Any]) -> str:
    """pur_<supplier>_<project>, or with the PO number appended if that id is taken by another PO."""
    q, p = values(quote), values(po)
    supplier, project = _named(store, "supplier", q["supplier_name"]), _named(store, "project", q["project_name"])
    if supplier is None or project is None:
        raise ValueError("quote names a supplier or project that isn't on file")
    base = f"pur_{supplier['id'].removeprefix('sup_')}_{project['id'].removeprefix('prj_')}"
    taken = one(store, "purchase", id=base)
    return base if taken is None or taken["po_number"] == p["po_number"] else f"{base}_{_slug(str(p['po_number']))}"


def record_purchase(store: Store, quote: dict[str, Any], po: dict[str, Any], purchase_id: str) -> str:
    """Purchase + quote terms. Terms are accepted only if the buyer accepted the quote and the
    supplier acknowledged a PO that incorporates it; otherwise the purchase needs contract review."""
    for ext in (quote, po):
        problems = validated(store, ext)
        if problems:
            raise ValueError(f"{ext['document_id']}: evidence problems: {problems}")
    q, p = values(quote), values(po)
    supplier, project = _named(store, "supplier", q["supplier_name"]), _named(store, "project", q["project_name"])
    if supplier is None or project is None:
        raise ValueError("quote names a supplier or project that isn't on file")
    agreed = bool(q.get("buyer_accepted_on")) and bool(p.get("supplier_acknowledged_on")) and \
        p.get("incorporates_quote") == q.get("quote_number")
    _ok(R.upsert_purchase(store, "agent", purchase_id, supplier["id"], project["id"], str(q["product"]), str(q["unit"]),
                          str(p["po_number"]), quote["document_id"], po["document_id"], "open" if agreed else "contract_review"),
        "purchase")
    for t in quote["terms"]:
        _ok(R.record_term(store, "agent", term_id(purchase_id, t["code"]), purchase_id, t["code"], t["label"],
                          t["amount_cents"], t["quantity_milli"], t["quote"], t.get("scope", {}), t["effective_from"],
                          t["effective_to"], "accepted" if agreed else "proposed", t["fragments"], 1), f"term {t['code']}")
    return purchase_id


def record_email_extraction(store: Store, ext: dict[str, Any], purchase_id: str) -> list[dict[str, Any]]:
    """Proposed changes and supplier acceptances. Claims of internal approval are returned, never recorded:
    only a decision made in the app by an authorized person counts."""
    problems = validated(store, ext)
    if problems:
        raise ValueError(f"{ext['document_id']}: evidence problems: {problems}")
    msg = one(store, "email_message", document_id=ext["document_id"]) or {}
    proposed_here = {change_request_id(cr["ref"]) for cr in ext.get("change_requests", [])}
    for acc in ext.get("acceptances", []):
        cr_id = change_request_id(acc["ref"])
        if cr_id not in proposed_here and one(store, "change_request", id=cr_id) is None:
            raise NotYet(f"{cr_id} isn't on file yet: the email proposing it hasn't been read")
    for cr in ext.get("change_requests", []):
        _ok(R.propose_change_request(store, "agent", change_request_id(cr["ref"]), purchase_id, cr["kind"], cr["description"],
                                     cr["amount_cents"], cr["rate_cents"], cr["rate_unit"], cr.get("scope", {}),
                                     cr.get("effective_from", ""), msg.get("original_sent_at_iso", ""),
                                     msg.get("ingested_at_iso", ""), cr["classification"], cr["supplier_acceptance"],
                                     cr["fragments"]), f"change request {cr['ref']}")
    for acc in ext.get("acceptances", []):
        _ok(R.record_supplier_acceptance(store, "agent", change_request_id(acc["ref"]), acc["supplier_acceptance"],
                                         acc["fragments"]), f"acceptance {acc['ref']}")
    return list(ext.get("internal_approval_claims", []))


def record_invoice_extraction(store: Store, ext: dict[str, Any], purchase_id: str) -> tuple[str, str]:
    """Invoice, revision and lines. A document replaces an earlier revision only when identity is
    established: same supplier and number, and an evidenced statement that it supersedes it.
    Same number without that statement = a separate invoice, which the duplicate check flags."""
    problems = validated(store, ext)
    if problems:
        raise ValueError(f"{ext['document_id']}: evidence problems: {problems}")
    v = values(ext)
    purchase = one(store, "purchase", id=purchase_id)
    assert purchase is not None
    named = {change_request_id(l["links"]["change_request_ref"]) for l in ext["lines"] if l.get("links", {}).get("change_request_ref")}
    missing = sorted(cr for cr in named if one(store, "change_request", id=cr) is None)
    if missing:  # a line names a change we haven't read yet; a line naming none is recorded unlinked (a surprise charge)
        raise NotYet(f"invoice lines name {', '.join(missing)}, not on file yet")
    number = str(v["invoice_number"])
    already = one(store, "invoice_revision", document_id=ext["document_id"])
    if already is not None:  # this very document was recorded before (a retried job): same ids, lines topped up below
        invoice_id, revision_id = already["invoice_id"], already["id"]
    else:
        invoice_id = f"inv_{_slug(number)}"
        existing = one(store, "invoice", id=invoice_id)
        supersedes = v.get("supersedes") or {}
        revision_no, supersedes_rev = 1, ""
        if existing is not None and existing["supplier_id"] == purchase["supplier_id"] and supersedes.get("invoice_number") == number:
            prior = one(store, "invoice_revision", id=existing["active_revision_id"])
            assert prior is not None
            revision_no, supersedes_rev = int(v.get("revision") or prior["revision"] + 1), prior["id"]
        elif existing is not None:
            invoice_id = f"inv_{_slug(number)}_{sha8(ext['document_id'])}"
        if not supersedes_rev:
            _ok(R.record_invoice(store, "agent", invoice_id, purchase["supplier_id"], purchase_id, number, str(v["invoice_date"]),
                                 str(v.get("due_date") or ""), str(v.get("currency") or "USD")), "invoice")
        revision_id = f"rev_{invoice_id.removeprefix('inv_')}_r{revision_no}"
        _ok(R.record_invoice_revision(store, "agent", revision_id, invoice_id, revision_no, ext["document_id"],
                                      int(v["gross_cents"]), int(v.get("deposit_shown_cents") or 0),
                                      int(v["balance_requested_cents"]), supersedes_rev), "revision")
    for i, line in enumerate(ext["lines"], start=1):
        links = line.get("links", {})
        term = term_id(purchase_id, links["term_code"]) if links.get("term_code") else ""
        cr = change_request_id(links["change_request_ref"]) if links.get("change_request_ref") else ""
        _ok(R.record_invoice_line(store, "agent", f"ln_{revision_id.removeprefix('rev_')}_{i}", revision_id, line["kind"],
                                  line["description"], line["quantity_milli"], line["unit"], line["unit_price_cents"],
                                  line["amount_cents"], term, cr, line["fragments"]), f"line {i}")
    return invoice_id, revision_id
