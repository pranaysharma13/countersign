"""The module's v2 rules (CONTRACT §9, v2.1), run against the in-memory reference."""

import pytest

from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.supplier_docs import fragments
from countersign.supplier_seed import seed_documents, seed_setup
from countersign.supplier_world import (BAYMIX, PAYEE_V1, PO, PO_NUMBER, PROJECT, PURCHASE_ID, QUOTE, WAITING_1,
                                        WEEKEND_1, WEEKEND_3, SourceDoc)


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
    assert store.rows("document", id=QUOTE.id)[0]["status"] == "validated"
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


def test_deposit_amount_cant_change(store):
    assert R.record_deposit(store, "sync", "dep_1", PURCHASE_ID, BAYMIX.id, 1_000_000, "settled", "mock_1").ok
    assert R.record_deposit(store, "sync", "dep_1", PURCHASE_ID, BAYMIX.id, 2_000_000, "settled", "mock_1").outcome == "denied"
    assert R.record_deposit(store, "agent", "dep_2", PURCHASE_ID, BAYMIX.id, 1_000_000, "settled", "mock_2").outcome == "denied"
