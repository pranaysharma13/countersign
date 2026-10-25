"""The committed "BayMix won't correct" seed (CONTRACT §9.9) is current, deterministic, and replays on the reference."""

import json

from countersign.fake_store import FakeStore
from countersign.settlement_seed import WONT_CORRECT_SEED, export_wont_correct_seed
from countersign.supplier_seed import SEEDS_DIR, replay, seed_bytes
from countersign.supplier_world import INVOICE_ID, REV1_ID


def test_committed_seed_is_current_and_byte_identical():
    first, second = export_wont_correct_seed(), export_wont_correct_seed()
    assert seed_bytes(first) == seed_bytes(second)
    assert (SEEDS_DIR / WONT_CORRECT_SEED).read_bytes() == seed_bytes(first), \
        f"stale {WONT_CORRECT_SEED}: run `uv run --project core python scripts/export_supplier_seed.py`"


def test_it_replays_to_a_proposal_of_73700_with_both_lines_disputed():
    s = FakeStore()
    for name in ("baymix_opening.json", WONT_CORRECT_SEED):
        assert all(r.ok for r in replay(s, json.loads((SEEDS_DIR / name).read_text())))
    assert {h["code"]: h["status"] for h in s.rows("hold", revision_id=REV1_ID) if h["code"] in {"PRICE_VARIANCE", "PROPOSED_CHARGE"}} \
        == {"PRICE_VARIANCE": "disputed", "PROPOSED_CHARGE": "disputed"}
    assert s.rows("invoice", id=INVOICE_ID)[0]["commercial_status"] == "partially_disputed"
    assert {o["status"] for o in s.rows("outbox") if o["id"].startswith("ob_dec_bm_")} == {"sent"}
    pending = [p for p in s.rows("proposal", work_item_id=f"wi_{INVOICE_ID}") if p["status"] == "pending"]
    assert [p["amount_cents"] for p in pending] == [7_370_000]
