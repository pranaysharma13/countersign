"""Load the BayMix world into the store: people and limits, supplier, contacts, verified payee,
and the fixture documents with their fragments and emails. Facts the documents establish
(purchase, terms, amendments, invoices) are recorded later from extractions, like real intake.

`identities` maps role -> identity hex for register_actor and set_authority; the fake store uses
role names. `export_seeds` turns the primary scenario into the replayable seed files in data/seeds/.
"""

from __future__ import annotations

import inspect
import json
import uuid
from pathlib import Path
from typing import Any

from . import reducers as R
from .config import DATA_DIR
from .fake_store import FakeStore
from .ids import sha256_hex
from .store import Result, Store, StoreError
from .supplier_docs import file_bytes, fragment_id, fragments
from .supplier_world import BAYMIX, COMPANY, CONTACTS, PAYEE_V1, PEOPLE, PRIMARY_DOCS, PROJECT, SourceDoc


def _ok(res: Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"seed {what}: {res.outcome} {res.message}")


SYSTEM_ACTORS = {"agent": "Countersign agent", "gateway": "Payment gateway (simulated Nessie)", "sync": "Intake"}


def seed_setup(store: Store, identities: dict[str, str] | None = None) -> None:
    ids = identities or {}
    for role, name in [(p.role, p.name) for p in PEOPLE] + sorted(SYSTEM_ACTORS.items()):
        _ok(R.register_actor(store, ids.get(role, role), role, name), f"actor {role}")
    for p in PEOPLE:
        _ok(R.set_authority(store, ids.get(p.role, p.role), p.role, p.limit_cents, p.project_scope), f"authority {p.role}")
    _ok(R.upsert_company(store, "sync", COMPANY.id, COMPANY.name, COMPANY.owner_name, COMPANY.state,
                         COMPANY.bank_account_ref, COMPANY.bank_last4), "company")  # the payer account
    _ok(R.upsert_project(store, "sync", PROJECT.id, PROJECT.name, PROJECT.address), "project")
    _ok(R.upsert_supplier(store, "sync", BAYMIX.id, BAYMIX.name, BAYMIX.email_domain, BAYMIX.phone_on_file,
                          BAYMIX.crs_ref, BAYMIX.status), "supplier")
    for c in CONTACTS:
        _ok(R.upsert_supplier_contact(store, "sync", c.id, c.supplier_id, c.name, c.email, c.phone, c.title,
                                      c.pre_established), f"contact {c.id}")
    _ok(R.add_payee_profile(store, "admin", PAYEE_V1.id, PAYEE_V1.supplier_id, PAYEE_V1.version, PAYEE_V1.account_ref,
                            PAYEE_V1.last4, PAYEE_V1.bank_name, PAYEE_V1.requested_via), "payee profile")


def seed_document(store: Store, doc: SourceDoc, files_dir: Path | None = None, source_kind: str = "seed") -> str:
    """Record one document, its fragments and (for email) its message. Returns its sha256."""
    data = file_bytes(doc)
    sha = sha256_hex(data)
    storage = ""
    if files_dir is not None:
        files_dir.mkdir(parents=True, exist_ok=True)
        (files_dir / doc.filename).write_bytes(data)
        storage = str(files_dir / doc.filename)
    src_id = f"src_{sha[:8]}"
    meta = doc.email
    _ok(R.record_source_file(store, src_id, source_kind, doc.filename, sha, meta.ingested_at_iso if meta else "",
                             meta.from_address if meta else "", meta.subject if meta else "", storage), f"source {doc.id}")
    _ok(R.record_document(store, doc.id, doc.kind, src_id, sha, doc.filename, 0 if meta else len(doc.pages)), f"document {doc.id}")
    for f in fragments(doc):
        _ok(R.add_fragment(store, "sync", f.id, f.document_id, f.page, f.email_message_id, f.line_start, f.line_end, f.text),
            f"fragment {f.id}")
    if meta:
        _ok(R.record_email(store, meta.message_id, meta.thread_id, doc.id, meta.from_address, meta.to_addresses,
                           meta.subject, meta.sent_at_iso, meta.ingested_at_iso, fragment_id(doc.id, 0)), f"email {doc.id}")
    return sha


def seed_documents(store: Store, docs: tuple[SourceDoc, ...] = PRIMARY_DOCS, files_dir: Path | None = None) -> dict[str, str]:
    return {d.id: seed_document(store, d, files_dir) for d in docs}


# ---------------------------------------------------------------- replayable seeds for the web's local backend

SEEDS_DIR = DATA_DIR / "seeds"
IDENTITY_ARGS = {"register_actor": "identity_hex", "set_authority": "identity_hex"}


def identity_placeholder(role: str) -> str:
    return f"<identity:{role}>"


