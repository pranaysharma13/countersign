"""Export the BayMix primary scenario as replayable seeds for the web's local backend.

    uv run --project core python scripts/export_supplier_seed.py

Writes data/seeds/baymix_opening.json, baymix_correction.json, queue_companions.json and
judge_sandbox.json (committed, the judge page's sandbox supplier and purchase) and baymix_wont_correct.json
(the §9.9 path, replayed by the module's tests): ordered
lists of {"role", "reducer", "args"} with named args in CONTRACT order. Same bytes every run. Re-run
after changing the fixtures, the world, the assessment or the clarification; a test fails if stale.
"""

import _path  # noqa: F401

from countersign.companion_seed import COMPANION_SEED, export_companion_seed, write_companion_fixtures
from countersign.sandbox import SANDBOX_SEED, export_sandbox_seed
from countersign.settlement_seed import WONT_CORRECT_SEED, export_wont_correct_seed
from countersign.variant_fixtures import write_variant_fixtures
from countersign.supplier_seed import SEEDS_DIR, export_seeds, seed_bytes


def main() -> None:
    SEEDS_DIR.mkdir(parents=True, exist_ok=True)
    write_companion_fixtures()
    write_variant_fixtures()
    for name, calls in export_seeds().items():
        (SEEDS_DIR / name).write_bytes(seed_bytes(calls))
        reducers = sorted({c["reducer"] for c in calls})
        print(f"{name:26} {len(calls):>4} calls  {', '.join(reducers)}")
    companions = export_companion_seed()
    (SEEDS_DIR / COMPANION_SEED).write_bytes(seed_bytes(companions))
    print(f"{COMPANION_SEED:26} {len(companions):>4} calls  {', '.join(sorted({c['reducer'] for c in companions}))}")
    sandbox = export_sandbox_seed()
    (SEEDS_DIR / SANDBOX_SEED).write_bytes(seed_bytes(sandbox))
    print(f"{SANDBOX_SEED:26} {len(sandbox):>4} calls  {', '.join(sorted({c['reducer'] for c in sandbox}))}")
    wont = export_wont_correct_seed()
    (SEEDS_DIR / WONT_CORRECT_SEED).write_bytes(seed_bytes(wont))
    print(f"{WONT_CORRECT_SEED:26} {len(wont):>4} calls  {', '.join(sorted({c['reducer'] for c in wont}))}")
    print(f"Wrote {SEEDS_DIR}")


if __name__ == "__main__":
    main()
