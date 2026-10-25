"""The module's v2 rules (CONTRACT §9, v2.1), run against the in-memory reference."""

import pytest

from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import fragments
from countersign.supplier_seed import seed_documents, seed_setup
from countersign.supplier_world import (BAYMIX, INVOICE_ID, INVOICE_NUMBER, INVOICE_R1, INVOICE_R2, PAYEE_V1, PO,
                                        PO_NUMBER, PROJECT, PURCHASE_ID, QUOTE, REV1_ID, REV2_ID, WAITING_1, WEEKEND_1,
                                        WEEKEND_3, SourceDoc)


def frag(doc: SourceDoc, needle: str) -> str:
    return next(f.id for f in fragments(doc) if needle in f.text and not f.id.endswith("_body"))


@pytest.fixture()
def store():
    s = FakeStore()
    seed_setup(s)
    seed_documents(s)
    assert R.upsert_purchase(s, "agent", PURCHASE_ID, BAYMIX.id, PROJECT.id, "Ready-mix concrete 4,000 psi", "cy",
                             PO_NUMBER, QUOTE.id, PO.id).ok
    assert R.record_term(s, "agent", "term_bm_max_qty", PURCHASE_ID, "max_quantity", "Maximum quantity", 0, 500_000,
                         "Maximum quantity: 500 cubic yards (cy)", {}, "2026-10-01", "2026-10-31", "accepted",
                         [frag(QUOTE, "Maximum quantity")], 1).ok
    return s


def weekend_request(s, cr_id="cr_weekend", amount_cents=120_000, role="agent"):
    return R.propose_change_request(
        s, role, cr_id, PURCHASE_ID, "extra_charge", "Weekend delivery, Saturday Oct 10 pour", amount_cents, 0, "",
        {"delivery_refs": ["2026-10-10"]}, "2026-10-10", WEEKEND_1.email.sent_at_iso, WEEKEND_1.email.ingested_at_iso,
        "PROPOSED", "proposed", [] if role == "purchasing" else [frag(WEEKEND_1, "$1,200.00")])


def denied_logged(s, action):
    return any(a["outcome"] == "denied" and a["action"] == action for a in s.rows("audit_log"))


def test_seed_sets_limits_contacts_and_one_verified_payee(store):
    assert store.rows("authority", identity="purchasing")[0]["limit_cents"] == 200_000
    assert store.rows("authority", identity="receiver")[0]["limit_cents"] == 0
    assert all(c["pre_established"] for c in store.rows("supplier_contact", supplier_id=BAYMIX.id))
    assert [p["id"] for p in store.rows("payee_profile", status="verified")] == [PAYEE_V1.id]
    assert store.rows("document", id=QUOTE.id)[0]["status"] == "received"


def test_fragments_and_documents_are_immutable(store):
    f = fragments(QUOTE)[9]
    assert R.add_fragment(store, "sync", f.id, f.document_id, f.page, "", f.line_start, f.line_end, f.text).outcome == "duplicate"
    res = R.add_fragment(store, "agent", f.id, f.document_id, f.page, "", f.line_start, f.line_end, "Unit price: $172.00")
    assert res.outcome == "denied" and denied_logged(store, "add_fragment")
    assert store.rows("source_fragment", id=f.id)[0]["text"] == f.text
    assert R.record_document(store, QUOTE.id, "quote", "src_x", "0" * 64, QUOTE.filename, 2).outcome == "denied"


def test_terms_need_real_fragments(store):
    args = ("term_bad", PURCHASE_ID, "unit_price", "Unit price", 16_500, 0, "", {}, "", "", "accepted")
    assert R.record_term(store, "agent", *args, ["frag_does_not_exist"], 1).outcome == "invalid"
    assert R.record_term(store, "agent", *args, [], 1).outcome == "invalid"
    assert R.record_term(store, "agent", *args, [frag(QUOTE, "Unit price")], 1).ok


def test_emails_know_whether_the_sender_is_on_file(store):
    assert store.rows("email_message", id="em_weekend_1")[0]["from_known_contact"] is True
    assert store.rows("email_message", id="em_weekend_2")[0]["from_known_contact"] is False  # our own purchasing


def test_extraction_run_sets_document_status(store):
    assert R.record_extraction_run(store, "run_1", QUOTE.id, "fixture", "fixture", "v1", "ok", "", {}).ok
    assert store.rows("document", id=QUOTE.id)[0]["status"] == "extracted"  # as the module does
    assert R.record_extraction_run(store, "run_2", PO.id, "live", "claude", "v1", "failed", "timeout", {}).ok
    assert store.rows("document", id=PO.id)[0]["status"] == "failed"
    assert R.record_extraction_run(store, "run_3", PO.id, "guess", "x", "v1", "ok", "", {}).outcome == "invalid"


