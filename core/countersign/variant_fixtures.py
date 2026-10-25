"""Labelled fixture extractions for the BayMix variant emails (SPEC §8 scoped amendment). Built from the
document fragments so line numbers can't drift; written to data/fixtures/baymix_variants/extractions/ by
scripts/export_supplier_seed.py. Model input only; the expected numbers live in the tests.
"""

from __future__ import annotations

import json
from typing import Any

from .companion_fixtures import _one, _wrap
from .config import DATA_DIR
from .supplier_world import SCOPED_DATE_1, SCOPED_QTY_1, SourceDoc

VARIANT_FIXTURE_DIR = DATA_DIR / "fixtures" / "baymix_variants" / "extractions"
HEMIX = "High-early mix BM-40-34-HE"


def _price_change(doc: SourceDoc, ref: str, description: str, price_needle: str, scope: dict[str, Any],
                  agree_needle: str) -> dict[str, Any]:
    price, agree = _one(doc, price_needle), _one(doc, agree_needle)
    return _wrap(doc.id, "email", fields={}, change_requests=[{
        "ref": ref, "kind": "price_change", "description": description, "amount_cents": 0, "rate_cents": 17_200,
        "rate_unit": "cy", "scope": scope, "effective_from": "2026-10-19", "classification": "PROPOSED",
        "supplier_acceptance": "proposed", "quote": price.text, "fragments": [price.id]}],
        acceptances=[{"ref": ref, "supplier_acceptance": "accepted", "quote": agree.text, "fragments": [agree.id]}],
        internal_approval_claims=[], payee_change_requests=[])


def scoped_qty() -> dict[str, Any]:
    return _price_change(SCOPED_QTY_1, "baymix_hemix_final120", f"{HEMIX} at $172.00/cy for the final 120 cy, pours from Oct 19",
                         "for the final 120 cy only", {"quantity_milli": 120_000, "unit": "cy", "from": "2026-10-19"},
                         "BayMix agrees to these terms")


def scoped_date() -> dict[str, Any]:
    return _price_change(SCOPED_DATE_1, "baymix_hemix_from_oct19", f"{HEMIX} at $172.00/cy for pours from Oct 19",
                         "Price for those pours", {"unit": "cy", "from": "2026-10-19"}, "BayMix agrees to this price")


def all_variant_fixtures() -> dict[str, dict[str, Any]]:
    return {SCOPED_QTY_1.id: scoped_qty(), SCOPED_DATE_1.id: scoped_date()}


def write_variant_fixtures() -> None:
    VARIANT_FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for doc_id, ext in all_variant_fixtures().items():
        (VARIANT_FIXTURE_DIR / f"{doc_id}.json").write_bytes((json.dumps(ext, indent=2) + "\n").encode())
