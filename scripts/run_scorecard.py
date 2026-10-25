"""Print the offline scorecard (no APIs, deterministic).

    uv run --project core python scripts/run_scorecard.py
"""

import _path  # noqa: F401

from countersign.money import fmt
from countersign.scorecard import run_offline


def main() -> None:
    results, t = run_offline()
    print(f"Scams caught:        {t['scams_caught']} / {t['scams']}")
    print(f"Real bills paid:     {t['legit_paid']} / {t['legit']}  (wrongly held: {t['legit_wrongly_held']})")
    print(f"Dollars protected:   {fmt(t['dollars_protected_cents'])}   lost: {fmt(t['dollars_lost_cents'])}")
    print(f"Expected check fired on {t['expected_check_fired']} / {t['scams']} scams")
    for k, v in t["per_type"].items():
        print(f"  {k:24} {v['correct']:>3} / {v['total']}")


if __name__ == "__main__":
    main()
