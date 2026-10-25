# core/ — Python services

**Owner:** Python developer · **Branch:** `py/core` · **Port:** 8000 (upload + file preview only)

Countersign checks every supplier invoice against what was actually agreed (quote, purchase order, email thread) and prepares a payment the controller can trust (SPEC v2). This folder holds the deterministic commercial checks, the extraction and evidence rules, the job worker, the investigation agent (Factory Droid + Claude), the payment gateway, and the connections to Nessie, CRS and Apify. Every external service has a mock (`USE_MOCKS=true`); extraction has a labelled fixture mode (`AI_MODE=fixture`).

The v1 flow (subcontractor pay applications, the fake bank-change bill, the "scam us" page) still runs as a second capability.

## Setup

```bash
brew install uv            # once
cd core && uv sync && cd ..
uv run --project core pytest core   # all offline, no keys needed
uv run --project core python scripts/make_supplier_fixtures.py   # write the BayMix PDFs and .eml files to look at
```

## The primary scenario (step A, done)

Marlow & Finch buys ready-mix from BayMix Supply for the Oakview Lane Fourplex. Tests run it end to end through the module reference and assert the exact values: $87,425 claimed · $77,425 requested · $3,500 price variance · $225 pending · $3,725 under review · $83,700 corrected · $10,000 deposit · $73,700 settled · AP $0 · $83,700 cash out.

1. **Documents** (`supplier_world.py`, `supplier_docs.py`): quote with terms (price changes need mutual written agreement; fuel surcharge tied to the weekly diesel index), acknowledged PO, the weekend-delivery and waiting-charge email threads, invoice BM-23104 and its corrected revision. Rendered reproducibly; every line becomes an immutable source fragment (`frag_<doc>_p<page>_l<line>`).
2. **Extraction** (`extractions.py`): a labelled fixture (or, from step C, Claude) says what each document contains. Every material value cites fragments of its own document, its quote must match them after whitespace normalization, and every money value must appear in its quote. Missing facts are null with a reason. Bad evidence = an `invalid` run and nothing recorded.
3. **Records**: purchase, terms, change requests, supplier acceptances, invoice, revisions and lines go through reducers. A corrected invoice supersedes the earlier revision only with an evidenced notice for the same supplier and number. An email saying "approved" is never recorded as an approval.
4. **Assessment** (`commercial.py`, no model calls): per line, claimed vs. accepted vs. pending vs. variance; independent holds (`PRICE_VARIANCE`, `PROPOSED_CHARGE`, `RECEIPT_NOT_VERIFIED`, ...); a fingerprint of every input; the proposed payment is the full balance requested or $0, never silently less.
5. **Books** (`supplier_ledger.py`): CONTRACT §9.6 journals with idempotent ids.

## Key files

| File | What |
|---|---|
| `countersign/reducers.py` | The only place that knows reducer argument order (CONTRACT §4 and §9.4, v2.1) |
| `countersign/fake_store.py` | Runnable Python copy of the module's rules, for tests; the TypeScript module mirrors it |
| `countersign/commercial.py` | v2 deterministic assessment, holds, fingerprint, bill-posting gate |
| `countersign/extractions.py` | v2 evidence validation and recording; fixture loader |
| `countersign/supplier_world.py`, `supplier_docs.py`, `supplier_seed.py` | v2 fictional world, document rendering and fragments, seeding |
| `countersign/supplier_ledger.py` | v2 journals |
| `countersign/money.py` | Integer cents and integer-thousandth quantities; exact extension |
| `countersign/checks.py`, `decide.py` | v1 deterministic checks and decision rules |
| `countersign/agent.py` | v1 Droid agent, scripted agent, compromised-agent demo, "why?" chat |
| `countersign/pipeline.py` | v1 seed, intake, agent tools, gateway (pays once, even after a timeout), ledger |
| `countersign/world.py`, `attacks.py` | v1 company, history, demo pile and scam generator |
| `countersign/worker.py` | Job worker; holds only the agent, gateway and sync keys |

