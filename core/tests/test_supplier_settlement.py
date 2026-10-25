"""v2.2 settlement decisions on disputed lines (CONTRACT §9.9): BayMix won't correct revision 1, so the owner
decides each disputed line. The agreed part is paid only after the supplier is told; the rest stays open."""

import dataclasses
import json

import pytest

from countersign import intake, worker
from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.commercial import assess, bundle_from_store
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.integrations import nessie
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PROJECT, PURCHASE_ID, QUOTE,
                                        REPLY_1, REV1_ID, REV2_ID, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

WI = f"wi_{INVOICE_ID}"
PRICE, WEEKEND, WAITING = "ln_bm23104_r1_1", "ln_bm23104_r1_2", "ln_bm23104_r1_3"
AR = "ctc_baymix_ar"
MONEY = ("PRICE_VARIANCE", "PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING", "PO_CEILING")


def receive(s, doc, files):
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


@pytest.fixture()
def bank():
    b = nessie.MockNessie()
    nessie.set_client(b)
    yield b
    nessie.set_client(None)


@pytest.fixture()
def r1(tmp_path):
    """Revision 1 assessed: $3,500 price variance and $225 proposed waiting time, the weekend charge agreed."""
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(s, doc, tmp_path)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    assert L.post(s, "sync", L.deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)).ok
    receive(s, INVOICE_R1, tmp_path)
    return s


def latest(s, revision_id=REV1_ID):
    return max(s.rows("assessment", revision_id=revision_id), key=lambda a: a["version"])


def decide(s, id, line, decision, amount, note="BayMix won't correct; pay what was agreed", contact=None, fp=None, role="owner"):
    contact = (AR if decision == "pay_agreed_dispute_rest" else "") if contact is None else contact
    return R.decide_disputed_line(s, role, id, line, decision, amount, fp or latest(s)["fingerprint"], contact, note)


def hold_status(s, code, revision_id=REV1_ID):
    return s.rows("hold", id=hold_id(revision_id, code))[0]["status"]


def denied_logged(s, action, entity_id):
    return any(a["action"] == action and a["outcome"] == "denied" and a["entity_id"] == entity_id for a in s.rows("audit_log"))


def test_details_name_every_line_for_the_module(r1):
    lines = json.loads(latest(r1)["details_json"])["lines"]
    assert [l["line_id"] for l in lines] == [PRICE, WEEKEND, WAITING]
    assert all({"line_id", "hold_code", "pending_cents", "variance_cents"} <= set(l) for l in lines)
    assert {l["line_id"]: (l["hold_code"], l["pending_cents"] + l["variance_cents"]) for l in lines} == {
        PRICE: ("PRICE_VARIANCE", 350_000), WEEKEND: ("", 0), WAITING: ("PROPOSED_CHARGE", 22_500)}


