"""One-time setup after publishing the module (CONTRACT §6).

Creates an identity per role, claims admin, registers each actor, and prints the
env lines to paste into .env (Python) and web/.env.local (web). From the repo root:

    uv run --project core python scripts/setup_actors.py

Tokens are printed once to your terminal. Never commit them.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

import httpx  # noqa: E402

from countersign import reducers  # noqa: E402
from countersign.config import settings  # noqa: E402
from countersign.store import SpacetimeStore  # noqa: E402

ROLES = {
    "admin": "Setup script",
    "owner": "Owner (demo)",
    "bookkeeper": "Bookkeeper (demo)",
    "agent": "Countersign agent",
    "gateway": "Payment gateway",
    "sync": "Intake & sync",
    "purchasing": "Purchasing approver (demo)",  # v2: approves change requests within a limit
    "receiver": "Superintendent (demo)",  # v2: attests receipt
}


def main() -> int:
    base = settings.spacetimedb_uri.rstrip("/")
    tokens: dict[str, str] = {}
    identities: dict[str, str] = {}
    with httpx.Client(timeout=20) as http:
        for role in ROLES:
            r = http.post(f"{base}/v1/identity")
            r.raise_for_status()
            body = r.json()
            identities[role] = str(body["identity"])
            tokens[role] = str(body["token"])

    store = SpacetimeStore(tokens=tokens)
    res = reducers.claim_admin(store)
    print(f"claim_admin: {res.outcome} {res.message}")
    if res.outcome not in {"ok", "duplicate"}:
        print("Admin was already claimed. Republish the module with a clean database, or use the existing admin token.")
        return 1
    for role, name in ROLES.items():
        if role == "admin":
            continue
        res = reducers.register_actor(store, identities[role], role, name)
        print(f"register {role}: {res.outcome} {res.message}")

    print("\n# ---- paste into .env (repo root) ----")
    print("# Owner token here is used ONLY by scripts/load_seed.py and reset_demo.py; the worker never loads it.")
    for role in ROLES:
        print(f"SPACETIMEDB_{role.upper()}_TOKEN={tokens[role]}")
    for role in ROLES:
        print(f"SPACETIMEDB_{role.upper()}_IDENTITY={identities[role]}")
    print("\n# ---- send to the TypeScript developer for web/.env.local ----")
    print(f"SPACETIMEDB_OWNER_TOKEN={tokens['owner']}")
    print(f"SPACETIMEDB_BOOKKEEPER_TOKEN={tokens['bookkeeper']}")
    print(f"SPACETIMEDB_PURCHASING_TOKEN={tokens['purchasing']}")
    print(f"SPACETIMEDB_RECEIVER_TOKEN={tokens['receiver']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
