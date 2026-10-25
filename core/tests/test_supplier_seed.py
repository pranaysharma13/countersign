"""data/seeds/baymix_opening.json + baymix_correction.json: current, named in contract order, and exact on replay."""

import json
import re

import pytest

from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.commercial import assess, bundle_from_store, record
from countersign.config import DATA_DIR, REPO_ROOT
from countersign.fake_store import FakeStore
from countersign.supplier_seed import SEEDS_DIR, export_seeds, identity_placeholder, reducer_params, replay, seed_bytes
from countersign.supplier_world import DEPOSIT, INVOICE_ID, PROJECT, REV1_ID, REV2_ID, WAITING_CR_ID, WEEKEND_CR_ID

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())
FILES = ("baymix_opening.json", "baymix_correction.json")
SEEDS = {name: json.loads((SEEDS_DIR / name).read_text()) for name in FILES}


def calls():
    return [c for name in FILES for c in SEEDS[name]]


def test_committed_seeds_are_current_and_byte_identical():
    first, second = export_seeds(), export_seeds()
    assert list(first) == list(FILES)
    for name in FILES:
        assert seed_bytes(first[name]) == seed_bytes(second[name])
        assert (SEEDS_DIR / name).read_bytes() == seed_bytes(first[name]), \
            f"stale {name}: run `uv run --project core python scripts/export_supplier_seed.py`"


def test_every_call_has_named_args_in_contract_order_and_no_request_id():
    for c in calls():
        assert list(c) == ["role", "reducer", "args"]
        assert list(c["args"]) == reducer_params(c["reducer"]), c["reducer"]
        assert "request_id" not in c["args"]


def test_arg_names_match_the_typescript_module():
    ts_file = REPO_ROOT / "db" / "src" / "reducer_args.ts"
    if not ts_file.exists():
        pytest.skip("db/ not checked out")
    ts = {m.group(1): re.findall(r'"(\w+)"', m.group(2))[1:]
          for m in re.finditer(r"^\s+(\w+): \[(.*)\],$", ts_file.read_text(), re.M)}
    for c in calls():
        assert list(c["args"]) == ts[c["reducer"]], c["reducer"]


def test_identity_args_are_placeholders():
    seen = [c for c in calls() if c["reducer"] in {"register_actor", "set_authority"}]
    assert {c["reducer"] for c in seen} == {"register_actor", "set_authority"}
    for c in seen:
        assert c["args"]["identity_hex"] == identity_placeholder(c["args"]["role"]) == f"<identity:{c['args']['role']}>"
    assert "claim_admin" not in {c["reducer"] for c in calls()}  # the replayer's admin claims it


def test_opening_stops_at_the_drafted_clarification():
    opening = SEEDS["baymix_opening.json"]
    reducers = [c["reducer"] for c in opening]
    assert reducers[-1] == "draft_outbox"
    for needed in ("record_email", "upsert_purchase", "record_term", "propose_change_request", "decide_change_request",
                   "record_supplier_acceptance", "record_deposit", "post_journal", "record_invoice", "record_invoice_line",
                   "record_assessment", "open_hold"):
        assert needed in reducers, needed
    assert not any(c["args"].get("document_id", "").startswith(("doc_em_reply", "doc_bm_inv_23104_r2")) for c in opening)


def test_round_trip_reproduces_the_exact_values():
    store = FakeStore()
    assert {r.outcome for r in replay(store, SEEDS["baymix_opening.json"])} == {"ok"}
    a1 = store.rows("assessment", revision_id=REV1_ID)[0]
    rev1 = store.rows("invoice_revision", id=REV1_ID)[0]
    r1 = KEY["revision_1"]
    assert a1["claimed_cents"] == r1["claimed_cents"] == 8_742_500  # $87,425
    assert rev1["balance_requested_cents"] == r1["balance_requested_cents"] == 7_742_500  # $77,425
    assert a1["variance_cents"] == 350_000 and a1["pending_cents"] == 22_500  # $3,500 and $225
    assert a1["variance_cents"] + a1["pending_cents"] == r1["under_review_cents"] == 372_500  # $3,725
    assert a1["authorised_cents"] == 8_370_000 and a1["deposit_available_cents"] == 1_000_000  # $83,700, $10,000
    assert a1["proposed_payment_cents"] == 0
    assert {h["code"]: h["amount_cents"] for h in store.rows("hold", revision_id=REV1_ID)} == r1["holds"]
    assert store.rows("change_request", id=WEEKEND_CR_ID)[0]["classification"] == "AUTHORISED_FIXED"
    clar = KEY["clarification"]
    ob = store.rows("outbox", id=clar["outbox_id"])[0]
    assert (ob["status"], ob["simulated"], ob["subject"], ob["to_contact_id"]) == ("draft", True, clar["subject"], clar["to_contact_id"])

    assert {r.outcome for r in replay(store, SEEDS["baymix_correction.json"])} == {"ok"}
    assert store.rows("change_request", id=WAITING_CR_ID)[0]["classification"] == "DECLINED"
    a2 = store.rows("assessment", revision_id=REV2_ID)[0]
    assert (a2["claimed_cents"], a2["proposed_payment_cents"], a2["commercial_status"]) == (8_370_000, 7_370_000, "matches")
    assert [h["code"] for h in store.rows("hold", revision_id=REV2_ID, status="open")] == ["RECEIPT_NOT_VERIFIED"]

    # The demo's live steps after the seeds: receipt, reassessment, then (step E) approval and settlement.
    assert R.attest_receipt(store, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour").ok
    a3 = assess(bundle_from_store(store, INVOICE_ID))
    record(store, a3)
    assert (a3.hold_amounts(), a3.proposed_payment_cents) == ({}, 7_370_000)  # $73,700
    for j in (L.bill_accepted(INVOICE_ID, REV2_ID, PROJECT.id, a3.claimed_cents, "2026-10-24"),
              L.deposit_applied(INVOICE_ID, DEPOSIT.id, a3.deposit_applied_cents, "2026-10-24"),
              L.settlement(INVOICE_ID, a3.proposed_payment_cents, "2026-10-24")):
        assert L.post(store, "gateway", j).ok
    bal = L.balances(store.rows("ledger_line"))
    assert bal[L.AP] == 0 and -bal[L.CASH] == KEY["settlement"]["cash_out_cents"] == 8_370_000  # AP $0, $83,700 out


def test_placeholders_map_to_the_replayers_identities():
    store = FakeStore()
    ids = {r: f"0x{i:064x}" for i, r in enumerate(("owner", "purchasing", "receiver", "bookkeeper", "agent", "gateway", "sync"), 1)}
    replay(store, SEEDS["baymix_opening.json"][:20], ids)
    assert {a["identity"] for a in store.rows("authority")} <= set(ids.values())
    assert {a["identity"] for a in store.rows("actor") if a["role"] != "admin"} <= set(ids.values())