def test_baymix_wont_correct(r1, bank):
    s = r1
    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    assert (hold_status(s, "PRICE_VARIANCE"), hold_status(s, "PROPOSED_CHARGE")) == ("disputed", "open")
    worker.drain(s)  # the module queued reassess_invoice
    assert (latest(s)["commercial_status"], latest(s)["proposed_payment_cents"]) == ("differences_under_review", 0)

    assert decide(s, "dec_wait", WAITING, "pay_agreed_dispute_rest", 22_500).ok
    assert hold_status(s, "PROPOSED_CHARGE") == "disputed"
    worker.drain(s)
    a = latest(s)
    assert (a["commercial_status"], a["authorised_cents"], a["variance_cents"] + a["pending_cents"]) == \
        ("partially_disputed", 8_370_000, 372_500)
    assert a["proposed_payment_cents"] == 7_370_000  # authorised $83,700 less the $10,000 deposit
    assert s.rows("invoice", id=INVOICE_ID)[0]["commercial_status"] == "partially_disputed"

    notices = {d["id"]: s.rows("outbox", id=d["outbox_id"])[0] for d in s.rows("settlement_decision")}
    assert notices["dec_price"]["subject"] == "Invoice BM-23104: paying the agreed amount, $3,500.00 disputed"
    assert notices["dec_wait"]["subject"] == "Invoice BM-23104: paying the agreed amount, $225.00 disputed"
    for ob in notices.values():
        assert (ob["status"], ob["simulated"], ob["created_by_role"], ob["to_contact_id"]) == ("draft", True, "owner", AR)
        assert "corrected invoice or an agreed credit" in ob["body"] and "won't correct" not in ob["body"]  # the note stays internal

    assert R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
    worker.drain(s)
    p = next(p for p in s.rows("proposal", work_item_id=WI) if p["status"] == "pending")
    assert p["amount_cents"] == 7_370_000
    res = R.approve_supplier_payment(s, "owner", p["id"], latest(s)["fingerprint"], "Agreed part")
    assert res.outcome == "denied" and "notice to supplier not sent" in res.message  # never pay short before telling them

    for ob in notices.values():
        assert R.approve_outbox(s, "owner", ob["id"]).ok
    worker.drain(s)
    assert {o["status"] for o in s.rows("outbox") if o["id"] in {n["id"] for n in notices.values()}} == {"sent"}
    assert R.approve_supplier_payment(s, "owner", p["id"], latest(s)["fingerprint"], "Agreed part").ok
    worker.drain(s)

    inv = s.rows("invoice", id=INVOICE_ID)[0]
    assert inv["payment_status"] == "partially_settled" and "$3,725.00 still disputed" in inv["next_action"]
    assert sum(d["amount_cents"] for d in s.rows("settlement_decision", invoice_id=INVOICE_ID, status="active")) == 372_500
    assert s.rows("payment", id=p["id"])[0]["amount_cents"] == 7_370_000
    assert s.rows("payment_approval", id=f"appr_{p['id']}")[0]["status"] == "used"
    books = L.balances(s.rows("ledger_line"))
    assert books[L.material_cost(PROJECT.id)] == 8_370_000  # booked at what's authorised, not the $87,425 gross
    assert books[L.AP] == 0 and books[L.PREPAYMENT] == 0 and books[L.CASH] == -8_370_000
    assert {l["ref_type"] for l in s.rows("ledger_line") if l["account"] == L.PREPAYMENT} == {"deposit"}
    assert s._remaining_ceiling(s.rows("purchase", id=PURCHASE_ID)[0]) == 0  # partially settled counts as settled
    assert s.rows("hold", revision_id=REV1_ID, status="open") == []


def test_accept_as_billed_moves_the_amount_into_authorised(r1):
    s = r1
    assert decide(s, "dec_wait", WAITING, "accept_as_billed", 22_500, note="Trucks really waited; accept").ok
    assert hold_status(s, "PROPOSED_CHARGE") == "resolved"
    cr = s.rows("change_request", id="cr_dec_wait")[0]
    assert (cr["kind"], cr["amount_cents"], cr["classification"], cr["supplier_acceptance"], cr["internal_status"],
            cr["decided_by_role"], cr["requested_by_identity"]) == \
        ("settlement", 22_500, "AUTHORISED_FIXED", "accepted", "approved", "owner", "")
    assert json.loads(cr["scope_json"]) == {"invoice_line_id": WAITING, "settlement_decision_id": "dec_wait"}
    assert s.rows("settlement_decision", id="dec_wait")[0]["outbox_id"] == ""
    worker.drain(s)
    a = latest(s)
    assert (a["authorised_cents"], a["commercial_status"], a["proposed_payment_cents"]) == (8_392_500, "differences_under_review", 0)

    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    worker.drain(s)
    a = latest(s)
    assert (a["commercial_status"], a["authorised_cents"], a["proposed_payment_cents"]) == ("partially_disputed", 8_392_500, 7_392_500)