## JSON seed for the web's local backend

`data/seeds/baymix_primary.json` is the primary scenario as replayable reducer calls, produced by the same code the tests run (`supplier_seed.export_primary_seed`). Regenerate it after changing the fixtures, `supplier_world.py` or the assessment:

```bash
uv run --project core python scripts/export_supplier_seed.py
```

A test fails if the committed file is stale. What's in it:
- **Stages:** `people` → `purchase` → `invoice_r1` → `correction_r2` → `receipt`. Load up to any stage to start the demo there. `invoice_r1` is the opening state ($87,425 claimed, holds open).
- **Calls:** positional args in CONTRACT order, without `request_id`. Each call carries its own fixed `request_id`, so loading twice changes nothing. Args named `*_cents` and `*_milli` are i64. `{{identity:<role>}}` stands for that role's identity hex (only in `set_authority`).
- **Actors:** the loader registers actors first. The roles needed are listed in `conventions.roles_needed`.
- **Documents:** the PDF and `.eml` bytes (base64), for the source viewer. Their SHA-256 matches `record_document`.

## Module reference coverage (CONTRACT §9.4)

Implemented in `fake_store.py` and `reducers.py`: setup and records, amendments, invoices and assessment, holds, receipt attestation, payee decisions. Rules beyond the contract text that the TypeScript module should mirror: a new change request can't be created as authorised (the stored classification follows the in-app decision and supplier acceptance); a pre-established contact's email and phone can't change, and a contact can't become pre-established later; payee profiles, documents and invoice lines are immutable; lines go only on the active revision.

Not yet: clarification outbox, payment proposal/approval/settlement for supplier payments, deposit allocation, the new job kinds and worker leases.

## Run against the SpacetimeDB module (v1 today)

```bash
uv run --project core python scripts/setup_actors.py   # once per fresh module; paste tokens into .env / web/.env.local
uv run --project core python scripts/load_seed.py      # v1 company, subs, contracts, 6 months of paid history
uv run --project core python scripts/run_worker.py     # leave running: agent + gateway + sync
uv run --project core python scripts/demo_pile.py moment   # v1: the opening fake bank-change bill
uv run --project core uvicorn countersign.api:app --port 8000   # PDF upload + preview for the dashboard
```

Other scripts: `smoke_spacetime.py` (go/no-go HTTP check), `check_droid.py` (Droid only sees our tools), `run_scorecard.py` (v1 offline scorecard), `reset_demo.py`.

## Where Droid runs (for the Factory judges)

- **v1 today:** every `process_bill` job starts a Droid session (`countersign/agent.py`, `run_droid`) limited to five tools we wrote (`read_bill`, `list_checks`, `run_check`, `get_sub_history`, `file_proposal`). Built-in file and shell tools are removed with `restrict_tools`. The database refuses approve/pay calls from the `agent` role. Every step goes to `agent_step`. If Droid errors, the scripted agent finishes with the same tools and holds.
- **v2 (steps B–C):** `process_document` jobs with the supplier-invoice tools from the brief (`get_invoice_bundle`, `get_term_version`, `get_source_fragment`, `get_authority_policy`, `list_open_holds`, `run_check`, `open_hold`, `draft_clarification`, `propose_supplier_payment`). Not built yet.

## Known gaps (as of this commit)

- Steps B–E: intake jobs and worker retries/leases, live Claude extraction (strict schema), outbox, version-bound approval and settlement, audit export.
- Variants: scoped amendment, fuel surcharge (Apify diesel index), supplier risk (CRS), prompt injection on supplier documents, judge page.
- Settlement decisions on disputed lines (`decide_disputed_line`, CONTRACT v2.2 proposal on `docs/contract-v2.2`): built after step B's core works. Until then, money holds clear only through a corrected invoice.
- CRS business-report mapping and the Apify Actors are still to come (`integrations/`).
