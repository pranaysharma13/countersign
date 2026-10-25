"""Access to the system of work (the SpacetimeDB module, CONTRACT §0).

App code uses only `Store.call(role, reducer, *args)` and `Store.rows(table, **filters)`,
so it runs unchanged against the real module (SpacetimeStore) or the in-memory
reference (FakeStore, see fake_store.py). Reducer argument order lives in reducers.py.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .config import settings
from .ids import request_id as new_request_id


class StoreError(RuntimeError):
    """The call itself failed (network, HTTP error, reducer crashed)."""


@dataclass(frozen=True)
class Result:
    request_id: str
    outcome: str  # ok | duplicate | denied | invalid
    message: str

    @property
    def ok(self) -> bool:
        return self.outcome in {"ok", "duplicate"}


class Store(Protocol):
    def call(self, role: str, reducer: str, *args: Any, request_id: str | None = None) -> Result: ...

    def rows(self, table: str, **filters: Any) -> list[dict[str, Any]]: ...


def one(store: Store, table: str, **filters: Any) -> dict[str, Any] | None:
    found = store.rows(table, **filters)
    return found[0] if found else None


# ---------------------------------------------------------------------------
# SpacetimeDB over HTTP
# ---------------------------------------------------------------------------


def _sql_literal(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _column_name(element: dict[str, Any]) -> str:
    name = element.get("name")
    if isinstance(name, dict):
        return str(name.get("some", ""))
    return str(name)


def _normalize(value: Any) -> Any:
    """Flatten SpacetimeDB's JSON encodings (timestamps, identities, options)."""
    if isinstance(value, dict):
        if len(value) == 1:
            (key, inner), = value.items()
            if key.startswith("__") and key.endswith("__"):
                return _normalize(inner)
            if key == "some":
                return _normalize(inner)
            if key == "none":
                return None
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], (str, int)):
        return value  # keep simple arrays as-is
    return value


def parse_sql_response(payload: Any) -> list[dict[str, Any]]:
    """SQL endpoint returns [{schema: {elements: [...]}, rows: [[...]]}, ...]."""
    statements = payload if isinstance(payload, list) else [payload]
    out: list[dict[str, Any]] = []
    for stmt in statements:
        elements = (stmt.get("schema") or {}).get("elements") or []
        names = [_column_name(e) for e in elements]
        for row in stmt.get("rows") or []:
            out.append({n: _normalize(v) for n, v in zip(names, row)})
    return out


class SpacetimeStore:
    def __init__(self, uri: str | None = None, database: str | None = None, tokens: dict[str, str] | None = None):
        self.base = (uri or settings.spacetimedb_uri).rstrip("/")
        self.database = database or settings.spacetimedb_database
        self.tokens = tokens if tokens is not None else dict(settings.tokens)
        self.http = httpx.Client(timeout=30)

    def _headers(self, role: str | None) -> dict[str, str]:
        token = self.tokens.get(role or "", "") if role else ""
        return {"Authorization": f"Bearer {token}"} if token else {}

    def raw_call(self, role: str | None, reducer: str, args: list[Any]) -> httpx.Response:
        url = f"{self.base}/v1/database/{self.database}/call/{reducer}"
        resp = self.http.post(url, json=args, headers=self._headers(role))
        if resp.status_code >= 300:
            raise StoreError(f"{reducer} failed: HTTP {resp.status_code}: {resp.text[:500]}")
        return resp

    def sql(self, query: str, role: str | None = None) -> list[dict[str, Any]]:
        url = f"{self.base}/v1/database/{self.database}/sql"
        resp = self.http.post(url, content=query.encode(), headers={**self._headers(role), "Content-Type": "text/plain"})
        if resp.status_code >= 300:
            raise StoreError(f"SQL failed: HTTP {resp.status_code}: {resp.text[:500]} -- {query}")
        return parse_sql_response(resp.json())

    def call(self, role: str, reducer: str, *args: Any, request_id: str | None = None) -> Result:
        rid = request_id or new_request_id()
        self.raw_call(role, reducer, [rid, *args])
        for attempt in range(5):
            found = self.sql(f"SELECT * FROM request_result WHERE request_id = {_sql_literal(rid)}", role)
            if found:
                r = found[0]
                return Result(rid, str(r.get("outcome", "")), str(r.get("message", "")))
            time.sleep(0.05 * (attempt + 1))
        raise StoreError(f"{reducer}: no request_result for {rid}")

    def rows(self, table: str, **filters: Any) -> list[dict[str, Any]]:
        query = f"SELECT * FROM {table}"
        if filters:
            query += " WHERE " + " AND ".join(f"{k} = {_sql_literal(v)}" for k, v in filters.items())
        return self.sql(query, "agent" if self.tokens.get("agent") else None)


def get_store() -> Store:
    if settings.store_backend == "fake":
        from .fake_store import FakeStore

        return FakeStore()
    return SpacetimeStore()


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True, default=str)
