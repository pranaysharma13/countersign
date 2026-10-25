"""Reset the v2 demo after `spacetime publish --delete-data`.

Claims admin, re-registers the seven roles with the identities already in .env (so web/.env.local
doesn't change), sets the authority limits, and loads baymix_opening.json then judge_sandbox.json.
The registrations and limits come from the opening seed itself. Every call has a fixed request id,
so running it twice is harmless: the second run is all duplicates.
"""

from __future__ import annotations

import json
from typing import Any

from .sandbox import SANDBOX_SEED
from .store import Store, one
from .supplier_seed import SEEDS_DIR, fixed_request_id, replay

ROLES = ("owner", "bookkeeper", "agent", "gateway", "sync", "purchasing", "receiver")
SEED_FILES = ("baymix_opening.json", SANDBOX_SEED)


class ResetError(RuntimeError):
    pass


def seeds() -> dict[str, list[dict[str, Any]]]:
    return {name: json.loads((SEEDS_DIR / name).read_text()) for name in SEED_FILES}


def reset(store: Store, identities: dict[str, str], admin_identity: str) -> list[str]:
    """`identities`: role -> identity for the seven roles; `admin_identity`: the admin token's identity."""
    missing = [r for r in ROLES if not identities.get(r)]
    if missing:
        raise ResetError(f"no identity for {', '.join(missing)}")
    log = []
    res = store.call("admin", "claim_admin", request_id=fixed_request_id("claim_admin", 0))
    if res.outcome == "denied":  # claimed outside this script (e.g. setup_actors.py): fine if it's our admin
        admin = one(store, "actor", role="admin")
        if admin is None or str(admin["identity"]).lower().removeprefix("0x") != admin_identity.lower().removeprefix("0x"):
            raise ResetError(f"another identity is admin: {res.message}")
    log.append(f"claim_admin: {res.outcome}")
    for name, calls in seeds().items():
        outcomes: dict[str, int] = {}
        for i, (call, result) in enumerate(zip(calls, replay(store, calls, identities, id_seed=name))):
            if not result.ok:
                raise ResetError(f"{name} call {i + 1} ({call['role']} {call['reducer']}): {result.outcome} {result.message}")
            outcomes[result.outcome] = outcomes.get(result.outcome, 0) + 1
        log.append(f"{name}: {len(calls)} calls ({', '.join(f'{v} {k}' for k, v in sorted(outcomes.items()))})")
    return log
