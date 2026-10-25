"""Export the BayMix primary scenario as a JSON seed for the web's local backend.

    uv run --project core python scripts/export_supplier_seed.py

Writes data/seeds/baymix_primary.json (committed): staged reducer calls in CONTRACT order plus the
document bytes. Re-run after changing the fixtures, the world or the assessment; a test fails if
the committed file is stale.
"""

import json

import _path  # noqa: F401

from countersign.supplier_seed import SEED_PATH, export_primary_seed


def main() -> None:
    seed = export_primary_seed()
    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text(json.dumps(seed, indent=1) + "\n")
    for s in seed["stages"]:
        print(f"{s['name']:14} {len(s['calls']):>4} calls  {s['description']}")
    print(f"\n{len(seed['documents'])} documents, roles: {', '.join(seed['conventions']['roles_needed'])}")
    print(f"Wrote {SEED_PATH}")


if __name__ == "__main__":
    main()
