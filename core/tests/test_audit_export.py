"""Audit export (SPEC step E): every recorded event about one invoice, oldest first, denials included,
with tokens masked; JSON and CSV agree; another invoice's events never leak in."""

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from countersign import api, audit_export, intake, worker
from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.companion_seed import record_cedar, seed_companion_parties
from countersign.companion_world import CEDAR, CEDAR_INVOICE_ID
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.integrations import nessie
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, PAYEE_V1, PO, PURCHASE_ID, QUOTE, REV1_ID,
                                        WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

WI = f"wi_{INVOICE_ID}"


def receive(s, doc, files):
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


def latest_fp(s):
    return max(s.rows("assessment", revision_id=REV1_ID), key=lambda a: a["version"])["fingerprint"]


@pytest.fixture()
def settled(tmp_path):
    """BayMix won't correct: both disputed lines decided, notices sent, receipt attested, $73,700 paid
    (simulated). Cedar & Bolt's invoice sits in the same store."""
    nessie.set_client(nessie.MockNessie())
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    assert L.post(s, "sync", L.deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)).ok
    receive(s, INVOICE_R1, tmp_path)
    assert R.resolve_hold(s, "owner", hold_id(REV1_ID, "PRICE_VARIANCE"), "fine by me").outcome == "denied"
    for line, amount in (("ln_bm23104_r1_1", 350_000), ("ln_bm23104_r1_3", 22_500)):
        assert R.decide_disputed_line(s, "owner", f"dec_{line[-1]}", line, "pay_agreed_dispute_rest", amount, latest_fp(s),
                                      "ctc_baymix_ar", "BayMix won't correct").ok
        worker.drain(s)
    for d in s.rows("settlement_decision"):
        assert R.approve_outbox(s, "owner", d["outbox_id"]).ok
    assert R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
    worker.drain(s)
    p = next(p for p in s.rows("proposal", work_item_id=WI) if p["status"] == "pending")
    assert R.approve_supplier_payment(s, "owner", p["id"], latest_fp(s), "Agreed part").ok
    worker.drain(s)
    seed_companion_parties(s)
    record_cedar(s)
    yield s
    nessie.set_client(None)


def first(events, action, outcome="ok", entity_type=None, prefix=""):
    return next(i for i, e in enumerate(events) if e["action"] == action and e["outcome"] == outcome
                and (entity_type is None or e["entity_type"] == entity_type) and e["entity_id"].startswith(prefix))


def test_the_export_tells_the_whole_story_in_order(settled):
    x = audit_export.invoice_audit(settled, INVOICE_ID)
    ev = x["events"]
    assert x["invoice"]["payment_status"] == "partially_settled" and x["invoice"]["commercial_status"] == "partially_disputed"
    assert [e["id"] for e in ev] == sorted(e["id"] for e in ev)  # oldest first
    order = [first(ev, "record_extraction_run", entity_type="extraction_run"), first(ev, "record_assessment"),
             first(ev, "resolve_hold", "denied"), first(ev, "decide_disputed_line", entity_type="settlement_decision"),
             first(ev, "attest_receipt", entity_type="receipt_attestation"), first(ev, "mark_outbox"),
             first(ev, "approve_supplier_payment", entity_type="payment_approval"), first(ev, "start_payment"),
             first(ev, "record_payment", entity_type="payment"), first(ev, "post_journal", prefix="jrnl_bill_")]
    assert order == sorted(order)
    assert x["denied"] >= 1 and ev[first(ev, "resolve_hold", "denied")]["entity_id"] == hold_id(REV1_ID, "PRICE_VARIANCE")
    assert {e["entity_type"] for e in ev} >= {"invoice", "invoice_revision", "invoice_line", "hold", "assessment", "outbox",
                                             "settlement_decision", "proposal", "payment_approval", "payment", "journal",
                                             "document", "change_request", "term", "payee_profile", "job"}
    assert [p["amount_cents"] for p in x["payments"]] == [7_370_000] and x["payments"][0]["simulated"] is True
    assert x["ledger"]["balances"][L.AP] == 0 and x["ledger"]["balances"][L.material_cost("prj_oak")] == 8_370_000
    assert {d["decision"] for d in x["settlement_decisions"]} == {"pay_agreed_dispute_rest"}
    assert {r["mode"] for r in x["extraction_runs"]} == {"fixture"}
    assert x["latest_assessment"]["proposed_payment_cents"] == 7_370_000
    assert any("Paid $73,700.00" in t["title"] for t in x["timeline"])
    assert any("not cryptographically tamper-evident" in n for n in x["notes"])


def test_account_tokens_are_masked(settled):
    text = json.dumps(audit_export.invoice_audit(settled, INVOICE_ID), ensure_ascii=False)
    assert PAYEE_V1.account_ref not in text and f"…{PAYEE_V1.account_ref[-4:]}" in text


def test_another_invoices_events_never_leak_in(settled):
    bm = audit_export.invoice_audit(settled, INVOICE_ID)
    cb = audit_export.invoice_audit(settled, CEDAR_INVOICE_ID)
    bm_ids, cb_ids = {e["id"] for e in bm["events"]}, {e["id"] for e in cb["events"]}
    assert bm_ids and cb_ids and not bm_ids & cb_ids
    assert not any(CEDAR.id in e["entity_id"] or "cb8802" in e["entity_id"] for e in bm["events"])
    assert not any("bm23104" in e["entity_id"] or e["entity_id"] == BAYMIX.id for e in cb["events"])


def test_csv_and_json_carry_the_same_events(settled):
    x = audit_export.invoice_audit(settled, INVOICE_ID)
    rows = list(csv.DictReader(io.StringIO(audit_export.to_csv(x))))
    assert [int(r["id"]) for r in rows] == [e["id"] for e in x["events"]]
    assert list(rows[0]) == list(audit_export.CSV_COLUMNS)


def test_cells_a_spreadsheet_would_run_are_neutralised():
    assert audit_export._cell("=HYPERLINK(\"http://x\")") == "'=HYPERLINK(\"http://x\")"
    assert audit_export._cell("-$3,500.00") == "'-$3,500.00" and audit_export._cell("ok") == "ok"


def test_the_route(settled, monkeypatch):
    monkeypatch.setattr(api, "store", settled)
    c = TestClient(api.app)
    r = c.get(f"/invoices/{INVOICE_ID}/audit")
    assert r.status_code == 200 and r.json()["invoice"]["id"] == INVOICE_ID
    r = c.get(f"/invoices/{INVOICE_ID}/audit?format=csv")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert f'filename="audit_{INVOICE_ID}.csv"' in r.headers["content-disposition"]
    assert c.get("/invoices/inv_nope/audit").status_code == 404
    assert c.get(f"/invoices/{INVOICE_ID}/audit?format=xml").status_code == 422