def test_weekend_charge_needs_both_the_in_app_approval_and_supplier_acceptance(store):
    assert weekend_request(store).ok
    assert R.decide_change_request(store, "purchasing", "cr_weekend", True, "Saturday pour, within limit").ok
    cr = store.rows("change_request", id="cr_weekend")[0]
    assert cr["internal_status"] == "approved" and cr["classification"] == "PROPOSED"  # supplier hasn't confirmed yet
    assert R.record_supplier_acceptance(store, "agent", "cr_weekend", "accepted", [frag(WEEKEND_3, "Confirmed")]).ok
    cr = store.rows("change_request", id="cr_weekend")[0]
    assert cr["classification"] == "AUTHORISED_FIXED" and cr["decided_by_role"] == "purchasing"


def test_acceptance_needs_evidence_and_requests_cant_be_born_authorised(store):
    assert weekend_request(store).ok
    assert R.record_supplier_acceptance(store, "agent", "cr_weekend", "accepted", []).outcome == "invalid"
    res = R.propose_change_request(store, "agent", "cr_x", PURCHASE_ID, "extra_charge", "x", 100, 0, "", {}, "", "", "",
                                   "AUTHORISED_FIXED", "accepted", [frag(WEEKEND_1, "$1,200.00")])
    assert res.outcome == "invalid"


def test_purchasing_over_its_limit_is_denied_and_the_owner_can_approve(store):
    assert weekend_request(store, amount_cents=250_000).ok
    res = R.decide_change_request(store, "purchasing", "cr_weekend", True)
    assert res.outcome == "denied" and "$2,500.00" in res.message and "$2,000.00" in res.message
    assert denied_logged(store, "decide_change_request")
    assert store.rows("change_request", id="cr_weekend")[0]["internal_status"] == "pending"
    assert R.decide_change_request(store, "owner", "cr_weekend", True).ok


def test_nobody_approves_their_own_request_and_the_agent_never_decides(store):
    assert weekend_request(store, role="purchasing").ok
    assert R.decide_change_request(store, "purchasing", "cr_weekend", True).outcome == "denied"
    assert R.decide_change_request(store, "agent", "cr_weekend", True).outcome == "denied"
    assert R.decide_change_request(store, "receiver", "cr_weekend", True).outcome == "denied"
    assert R.decide_change_request(store, "owner", "cr_weekend", True).ok


def _rate_request(s, cr_id, kind, rate_cents, unit, scope):
    return R.propose_change_request(s, "agent", cr_id, PURCHASE_ID, kind, "rate change", 0, rate_cents, unit, scope,
                                    "2026-10-15", WAITING_1.email.sent_at_iso, WAITING_1.email.ingested_at_iso,
                                    "PROPOSED", "proposed", [frag(WAITING_1, "Waiting charges may apply")])


def test_rate_change_without_scope_is_sized_against_the_remaining_ceiling(store):
    assert _rate_request(store, "cr_price", "price_change", 700, "cy", {}).ok  # +$7/cy x 500 cy left = $3,500
    res = R.decide_change_request(store, "purchasing", "cr_price", True)
    assert res.outcome == "denied" and "$3,500.00" in res.message
    assert _rate_request(store, "cr_price_scoped", "price_change", 700, "cy", {"quantity_milli": 100_000, "unit": "cy"}).ok
    assert R.decide_change_request(store, "purchasing", "cr_price_scoped", True).ok  # 100 cy = $700


def test_rate_in_another_unit_cant_be_sized_without_a_scoped_quantity(store):
    assert _rate_request(store, "cr_wait", "extra_charge", 250, "min", {}).ok
    res = R.decide_change_request(store, "owner", "cr_wait", True)
    assert res.outcome == "denied" and "can't size" in res.message
    assert R.decide_change_request(store, "purchasing", "cr_wait", False, "never agreed").ok  # rejecting commits no money
    assert store.rows("change_request", id="cr_wait")[0]["classification"] == "DECLINED"
    assert _rate_request(store, "cr_wait_90", "extra_charge", 250, "min", {"quantity_milli": 90_000, "unit": "min"}).ok
    assert R.decide_change_request(store, "purchasing", "cr_wait_90", True).ok  # 90 min x $2.50 = $225


