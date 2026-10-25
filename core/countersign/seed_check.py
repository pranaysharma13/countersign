"""Does the live module agree with the Python reference after loading a seed? Read-only.

Replays the same seed into a FakeStore and compares the module's rows with it, row by row, for the
rows the seed created only (other data in the module is ignored). Columns that legitimately differ
are skipped: timestamps, identities, request ids, auto-increment ids, and the audit_log and
request_result tables. JSON columns are compared parsed. Then, per invoice, the fingerprint Python
computes from the module's rows must equal the module's latest assessment; otherwise the worker
would record an extra assessment version, which is a mismatch.
"""

from __future__ import annotations

import json
from typing import Any

from .commercial import assess, bundle_from_store
from .fake_store import FakeStore
from .store import Store
from .supplier_seed import replay

SKIP_TABLES = {"audit_log", "request_result", "actor", "agent_step", "job"}
SKIP_COLUMNS = {"created_at", "updated_at", "at", "resolved_at_iso", "decided_at_iso", "request_id", "identity",
                "claimed_by", "requested_by"}
AUTO_INC = {"ledger_line", "audit_log", "agent_step"}
KEYS = {"authority": ("role",), "ledger_line": ("journal_id", "account")}


def _skip(table: str, column: str) -> bool:
    return column in SKIP_COLUMNS or column.endswith("_identity") or (table in AUTO_INC and column == "id")


def _norm(column: str, value: Any) -> Any:
    if column.endswith("_json") and isinstance(value, str):
        try:
            return json.loads(value or "null")
        except json.JSONDecodeError:
            return value
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value)  # the module may serialize i64 as a string
    return value


def _key(table: str, row: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(str(row.get(k)) for k in KEYS.get(table, ("id",)))


def reference(seeds: list[list[dict[str, Any]]]) -> FakeStore:
    ref = FakeStore()
    for calls in seeds:
        for res in replay(ref, calls):
            if not res.ok:
                raise RuntimeError(f"the seed doesn't replay on the reference: {res.outcome} {res.message}")
    return ref


def compare(module: Store, ref: FakeStore) -> list[str]:
    """Mismatches as readable lines; empty means the module and the reference agree."""
    out: list[str] = []
    for table in sorted(t for t in ref.tables if t not in SKIP_TABLES):
        expected = {_key(table, r): r for r in ref.rows(table)}
        if not expected:
            continue
        actual = {_key(table, r): r for r in module.rows(table)}
        sample = next(iter(expected.values()))
        live = next((actual[k] for k in expected if k in actual), None)
        if live is not None:
            only_ref = sorted(c for c in sample if c not in live and not _skip(table, c))
            only_mod = sorted(c for c in live if c not in sample and not _skip(table, c))
            if only_ref or only_mod:
                out.append(f"{table}: columns only in the reference {only_ref}, only in the module {only_mod}")
        for key, row in expected.items():
            got = actual.get(key)
            if got is None:
                out.append(f"{table} {'/'.join(key)}: missing in the module")
                continue
            for col, want in row.items():
                if col in got and not _skip(table, col) and _norm(col, want) != _norm(col, got[col]):
                    out.append(f"{table} {'/'.join(key)}.{col}: module {got[col]!r}, reference {want!r}")
    for inv in ref.rows("invoice"):
        if not inv["active_revision_id"] or not module.rows("invoice", id=inv["id"]):
            continue
        computed = assess(bundle_from_store(module, inv["id"])).fingerprint
        stored = max(module.rows("assessment", revision_id=inv["active_revision_id"]), key=lambda a: int(a["version"]),
                     default=None)
        if stored is None or stored["fingerprint"] != computed:
            out.append(f"invoice {inv['id']}: Python computes fingerprint {computed} from the module's rows, the module's latest "
                       f"assessment has {stored['fingerprint'] if stored else 'none'} (the worker would record an extra version)")
    return out
