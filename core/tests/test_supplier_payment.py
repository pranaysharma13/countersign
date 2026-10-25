"""Step E: the payment proposed from the assessment, owner approval bound to the fingerprint, the gateway
(simulated Nessie), deposit allocation and journals. Ends at $73,700 settled, AP $0, $83,700 cash out."""

import json

import pytest

from countersign import intake, supplier_gateway, worker
from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.fake_store import FakeStore
from countersign.integrations import nessie
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PAYEE_V1, PO, PROJECT, PURCHASE_ID,
                                        QUOTE, REPLY_1, REV2_ID, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

WI = f"wi_{INVOICE_ID}"


def receive(s, doc, files):
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


def build(files, attest=True):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(s, doc, files)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    assert L.post(s, "sync", L.deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)).ok
    receive(s, INVOICE_R1, files)
    for ob in s.rows("outbox", status="draft"):
        assert R.approve_outbox(s, "purchasing", ob["id"]).ok
    worker.drain(s)
    receive(s, REPLY_1, files)
    receive(s, INVOICE_R2, files)
    if attest:
        assert R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
        worker.drain(s)
    return s


@pytest.fixture()
def bank():
    b = nessie.MockNessie()
    nessie.set_client(b)
    yield b
    nessie.set_client(None)


def pending(s):
    return next(p for p in s.rows("proposal", work_item_id=WI) if p["status"] == "pending")


def latest_fp(s):
    return max(s.rows("assessment", revision_id=REV2_ID), key=lambda a: a["version"])["fingerprint"]


def approve(s, note="Matches the corrected invoice; receipt attested"):
    p = pending(s)
    res = R.approve_supplier_payment(s, "owner", p["id"], latest_fp(s), note)
    return p, res


def books(s):
    return L.balances(s.rows("ledger_line"))


def test_the_scenario_settles_73700_with_ap_zero_and_83700_cash_out(tmp_path, bank):
    s = build(tmp_path)
    p = pending(s)
    ref = json.loads(p["evidence_json"])
    assert (p["amount_cents"], ref["deposit_allocation_cents"], ref["payee_profile_id"]) == (7_370_000, "1000000", PAYEE_V1.id)
    assert p["payee_account_ref"] == PAYEE_V1.account_ref
    opening = bank.balance_cents("acct_company_operating")
    _, res = approve(s)
    assert res.ok
    assert R.approve_supplier_payment(s, "owner", p["id"], latest_fp(s), "again").outcome == "invalid"  # not pending any more
    assert s.rows("job", id=f"job_pay_{p['id']}")[0]["kind"] == "pay_supplier"
    worker.drain(s)
    result = json.loads(s.rows("job", id=f"job_pay_{p['id']}")[0]["result_json"])
    assert result["status"] == "settled" and result["simulated"] is True and "simulated" in result["bank"]
    assert len(bank.transfers) == 1 and bank.transfers[0]["amount_cents"] == 7_370_000
    assert bank.transfers[0]["payee"] == PAYEE_V1.account_ref
    assert bank.balance_cents("acct_company_operating") == opening - 7_370_000  # $73,700 settled
    inv = s.rows("invoice", id=INVOICE_ID)[0]
    assert (inv["approval_status"], inv["payment_status"]) == ("approved", "settled")
    assert s.rows("payment_approval", id=f"appr_{p['id']}")[0]["status"] == "used"
    assert s.rows("work_item", id=WI)[0]["state"] == "paid"
    assert [(a["deposit_id"], a["amount_cents"]) for a in s.rows("deposit_allocation")] == [(DEPOSIT.id, 1_000_000)]
    ledger = s.rows("ledger_line")
    assert sum(l["debit_cents"] for l in ledger) == sum(l["credit_cents"] for l in ledger)
    bal = books(s)
    assert bal[L.AP] == 0  # AP $0
    assert -bal[L.CASH] == 8_370_000  # $83,700 out, including the $10,000 deposit
    assert bal[L.PREPAYMENT] == 0 and bal[L.material_cost(PROJECT.id)] == 8_370_000
    assert any("Paid $73,700.00" in st["title"] for st in s.rows("agent_step", work_item_id=WI))


