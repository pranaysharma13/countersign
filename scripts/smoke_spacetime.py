"""Go/no-go check (CHECKLIST ~3:45 PM): can Python call the module over HTTP?

Ask the TypeScript developer for their test reducer, then run, from the repo root:

    uv run --project core python scripts/smoke_spacetime.py \
        --reducer add_note --args '["hello from python"]' --sql "SELECT * FROM note"

It creates a throwaway identity, calls the reducer with a positional JSON array,
and reads the table back with SQL.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))

import httpx  # noqa: E402

from countersign.config import settings  # noqa: E402
from countersign.store import parse_sql_response  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uri", default=settings.spacetimedb_uri)
    ap.add_argument("--database", default=settings.spacetimedb_database)
    ap.add_argument("--reducer", required=True)
    ap.add_argument("--args", default="[]", help="JSON array of positional args")
    ap.add_argument("--sql", required=True)
    a = ap.parse_args()
    base = a.uri.rstrip("/")

    with httpx.Client(timeout=20) as http:
        r = http.post(f"{base}/v1/identity")
        print(f"1. POST /v1/identity -> {r.status_code}")
        if r.status_code >= 300:
            print(r.text)
            return 1
        ident = r.json()
        token = ident.get("token", "")
        print(f"   identity: {str(ident.get('identity', ''))[:16]}…  (token received: {bool(token)})")
        headers = {"Authorization": f"Bearer {token}"}

        args = json.loads(a.args)
        r = http.post(f"{base}/v1/database/{a.database}/call/{a.reducer}", json=args, headers=headers)
        print(f"2. call {a.reducer}({args}) -> {r.status_code} {r.text[:300]}")
        if r.status_code >= 300:
            return 1

        r = http.post(f"{base}/v1/database/{a.database}/sql", content=a.sql.encode(), headers=headers)
        print(f"3. SQL {a.sql!r} -> {r.status_code}")
        if r.status_code >= 300:
            print(r.text)
            return 1
        rows = parse_sql_response(r.json())
        for row in rows[-5:]:
            print("  ", row)
        print("\nGO: Python can call reducers and read tables." if rows else "\nCalled OK but no rows came back; check the SQL.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
