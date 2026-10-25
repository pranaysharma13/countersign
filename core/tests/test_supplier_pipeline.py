"""Step B end to end: intake -> process_document jobs -> records, assessment, holds, clarification -> reply,
correction, receipt -> automatic reassessment. Plus restarts, retries and the paths that go to review."""

import copy
import json

import pytest

from countersign import commercial, extractions, intake, supplier_pipeline, worker
from countersign import reducers as R
from countersign.config import DATA_DIR
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, REPLY_1,
                                        REV1_ID, REV2_ID, WAITING_1, WAITING_CR_ID, WEEKEND_1, WEEKEND_2, WEEKEND_3,
                                        WEEKEND_CR_ID)

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())


def receive(store, doc, files_dir):
    return intake.ingest(store, doc.filename, file_bytes(doc), files_dir=files_dir)


def latest(store, revision_id):
    return max(store.rows("assessment", revision_id=revision_id), key=lambda a: a["version"])


@pytest.fixture()
def opening(tmp_path):
    """Documents arrive in date order; people act in the app between them."""
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
        worker.drain(s)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour requested by Granite Line").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    receive(s, INVOICE_R1, tmp_path)
    worker.drain(s)
    return s


def test_intake_and_worker_reach_the_exact_opening_state(opening):
    s = opening
    assert s.rows("purchase", id=PURCHASE_ID)[0]["status"] == "open"
    assert {j["status"] for j in s.rows("job", kind="process_document")} == {"done"}
    a1, r1 = latest(s, REV1_ID), KEY["revision_1"]
    assert (a1["claimed_cents"], a1["authorised_cents"], a1["variance_cents"], a1["pending_cents"]) == \
        (8_742_500, 8_370_000, 350_000, 22_500)
    assert s.rows("invoice_revision", id=REV1_ID)[0]["balance_requested_cents"] == 7_742_500
    assert a1["deposit_available_cents"] == 1_000_000 and a1["proposed_payment_cents"] == 0
    assert {h["code"]: h["amount_cents"] for h in s.rows("hold", revision_id=REV1_ID, status="open")} == r1["holds"]
    ob = s.rows("outbox", id=KEY["clarification"]["outbox_id"])[0]
    assert (ob["status"], ob["simulated"], ob["subject"]) == ("draft", True, KEY["clarification"]["subject"])
    assert {r["mode"] for r in s.rows("extraction_run")} == {"fixture"}
    assert s.rows("change_request", id=WEEKEND_CR_ID)[0]["classification"] == "AUTHORISED_FIXED"
    steps = s.rows("agent_step", work_item_id=f"wi_{INVOICE_ID}")
    assert any("Drafted a clarification" in st["title"] for st in steps) and any("$3,725.00 under review" in st["title"] for st in steps)
    weekend_2 = next(j for j in s.rows("job", kind="process_document") if WEEKEND_2.id in j["payload_json"])
    assert json.loads(weekend_2["result_json"])["ignored_approval_claims"] == 1  # "I've approved it" is not an approval


def test_reply_correction_and_receipt_flow_through_the_worker(opening, tmp_path):
    s = opening
    ob = KEY["clarification"]["outbox_id"]
    assert R.approve_outbox(s, "purchasing", ob).ok
    worker.drain(s)
    sent = s.rows("outbox", id=ob)[0]
    assert (sent["status"], sent["delivery_ref"]) == ("sent", f"simulated-{ob}")

    receive(s, REPLY_1, tmp_path)
    worker.drain(s)
    assert s.rows("change_request", id=WAITING_CR_ID)[0]["classification"] == "DECLINED"
    assert latest(s, REV1_ID)["version"] == 2  # the reply changed an input, so revision 1 was reassessed

    receive(s, INVOICE_R2, tmp_path)
    worker.drain(s)
    a2 = latest(s, REV2_ID)
    assert (a2["claimed_cents"], a2["proposed_payment_cents"], a2["commercial_status"]) == (8_370_000, 7_370_000, "matches")
    assert [h["code"] for h in s.rows("hold", revision_id=REV2_ID, status="open")] == ["RECEIPT_NOT_VERIFIED"]

    assert R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
    worker.drain(s)  # no job for this: the sweep notices the attestation changed the inputs
    a3 = latest(s, REV2_ID)
    assert a3["version"] == 2 and a3["proposed_payment_cents"] == 7_370_000
    assert s.rows("hold", revision_id=REV2_ID, status="open") == []
    inv = s.rows("invoice", id=INVOICE_ID)[0]
    assert (inv["commercial_status"], inv["receipt_status"], inv["next_owner_role"]) == ("matches", "manually_confirmed", "owner")
    worker.drain(s)
    assert latest(s, REV2_ID)["version"] == 2  # nothing changed, nothing re-recorded