def test_pre_established_contacts_cant_be_redirected_or_minted(store):
    rosa = store.rows("supplier_contact", id="ctc_baymix_rosa")[0]
    res = R.upsert_supplier_contact(store, "sync", rosa["id"], BAYMIX.id, rosa["name"], rosa["email"], "(510) 555-0999",
                                    rosa["title"], True)
    assert res.outcome == "denied"
    assert R.upsert_supplier_contact(store, "sync", "ctc_new", BAYMIX.id, "New AR", "new.ar@baymix-supply.example",
                                     "(510) 555-0198", "AR", False).ok
    assert R.upsert_supplier_contact(store, "sync", "ctc_new", BAYMIX.id, "New AR", "new.ar@baymix-supply.example",
                                     "(510) 555-0198", "AR", True).outcome == "denied"


def test_payee_profiles_are_immutable_and_only_a_seed_is_born_verified(store):
    assert R.add_payee_profile(store, "agent", f"{BAYMIX.id}:v2", BAYMIX.id, 2, "acct_new", "7781", "Harbor Bank", "email").ok
    assert store.rows("payee_profile", id=f"{BAYMIX.id}:v2")[0]["status"] == "pending"
    res = R.add_payee_profile(store, "agent", f"{BAYMIX.id}:v2", BAYMIX.id, 2, "acct_other", "7781", "Harbor Bank", "email")
    assert res.outcome == "denied"
    assert R.add_payee_profile(store, "agent", f"{BAYMIX.id}:v3", BAYMIX.id, 2, "acct_x", "1111", "X", "email").outcome == "invalid"


R1_LINES = [("ln_r1_mat", "material", 500_000, "cy", 17_200, 8_600_000, "mix BM-40-34"),
            ("ln_r1_wkd", "extra", 1_000, "ea", 120_000, 120_000, "Weekend delivery, Saturday"),
            ("ln_r1_wait", "waiting", 90_000, "min", 250, 22_500, "Truck waiting time")]


def invoice_r1(s):
    assert R.record_invoice(s, "agent", INVOICE_ID, BAYMIX.id, PURCHASE_ID, INVOICE_NUMBER, "2026-10-23", "2026-11-22").ok
    assert R.record_invoice_revision(s, "agent", REV1_ID, INVOICE_ID, 1, INVOICE_R1.id, 8_742_500, 1_000_000, 7_742_500).ok
    for lid, kind, q, unit, price, amount, needle in R1_LINES:
        assert R.record_invoice_line(s, "agent", lid, REV1_ID, kind, needle, q, unit, price, amount, "", "",
                                     [frag(INVOICE_R1, needle)]).ok


def correct_invoice(s):
    return R.record_invoice_revision(s, "agent", REV2_ID, INVOICE_ID, 2, INVOICE_R2.id, 8_370_000, 1_000_000, 7_370_000, REV1_ID)


def open_(s, revision_id, code, amount=0):
    return R.open_hold(s, "agent", hold_id(revision_id, code), revision_id, code, amount, f"{code} reason", {"why": code})


def hold(s, revision_id, code):
    found = s.rows("hold", id=hold_id(revision_id, code))
    return found[0] if found else None


def test_invoice_starts_with_five_independent_statuses_and_a_work_item(store):
    invoice_r1(store)
    inv = store.rows("invoice", id=INVOICE_ID)[0]
    assert (inv["commercial_status"], inv["receipt_status"], inv["payee_status"], inv["approval_status"],
            inv["payment_status"]) == ("pending", "required", "verified", "none", "not_ready")
    assert inv["active_revision_id"] == REV1_ID
    wi = store.rows("work_item", id=f"wi_{INVOICE_ID}")[0]
    assert wi["kind"] == "supplier_invoice" and wi["entity_id"] == INVOICE_ID


def test_invoice_line_math_is_exact_and_lines_need_evidence(store):
    invoice_r1(store)
    f = [frag(INVOICE_R1, "mix BM-40-34")]
    assert R.record_invoice_line(store, "agent", "ln_bad", REV1_ID, "material", "x", 500_000, "cy", 17_200, 8_600_001, "", "", f).outcome == "invalid"
    assert R.record_invoice_line(store, "agent", "ln_bad", REV1_ID, "material", "x", 1_333, "cy", 16_500, 21_994, "", "", f).outcome == "invalid"
    assert R.record_invoice_line(store, "agent", "ln_bad", REV1_ID, "material", "x", 500_000, "cy", 17_200, 8_600_000, "", "", []).outcome == "invalid"


