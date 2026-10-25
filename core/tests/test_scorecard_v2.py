"""Scorecard v2: the hand-written key agrees with the BayMix answer key, the grader counts what it should,
and the committed scorecard files are what the pipeline measures today."""

import json

from countersign import scorecard_v2 as S
from countersign.config import DATA_DIR

PRIMARY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())


def test_the_bm23104_scenarios_match_the_primary_answer_key():
    key = {sc["id"]: sc for sc in S.load_key()["scenarios"]}
    r1, r2, st = PRIMARY["revision_1"], PRIMARY["revision_2"], PRIMARY["settlement"]
    assert key["baymix_r1"]["holds"] == r1["holds"]
    assert {k: r1[k] for k in key["baymix_r1"]["amounts"]} == key["baymix_r1"]["amounts"]
    assert key["baymix_r2"]["holds"] == r2["holds_after_receipt"]
    assert {k: r2[k] for k in key["baymix_r2"]["amounts"]} == key["baymix_r2"]["amounts"]
    assert {k: st[k] for k in key["baymix_r2"]["settlement"]} == key["baymix_r2"]["settlement"]
    assert key["baymix_r2"]["proposal_cents"] == st["settled_cents"]


def test_the_grader_counts_misses_false_holds_and_wrong_amounts():
    sc = {"id": "x", "title": "x", "group": "g", "clean": False, "why": "", "holds": {"PRICE_VARIANCE": 350_000, "RECEIPT_NOT_VERIFIED": 0},
          "amounts": {"claimed_cents": 100}, "proposal_cents": None}
    obs = {"invoice_number": "X-1", "holds": {"PRICE_VARIANCE": 349_999, "DUPLICATE_REVIEW": 0},
           "amounts": {"claimed_cents": 100}, "proposal_cents": 5}
    r = S.grade(sc, obs)
    assert (r["caught"], r["missed"], r["false"]) == (["PRICE_VARIANCE"], ["RECEIPT_NOT_VERIFIED"], ["DUPLICATE_REVIEW"])
    assert [a["exact"] for a in r["amounts"]] == [False, True, False]  # hold amount, claimed, the proposal nobody expected
    pr = S._pr([r])
    assert (pr["precision"], pr["recall"]) == (0.5, 0.5)


def test_a_sandbox_price_rule_uses_the_line_as_submitted():
    sc = {"holds": {"PRICE_VARIANCE": {"rule": "billed_qty_x_unit_minus_quoted", "quoted_unit_cents": 16_500}}}
    obs = {"submitted_lines": [{"quantity_milli": 9_000, "unit_price_cents": 17_200, "amount_cents": 154_800}]}
    assert S.expected_holds(sc, obs) == {"PRICE_VARIANCE": 6_300}


def test_the_committed_scorecard_is_current():
    report = S.run()
    committed = json.loads(S.OUT_JSON.read_text())
    report["live_extraction"] = committed["live_extraction"]  # a recorded measurement, or a newer local run
    assert committed == report, "stale scorecard: run `uv run --project core python scripts/run_scorecard_v2.py`"
    assert S.OUT_MD.read_text() == S.markdown(report)
    assert report["summary"]["bm23104_untouched_by_sandbox"] is True