def test_receiving_the_same_file_twice_changes_nothing(opening, tmp_path):
    s = opening
    before = {t: len(s.rows(t)) for t in ("document", "source_fragment", "job", "invoice", "invoice_revision", "invoice_line", "hold")}
    assert receive(s, INVOICE_R1, tmp_path) == INVOICE_R1.id
    worker.drain(s)
    assert {t: len(s.rows(t)) for t in before} == before


def test_a_file_without_a_labelled_extraction_goes_to_review(tmp_path):
    s = FakeStore()
    seed_setup(s)
    pdf = bytearray(file_bytes(INVOICE_R1))
    pdf = bytes(pdf.replace(b"BM-23104", b"BM-99999"))  # different bytes: no fixture for it
    doc_id = intake.ingest(s, "scan.pdf", pdf, files_dir=tmp_path)
    assert doc_id.startswith("doc_") and s.rows("source_fragment", document_id=doc_id)  # cut into line fragments
    worker.drain(s)
    assert s.rows("document", id=doc_id)[0]["status"] == "needs_review"
    assert json.loads(s.rows("job", id=intake.job_id(doc_id))[0]["result_json"])["status"] == "needs_review"
    assert s.rows("invoice") == []  # nothing guessed, nothing payable


def test_bad_evidence_records_nothing(tmp_path, monkeypatch):
    s = FakeStore()
    seed_setup(s)
    real = extractions.find_fixture

    def tampered(document_id, *a):
        ext = copy.deepcopy(real(document_id, *a))
        if ext and ext["document_kind"] == "quote":
            ext["terms"][0]["amount_cents"] = 17_200  # "$172.00" isn't what the quote says
        return ext

    monkeypatch.setattr(supplier_pipeline, "find_fixture", tampered)
    receive(s, QUOTE, tmp_path)
    worker.drain(s)
    assert s.rows("document", id=QUOTE.id)[0]["status"] == "needs_review"
    assert s.rows("term") == [] and s.rows("purchase") == []


def test_a_crash_midway_is_retried_without_duplicates(tmp_path, monkeypatch):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
        worker.drain(s)
    real_record, calls = commercial.record, []

    def crash_once(store, a, role="agent"):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError("store went away mid-job")
        return real_record(store, a, role)

    monkeypatch.setattr(supplier_pipeline, "record", crash_once)
    receive(s, INVOICE_R1, tmp_path)
    worker.drain(s)
    job = s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]
    assert job["status"] == "queued" and job["attempts"] == 1
    s.advance(10)
    worker.drain(s)
    assert s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]["status"] == "done"
    assert len(s.rows("invoice")) == 1 and len(s.rows("invoice_revision")) == 1 and len(s.rows("invoice_line")) == 3
    assert len(s.rows("assessment", revision_id=REV1_ID)) == 1
    codes = [h["code"] for h in s.rows("hold", revision_id=REV1_ID)]
    assert len(codes) == len(set(codes))  # one hold per code, however many attempts
    assert "CONTRACT_REVIEW" in codes  # no deposit was recorded in this test, yet the invoice deducts one


def test_out_of_retries_puts_the_invoice_in_front_of_a_person(tmp_path, monkeypatch):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
        worker.drain(s)

    def always_down(store, a, role="agent"):
        raise ConnectionError("assessment store unreachable")

    monkeypatch.setattr(supplier_pipeline, "record", always_down)
    monkeypatch.setattr(supplier_pipeline, "reassess_stale", lambda store: [])
    receive(s, INVOICE_R1, tmp_path)
    for wait in (0, 10, 20):
        s.advance(wait)
        worker.drain(s)
    job = s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]
    assert (job["status"], job["attempts"]) == ("failed", 3)
    assert s.rows("document", id=INVOICE_R1.id)[0]["status"] == "needs_review"
    review = s.rows("hold", id=hold_id(REV1_ID, "EXTRACTION_REVIEW"))[0]
    assert review["status"] == "open" and "assessment store unreachable" in review["reason"]


def test_an_email_before_its_purchase_waits_and_retries(tmp_path):
    s = FakeStore()
    seed_setup(s)
    receive(s, WEEKEND_1, tmp_path)
    worker.drain(s)
    job = s.rows("job", id=intake.job_id(WEEKEND_1.id))[0]
    assert job["status"] == "queued" and "no purchase on file yet" in job["error"]
    for doc in (QUOTE, PO):
        receive(s, doc, tmp_path)
        worker.drain(s)
    s.advance(10)
    worker.drain(s)
    assert s.rows("job", id=intake.job_id(WEEKEND_1.id))[0]["status"] == "done"
    assert s.rows("change_request", id=WEEKEND_CR_ID)