def test_agent_opens_holds_but_never_resolves_them(store):
    invoice_r1(store)
    assert open_(store, REV1_ID, "PRICE_VARIANCE", 350_000).ok
    assert open_(store, REV1_ID, "PRICE_VARIANCE", 999).outcome == "duplicate"
    assert hold(store, REV1_ID, "PRICE_VARIANCE")["amount_cents"] == 350_000
    hid = hold_id(REV1_ID, "PRICE_VARIANCE")
    assert R.resolve_hold(store, "agent", hid, "looks fine").outcome == "denied" and denied_logged(store, "resolve_hold")
    assert R.resolve_hold(store, "owner", hid, "  ").outcome == "invalid"
    assert R.resolve_hold(store, "owner", hid, "BayMix agreed to a credit memo").ok
    assert hold(store, REV1_ID, "PRICE_VARIANCE")["status"] == "resolved"
    assert open_(store, REV1_ID, "RECEIPT_NOT_VERIFIED").ok
    res = R.resolve_hold(store, "owner", hold_id(REV1_ID, "RECEIPT_NOT_VERIFIED"), "I'm sure it arrived")
    assert res.outcome == "denied" and "superintendent" in res.message


def test_receipt_needs_an_attestation_covering_the_billed_quantity(store):
    invoice_r1(store)
    assert open_(store, REV1_ID, "RECEIPT_NOT_VERIFIED").ok
    assert R.attest_receipt(store, "att_x", INVOICE_ID, "all", 500_000, "cy", "saw it", role="owner").outcome == "denied"
    assert R.attest_receipt(store, "att_x", INVOICE_ID, "all", 500_000, "cy", "saw it", role="agent").outcome == "denied"
    assert R.attest_receipt(store, "att_1", INVOICE_ID, "Oct 5-14 pours", 300_000, "cy", "On site for those pours").ok
    assert hold(store, REV1_ID, "RECEIPT_NOT_VERIFIED")["status"] == "open"
    assert store.rows("invoice", id=INVOICE_ID)[0]["receipt_status"] == "required"
    assert R.attest_receipt(store, "att_2", INVOICE_ID, "Oct 15-22 pours", 200_000, "cy", "On site for those pours").ok
    assert hold(store, REV1_ID, "RECEIPT_NOT_VERIFIED")["status"] == "resolved"
    assert store.rows("invoice", id=INVOICE_ID)[0]["receipt_status"] == "manually_confirmed"
    assert {a["label"] for a in store.rows("receipt_attestation")} == {"MANUALLY_CONFIRMED"}


def test_corrected_invoice_supersedes_and_keeps_the_original_claim(store):
    invoice_r1(store)
    for code, amount in (("PRICE_VARIANCE", 350_000), ("PROPOSED_CHARGE", 22_500), ("RECEIPT_NOT_VERIFIED", 0), ("SUPPLIER_RISK", 0)):
        assert open_(store, REV1_ID, code, amount).ok
    assert correct_invoice(store).ok
    assert store.rows("invoice_revision", id=REV1_ID)[0]["status"] == "superseded"
    assert {h["status"] for h in store.rows("hold", revision_id=REV1_ID)} == {"superseded"}
    carried = {h["code"]: h for h in store.rows("hold", revision_id=REV2_ID)}
    assert set(carried) == {"RECEIPT_NOT_VERIFIED", "SUPPLIER_RISK"}
    assert all(h["status"] == "open" for h in carried.values())
    inv = store.rows("invoice", id=INVOICE_ID)[0]
    assert inv["active_revision_id"] == REV2_ID and inv["commercial_status"] == "pending"
    original = store.rows("invoice_line", id="ln_r1_mat")[0]  # the original claim is preserved
    assert original["unit_price_cents"] == 17_200 and store.rows("invoice_revision", id=REV1_ID)[0]["gross_cents"] == 8_742_500
    f = [frag(INVOICE_R1, "mix BM-40-34")]
    assert R.record_invoice_line(store, "agent", "ln_late", REV1_ID, "material", "x", 1_000, "cy", 100, 100, "", "", f).outcome == "invalid"
    assert R.record_invoice_line(store, "agent", "ln_r1_mat", REV1_ID, "material", "mix BM-40-34", 500_000, "cy", 17_200,
                                 8_600_000, "", "", f).outcome == "duplicate"


def test_a_new_revision_must_supersede_the_active_one(store):
    invoice_r1(store)
    assert R.record_invoice_revision(store, "agent", "rev_x", INVOICE_ID, 2, INVOICE_R2.id, 1, 0, 1).outcome == "invalid"
    assert R.record_invoice_revision(store, "agent", "rev_x", INVOICE_ID, 1, INVOICE_R2.id, 1, 0, 1, REV1_ID).outcome == "invalid"
    assert correct_invoice(store).ok
    assert R.record_invoice_revision(store, "agent", "rev_y", INVOICE_ID, 3, INVOICE_R2.id, 1, 0, 1, REV1_ID).outcome == "invalid"