def test_accepting_every_disputed_line_proposes_the_full_balance(r1):
    s = r1
    assert decide(s, "dec_price", PRICE, "accept_as_billed", 350_000, note="Accept the new price").ok
    worker.drain(s)
    assert decide(s, "dec_wait", WAITING, "accept_as_billed", 22_500, note="Accept the waiting time").ok
    worker.drain(s)
    a = latest(s)
    assert (a["commercial_status"], a["authorised_cents"], a["proposed_payment_cents"]) == ("matches", 8_742_500, 7_742_500)
    assert (hold_status(s, "PRICE_VARIANCE"), hold_status(s, "PROPOSED_CHARGE")) == ("resolved", "resolved")


@pytest.mark.parametrize("code", MONEY)
def test_resolve_hold_on_a_money_hold_is_denied_and_logged(r1, code):
    s = r1
    hid = hold_id(REV1_ID, code)
    if not s.rows("hold", id=hid):
        assert R.open_hold(s, "agent", hid, REV1_ID, code, 100, f"{code} for the test", {}).ok
    res = R.resolve_hold(s, "owner", hid, "Looks fine to me")
    assert res.outcome == "denied" and "decides each disputed line" in res.message
    assert denied_logged(s, "resolve_hold", hid) and hold_status(s, code) == "open"


def test_a_stale_fingerprint_is_denied(r1):
    s = r1
    old = latest(s)["fingerprint"]
    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    worker.drain(s)
    res = decide(s, "dec_wait", WAITING, "pay_agreed_dispute_rest", 22_500, fp=old)
    assert res.outcome == "denied" and res.message == "the assessment changed; review it again"
    assert denied_logged(s, "decide_disputed_line", "dec_wait") and not s.rows("settlement_decision", id="dec_wait")
    assert not s.rows("outbox", id="ob_dec_wait")


def test_accept_as_billed_above_the_callers_limit_is_denied(r1):
    s = r1
    assert R.set_authority(s, "owner", "owner", 1_000_00, "*").ok  # admin lowers the owner's limit to $1,000
    res = decide(s, "dec_price", PRICE, "accept_as_billed", 350_000)
    assert res.outcome == "denied" and "above your approval limit" in res.message
    assert denied_logged(s, "decide_disputed_line", "dec_price") and not s.rows("change_request", id="cr_dec_price")
    assert hold_status(s, "PRICE_VARIANCE") == "open"
    # Paying the agreed part commits nothing beyond what's authorised, so there's no limit check.
    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok


def test_only_the_owner_decides(r1):
    res = decide(r1, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000, role="purchasing")
    assert res.outcome == "denied" and denied_logged(r1, "decide_disputed_line", "")


