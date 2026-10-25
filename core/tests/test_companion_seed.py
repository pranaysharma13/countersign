"""Companion queue invoices sit beside BM-23104 without changing its numbers."""

from countersign.companion_fixtures import all_companion_fixtures
from countersign.companion_seed import COMPANION_SEED, export_companion_seed, seed_bytes, write_companion_fixtures
from countersign.companion_world import (CEDAR_GROSS_CENTS, CEDAR_INVOICE_ID, COMPANION_DOCS, HARBOR_INVOICE_ID,
                                         HP_GROSS_CENTS, INJECT_TEXT, NL_GROSS_CENTS, NORTHLINE_INVOICE_ID,
                                         PEAK_INVOICE_ID, PF_GROSS_CENTS, REDLINE_INVOICE_ID, RH_FUEL_CENTS,
                                         RH_GROSS_CENTS, RH_MATERIAL_CENTS, VALLEY_INVOICE_ID, VS_GROSS_CENTS)
from countersign.extractions import evidence_problems, load_fixture
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import fragments
from countersign.supplier_seed import SEEDS_DIR, replay, seed_setup
from countersign.supplier_world import INVOICE_ID


def test_companion_fixtures_cite_their_own_fragments():
    write_companion_fixtures()
    texts = {d.id: {f.id: f.text for f in fragments(d)} for d in COMPANION_DOCS}
    for doc_id, ext in all_companion_fixtures().items():
        assert ext["mode"] == "fixture" and ext["label"].startswith("FIXTURE")
        assert evidence_problems(ext, texts[doc_id]) == []
        assert load_fixture(doc_id)["document_id"] == doc_id


def test_committed_companion_seed_is_current():
    write_companion_fixtures()
    first, second = export_companion_seed(), export_companion_seed()
    assert seed_bytes(first) == seed_bytes(second)
    assert (SEEDS_DIR / COMPANION_SEED).read_bytes() == seed_bytes(first), \
        f"stale {COMPANION_SEED}: run `uv run --project core python scripts/export_supplier_seed.py`"