def _bank_change(s):
    return R.add_payee_profile(s, "agent", f"{BAYMIX.id}:v2", BAYMIX.id, 2, "acct_unknown_9921", "9921",
                               "Harborline National Bank", "email")


def test_bank_change_hold_survives_the_correction_until_the_owner_checks_a_known_contact(store):
    invoice_r1(store)
    assert _bank_change(store).ok
    assert store.rows("invoice", id=INVOICE_ID)[0]["payee_status"] == "change_pending"
    assert hold(store, REV1_ID, "PAYEE_CHANGE_PENDING")["status"] == "open"
    assert correct_invoice(store).ok
    assert hold(store, REV2_ID, "PAYEE_CHANGE_PENDING")["status"] == "open"  # a correction doesn't clear it
    assert R.upsert_supplier_contact(store, "sync", "ctc_from_request", BAYMIX.id, "New AR", "ar@baymix-supply-billing.example",
                                     "(510) 555-0177", "AR", False).ok
    v2 = f"{BAYMIX.id}:v2"
    assert R.decide_payee_profile(store, "owner", v2, True, "ctc_from_request").outcome == "denied"
    assert R.decide_payee_profile(store, "agent", v2, True, "ctc_baymix_rosa").outcome == "denied"
    assert R.resolve_hold(store, "owner", hold_id(REV2_ID, "PAYEE_CHANGE_PENDING"), "fine").outcome == "denied"
    assert R.decide_payee_profile(store, "owner", v2, False, "ctc_baymix_rosa", "Rosa says BayMix never changed banks").ok
    assert hold(store, REV2_ID, "PAYEE_CHANGE_PENDING")["status"] == "resolved"
    assert store.rows("invoice", id=INVOICE_ID)[0]["payee_status"] == "verified"
    assert store.rows("payee_profile", id=PAYEE_V1.id)[0]["status"] == "verified"
    assert store.rows("payee_profile", id=v2)[0]["status"] == "rejected"


def test_a_verified_bank_change_replaces_the_payee_profile(store):
    invoice_r1(store)
    assert _bank_change(store).ok
    assert R.decide_payee_profile(store, "owner", f"{BAYMIX.id}:v2", True, "ctc_baymix_ar", "Confirmed by phone").ok
    assert store.rows("payee_profile", id=PAYEE_V1.id)[0]["status"] == "superseded"
    assert [p["id"] for p in store.rows("payee_profile", status="verified")] == [f"{BAYMIX.id}:v2"]
    assert hold(store, REV1_ID, "PAYEE_CHANGE_PENDING")["status"] == "resolved"


def test_assessment_sets_commercial_status_on_the_active_revision_only(store):
    invoice_r1(store)
    args = (1, "fp_1", "commercial-v1", 8_742_500, 8_370_000, 22_500, 350_000, 1_000_000, 0, "differences_under_review",
            "$3,725.00 under review", {"lines": []}, "Ask BayMix for a corrected invoice or an agreed credit")
    assert R.record_assessment(store, "asm_1", REV1_ID, *args).ok
    inv = store.rows("invoice", id=INVOICE_ID)[0]
    assert inv["commercial_status"] == "differences_under_review" and inv["next_owner_role"] == "purchasing"
    assert R.record_assessment(store, "asm_1b", REV1_ID, 1, "fp_1", "commercial-v1", 1, 1, 0, 0, 0, -5, "matches", "",
                               {}, "").outcome == "invalid"
    assert correct_invoice(store).ok
    assert R.record_assessment(store, "asm_2", REV1_ID, *args).outcome == "invalid"


def test_unpaid_invoices_dont_use_up_the_ceiling(store):
    invoice_r1(store)  # 500 cy billed but not paid: a price change could still reach it
    assert _rate_request(store, "cr_price", "price_change", 700, "cy", {}).ok
    res = R.decide_change_request(store, "purchasing", "cr_price", True)
    assert res.outcome == "denied" and "$3,500.00" in res.message


def test_deposit_amount_cant_change(store):
    assert R.record_deposit(store, "sync", "dep_1", PURCHASE_ID, BAYMIX.id, 1_000_000, "settled", "mock_1").ok
    assert R.record_deposit(store, "sync", "dep_1", PURCHASE_ID, BAYMIX.id, 2_000_000, "settled", "mock_1").outcome == "denied"
    assert R.record_deposit(store, "agent", "dep_2", PURCHASE_ID, BAYMIX.id, 1_000_000, "settled", "mock_2").outcome == "denied"
