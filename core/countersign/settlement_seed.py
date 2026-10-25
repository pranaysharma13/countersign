"""The "BayMix won't correct" path (CONTRACT §9.9) as a replayable seed, recorded on the Python reference:
from the opening state, the owner decides the price line and the waiting line as "pay agreed, dispute the
rest", both notices are sent, the superintendent attests receipt, and the agent proposes $73,700. It stops
before the owner's approval, so the module's own rules (and the gateway) are exercised by whoever replays it.

Written to data/seeds/baymix_wont_correct.json by scripts/export_supplier_seed.py. Every call is what the
worker and the people make, in order (jobs claimed and finished included); no dates from the clock.
"""

from __future__ import annotations

import json
from typing import Any

from . import reducers as R
from . import worker
from .fake_store import FakeStore
from .supplier_seed import SEEDS_DIR, RecordingStore, replay
from .supplier_world import INVOICE_ID, REV1_ID

WONT_CORRECT_SEED = "baymix_wont_correct.json"
DECISIONS = (("dec_bm_price", "ln_bm23104_r1_1", 350_000), ("dec_bm_waiting", "ln_bm23104_r1_3", 22_500))
NOTE = "BayMix won't correct the invoice: pay what was agreed and dispute the rest"


def _ok(res: R.Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"wont_correct {what}: {res.outcome} {res.message}")


def _latest_fp(store) -> str:
    return max(store.rows("assessment", revision_id=REV1_ID), key=lambda a: a["version"])["fingerprint"]


def export_wont_correct_seed() -> list[dict[str, Any]]:
    inner = FakeStore()
    for res in replay(inner, json.loads((SEEDS_DIR / "baymix_opening.json").read_text())):
        _ok(res, "opening seed")
    rec = RecordingStore(inner)
    for decision_id, line_id, cents in DECISIONS:
        _ok(R.decide_disputed_line(rec, "owner", decision_id, line_id, "pay_agreed_dispute_rest", cents, _latest_fp(rec),
                                   "ctc_baymix_ar", NOTE), decision_id)
        worker.drain(rec)  # the module queued reassess_invoice
    for decision_id, _, _ in DECISIONS:
        _ok(R.approve_outbox(rec, "owner", f"ob_{decision_id}"), f"notice {decision_id}")
    _ok(R.attest_receipt(rec, "att_bm_500", INVOICE_ID, "All pours, Oct 5-22", 500_000, "cy",
                         "Checked against the pour log"), "receipt")
    worker.drain(rec)  # notices sent (simulated), reassessed, $73,700 proposed
    if not [p for p in rec.rows("proposal", work_item_id=f"wi_{INVOICE_ID}") if p["status"] == "pending"]:
        raise RuntimeError("wont_correct: no payment proposed")
    return rec.take()
