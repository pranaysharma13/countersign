"""Load the demo company into the module: subs, contracts, change orders, 6 months of paid history.

    uv run --project core python scripts/load_seed.py

Uses the sync token, plus the owner token to confirm contracts and approve change orders
(seed only). Safe to re-run: every write is an idempotent upsert.
"""

import _path  # noqa: F401

from countersign.config import settings
from countersign.pipeline import load_seed
from countersign.store import SpacetimeStore, get_store
from countersign.world import build_world


def main() -> None:
    store = get_store()
    owner = store if settings.store_backend == "fake" else (
        SpacetimeStore(tokens={"owner": settings.tokens["owner"]}) if settings.tokens.get("owner") else None)
    if owner is None:
        print("No SPACETIMEDB_OWNER_TOKEN in .env: contracts will stay 'draft' until the owner confirms them in the web app.")
    print(load_seed(store, build_world(), owner=owner))


if __name__ == "__main__":
    main()
