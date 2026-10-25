"""Load the BayMix world into the store: people and limits, supplier, contacts, verified payee,
and the fixture documents with their fragments and emails. Facts the documents establish
(purchase, terms, amendments, invoices) are recorded later from extractions, like real intake.

`identities` maps role -> identity hex for set_authority; the fake store uses role names.
"""

from __future__ import annotations

from pathlib import Path

from . import reducers as R
from .ids import sha256_hex
from .store import Result, Store
from .supplier_docs import file_bytes, fragment_id, fragments
from .supplier_world import BAYMIX, CONTACTS, PAYEE_V1, PEOPLE, PRIMARY_DOCS, PROJECT, SourceDoc


def _ok(res: Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"seed {what}: {res.outcome} {res.message}")


def seed_setup(store: Store, identities: dict[str, str] | None = None) -> None:
    ids = identities or {}
    for p in PEOPLE:
        _ok(R.set_authority(store, ids.get(p.role, p.role), p.role, p.limit_cents, p.project_scope), f"authority {p.role}")
    _ok(R.upsert_project(store, "sync", PROJECT.id, PROJECT.name, PROJECT.address), "project")
    _ok(R.upsert_supplier(store, "sync", BAYMIX.id, BAYMIX.name, BAYMIX.email_domain, BAYMIX.phone_on_file,
                          BAYMIX.crs_ref, BAYMIX.status), "supplier")
    for c in CONTACTS:
        _ok(R.upsert_supplier_contact(store, "sync", c.id, c.supplier_id, c.name, c.email, c.phone, c.title,
                                      c.pre_established), f"contact {c.id}")
    _ok(R.add_payee_profile(store, "admin", PAYEE_V1.id, PAYEE_V1.supplier_id, PAYEE_V1.version, PAYEE_V1.account_ref,
                            PAYEE_V1.last4, PAYEE_V1.bank_name, PAYEE_V1.requested_via), "payee profile")


def seed_document(store: Store, doc: SourceDoc, files_dir: Path | None = None) -> str:
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
    _ok(R.record_source_file(store, src_id, "seed", doc.filename, sha, meta.ingested_at_iso if meta else "",
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
