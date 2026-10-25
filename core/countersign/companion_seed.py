"""Replayable companion queue: Cedar & Bolt, Northline Rebar, and four more Oakview
cases (injection, PO ceiling, unapproved extra, CRS risk). Built on top of seed_setup
so actors and Oakview already exist. Does not record BayMix invoices or change BM-23104.
"""

from __future__ import annotations

import json
from typing import Any

from . import reducers as R
from .commercial import assess, bundle_from_store, record
from .companion_fixtures import all_companion_fixtures
from .companion_world import (CEDAR_DOCS, CEDAR_INVOICE, CEDAR_INVOICE_ID, CEDAR_PO, CEDAR_PURCHASE_ID, CEDAR_QTY_MILLI,
                              CEDAR_QUOTE, COMPANION_CONTACTS, COMPANION_PAYEES, COMPANION_SUPPLIERS, HARBOR_DOCS,
                              HARBOR_INVOICE_ID, HARBOR_PURCHASE_ID, HP_INVOICE, HP_PO, HP_QTY_MILLI, HP_QUOTE,
                              INJECT_TEXT, NL_BANK_1, NL_INVOICE, NL_PO, NL_QTY_MILLI, NL_QUOTE, NORTHLINE_DOCS,
                              NORTHLINE, NORTHLINE_INVOICE_ID, NORTHLINE_PAYEE_V2, NORTHLINE_PURCHASE_ID, PEAK, PEAK_DOCS,
                              PEAK_INVOICE_ID, PEAK_PURCHASE_ID, PF_INVOICE, PF_PO, PF_QTY_MILLI, PF_QUOTE,
                              REDLINE_DOCS, REDLINE_INVOICE_ID, REDLINE_PURCHASE_ID, RH_INVOICE, RH_PO, RH_QTY_MILLI,
                              RH_QUOTE, VALLEY_DOCS, VALLEY_INVOICE_ID, VALLEY_PURCHASE_ID, VS_INVOICE, VS_PO,
                              VS_QTY_MILLI, VS_QUOTE)
from .config import DATA_DIR
from .extractions import record_email_extraction, record_invoice_extraction, record_purchase
from .fake_store import FakeStore
from .ids import hold_id
from .money import fmt
from .supplier_docs import fragments
from .supplier_pipeline import propose_payment, record_payee_changes
from .supplier_seed import RecordingStore, seed_bytes, seed_document, seed_setup

# crs_test_business_02 in integrations.crs._MOCK — keep the seed free of mock vs live source labels
_PEAK_JUDGMENT = {"type": "civil judgment", "amount_cents": 1_240_000, "filed": "2025-11-03",
                  "creditor": "Electrical supply house"}

COMPANION_SEED = "queue_companions.json"
COMPANION_FIXTURE_DIR = DATA_DIR / "fixtures" / "companions" / "extractions"


def seed_companion_parties(store) -> None:
    for s in COMPANION_SUPPLIERS:
        res = R.upsert_supplier(store, "sync", s.id, s.name, s.email_domain, s.phone_on_file, s.crs_ref, s.status)
        if not res.ok:
            raise RuntimeError(f"companion supplier {s.id}: {res.outcome} {res.message}")
    for c in COMPANION_CONTACTS:
        res = R.upsert_supplier_contact(store, "sync", c.id, c.supplier_id, c.name, c.email, c.phone, c.title,
                                        c.pre_established)
        if not res.ok:
            raise RuntimeError(f"companion contact {c.id}: {res.outcome} {res.message}")
    for p in COMPANION_PAYEES:
        res = R.add_payee_profile(store, "admin", p.id, p.supplier_id, p.version, p.account_ref, p.last4, p.bank_name,
                                  p.requested_via)
        if not res.ok:
            raise RuntimeError(f"companion payee {p.id}: {res.outcome} {res.message}")


def write_companion_fixtures() -> None:
    COMPANION_FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for doc_id, ext in all_companion_fixtures().items():
        path = COMPANION_FIXTURE_DIR / f"{doc_id}.json"
        path.write_bytes((json.dumps(ext, indent=2) + "\n").encode())


def _fx(doc_id: str) -> dict[str, Any]:
    return all_companion_fixtures()[doc_id]


def record_cedar(store) -> None:
    for doc in CEDAR_DOCS:
        seed_document(store, doc)
    record_purchase(store, _fx(CEDAR_QUOTE.id), _fx(CEDAR_PO.id), CEDAR_PURCHASE_ID)
    invoice_id, _ = record_invoice_extraction(store, _fx(CEDAR_INVOICE.id), CEDAR_PURCHASE_ID)
    if invoice_id != CEDAR_INVOICE_ID:
        raise RuntimeError(f"expected {CEDAR_INVOICE_ID}, got {invoice_id}")
    res = R.attest_receipt(store, "att_cb_200", invoice_id, "South-curb lumber drop", CEDAR_QTY_MILLI, "sheet",
                           "Counted 200 sheets against the delivery ticket")
    if not res.ok:
        raise RuntimeError(f"cedar receipt: {res.outcome} {res.message}")
    bundle = bundle_from_store(store, invoice_id)
    assessment = assess(bundle)
    propose_payment(store, bundle, assessment, record(store, assessment))


