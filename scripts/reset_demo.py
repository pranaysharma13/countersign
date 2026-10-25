"""Reset the demo after the module was republished with clean data
(TypeScript developer: `spacetime publish --delete-data ...`).

Re-claims admin and re-registers the SAME identities (tokens stay valid, so web/.env.local
doesn't change), reloads the seed, and delivers the opening bill.

    uv run --project core python scripts/reset_demo.py
"""

import os

import _path  # noqa: F401

from countersign import reducers as R
from countersign.config import settings
from countersign.pipeline import ingest, load_seed
from countersign.store import SpacetimeStore
from countersign.world import build_world


def main() -> None:
    store = SpacetimeStore()
    print("claim_admin:", R.claim_admin(store).outcome)
    for role in ("owner", "bookkeeper", "agent", "gateway", "sync"):
        ident = os.getenv(f"SPACETIMEDB_{role.upper()}_IDENTITY", "")
        if not ident:
            raise SystemExit(f"Missing SPACETIMEDB_{role.upper()}_IDENTITY in .env (printed by setup_actors.py)")
        print(f"register {role}:", R.register_actor(store, ident, role, role.title()).outcome)
    world = build_world()
    owner = SpacetimeStore(tokens={"owner": settings.tokens["owner"]}) if settings.tokens.get("owner") else None
    print(load_seed(store, world, owner=owner))
    moment = next(d for d in world.current if d.id.endswith("bankchange"))
    print("delivered:", ingest(store, world, moment, "upload"))


if __name__ == "__main__":
    main()
