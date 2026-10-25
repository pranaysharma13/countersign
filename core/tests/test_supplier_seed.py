"""data/seeds/baymix_primary.json: current, loadable through the module rules, and exact."""

import base64
import json

from countersign.config import DATA_DIR
from countersign.fake_store import FakeStore
from countersign.ids import sha256_hex
from countersign.supplier_seed import SEED_PATH, export_primary_seed, identity_placeholder

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())
SEED = json.loads(SEED_PATH.read_text())
ROLES = ("admin", "owner", "purchasing", "receiver", "bookkeeper")


def _resolve(arg):
    """The fake store's identities are role names."""
    return next((r for r in ROLES if arg == identity_placeholder(r)), arg)


def replay(store, stages):
    outcomes = []
    for stage in stages:
        for c in stage["calls"]:
            args = [_resolve(a) for a in c["args"]]
            outcomes.append(store.call(c["role"], c["reducer"], *args, request_id=c["request_id"]).outcome)
    return outcomes


def latest_assessment(store, revision_id):
    return max(store.rows("assessment", revision_id=revision_id), key=lambda a: a["version"])


def test_committed_seed_is_current():
    assert SEED == json.loads(json.dumps(export_primary_seed())), \
        "stale seed: run `uv run --project core python scripts/export_supplier_seed.py`"


def test_seed_replays_through_the_module_rules_to_the_exact_values():
    store = FakeStore()
    stages = {s["name"]: s for s in SEED["stages"]}
    assert list(stages) == ["people", "purchase", "invoice_r1", "correction_r2", "receipt"]
    assert set(replay(store, [stages["people"], stages["purchase"], stages["invoice_r1"]])) == {"ok"}
    a1 = latest_assessment(store, "rev_bm23104_r1")
    r1 = KEY["revision_1"]
    assert (a1["claimed_cents"], a1["authorised_cents"], a1["variance_cents"], a1["pending_cents"], a1["proposed_payment_cents"]) == \
        (r1["claimed_cents"], r1["authorised_cents"], r1["variance_cents"], r1["pending_cents"], r1["proposed_payment_cents"])
    assert {h["code"]: h["amount_cents"] for h in store.rows("hold", revision_id="rev_bm23104_r1")} == r1["holds"]

    assert set(replay(store, [stages["correction_r2"], stages["receipt"]])) == {"ok"}
    a3 = latest_assessment(store, "rev_bm23104_r2")
    assert (a3["claimed_cents"], a3["proposed_payment_cents"], a3["commercial_status"]) == (8_370_000, 7_370_000, "matches")
    assert store.rows("hold", revision_id="rev_bm23104_r2", status="open") == []
    inv = store.rows("invoice", id="inv_bm23104")[0]
    assert (inv["receipt_status"], inv["payee_status"], inv["active_revision_id"]) == ("manually_confirmed", "verified", "rev_bm23104_r2")
    assert {r["mode"] for r in store.rows("extraction_run")} == {"fixture"}


def test_loading_the_seed_twice_changes_nothing():
    store = FakeStore()
    replay(store, SEED["stages"])
    before = {t: len(rows) for t, rows in store.tables.items() if t not in {"audit_log", "request_result"}}
    assert set(replay(store, SEED["stages"])) == {"duplicate"}
    assert {t: len(rows) for t, rows in store.tables.items() if t not in {"audit_log", "request_result"}} == before


def test_seed_documents_match_what_was_recorded():
    recorded = {c["args"][0]: c["args"][3] for s in SEED["stages"] for c in s["calls"] if c["reducer"] == "record_document"}
    assert len(SEED["documents"]) == len(recorded) == 8
    for d in SEED["documents"]:
        assert sha256_hex(base64.b64decode(d["base64"])) == d["sha256"] == recorded[d["id"]]
    calls = [c for s in SEED["stages"] for c in s["calls"]]
    assert all(c["args"][0] == identity_placeholder(c["args"][1]) for c in calls if c["reducer"] == "set_authority")
    assert len({c["request_id"] for c in calls}) == len(calls)
