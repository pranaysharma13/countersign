"""Score an extraction against the answer key's labelled fields (SPEC §9: extraction accuracy, measured).

Reads the answer key, so it lives apart from extraction and assessment and is only used by tests,
scripts/check_extraction.py and the scorecard.
"""

from __future__ import annotations

from typing import Any

from .extractions import values

LINE_KEYS = ("kind", "quantity_milli", "unit", "unit_price_cents", "amount_cents")


def _terms(ext: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {t["code"]: t for t in ext.get("terms", [])}


def actual_labels(doc_id: str, ext: dict[str, Any]) -> dict[str, Any]:
    """What the extraction says, in the answer key's terms for this document."""
    v = values(ext) if "fields" in ext else {}
    kind = ext.get("document_kind")
    if kind == "quote":
        t = _terms(ext)
        validity = t.get("valid_through") or t.get("unit_price") or {}
        return {"quote_number": v.get("quote_number"), "unit": v.get("unit"),
                "unit_price_cents": (t.get("unit_price") or {}).get("amount_cents"),
                "max_quantity_milli": (t.get("max_quantity") or {}).get("quantity_milli"),
                "valid_from": validity.get("effective_from") or (t.get("unit_price") or {}).get("effective_from"),
                "valid_through": validity.get("effective_to") or (t.get("unit_price") or {}).get("effective_to"),
                "deposit_cents": (t.get("deposit") or {}).get("amount_cents"),
                "has_price_change_rule": "price_change_rule" in t, "has_fuel_surcharge_rule": "fuel_surcharge_rule" in t}
    if kind == "po":
        return {k: v.get(k) for k in ("po_number", "not_to_exceed_cents", "incorporates_quote", "supplier_acknowledged_on")}
    if kind == "invoice":
        sup = v.get("supersedes") or {}
        return {"invoice_number": v.get("invoice_number"), "invoice_date": v.get("invoice_date"), "po_number": v.get("po_number"),
                "gross_cents": v.get("gross_cents"), "deposit_shown_cents": v.get("deposit_shown_cents"),
                "balance_requested_cents": v.get("balance_requested_cents"), "supersedes": sup.get("invoice_number"),
                "lines": [{k: l.get(k) for k in LINE_KEYS} for l in ext.get("lines", [])]}
    if kind == "email":
        withdrawn = any(a["supplier_acceptance"] == "declined" and "wait" in a["ref"] for a in ext.get("acceptances", []))
        return {"waiting_charge": "withdrawn" if withdrawn else None}
    return {}


def score(doc_id: str, ext: dict[str, Any], labels: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per labelled field this extraction can be judged on."""
    got = actual_labels(doc_id, ext)
    return [{"field": k, "expected": want, "actual": got.get(k), "correct": got.get(k) == want}
            for k, want in labels.items() if k in got]