def test_approval_before_receipt_is_denied_with_the_reasons(tmp_path, bank):
    s = build(tmp_path, attest=False)
    _, res = approve(s)
    assert res.outcome == "denied"
    reasons = json.loads(res.message)
    assert "receipt not attested" in reasons and any(r.startswith("open hold RECEIPT_NOT_VERIFIED") for r in reasons)
    assert s.rows("job", kind="pay_supplier") == []


def test_only_the_assessments_amount_and_only_the_owner_decides(tmp_path, bank):
    s = build(tmp_path)
    p = pending(s)
    ref = json.loads(p["evidence_json"])
    assert R.propose_supplier_payment(s, "prop_less", INVOICE_ID, REV2_ID, ref["assessment_id"], 7_000_000, 1_000_000,
                                      PAYEE_V1.id).outcome == "denied"  # never silently pay less
    assert R.approve_supplier_payment(s, "agent", p["id"], latest_fp(s)).outcome == "denied"
    assert R.decide_proposal(s, "owner", p["id"], True).outcome == "denied"  # supplier payments have their own reducer
    assert R.reject_supplier_payment(s, "owner", p["id"], "Hold until month end").ok
    assert s.rows("invoice", id=INVOICE_ID)[0]["approval_status"] == "rejected"
    assert s.rows("job", kind="pay_supplier") == []


def test_a_stale_approval_never_pays_until_the_owner_approves_again(tmp_path, bank):
    s = build(tmp_path)
    first, res = approve(s)
    assert res.ok
    # Before the gateway runs, an input changes: another attestation (only reassessed by the next sweep).
    assert R.attest_receipt(s, "att_extra", INVOICE_ID, "Re-count", 10_000, "cy", "Found a second ticket").ok
    worker.drain(s)
    blocked = json.loads(s.rows("job", id=f"job_pay_{first['id']}")[0]["result_json"])
    assert blocked["status"] == "blocked" and blocked["inputs_changed"] is True and blocked["mismatch"] is False
    assert any("att_extra" in c for c in blocked["changes"])
    assert bank.transfers == []
    assert any("input(s) changed since the owner approved" in st["title"] for st in s.rows("agent_step", work_item_id=WI))
    # The sweep reassessed: the module made the approval stale and the agent proposed again.
    assert s.rows("payment_approval", id=f"appr_{first['id']}")[0]["status"] == "stale"
    assert s.rows("proposal", id=first["id"])[0]["status"] == "cancelled"
    assert [h["code"] for h in s.rows("hold", revision_id=REV2_ID, status="open")] == ["APPROVAL_STALE"]
    assert s.rows("invoice", id=INVOICE_ID)[0]["approval_status"] == "stale"
    second, res = approve(s, "Re-approved after the re-count")
    assert res.ok and second["id"] != first["id"]
    assert s.rows("hold", revision_id=REV2_ID, status="open") == []  # the new approval clears APPROVAL_STALE
    worker.drain(s)
    assert len(bank.transfers) == 1 and books(s)[L.AP] == 0


def test_the_module_rechecks_at_start_payment_and_makes_the_approval_stale(tmp_path, bank):
    s = build(tmp_path)
    p, res = approve(s)
    assert res.ok
    assert R.add_payee_profile(s, "agent", f"{BAYMIX.id}:v2", BAYMIX.id, 2, "acct_new", "9921", "Harborline", "email").ok
    res = R.start_payment(s, p["id"])
    assert res.outcome == "denied" and any(r.startswith("open hold PAYEE_CHANGE_PENDING") for r in json.loads(res.message))
    assert s.rows("payment_approval", id=f"appr_{p['id']}")[0]["status"] == "stale"
    assert s.rows("proposal", id=p["id"])[0]["status"] == "cancelled"
    assert "APPROVAL_STALE" in {h["code"] for h in s.rows("hold", revision_id=REV2_ID, status="open")}
    assert bank.transfers == []


