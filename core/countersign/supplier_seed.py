"""Load the BayMix world into the store: people and limits, supplier, contacts, verified payee,
and the fixture documents with their fragments and emails. Facts the documents establish
(purchase, terms, amendments, invoices) are recorded later from extractions, like real intake.

`identities` maps role -> identity hex for set_authority; the fake store uses role names.
`export_primary_seed` turns the whole primary scenario into replayable reducer calls
(data/seeds/baymix_primary.json) for the web's local backend.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

from . import reducers as R
from .config import DATA_DIR
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


# ---------------------------------------------------------------- JSON seed for the web's local backend

SEED_FORMAT = "countersign-seed/1"
SEED_PATH = DATA_DIR / "seeds" / "baymix_primary.json"


def identity_placeholder(role: str) -> str:
    return f"{{{{identity:{role}}}}}"


class _Recorder:
    """Wraps a store and keeps every call that changed something, in order, as replayable JSON."""

    def __init__(self, inner: Store) -> None:
        self.inner, self.calls = inner, []

    def call(self, role: str, reducer: str, *args: Any, request_id: str | None = None) -> Result:
        res = self.inner.call(role, reducer, *args, request_id=request_id)
        if not res.ok:
            raise RuntimeError(f"seed export {reducer}: {res.outcome} {res.message}")
        if res.outcome == "ok":
            recorded = list(args)
            if reducer == "set_authority":
                recorded[0] = identity_placeholder(recorded[0])
            self.calls.append({"request_id": f"seed-baymix-{len(self.calls) + 1:04d}", "role": role,
                               "reducer": reducer, "args": recorded})
        return res

    def rows(self, table: str, **filters: Any) -> list[dict[str, Any]]:
        return self.inner.rows(table, **filters)


def export_primary_seed() -> dict[str, Any]:
    """The primary scenario as staged reducer calls, produced by the same code the tests run."""
    from .commercial import assess, bundle_from_store, record
    from .extractions import load_fixture, record_email_extraction, record_invoice_extraction, record_purchase
    from .fake_store import FakeStore
    from .supplier_ledger import deposit_settled, post
    from .supplier_world import (DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, WAITING_1, WEEKEND_1,
                                 WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

    rec = _Recorder(FakeStore())
    stages: list[dict[str, Any]] = []
    doc_stage: dict[str, str] = {}

    def stage(name: str, description: str, docs: tuple[SourceDoc, ...], body: Any) -> None:
        start = len(rec.calls)
        for d in docs:
            seed_document(rec, d)
            doc_stage[d.id] = name
        body()
        stages.append({"name": name, "description": description, "calls": rec.calls[start:]})

    def reassess() -> None:
        record(rec, assess(bundle_from_store(rec, INVOICE_ID)))

    def setup() -> None:
        record_purchase(rec, load_fixture(QUOTE.id), load_fixture(PO.id), PURCHASE_ID)
        for d in (WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
            record_email_extraction(rec, load_fixture(d.id), PURCHASE_ID)
        _ok(R.decide_change_request(rec, "purchasing", WEEKEND_CR_ID, True, "Saturday pour requested by Granite Line"),
            "weekend decision")
        _ok(R.record_deposit(rec, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, DEPOSIT.status,
                             DEPOSIT.transfer_ref), "deposit")
        _ok(post(rec, "sync", deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)), "deposit journal")

    seed_setup(rec)
    stages.append({"name": "people", "description": "Authority limits, project, supplier, contacts on file, verified payee.",
                   "calls": list(rec.calls)})
    stage("purchase", "Quote, PO and email threads (fixture extractions); weekend charge approved in the app; "
          "$10,000 deposit settled (simulated).", (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1), setup)
    stage("invoice_r1", "Invoice BM-23104 arrives: $87,425 claimed, $3,725 under review, holds open.",
          (INVOICE_R1,), lambda: (record_invoice_extraction(rec, load_fixture(INVOICE_R1.id), PURCHASE_ID), reassess()))
    stage("correction_r2", "Corrected invoice ($83,700) supersedes revision 1; receipt still unconfirmed.",
          (INVOICE_R2,), lambda: (record_invoice_extraction(rec, load_fixture(INVOICE_R2.id), PURCHASE_ID), reassess()))
    stage("receipt", "Superintendent attests 500 cy (MANUALLY_CONFIRMED); reassessed: $73,700 proposed, no holds.", (),
          lambda: (_ok(R.attest_receipt(rec, "att_bm23104_500cy", INVOICE_ID, "Deliveries 2026-10-05 to 2026-10-22", 500_000,
                                        "cy", "On site for every pour; matches the pour log"), "receipt"), reassess()))

    documents = []
    for d in PRIMARY_DOCS:
        data = file_bytes(d)
        documents.append({"id": d.id, "kind": d.kind, "filename": d.filename, "stage": doc_stage[d.id],
                          "content_type": "message/rfc822" if d.email else "application/pdf", "sha256": sha256_hex(data),
                          "source_file_id": f"src_{sha256_hex(data)[:8]}", "base64": base64.b64encode(data).decode()})
    return {
        "format": SEED_FORMAT,
        "scenario": "baymix_primary",
        "generated_by": "uv run --project core python scripts/export_supplier_seed.py",
        "note": "All fictional. Extractions are labelled fixtures (AI_MODE=fixture); deposit and payments are simulated.",
        "conventions": {
            "calls": "Replay in order. args are positional in CONTRACT order without request_id; use the given request_id "
                     "so loading twice is a no-op. Every call returned ok when generated.",
            "i64": "Args whose names end in _cents or _milli (db/src/reducer_args.ts) are i64: convert to BigInt.",
            "identity": "'{{identity:<role>}}' stands for the hex identity of that role's actor.",
            "roles_needed": sorted({c["role"] for s in stages for c in s["calls"]}),
            "documents": "File bytes for the source viewer, base64; sha256 matches record_document.",
        },
        "documents": documents,
        "stages": stages,
    }
