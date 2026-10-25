"""Load the BayMix seeds into the real SpacetimeDB module over HTTP.

    uv run --project core python scripts/load_supplier_seed.py          # the demo's opening state + judge sandbox
    uv run --project core python scripts/load_supplier_seed.py --all    # plus BayMix's reply and revision 2

Needs a published module, actors from scripts/setup_actors.py, and their tokens in .env (the admin
token too: the seed registers actors and sets authority limits). `<identity:role>` placeholders
are replaced with SPACETIMEDB_<ROLE>_IDENTITY from .env, or the identity in the module's actor
table. Calls run in order with fresh request ids; a duplicate is fine, anything else stops the load. A seed the
module already matches (e.g. after scripts/reset_demo_v2.py) is skipped, so running this twice is safe.

Right after loading (start the worker only after this), it checks that the module agrees with the
Python reference (countersign/seed_check.py) and prints every mismatch. --check-only skips loading.
"""

import argparse
import json
import os

import _path  # noqa: F401
import httpx

from countersign import seed_check
from countersign.sandbox import SANDBOX_SEED
from countersign.store import SpacetimeStore, StoreError
from countersign.supplier_seed import SEEDS_DIR, replay

ROLES = ("owner", "bookkeeper", "agent", "gateway", "sync", "purchasing", "receiver")


def identities(store: SpacetimeStore) -> dict[str, str]:
    on_file = {str(a["role"]): str(a["identity"]) for a in store.rows("actor")}
    return {r: os.getenv(f"SPACETIMEDB_{r.upper()}_IDENTITY") or on_file.get(r, "") for r in ROLES}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", action="store_true", help="also load the correction (reply + revision 2)")
    ap.add_argument("--check-only", action="store_true", help="don't load; only compare the module with the reference")
    args = ap.parse_args()
    store = SpacetimeStore()
    try:
        ids = identities(store)
    except (httpx.HTTPError, StoreError) as e:
        print(f"Can't read the module at {store.base} ({store.database}): {e}. Is `spacetime start` running and published?")
        return 1
    seeds = {name: json.loads((SEEDS_DIR / name).read_text())
             for name in ["baymix_opening.json", SANDBOX_SEED] + (["baymix_correction.json"] if args.all else [])}
    missing = [f"{r} identity" for r, i in ids.items() if not i]
    missing += [f"{r} token" for r in sorted({c["role"] for calls in seeds.values() for c in calls}) if not store.tokens.get(r)]
    if missing:
        print(f"Missing: {', '.join(missing)}. Run scripts/setup_actors.py and paste its output into .env.")
        return 1
    so_far: list[list[dict]] = []
    for name, calls in ({} if args.check_only else seeds).items():
        so_far.append(calls)
        if not seed_check.compare(store, seed_check.reference(so_far)):  # e.g. reset_demo_v2.py already loaded it
            print(f"{name}: already loaded, skipped")
            continue
        for n, call in enumerate(calls, start=1):
            res = replay(store, [call], ids)[0]
            if not res.ok:
                print(f"{name} call {n} ({call['role']} {call['reducer']}): {res.outcome} {res.message}")
                return 1
        print(f"{name}: {len(calls)} calls ok")
    problems = seed_check.compare(store, seed_check.reference(list(seeds.values())))
    if problems:
        print(f"\nMISMATCH: the module and the Python reference disagree in {len(problems)} place(s):")
        for line in problems:
            print(f"  - {line}")
        return 2
    print("Check: the module agrees with the Python reference (rows and assessment fingerprints).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