def test_invalid_decisions_change_nothing(r1):
    s = r1
    assert R.upsert_supplier(s, "sync", "sup_other", "Other Aggregate Co", "other-agg.example", "(510) 555-0170", "", "active").ok
    assert R.upsert_supplier_contact(s, "sync", "ctc_other", "sup_other", "Pat Doe", "pat@other-agg.example",
                                     "(510) 555-0171", "AR", True).ok
    before = len(s.rows("audit_log"))
    cases = [
        decide(s, "d1", PRICE, "pay_agreed_dispute_rest", 349_999),  # not the disputed amount
        decide(s, "d2", WEEKEND, "pay_agreed_dispute_rest", 120_000),  # agreed line, not disputed
        decide(s, "d3", PRICE, "pay_agreed_dispute_rest", 350_000, note="  "),
        decide(s, "d4", PRICE, "pay_agreed_dispute_rest", 350_000, contact="ctc_other"),
        decide(s, "d5", PRICE, "accept_as_billed", 350_000, contact=AR),
        decide(s, "d6", PRICE, "split_the_difference", 350_000),
        decide(s, "d7", "ln_nope", "pay_agreed_dispute_rest", 350_000),
    ]
    assert [r.outcome for r in cases] == ["invalid"] * len(cases)
    assert len(s.rows("audit_log")) == before and not s.rows("settlement_decision")
    assert decide(s, "d8", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    assert decide(s, "d9", PRICE, "accept_as_billed", 350_000).outcome == "invalid"  # the line already has a decision
    assert decide(s, "d8", PRICE, "pay_agreed_dispute_rest", 350_000).outcome == "duplicate"


def test_propose_change_request_cannot_create_a_settlement(r1):
    res = R.propose_change_request(r1, "agent", "cr_fake", PURCHASE_ID, "settlement", "Settle it", 350_000, 0, "", {}, "", "", "",
                                   "PROPOSED", "none", ["frag_bm_inv_23104_r1_p1_l11"])
    assert res.outcome == "invalid"


def test_a_corrected_revision_supersedes_the_decisions(r1, tmp_path):
    s = r1
    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    worker.drain(s)
    assert decide(s, "dec_wait", WAITING, "accept_as_billed", 22_500, note="Accept waiting").ok
    worker.drain(s)
    receive(s, REPLY_1, tmp_path)
    receive(s, INVOICE_R2, tmp_path)
    assert {d["id"]: d["status"] for d in s.rows("settlement_decision")} == {"dec_price": "superseded", "dec_wait": "superseded"}
    assert hold_status(s, "PRICE_VARIANCE") == "superseded"
    a2 = latest(s, REV2_ID)  # assessed from scratch: the corrected invoice matches
    assert (a2["commercial_status"], a2["authorised_cents"]) == ("matches", 8_370_000)
    assert "settlement_decisions" not in json.loads(a2["details_json"])["inputs"]


def test_a_decision_that_no_longer_matches_does_not_apply(r1):
    b = bundle_from_store(r1, INVOICE_ID)
    stale = {"id": "dec_old", "invoice_line_id": PRICE, "decision": "pay_agreed_dispute_rest", "amount_cents": 300_000}
    a = assess(dataclasses.replace(b, decisions=[stale]))
    price = next(l for l in a.lines if l.line_id == PRICE)
    assert price.decision == "" and "no longer applies" in price.uncertainty
    assert (a.commercial_status, a.proposed_payment_cents) == ("differences_under_review", 0)


def test_the_gateway_wont_pay_while_a_notice_is_unsent(r1, bank, monkeypatch):
    """A module without the notice check (the reference has one): the gateway still refuses."""
    s = r1
    monkeypatch.setattr(FakeStore, "_unsent_notices", lambda self, invoice_id: [])
    assert decide(s, "dec_price", PRICE, "pay_agreed_dispute_rest", 350_000).ok
    worker.drain(s)
    assert decide(s, "dec_wait", WAITING, "pay_agreed_dispute_rest", 22_500).ok
    assert R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
    worker.drain(s)
    p = next(p for p in s.rows("proposal", work_item_id=WI) if p["status"] == "pending")
    assert R.approve_supplier_payment(s, "owner", p["id"], latest(s)["fingerprint"], "Agreed part").ok
    worker.drain(s)
    job = s.rows("job", id=f"job_pay_{p['id']}")[0]
    assert json.loads(job["result_json"])["reason"] == "blocked: notice to supplier not sent"
    assert not s.rows("payment") and s.rows("invoice", id=INVOICE_ID)[0]["payment_status"] == "ready"


def test_a_module_without_the_v22_table_reads_no_decisions(r1):
    """Until the real module has settlement_decision, assessment still works (and can only propose less)."""
    from countersign.store import StoreError

    class NoV22:
        def __init__(self, inner):
            self.inner = inner

        def rows(self, table, **filters):
            if table == "settlement_decision":
                raise StoreError("SQL failed: HTTP 400: no such table -- SELECT * FROM settlement_decision")
            return self.inner.rows(table, **filters)

    b = bundle_from_store(NoV22(r1), INVOICE_ID)
    assert b.decisions == [] and assess(b).fingerprint == latest(r1)["fingerprint"]
