"""seed_check: silent when the module matches the reference, precise when it doesn't."""

import json

from countersign.fake_store import FakeStore
from countersign.seed_check import compare, reference
from countersign.supplier_seed import SEEDS_DIR, replay

SEEDS = [json.loads((SEEDS_DIR / n).read_text()) for n in ("baymix_opening.json", "baymix_correction.json")]


def loaded():
    module = FakeStore()
    for calls in SEEDS:
        assert {r.outcome for r in replay(module, calls)} == {"ok"}
    return module


def test_a_matching_module_reports_nothing_even_with_different_identities_and_timestamps():
    module = loaded()
    for rows in module.tables.values():  # what a real module legitimately does differently
        for row in rows.values():
            for col in list(row):
                if col.endswith("_identity") or col in {"created_at", "updated_at", "at"}:
                    row[col] = "0x" + "ab" * 32 if col.endswith("_identity") else 1_761_000_000_000_000
    for row in module.tables["ledger_line"].values():
        row["id"] += 1000
    assert compare(module, reference(SEEDS)) == []


def test_a_real_difference_is_reported_with_table_and_column():
    module = loaded()
    module.tables["change_request"]["cr_baymix_weekend_oct10"]["classification"] = "PROPOSED"
    del module.tables["source_fragment"]["frag_bm_quote_p1_l10"]
    problems = compare(module, reference(SEEDS))
    assert any("change_request cr_baymix_weekend_oct10.classification: module 'PROPOSED'" in p for p in problems)
    assert any("source_fragment frag_bm_quote_p1_l10: missing in the module" in p for p in problems)


def test_an_input_the_assessment_reads_differently_shows_as_an_extra_version():
    module = loaded()
    module.tables["change_request"]["cr_baymix_weekend_oct10"]["internal_status"] = "pending"
    problems = compare(module, reference(SEEDS))
    assert any("would record an extra version" in p for p in problems)
