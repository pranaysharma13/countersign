"""SPEC §8 scoped amendment: a valid $172 price for a later subset of deliveries. Countersign applies it to
that scope, or authorises only the quoted price and asks for allocation evidence. It never applies a
date-scoped price to deliveries outside the scope."""

import dataclasses
import json

import pytest

from countersign import intake, worker
from countersign import reducers as R
from countersign.commercial import assess, bundle_from_store, period_fit
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, PO, PURCHASE_ID, QUOTE, REV1_ID, SCOPED_DATE_1,
                                        SCOPED_QTY_1, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)
from countersign.variant_fixtures import VARIANT_FIXTURE_DIR, all_variant_fixtures

QTY_CR, DATE_CR = "cr_baymix_hemix_final120", "cr_baymix_hemix_from_oct19"
MATERIAL = "ln_bm23104_r1_1"


def receive(s, doc, files):
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


def opening(files, email, approve=True):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1, email):
        receive(s, doc, files)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    cr = QTY_CR if email is SCOPED_QTY_1 else DATE_CR
    if approve:
        assert R.decide_change_request(s, "owner", cr, True, "High-early mix for the late pours").ok
    receive(s, INVOICE_R1, files)
    return s


def latest(s):
    return max(s.rows("assessment", revision_id=REV1_ID), key=lambda a: a["version"])


def line(s, line_id=MATERIAL):
    return next(l for l in json.loads(latest(s)["details_json"])["lines"] if l["line_id"] == line_id)


def open_holds(s):
    return {h["code"]: h["amount_cents"] for h in s.rows("hold", revision_id=REV1_ID, status="open")}


def test_the_variant_fixtures_are_current():
    for doc_id, ext in all_variant_fixtures().items():
        assert json.loads((VARIANT_FIXTURE_DIR / f"{doc_id}.json").read_text()) == ext, \
            "stale variant fixture: run `uv run --project core python scripts/export_supplier_seed.py`"


def test_a_quantity_scoped_price_applies_to_its_120_cy_only(tmp_path):
    s = opening(tmp_path, SCOPED_QTY_1)
    cr = s.rows("change_request", id=QTY_CR)[0]
    assert (cr["kind"], cr["rate_cents"], json.loads(cr["scope_json"])["quantity_milli"]) == ("price_change", 17_200, 120_000)
    m = line(s)
    assert (m["accepted_cents"], m["variance_cents"], m["hold_code"]) == (8_334_000, 266_000, "PRICE_VARIANCE")  # 120x172 + 380x165
    assert "120 cy x $172.00" in m["calculation"] and "380 cy x $165.00" in m["calculation"]
    assert open_holds(s)["PRICE_VARIANCE"] == 266_000  # not $3,500: the agreed part of the price change counts


def test_purchasing_cant_approve_the_price_change_above_its_limit(tmp_path):
    s = opening(tmp_path, SCOPED_QTY_1, approve=False)
    res = R.decide_change_request(s, "purchasing", QTY_CR, True, "ok")
    assert res.outcome == "denied" and "$20,640.00" in res.message  # $172 x 120 cy against a $2,000 limit


def test_a_date_scoped_price_waits_for_allocation_evidence(tmp_path):
    s = opening(tmp_path, SCOPED_DATE_1)
    m = line(s)
    assert (m["accepted_cents"], m["pending_cents"], m["variance_cents"], m["hold_code"]) == \
        (8_250_000, 350_000, 0, "USAGE_EVIDENCE_MISSING")  # never a silent $172 on the Oct 5-18 pours
    assert "2026-10-19" in m["uncertainty"] and "2026-10-05 to 2026-10-22" in m["uncertainty"]
    holds = open_holds(s)
    assert holds["USAGE_EVIDENCE_MISSING"] == 350_000 and "PRICE_VARIANCE" not in holds
    a = latest(s)
    assert (a["commercial_status"], a["proposed_payment_cents"]) == ("differences_under_review", 0)
    assert json.loads(a["details_json"])["inputs"]["delivery_period"] == {"from": "2026-10-05", "to": "2026-10-22"}
    body = next(o for o in s.rows("outbox") if o["invoice_id"] == INVOICE_ID)["body"]
    assert "delivery tickets" in body and "cr_" not in body  # the supplier sees the ask, not our ids


def test_the_owner_can_accept_it_once_the_tickets_check_out(tmp_path):
    s = opening(tmp_path, SCOPED_DATE_1)
    assert R.decide_disputed_line(s, "owner", "dec_hemix", MATERIAL, "accept_as_billed", 350_000, latest(s)["fingerprint"],
                                  "", "Delivery tickets checked: the billed yards match the scope").ok
    assert s.rows("hold", id=hold_id(REV1_ID, "USAGE_EVIDENCE_MISSING"))[0]["status"] == "resolved"
    worker.drain(s)
    assert (line(s)["accepted_cents"], line(s)["hold_code"]) == (8_600_000, "")


@pytest.mark.parametrize(("period", "accepted", "pending", "variance"), [
    ({"from": "2026-10-19", "to": "2026-10-22"}, 8_600_000, 0, 0),  # every delivery inside the scope: $172 applies
    ({"from": "2026-10-05", "to": "2026-10-18"}, 8_250_000, 0, 350_000),  # none inside: the quoted price, a variance
    (None, 8_250_000, 350_000, 0),  # the invoice states no dates: evidence, never a guess
])
def test_the_delivery_period_decides_how_a_date_scope_applies(tmp_path, period, accepted, pending, variance):
    b = bundle_from_store(opening(tmp_path, SCOPED_DATE_1), INVOICE_ID)
    m = next(l for l in assess(dataclasses.replace(b, delivery_period=period)).lines if l.line_id == MATERIAL)
    assert (m.accepted_cents, m.pending_cents, m.variance_cents) == (accepted, pending, variance)


def test_an_unapproved_amendment_changes_nothing(tmp_path):
    m = line(opening(tmp_path, SCOPED_DATE_1, approve=False))
    assert (m["accepted_cents"], m["variance_cents"], m["hold_code"]) == (8_250_000, 350_000, "PRICE_VARIANCE")


def test_period_fit():
    deliveries = {"from": "2026-10-05", "to": "2026-10-22"}
    assert period_fit(deliveries, {}) == "all" and period_fit(deliveries, {"quantity_milli": 1000}) == "all"
    assert period_fit(deliveries, {"from": "2026-10-01"}) == "all" and period_fit(deliveries, {"to": "2026-10-04"}) == "none"
    assert period_fit(deliveries, {"from": "2026-10-19"}) == "partial" and period_fit(deliveries, {"delivery_refs": ["T-1"]}) == "partial"
    assert period_fit(None, {"from": "2026-10-19"}) == "partial"
