"""Reset the v2 demo after the module was republished with clean data (`spacetime publish --delete-data`).

    uv run --project core python scripts/reset_demo_v2.py

Claims admin, re-registers the seven roles with the SAME identities from .env (tokens stay valid, so
web/.env.local doesn't change), sets the authority limits, loads baymix_opening.json and
judge_sandbox.json, then checks the module against the Python reference. Safe to run twice.
Start run_worker.py after it.
"""

import os
import sys

import _path  # noqa: F401
import httpx

from countersign import demo_reset, seed_check
from countersign.store import SpacetimeStore, StoreError


def main() -> int:
    ids = {r: os.getenv(f"SPACETIMEDB_{r.upper()}_IDENTITY", "") for r in demo_reset.ROLES}
    admin_identity = os.getenv("SPACETIMEDB_ADMIN_IDENTITY", "")
    store = SpacetimeStore()
    missing = [f"SPACETIMEDB_{r.upper()}_IDENTITY" for r, v in ids.items() if not v]
    missing += [f"SPACETIMEDB_{r.upper()}_TOKEN" for r in ("admin", "sync", "agent", "purchasing") if not store.tokens.get(r)]
    if not admin_identity:
        missing.append("SPACETIMEDB_ADMIN_IDENTITY")
    if missing:
        print(f"Missing in .env: {', '.join(missing)} (printed by scripts/setup_actors.py)")
        return 1
    try:
        for line in demo_reset.reset(store, ids, admin_identity):
            print(line)
        problems = seed_check.compare(store, seed_check.reference(list(demo_reset.seeds().values())))
    except (httpx.HTTPError, StoreError) as e:
        print(f"Can't reach the module at {store.base} ({store.database}): {e}. Is `spacetime start` running and published?")
        return 1
    except demo_reset.ResetError as e:
        print(f"Reset stopped: {e}")
        return 1
    if problems:
        print(f"\nMISMATCH: the module and the Python reference disagree in {len(problems)} place(s):", file=sys.stderr)
        for line in problems:
            print(f"  - {line}", file=sys.stderr)
        return 2
    print("Check: the module agrees with the Python reference. Start run_worker.py.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
