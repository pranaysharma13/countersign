"""The primary BayMix scenario end to end through the module reference, with the exact values (SPEC §8-9)."""

import copy
import inspect
import json
from dataclasses import replace

import pytest

from countersign import commercial, extractions
from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.commercial import assess, bundle_from_store, ready_to_post_bill, record
from countersign.config import DATA_DIR
from countersign.extractions import (evidence_problems, load_fixture, record_email_extraction, record_invoice_extraction,
                                     record_purchase)
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import fragments
from countersign.supplier_seed import seed_documents, seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PRIMARY_DOCS, PROJECT,
                                        PURCHASE_ID, QUOTE, REV1_ID, REV2_ID, WAITING_1, WAITING_CR_ID, WEEKEND_1,
                                        WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())


def build(purchasing_approves_weekend: bool = True) -> FakeStore:
    """Everything up to and including invoice BM-23104 revision 1, recorded the way intake will record it."""
    s = FakeStore()
    seed_setup(s)
    seed_documents(s)
    record_purchase(s, load_fixture(QUOTE.id), load_fixture(PO.id), PURCHASE_ID)
    for doc in (WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        record_email_extraction(s, load_fixture(doc.id), PURCHASE_ID)
    if purchasing_approves_weekend:  # Oct 8, in the app, by the purchasing approver ($2,000 limit, not the requester)
        assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour requested by Granite Line").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    assert L.post(s, "sync", L.deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)).ok
    assert record_invoice_extraction(s, load_fixture(INVOICE_R1.id), PURCHASE_ID) == (INVOICE_ID, REV1_ID)
    return s


@pytest.fixture()
def store():
    return build()


def line(a, kind):
    return next(r for r in a.lines if r.kind == kind)


def test_fixture_extractions_cite_real_fragments_and_never_read_the_answer_key():
    for doc in PRIMARY_DOCS:
        ext = load_fixture(doc.id)
        own = {f.id: f.text for f in fragments(doc)}
        assert evidence_problems(ext, own) == [], doc.id
        assert ext["mode"] == "fixture" and ext["label"].startswith("FIXTURE")
    for module in (extractions, commercial):
        assert "answer_key" not in inspect.getsource(module)


def test_bad_evidence_is_caught():
    own = {f.id: f.text for f in fragments(QUOTE)}
    ext = load_fixture(QUOTE.id)
    wrong_price = copy.deepcopy(ext)
    wrong_price["terms"][0]["amount_cents"] = 17_200  # "$172.00" isn't in the quoted text
    other_doc = copy.deepcopy(ext)
    other_doc["terms"][0]["fragments"] = ["frag_bm_inv_23104_r1_p1_l11"]  # real fragment, wrong document
    misquoted = copy.deepcopy(ext)
    misquoted["terms"][0]["quote"] = "Unit price: $165.00 per cubic yard, all deliveries in 2027"
    guessed = copy.deepcopy(ext)
    guessed["fields"]["quote_date"] = {"value": None}
    for bad in (wrong_price, other_doc, misquoted, guessed):
        assert evidence_problems(bad, own), bad


def test_extractions_match_the_labelled_fields():
    quote = {t["code"]: t for t in load_fixture(QUOTE.id)["terms"]}
    labels = KEY["labelled_fields"]["doc_bm_quote"]
    assert quote["unit_price"]["amount_cents"] == labels["unit_price_cents"]
    assert quote["max_quantity"]["quantity_milli"] == labels["max_quantity_milli"]
    assert quote["deposit"]["amount_cents"] == labels["deposit_cents"]
    assert quote["valid_through"]["effective_to"] == labels["valid_through"]
    assert {"price_change_rule", "fuel_surcharge_rule"} <= set(quote)
    for doc_id in ("doc_bm_inv_23104_r1", "doc_bm_inv_23104_r2"):
        ext, labels = load_fixture(doc_id), KEY["labelled_fields"][doc_id]
        assert extractions.values(ext)["gross_cents"] == labels["gross_cents"]
        assert [{k: l[k] for k in ("kind", "quantity_milli", "unit", "unit_price_cents", "amount_cents")} for l in ext["lines"]] == labels["lines"]


def test_primary_invoice_exact_values(store):
    a = assess(bundle_from_store(store, INVOICE_ID))
    exp = KEY["revision_1"]
    assert a.claimed_cents == exp["claimed_cents"] == 8_742_500  # $87,425
    assert a.balance_requested_cents == exp["balance_requested_cents"] == 7_742_500  # $77,425
    assert a.variance_cents == exp["variance_cents"] == 350_000  # $3,500
    assert a.pending_cents == exp["pending_cents"] == 22_500  # $225
    assert a.under_review_cents == exp["under_review_cents"] == 372_500  # $3,725
    assert a.authorised_cents == exp["authorised_cents"] == 8_370_000  # $83,700
    assert a.deposit_available_cents == exp["deposit_available_cents"] == 1_000_000  # $10,000
    assert a.conditional_payment_cents == exp["conditional_payment_cents"] == 7_370_000  # $73,700, only if corrected
    assert a.proposed_payment_cents == exp["proposed_payment_cents"] == 0  # never silently pay less
    assert a.claimed_cents == a.authorised_cents + a.variance_cents + a.pending_cents
    assert a.commercial_status == exp["commercial_status"]
    assert a.hold_amounts() == exp["holds"]
    assert {r.kind: r.status for r in a.lines} == exp["lines"]
    assert a.next_owner_role == "purchasing" and "corrected invoice or an agreed credit" in a.next_action
    assert "not savings" in a.summary


def test_weekend_charge_is_kept_and_waiting_stays_pending(store):
    a = assess(bundle_from_store(store, INVOICE_ID))
    weekend, waiting = line(a, "extra"), line(a, "waiting")
    assert (weekend.classification, weekend.accepted_cents, weekend.pending_cents) == ("AUTHORISED_FIXED", 120_000, 0)
    assert (waiting.classification, waiting.pending_cents, waiting.hold_code) == ("PROPOSED", 22_500, "PROPOSED_CHARGE")
    material = line(a, "material")
    assert "$82,500.00" in material.calculation and "$3,500.00" in material.calculation
    assert any("frag_bm_quote_p1_l10" == f for f in material.fragment_ids)
    assert any("waiting" in p.lower() for p in a.clarification_points)
    assert a.clarification_points[-1].startswith("Please send a corrected invoice or an agreed credit memo")
    assert store.rows("change_request", id=WAITING_CR_ID)[0]["internal_status"] == "pending"


def test_an_email_saying_approved_is_not_an_in_app_approval():
    s = build(purchasing_approves_weekend=False)  # Jordan's email says "I've approved it"; nobody decided in the app
    cr = s.rows("change_request", id=WEEKEND_CR_ID)[0]
    assert cr["supplier_acceptance"] == "accepted" and cr["internal_status"] == "pending"
    a = assess(bundle_from_store(s, INVOICE_ID))
    assert line(a, "extra").classification == "PROPOSED"
    assert a.hold_amounts()["PROPOSED_CHARGE"] == 120_000 + 22_500
    assert a.authorised_cents == 8_250_000


def test_corrected_invoice_through_receipt_to_exact_books(store):
    a1 = assess(bundle_from_store(store, INVOICE_ID))
    record(store, a1)
    assert {h["code"] for h in store.rows("hold", revision_id=REV1_ID, status="open")} == set(KEY["revision_1"]["holds"])
    assert not ready_to_post_bill(a1)

    # BayMix agrees to $165 and drops waiting: the corrected invoice supersedes revision 1.
    assert record_invoice_extraction(store, load_fixture(INVOICE_R2.id), PURCHASE_ID) == (INVOICE_ID, REV2_ID)
    assert {h["status"] for h in store.rows("hold", revision_id=REV1_ID)} == {"superseded"}
    a2 = assess(bundle_from_store(store, INVOICE_ID))
    exp = KEY["revision_2"]
    assert a2.claimed_cents == exp["claimed_cents"] == 8_370_000  # $83,700
    assert a2.balance_requested_cents == 7_370_000
    assert (a2.variance_cents, a2.pending_cents, a2.under_review_cents) == (0, 0, 0)
    assert a2.commercial_status == "matches"
    assert a2.proposed_payment_cents == exp["proposed_payment_cents"] == 7_370_000  # $73,700
    assert a2.hold_amounts() == exp["holds_before_receipt"]
    record(store, a2)
    assert [h["code"] for h in store.rows("hold", revision_id=REV2_ID, status="open")] == ["RECEIPT_NOT_VERIFIED"]
    assert not ready_to_post_bill(a2)
    rev1 = store.rows("invoice_revision", id=REV1_ID)[0]  # the original claim is preserved
    assert rev1["gross_cents"] == 8_742_500 and rev1["status"] == "superseded"

    # The superintendent attests 500 cy (manual), and the reassessment is clean.
    assert R.attest_receipt(store, "att_bm_500", INVOICE_ID, "Deliveries 2026-10-05 to 2026-10-22", 500_000, "cy",
                            "On site for every pour; matches the pour log").ok
    assert store.rows("hold", revision_id=REV2_ID, status="open") == []
    a3 = assess(bundle_from_store(store, INVOICE_ID))
    assert a3.hold_amounts() == exp["holds_after_receipt"] and a3.proposed_payment_cents == 7_370_000
    assert a3.fingerprint != a2.fingerprint and ready_to_post_bill(a3)
    record(store, a3)
    inv = store.rows("invoice", id=INVOICE_ID)[0]
    assert (inv["commercial_status"], inv["receipt_status"], inv["payee_status"]) == ("matches", "manually_confirmed", "verified")
    assert inv["next_owner_role"] == "owner"

    # §9.6 journals: bill once, deposit applied once, balance settled (simulated).
    assert L.post(store, "gateway", L.bill_accepted(INVOICE_ID, REV2_ID, PROJECT.id, a3.claimed_cents, "2026-10-24")).ok
    assert L.post(store, "gateway", L.bill_accepted(INVOICE_ID, REV2_ID, PROJECT.id, a3.claimed_cents, "2026-10-24")).outcome == "invalid"
    assert L.post(store, "gateway", L.deposit_applied(INVOICE_ID, DEPOSIT.id, a3.deposit_applied_cents, "2026-10-24")).ok
    assert L.post(store, "gateway", L.settlement(INVOICE_ID, a3.proposed_payment_cents, "2026-10-24")).ok
    ledger = store.rows("ledger_line")
    assert sum(l["debit_cents"] for l in ledger) == sum(l["credit_cents"] for l in ledger)
    bal = L.balances(ledger)
    done = KEY["settlement"]
    assert bal[L.AP] == done["accounts_payable_end_cents"] == 0  # AP $0
    assert bal[L.PREPAYMENT] == done["supplier_prepayment_end_cents"] == 0
    assert -bal[L.CASH] == done["cash_out_cents"] == 8_370_000  # cash out $83,700 including the deposit
    assert bal[L.material_cost(PROJECT.id)] == 8_370_000


def test_fingerprint_is_stable_and_follows_inputs(store):
    b = bundle_from_store(store, INVOICE_ID)
    assert assess(b).fingerprint == assess(bundle_from_store(store, INVOICE_ID)).fingerprint
    record(store, assess(b))  # invoice status columns change; the inputs don't
    assert assess(bundle_from_store(store, INVOICE_ID)).fingerprint == assess(b).fingerprint
    moved = replace(b, attestations=[{"id": "att", "invoice_id": INVOICE_ID, "unit": "cy", "quantity_milli": 1}])
    assert assess(moved).fingerprint != assess(b).fingerprint


def test_a_deposit_applies_once(store):
    b = bundle_from_store(store, INVOICE_ID)
    used = replace(b, allocations=[{"id": "alloc_1", "deposit_id": DEPOSIT.id, "invoice_id": "inv_earlier", "amount_cents": 1_000_000}])
    a = assess(used)
    assert a.deposit_available_cents == 0 and a.hold_amounts()["CONTRACT_REVIEW"] == 1_000_000
    assert a.proposed_payment_cents == 0 and a.commercial_status == "contract_review"


def test_a_resent_pdf_or_reused_number_goes_to_duplicate_review(store):
    sha = store.rows("document", id=INVOICE_R1.id)[0]["sha256"]
    assert R.record_document(store, "doc_resent", "invoice", "src_resent", sha, "BayMix_Invoice_BM-23104 (1).pdf", 1).ok
    assert R.record_invoice(store, "agent", "inv_resent", BAYMIX.id, PURCHASE_ID, "BM-23104", "2026-10-23", "2026-11-22").ok
    assert R.record_invoice_revision(store, "agent", "rev_resent_r1", "inv_resent", 1, "doc_resent", 8_742_500, 1_000_000, 7_742_500).ok
    for l in store.rows("invoice_line", revision_id=REV1_ID):
        assert R.record_invoice_line(store, "agent", l["id"] + "_dup", "rev_resent_r1", l["kind"], l["description"], l["quantity_milli"],
                                     l["unit"], l["unit_price_cents"], l["amount_cents"], l["linked_term_id"],
                                     l["linked_change_request_id"], json.loads(l["source_fragment_ids_json"])).ok
    a = assess(bundle_from_store(store, "inv_resent"))
    assert "DUPLICATE_REVIEW" in a.hold_amounts() and "same PDF" in next(c for c in a.checks if c.code == "duplicate").summary
    assert "PO_CEILING" in a.hold_amounts()  # 500 cy twice is over the 500 cy maximum
    assert a.proposed_payment_cents == 0


def test_same_number_without_a_correction_notice_is_not_a_correction(store):
    ext = load_fixture(INVOICE_R2.id)
    ext["fields"]["supersedes"] = {"value": None, "missing_reason": "no correction notice"}
    invoice_id, _ = record_invoice_extraction(store, ext, PURCHASE_ID)
    assert invoice_id != INVOICE_ID
    assert store.rows("invoice_revision", id=REV1_ID)[0]["status"] == "active"
    assert "DUPLICATE_REVIEW" in assess(bundle_from_store(store, invoice_id)).hold_amounts()


def test_a_pending_bank_change_holds_payment_after_the_correction(store):
    assert R.add_payee_profile(store, "agent", f"{BAYMIX.id}:v2", BAYMIX.id, 2, "acct_unknown", "9921", "Harborline", "email").ok
    record_invoice_extraction(store, load_fixture(INVOICE_R2.id), PURCHASE_ID)
    a = assess(bundle_from_store(store, INVOICE_ID))
    assert a.commercial_status == "matches" and "PAYEE_CHANGE_PENDING" in a.hold_amounts()
    assert store.rows("hold", id=hold_id(REV2_ID, "PAYEE_CHANGE_PENDING"))[0]["status"] == "open"


def test_an_unagreed_extra_is_pending(store):
    b = bundle_from_store(store, INVOICE_ID)
    unlinked = replace(b, lines=[{**l, "linked_change_request_id": ""} for l in b.lines])
    assert line(assess(unlinked), "extra").hold_code == "PROPOSED_CHARGE"


def test_a_check_that_crashes_holds_instead_of_passing(store, monkeypatch):
    record_invoice_extraction(store, load_fixture(INVOICE_R2.id), PURCHASE_ID)
    b = bundle_from_store(store, INVOICE_ID)
    assert assess(b).proposed_payment_cents == 7_370_000

    def boom(b, lines):
        raise RuntimeError("source down")

    monkeypatch.setattr(commercial, "CHECKS", [(c, boom if c == "price_terms" else f, h) for c, f, h in commercial.CHECKS])
    a = assess(b)
    assert next(c for c in a.checks if c.code == "price_terms").status == "error"
    assert "PRICE_VARIANCE" in a.hold_amounts() and a.commercial_status != "matches" and a.proposed_payment_cents == 0


def test_clarification_explains_each_line_and_never_offers_to_pay_less(store):
    from countersign.clarify import draft, outbox_id, recipient, record_draft

    b = bundle_from_store(store, INVOICE_ID)
    a = assess(b)
    assert record_draft(store, b, a) == outbox_id(REV1_ID)
    ob = store.rows("outbox", id=outbox_id(REV1_ID))[0]
    assert (ob["status"], ob["simulated"], ob["to_address"], ob["created_by_role"]) == ("draft", True, "ar@baymix-supply.example", "agent")
    assert ob["subject"] == "Invoice BM-23104: 2 lines don't match what we agreed"
    for text in ("$172.00", "$165.00", "$3,500.00", "Truck waiting time ($225.00)", "Weekend delivery, Saturday Oct 10 pour ($1,200.00)",
                 "corrected invoice or an agreed credit memo", "$3,725.00"):
        assert text in ob["body"], text
    assert "pay" not in ob["body"].lower().replace("payable", "")  # asks for a correction; never announces a short payment
    assert R.draft_outbox(store, "ob_x", INVOICE_ID, "ctc_baymix_ar", "s", "b", role="owner").outcome == "denied"
    assert R.draft_outbox(store, "ob_x", INVOICE_ID, "ctc_nobody", "s", "b").outcome == "invalid"
    a_clean = replace(a, lines=[replace(r, pending_cents=0, variance_cents=0) for r in a.lines])
    assert draft(b, a_clean, recipient(store, BAYMIX.id)) is None
