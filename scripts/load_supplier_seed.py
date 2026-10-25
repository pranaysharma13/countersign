"""Load the BayMix seeds into the real SpacetimeDB module over HTTP.

    uv run --project core python scripts/load_supplier_seed.py          # the demo's opening state
    uv run --project core python scripts/load_supplier_seed.py --all    # plus BayMix's reply and revision 2

Needs a published module, actors from scripts/setup_actors.py, and their tokens in .env (the admin
token too: the seed registers actors and sets authority limits). `<identity:role>` placeholders
are replaced with SPACETIMEDB_<ROLE>_IDENTITY from .env, or the identity in the module's actor
table. Calls run in order with fresh request ids; a duplicate is fine, anything else stops the load.
"""

import argparse
import json
import os

import _path  # noqa: F401
import httpx

from countersign.store import SpacetimeStore, StoreError
from countersign.supplier_seed import SEEDS_DIR, replay

ROLES = ("owner", "bookkeeper", "agent", "gateway", "sync", "purchasing", "receiver")


def identities(store: SpacetimeStore) -> dict[str, str]:
    on_file = {str(a["role"]): str(a["identity"]) for a in store.rows("actor")}
    return {r: os.getenv(f"SPACETIMEDB_{r.upper()}_IDENTITY") or on_file.get(r, "") for r in ROLES}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--all", action="store_true", help="also load the correction (reply + revision 2)")
    args = ap.parse_args()
    store = SpacetimeStore()
    try:
        ids = identities(store)
    except (httpx.HTTPError, StoreError) as e:
        print(f"Can't read the module at {store.base} ({store.database}): {e}. Is `spacetime start` running and published?")
        return 1
    seeds = {name: json.loads((SEEDS_DIR / name).read_text())
             for name in ["baymix_opening.json"] + (["baymix_correction.json"] if args.all else [])}
    missing = [f"{r} identity" for r, i in ids.items() if not i]
    missing += [f"{r} token" for r in sorted({c["role"] for calls in seeds.values() for c in calls}) if not store.tokens.get(r)]
    if missing:
        print(f"Missing: {', '.join(missing)}. Run scripts/setup_actors.py and paste its output into .env.")
        return 1
    for name, calls in seeds.items():
        for n, call in enumerate(calls, start=1):
            res = replay(store, [call], ids)[0]
            if not res.ok:
                print(f"{name} call {n} ({call['role']} {call['reducer']}): {res.outcome} {res.message}")
                return 1
        print(f"{name}: {len(calls)} calls ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