def test_companions_are_a_realistic_queue_and_leave_baymix_alone():
    store = FakeStore()
    seed_setup(store)
    replay(store, export_companion_seed())

    cedar = store.rows("invoice", id=CEDAR_INVOICE_ID)[0]
    assert cedar["invoice_number"] == "CB-8802"
    assert cedar["commercial_status"] == "matches"
    assert cedar["receipt_status"] == "manually_confirmed"
    assert cedar["payee_status"] == "verified"
    assert cedar["payment_status"] == "not_ready"
    cedar_rev = store.rows("invoice_revision", id=cedar["active_revision_id"])[0]
    assert cedar_rev["balance_requested_cents"] == CEDAR_GROSS_CENTS == 418_000
    assert store.rows("hold", revision_id=cedar["active_revision_id"], status="open") == []
    prop = [p for p in store.rows("proposal") if p["work_item_id"] == f"wi_{CEDAR_INVOICE_ID}" and p["status"] == "pending"]
    assert len(prop) == 1 and prop[0]["amount_cents"] == CEDAR_GROSS_CENTS

    nl = store.rows("invoice", id=NORTHLINE_INVOICE_ID)[0]
    assert nl["invoice_number"] == "NL-441"
    assert nl["commercial_status"] == "matches"
    assert nl["receipt_status"] == "manually_confirmed"
    assert nl["payee_status"] == "change_pending"
    nl_holds = {h["code"] for h in store.rows("hold", revision_id=nl["active_revision_id"], status="open")}
    assert nl_holds == {"PAYEE_CHANGE_PENDING"}
    assert store.rows("invoice_revision", id=nl["active_revision_id"])[0]["balance_requested_cents"] == NL_GROSS_CENTS
    assert not any(p["work_item_id"] == f"wi_{NORTHLINE_INVOICE_ID}" and p["status"] == "pending"
                   for p in store.rows("proposal"))

    assert store.rows("invoice", id=INVOICE_ID) == []
    assert {s["id"] for s in store.rows("supplier")} >= {
        "sup_baymix", "sup_cedar", "sup_northline", "sup_harbor", "sup_valley", "sup_redline", "sup_peak"}

    hp = store.rows("invoice", id=HARBOR_INVOICE_ID)[0]
    assert hp["invoice_number"] == "HP-220"
    assert hp["commercial_status"] == "matches"
    assert hp["receipt_status"] == "manually_confirmed"
    hp_holds = {h["code"] for h in store.rows("hold", revision_id=hp["active_revision_id"], status="open")}
    assert hp_holds == {"PROMPT_INJECTION"}
    assert store.rows("hold", id=hold_id(hp["active_revision_id"], "PROMPT_INJECTION"))[0]["status"] == "open"
    assert not any(p["work_item_id"] == f"wi_{HARBOR_INVOICE_ID}" and p["status"] == "pending"
                   for p in store.rows("proposal"))
    hp_fx = all_companion_fixtures()["doc_hp_inv_220"]
    assert hp_fx["instructions_found"] == [INJECT_TEXT]
    assert hp_fx["instruction_fragments"] == [f.id for f in fragments(next(d for d in COMPANION_DOCS if d.id == "doc_hp_inv_220"))
                                              if f.text == INJECT_TEXT]

    vs = store.rows("invoice", id=VALLEY_INVOICE_ID)[0]
    assert vs["invoice_number"] == "VS-310"
    assert vs["commercial_status"] == "differences_under_review"
    vs_rev = store.rows("invoice_revision", id=vs["active_revision_id"])[0]
    assert vs_rev["balance_requested_cents"] == VS_GROSS_CENTS == 399_000
    vs_holds = {h["code"] for h in store.rows("hold", revision_id=vs["active_revision_id"], status="open")}
    assert "PO_CEILING" in vs_holds
    vs_asm = max(store.rows("assessment", revision_id=vs["active_revision_id"]), key=lambda a: a["version"])
    assert vs_asm["proposed_payment_cents"] == 0
    assert not any(p["work_item_id"] == f"wi_{VALLEY_INVOICE_ID}" and p["status"] == "pending"
                   for p in store.rows("proposal"))

    rh = store.rows("invoice", id=REDLINE_INVOICE_ID)[0]
    assert rh["invoice_number"] == "RH-55"
    assert rh["commercial_status"] == "differences_under_review"
    rh_rev = store.rows("invoice_revision", id=rh["active_revision_id"])[0]
    assert rh_rev["balance_requested_cents"] == RH_GROSS_CENTS == 474_000
    rh_holds = {h["code"] for h in store.rows("hold", revision_id=rh["active_revision_id"], status="open")}
    assert rh_holds == {"PROPOSED_CHARGE"}
    rh_asm = max(store.rows("assessment", revision_id=rh["active_revision_id"]), key=lambda a: a["version"])
    assert rh_asm["authorised_cents"] == RH_MATERIAL_CENTS
    assert rh_asm["pending_cents"] == RH_FUEL_CENTS
    assert rh_asm["proposed_payment_cents"] == 0
    assert not any(p["work_item_id"] == f"wi_{REDLINE_INVOICE_ID}" and p["status"] == "pending"
                   for p in store.rows("proposal"))

    pf = store.rows("invoice", id=PEAK_INVOICE_ID)[0]
    assert pf["invoice_number"] == "PF-77"
    assert pf["commercial_status"] == "matches"
    assert pf["receipt_status"] == "manually_confirmed"
    assert pf["payee_status"] == "verified"
    pf_rev = store.rows("invoice_revision", id=pf["active_revision_id"])[0]
    assert pf_rev["balance_requested_cents"] == PF_GROSS_CENTS == 165_000
    pf_holds = store.rows("hold", revision_id=pf["active_revision_id"], status="open")
    assert {h["code"] for h in pf_holds} == {"SUPPLIER_RISK"}
    assert pf_holds[0]["id"] == hold_id(pf["active_revision_id"], "SUPPLIER_RISK")
    assert "civil judgment" in pf_holds[0]["reason"]
    assert not any(p["work_item_id"] == f"wi_{PEAK_INVOICE_ID}" and p["status"] == "pending"
                   for p in store.rows("proposal"))
    assert HP_GROSS_CENTS == 74_000
