"""Export the BayMix primary scenario as replayable seeds for the web's local backend.

    uv run --project core python scripts/export_supplier_seed.py

Writes data/seeds/baymix_opening.json and data/seeds/baymix_correction.json (committed): ordered
lists of {"role", "reducer", "args"} with named args in CONTRACT order. Same bytes every run. Re-run
after changing the fixtures, the world, the assessment or the clarification; a test fails if stale.
"""

import _path  # noqa: F401

from countersign.companion_seed import COMPANION_SEED, export_companion_seed, write_companion_fixtures
from countersign.supplier_seed import SEEDS_DIR, export_seeds, seed_bytes


def main() -> None:
    SEEDS_DIR.mkdir(parents=True, exist_ok=True)
    write_companion_fixtures()
    for name, calls in export_seeds().items():
        (SEEDS_DIR / name).write_bytes(seed_bytes(calls))
        reducers = sorted({c["reducer"] for c in calls})
        print(f"{name:26} {len(calls):>4} calls  {', '.join(reducers)}")
    companions = export_companion_seed()
    (SEEDS_DIR / COMPANION_SEED).write_bytes(seed_bytes(companions))
    print(f"{COMPANION_SEED:26} {len(companions):>4} calls  {', '.join(sorted({c['reducer'] for c in companions}))}")
    print(f"Wrote {SEEDS_DIR}")


if __name__ == "__main__":
    main()