def test_a_fingerprint_mismatch_with_no_input_change_is_reported_as_one(tmp_path, bank, monkeypatch, capsys):
    s = build(tmp_path)
    p, res = approve(s)
    assert res.ok
    monkeypatch.setattr(supplier_gateway, "fingerprint", lambda b: "fp_module_disagrees")
    worker.drain(s)
    result = json.loads(s.rows("job", id=f"job_pay_{p['id']}")[0]["result_json"])
    assert result["status"] == "blocked" and result["mismatch"] is True and result["inputs_changed"] is False
    assert "FINGERPRINT MISMATCH with the module" in capsys.readouterr().err
    assert any("fingerprint mismatch with the module" in st["title"] for st in s.rows("agent_step", work_item_id=WI))
    assert bank.transfers == []


def test_a_crash_after_record_payment_is_finished_exactly_once(tmp_path, bank, monkeypatch):
    s = build(tmp_path)
    p, res = approve(s)
    assert res.ok
    real_finish, calls = supplier_gateway._finish, []

    def killed_once(*a):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("worker killed right after record_payment")
        return real_finish(*a)

    monkeypatch.setattr(supplier_gateway, "_finish", killed_once)
    worker.drain(s)
    job = s.rows("job", id=f"job_pay_{p['id']}")[0]
    assert job["status"] == "queued" and s.rows("payment", id=p["id"])  # paid, books not done yet
    assert s.rows("deposit_allocation") == [] and books(s).get(L.AP, 0) == 0 and L.material_cost(PROJECT.id) not in books(s)
    s.advance(10)
    worker.drain(s)
    assert s.rows("job", id=f"job_pay_{p['id']}")[0]["status"] == "done"
    assert len(bank.transfers) == 1 and len(s.rows("payment")) == 1
    assert len(s.rows("deposit_allocation")) == 1
    journals = [l["journal_id"] for l in s.rows("ledger_line")]
    assert len(journals) == 2 * len(set(journals))  # every journal posted once (two lines each)
    assert books(s)[L.AP] == 0 and -books(s)[L.CASH] == 8_370_000


def test_a_bank_timeout_and_a_duplicate_job_still_pay_once(tmp_path, bank):
    s = build(tmp_path)
    p, res = approve(s)
    assert res.ok
    bank.fail_next_after_send = True  # the bank takes the transfer, then times out
    worker.drain(s)
    first = json.loads(s.rows("job", id=f"job_pay_{p['id']}")[0]["result_json"])
    assert first["status"] == "settled" and first["recovered_after_timeout"] is True
    ledger_before = len(s.rows("ledger_line"))
    again = supplier_gateway.pay_supplier(s, p["id"])  # e.g. a duplicate settlement callback
    assert again["status"] == "settled"
    assert len(bank.transfers) == 1 and len(s.rows("ledger_line")) == ledger_before and len(s.rows("deposit_allocation")) == 1


def test_a_deposit_is_applied_once_and_never_over(tmp_path, bank):
    s = build(tmp_path)
    assert R.record_deposit_allocation(s, "alloc_a", DEPOSIT.id, INVOICE_ID, 600_000).ok
    assert R.record_deposit_allocation(s, "alloc_b", DEPOSIT.id, INVOICE_ID, 100_000).outcome == "invalid"  # same invoice
    assert R.record_invoice(s, "agent", "inv_other", BAYMIX.id, PURCHASE_ID, "BM-99", "2026-10-30", "2026-11-29").ok
    assert R.record_deposit_allocation(s, "alloc_c", DEPOSIT.id, "inv_other", 500_000).outcome == "invalid"  # over the deposit
    assert R.record_deposit_allocation(s, "alloc_d", DEPOSIT.id, "inv_other", 400_000, role="agent").outcome == "denied"