def run_out_of_retries(s):
    for wait in (0, 10, 20):
        s.advance(wait)
        worker.drain(s)


def test_an_invoice_before_its_po_waits_then_links(tmp_path):
    s = FakeStore()
    seed_setup(s)
    receive(s, INVOICE_R1, tmp_path)
    worker.drain(s)
    job = s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]
    assert job["status"] == "queued" and "no purchase with PO number MF-PO-1031" in job["error"]
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
        worker.drain(s)
    s.advance(10)
    worker.drain(s)
    assert s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]["status"] == "done"
    assert s.rows("invoice", id=INVOICE_ID)


@pytest.mark.parametrize("doc", [INVOICE_R1, WEEKEND_1], ids=["invoice", "email"])
def test_out_of_retries_leaves_any_document_visibly_needing_review(doc, tmp_path):
    s = FakeStore()
    seed_setup(s)
    receive(s, doc, tmp_path)  # its purchase never arrives
    run_out_of_retries(s)
    assert s.rows("job", id=intake.job_id(doc.id))[0]["status"] == "failed"
    assert s.rows("document", id=doc.id)[0]["status"] == "needs_review"
    review = max(s.rows("extraction_run", document_id=doc.id, status="invalid"), key=lambda r: r["id"])
    assert "gave up after retries" in review["error"] and "NotYet" in review["error"]


def test_an_acceptance_before_its_proposal_waits(tmp_path):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_3):  # BayMix's confirmation is read before its proposal
        receive(s, doc, tmp_path)
        worker.drain(s)
    job = s.rows("job", id=intake.job_id(WEEKEND_3.id))[0]
    assert job["status"] == "queued" and f"{WEEKEND_CR_ID} isn't on file yet" in job["error"]
    receive(s, WEEKEND_1, tmp_path)
    worker.drain(s)
    s.advance(10)
    worker.drain(s)
    assert s.rows("change_request", id=WEEKEND_CR_ID)[0]["supplier_acceptance"] == "accepted"


def test_an_email_with_two_open_purchases_needs_review(tmp_path):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO):
        receive(s, doc, tmp_path)
        worker.drain(s)
    assert R.upsert_purchase(s, "sync", "pur_baymix_other", BAYMIX.id, "prj_oak", "Grout", "cy", "MF-PO-2000", "", "").ok
    receive(s, WEEKEND_1, tmp_path)
    worker.drain(s)
    assert s.rows("document", id=WEEKEND_1.id)[0]["status"] == "needs_review"
    assert s.rows("change_request") == []  # never linked by guesswork


def test_a_line_naming_an_unread_change_waits_but_a_surprise_charge_is_recorded(tmp_path, monkeypatch):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_3):  # the waiting-charge email hasn't been read yet
        receive(s, doc, tmp_path)
        worker.drain(s)
    receive(s, INVOICE_R1, tmp_path)
    worker.drain(s)
    assert "cr_baymix_waiting" in s.rows("job", id=intake.job_id(INVOICE_R1.id))[0]["error"]
    receive(s, WAITING_1, tmp_path)
    worker.drain(s)
    s.advance(10)
    worker.drain(s)
    waiting_line = next(l for l in s.rows("invoice_line", revision_id=REV1_ID) if l["kind"] == "waiting")
    assert waiting_line["linked_change_request_id"] == WAITING_CR_ID

    # A charge the extraction links to no change at all is a surprise charge: recorded unlinked, disputed.
    s2 = FakeStore()
    seed_setup(s2)
    real = extractions.find_fixture

    def no_link(document_id, *a):
        ext = copy.deepcopy(real(document_id, *a))
        if ext and ext["document_kind"] == "invoice":
            ext["lines"][2]["links"] = {}
        return ext

    monkeypatch.setattr(supplier_pipeline, "find_fixture", no_link)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_3, INVOICE_R1):
        receive(s2, doc, tmp_path)
        worker.drain(s2)
    waiting_line = next(l for l in s2.rows("invoice_line", revision_id=REV1_ID) if l["kind"] == "waiting")
    assert waiting_line["linked_change_request_id"] == ""
    assert "PROPOSED_CHARGE" in {h["code"] for h in s2.rows("hold", revision_id=REV1_ID)}