def record_northline(store) -> None:
    for doc in NORTHLINE_DOCS:
        seed_document(store, doc)
    record_purchase(store, _fx(NL_QUOTE.id), _fx(NL_PO.id), NORTHLINE_PURCHASE_ID)
    invoice_id, _ = record_invoice_extraction(store, _fx(NL_INVOICE.id), NORTHLINE_PURCHASE_ID)
    if invoice_id != NORTHLINE_INVOICE_ID:
        raise RuntimeError(f"expected {NORTHLINE_INVOICE_ID}, got {invoice_id}")
    record_email_extraction(store, _fx(NL_BANK_1.id), NORTHLINE_PURCHASE_ID)
    res = R.attest_receipt(store, "att_nl_2", invoice_id, "Rebar at the pump pad", NL_QTY_MILLI, "ton",
                           "Tags matched the footing schedule")
    if not res.ok:
        raise RuntimeError(f"northline receipt: {res.outcome} {res.message}")
    # the bank-change email itself asks for the new account, as the pipeline reads it (SPEC §8)
    if record_payee_changes(store, _fx(NL_BANK_1.id), NORTHLINE.id) != [NORTHLINE_PAYEE_V2.id]:
        raise RuntimeError(f"northline: expected the email to request {NORTHLINE_PAYEE_V2.id}")
    bundle = bundle_from_store(store, invoice_id)
    assessment = assess(bundle)
    record(store, assessment)  # hold only; do not propose while the payee change is pending


def _record_matched_invoice(store, docs, quote, po, invoice, purchase_id, invoice_id, attest_id, scope,
                            qty_milli, unit, note) -> tuple[str, str]:
    for doc in docs:
        seed_document(store, doc)
    record_purchase(store, _fx(quote.id), _fx(po.id), purchase_id)
    got, revision_id = record_invoice_extraction(store, _fx(invoice.id), purchase_id)
    if got != invoice_id:
        raise RuntimeError(f"expected {invoice_id}, got {got}")
    res = R.attest_receipt(store, attest_id, invoice_id, scope, qty_milli, unit, note)
    if not res.ok:
        raise RuntimeError(f"{invoice_id} receipt: {res.outcome} {res.message}")
    return got, revision_id


def _assess_no_payment(store, invoice_id) -> None:
    record(store, assess(bundle_from_store(store, invoice_id)))


def record_harbor(store) -> None:
    invoice_id, revision_id = _record_matched_invoice(
        store, HARBOR_DOCS, HP_QUOTE, HP_PO, HP_INVOICE, HARBOR_PURCHASE_ID, HARBOR_INVOICE_ID,
        "att_hp_40", "Crates by the job-box", HP_QTY_MILLI, "crate", "Counted 40 crates against the packing list")
    inj = next(f for f in fragments(HP_INVOICE) if f.text == INJECT_TEXT)
    res = R.open_hold(store, "agent", hold_id(revision_id, "PROMPT_INJECTION"), revision_id, "PROMPT_INJECTION", 0,
                      f"The invoice contains text aimed at an automated system, treated as data and ignored: \"{INJECT_TEXT}\"",
                      {"quotes": [INJECT_TEXT], "fragment_ids": [inj.id]})
    if not res.ok:
        raise RuntimeError(f"harbor injection hold: {res.outcome} {res.message}")
    _assess_no_payment(store, invoice_id)


def record_valley(store) -> None:
    invoice_id, _ = _record_matched_invoice(
        store, VALLEY_DOCS, VS_QUOTE, VS_PO, VS_INVOICE, VALLEY_PURCHASE_ID, VALLEY_INVOICE_ID,
        "att_vs_95", "Sand stockpile at the north curb", VS_QTY_MILLI, "ton",
        "Superintendent counted 95 tons against the tickets")
    _assess_no_payment(store, invoice_id)  # PO_CEILING; do not propose payment


def record_redline(store) -> None:
    invoice_id, _ = _record_matched_invoice(
        store, REDLINE_DOCS, RH_QUOTE, RH_PO, RH_INVOICE, REDLINE_PURCHASE_ID, REDLINE_INVOICE_ID,
        "att_rh_12", "Twelve haul loads to the plant", RH_QTY_MILLI, "load",
        "Tickets matched twelve delivered loads")
    _assess_no_payment(store, invoice_id)  # PROPOSED_CHARGE on fuel; do not propose payment


def record_peak(store) -> None:
    invoice_id, revision_id = _record_matched_invoice(
        store, PEAK_DOCS, PF_QUOTE, PF_PO, PF_INVOICE, PEAK_PURCHASE_ID, PEAK_INVOICE_ID,
        "att_pf_30", "Form panels at the pump pad", PF_QTY_MILLI, "panel",
        "Counted 30 steel-faced panels against the delivery ticket")
    _assess_no_payment(store, invoice_id)
    cited = next(f for f in fragments(PF_INVOICE) if f.text == "Peak Form Supply")
    reason = (f"CRS reports a {_PEAK_JUDGMENT['type']} of {fmt(_PEAK_JUDGMENT['amount_cents'])} filed "
              f"{_PEAK_JUDGMENT['filed']} (creditor: {_PEAK_JUDGMENT['creditor']}). Payment is held for the owner.")
    res = R.open_hold(store, "agent", hold_id(revision_id, "SUPPLIER_RISK"), revision_id, "SUPPLIER_RISK", 0, reason,
                      {"crs_ref": PEAK.crs_ref, "judgment": _PEAK_JUDGMENT, "fragment_ids": [cited.id]})
    if not res.ok:
        raise RuntimeError(f"peak supplier risk hold: {res.outcome} {res.message}")


def export_companion_seed() -> list[dict[str, Any]]:
    inner = FakeStore()
    seed_setup(inner)
    rec = RecordingStore(inner)
    seed_companion_parties(rec)
    record_cedar(rec)
    record_northline(rec)
    record_harbor(rec)
    record_valley(rec)
    record_redline(rec)
    record_peak(rec)
    return rec.take()


def replay_companions(store) -> None:
    """Add the companion invoices onto a store that already has actors and Oakview."""
    seed_companion_parties(store)
    record_cedar(store)
    record_northline(store)
    record_harbor(store)
    record_valley(store)
    record_redline(store)
    record_peak(store)
