"""Scorecard v2: every supplier-invoice scenario run offline through the real pipeline, graded against the
hand-written answer key. Free and deterministic (fixture extraction, scripted agent, mock bank).

    uv run --project core python scripts/run_scorecard_v2.py

Writes data/scorecard_v2.json and data/scorecard_v2.md (a table for the slide). Exit 1 if any scenario
missed a hold, held something unexpected or got an amount wrong; the files are written either way.
"""

import sys

import _path  # noqa: F401

from countersign import scorecard_v2


def main() -> int:
    report = scorecard_v2.run()
    scorecard_v2.write(report)
    print(scorecard_v2.markdown(report))
    print(f"Wrote {scorecard_v2.OUT_JSON} and {scorecard_v2.OUT_MD}")
    bad = [r for r in report["scenarios"] if r["missed"] or r["false"] or not r["all_exact"]]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
