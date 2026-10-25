"""SPEC §8 bank change: an email asks to pay a new account. Read through the real pipeline, it becomes a
pending payee profile and the module opens PAYEE_CHANGE_PENDING, which holds even after the invoice is
corrected, until the owner verifies or rejects it through a contact already on file."""

import json

import pytest

from countersign import extractions, intake, worker
from countersign import reducers as R
from countersign.companion_seed import seed_companion_parties
from countersign.companion_world import NL_BANK_1, NL_INVOICE, NL_PO, NL_QUOTE, NORTHLINE, NORTHLINE_INVOICE_ID
from countersign.fake_store import FakeStore
from countersign.ids import hold_id, sha256_hex
from countersign.supplier_docs import file_bytes
from countersign.supplier_pipeline import record_payee_changes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, MF_AP, PAYEE_V1, PO, PURCHASE_ID,
                                        QUOTE, REPLY_1, REV1_ID, REV2_ID, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3,
                                        WEEKEND_CR_ID, EmailMeta, SourceDoc)

BANK_LINE = "Please pay invoice BM-23104 into our new Coastline Test Bank account ending 6611."
BAYMIX_BANK = SourceDoc("doc_em_bm_bank_1", "email", "em_bm_bank_1.eml", ((
    "Hello Accounts Payable,", "", BANK_LINE, "Our Quarry Point Bank account ending 2290 will be closed.", "",
    "BayMix Accounts Receivable"),), EmailMeta("em_bm_bank_1", "thr_bm_bank", "ar@baymix-supply.example", MF_AP,
                                               "New remittance account", "2026-10-23T11:00:00-07:00",
                                               "2026-10-23T11:05:00-07:00"))


def receive(s, doc, files):
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


def profiles(s, supplier_id, status):
    return s.rows("payee_profile", supplier_id=supplier_id, status=status)


def doc_job(s, document_id):
    return json.loads(s.rows("job", id=intake.job_id(document_id))[0]["result_json"])


@pytest.mark.parametrize("email_first", [False, True])
def test_northlines_email_opens_the_payee_hold_through_the_pipeline(tmp_path, email_first):
    s = FakeStore()
    seed_setup(s)
    seed_companion_parties(s)
    docs = (NL_BANK_1, NL_QUOTE, NL_PO, NL_INVOICE) if email_first else (NL_QUOTE, NL_PO, NL_INVOICE, NL_BANK_1)
    for doc in docs:
        receive(s, doc, tmp_path)
    pending = profiles(s, NORTHLINE.id, "pending")
    assert [(p["id"], p["last4"], p["requested_via"]) for p in pending] == [("sup_northline:v2", "7703", "email")]
    assert [p["last4"] for p in profiles(s, NORTHLINE.id, "verified")] == ["4188"]  # "4188 is closed" requests nothing
    assert doc_job(s, NL_BANK_1.id)["status"] == "payee_change_pending"
    inv = s.rows("invoice", id=NORTHLINE_INVOICE_ID)[0]
    assert inv["payee_status"] == "change_pending"
    assert s.rows("hold", id=hold_id(inv["active_revision_id"], "PAYEE_CHANGE_PENDING"))[0]["status"] == "open"
    if not email_first:  # the invoice was on file when the email arrived: its timeline says why
        titles = [st["title"] for st in s.rows("agent_step", work_item_id=f"wi_{NORTHLINE_INVOICE_ID}")]
        assert any("asks to be paid into a new account ending 7703" in t for t in titles)
    receive(s, NL_BANK_1, tmp_path)  # the same email again records nothing new
    assert len(profiles(s, NORTHLINE.id, "pending")) == 1


@pytest.fixture()
def baymix_bank_email(tmp_path, monkeypatch):
    """The BayMix variant, received like any unknown email (generic intake), with a labelled fixture for it."""
    data = file_bytes(BAYMIX_BANK)
    base = sha256_hex(data)[:8]
    frag = f"frag_{base}_p0_l3"
    ext = {"document_id": f"doc_{base}", "document_kind": "email", "mode": "fixture", "prompt_version": "fixture-v1",
           "label": "FIXTURE: pre-labelled extraction (AI_MODE=fixture), not a live model call",
           "fields": {}, "change_requests": [], "acceptances": [], "internal_approval_claims": [], "instructions_found": [],
           "payee_change_requests": [{"last4": "6611", "bank_name": "Coastline Test Bank", "quote": BANK_LINE,
                                      "fragments": [frag]}]}
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    (fixtures / f"doc_{base}.json").write_text(json.dumps(ext))
    monkeypatch.setattr(extractions, "FIXTURE_DIRS", (*extractions.FIXTURE_DIRS, fixtures))
    return data


def test_the_hold_survives_the_corrected_invoice_until_the_owner_decides(tmp_path, baymix_bank_email):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    receive(s, INVOICE_R1, tmp_path)
    intake.ingest(s, BAYMIX_BANK.filename, baymix_bank_email, files_dir=tmp_path)
    worker.drain(s)
    assert [p["last4"] for p in profiles(s, BAYMIX.id, "pending")] == ["6611"]
    assert s.rows("hold", id=hold_id(REV1_ID, "PAYEE_CHANGE_PENDING"))[0]["status"] == "open"

    for ob in s.rows("outbox", status="draft"):
        assert R.approve_outbox(s, "purchasing", ob["id"]).ok
    worker.drain(s)
    receive(s, REPLY_1, tmp_path)
    receive(s, INVOICE_R2, tmp_path)  # the correction fixes the price, not the payee question
    assert s.rows("invoice", id=INVOICE_ID)[0]["active_revision_id"] == REV2_ID
    assert s.rows("hold", id=hold_id(REV2_ID, "PAYEE_CHANGE_PENDING"))[0]["status"] == "open"
    assert R.resolve_hold(s, "owner", hold_id(REV2_ID, "PAYEE_CHANGE_PENDING"), "looks fine").outcome == "denied"

    assert R.decide_payee_profile(s, "owner", "sup_baymix:v2", False, "ctc_baymix_ar",
                                  "Called AR on file: they never changed banks").ok
    assert s.rows("hold", id=hold_id(REV2_ID, "PAYEE_CHANGE_PENDING"))[0]["status"] == "resolved"
    assert s.rows("invoice", id=INVOICE_ID)[0]["payee_status"] == "verified"


def test_an_email_naming_only_the_account_on_file_requests_nothing():
    s = FakeStore()
    seed_setup(s)
    ext = {"document_id": "doc_x", "payee_change_requests": [{"last4": PAYEE_V1.last4, "bank_name": PAYEE_V1.bank_name}]}
    assert record_payee_changes(s, ext, BAYMIX.id) == [] and not profiles(s, BAYMIX.id, "pending")