def reducer_params(reducer: str) -> list[str]:
    """The contract's parameter names in order (request_id excluded), read from the fake store's handler."""
    handler = getattr(FakeStore, f"_r_{reducer}", None)
    if handler is None:
        raise StoreError(f"unknown reducer {reducer}")
    return list(inspect.signature(handler).parameters)[3:]  # self, rid, caller


class RecordingStore:
    """Wraps a FakeStore and records every call that changed something as (role, reducer, named args).
    Identity arguments become placeholders, because whoever replays the seed has its own identities."""

    def __init__(self, inner: FakeStore | None = None) -> None:
        self.inner = inner or FakeStore()
        self.calls: list[dict[str, Any]] = []

    def call(self, role: str, reducer: str, *args: Any, request_id: str | None = None) -> Result:
        names = reducer_params(reducer)
        if len(names) != len(args):
            raise StoreError(f"{reducer}: {len(args)} args for {names}")
        res = self.inner.call(role, reducer, *args, request_id=request_id)
        if not res.ok:
            raise RuntimeError(f"seed export {reducer}: {res.outcome} {res.message}")
        if res.outcome == "ok":  # a duplicate changed nothing, so replaying it isn't needed
            named = dict(zip(names, args))
            if reducer in IDENTITY_ARGS:
                named[IDENTITY_ARGS[reducer]] = identity_placeholder(named["role"])
            self.calls.append({"role": role, "reducer": reducer, "args": named})
        return res

    def rows(self, table: str, **filters: Any) -> list[dict[str, Any]]:
        return self.inner.rows(table, **filters)

    def take(self) -> list[dict[str, Any]]:
        calls, self.calls = self.calls, []
        return calls


def fixed_request_id(id_seed: str, n: int) -> str:
    """The same UUID for the same call of the same seed, so loading it again is all duplicates."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"countersign-seed:{id_seed}:{n}"))


def replay(store: Store, calls: list[dict[str, Any]], identities: dict[str, str] | None = None,
           id_seed: str | None = None) -> list[Result]:
    """Load a seed into a store. `identities` maps role -> identity for the placeholders (default: role names).
    With `id_seed`, every call gets a fixed request id (safe to run twice); otherwise fresh ones."""
    ids = identities or {}

    def resolve(value: Any) -> Any:
        if isinstance(value, str) and value.startswith("<identity:") and value.endswith(">"):
            role = value[len("<identity:"):-1]
            return ids.get(role, role)
        return value

    return [store.call(c["role"], c["reducer"], *(resolve(c["args"][n]) for n in reducer_params(c["reducer"])),
                       request_id=fixed_request_id(id_seed, i) if id_seed else None)
            for i, c in enumerate(calls)]


def export_seeds() -> dict[str, list[dict[str, Any]]]:
    """The primary scenario as two seeds, produced by the same steps the tests run:
    baymix_opening (up to the drafted clarification) and baymix_correction (reply + revision 2)."""
    from .clarify import record_draft
    from .commercial import assess, bundle_from_store, record
    from .supplier_pipeline import propose_payment
    from .extractions import load_fixture, record_email_extraction, record_invoice_extraction, record_purchase
    from .supplier_ledger import deposit_settled, post
    from .supplier_world import (DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, REPLY_1, WAITING_1,
                                 WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

    rec = RecordingStore()
    seed_setup(rec)
    for d in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        seed_document(rec, d)
    record_purchase(rec, load_fixture(QUOTE.id), load_fixture(PO.id), PURCHASE_ID)
    for d in (WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        record_email_extraction(rec, load_fixture(d.id), PURCHASE_ID)
    _ok(R.decide_change_request(rec, "purchasing", WEEKEND_CR_ID, True, "Saturday pour requested by Granite Line"),
        "weekend decision")
    _ok(R.record_deposit(rec, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, DEPOSIT.status,
                         DEPOSIT.transfer_ref), "deposit")
    _ok(post(rec, "sync", deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)), "deposit journal")
    seed_document(rec, INVOICE_R1)
    record_invoice_extraction(rec, load_fixture(INVOICE_R1.id), PURCHASE_ID)
    b1 = bundle_from_store(rec, INVOICE_ID)
    a1 = assess(b1)
    record(rec, a1)
    record_draft(rec, b1, a1)
    opening = rec.take()

    seed_document(rec, REPLY_1)
    record_email_extraction(rec, load_fixture(REPLY_1.id), PURCHASE_ID)
    seed_document(rec, INVOICE_R2)
    record_invoice_extraction(rec, load_fixture(INVOICE_R2.id), PURCHASE_ID)
    b2 = bundle_from_store(rec, INVOICE_ID)
    a2 = assess(b2)
    propose_payment(rec, b2, a2, record(rec, a2))  # $73,700, approvable once receipt is attested
    return {"baymix_opening.json": opening, "baymix_correction.json": rec.take()}


def seed_bytes(calls: list[dict[str, Any]]) -> bytes:
    return (json.dumps(calls, indent=2) + "\n").encode()
