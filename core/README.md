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
uv run --project core python scripts/check_extraction.py         # live Claude on the 9 documents, measured (costs ~14 API calls)
```

`AI_MODE=fixture` (default) uses the labelled extractions in `data/fixtures/`; `AI_MODE=live` calls Claude (`ANTHROPIC_API_KEY` in the repo-root `.env`; `ANTHROPIC_MODEL` defaults to `claude-opus-5-5`, `EXTRACTION_EFFORT` to `medium`).

## The primary scenario (step A, done)

Marlow & Finch buys ready-mix from BayMix Supply for the Oakview Lane Fourplex. Tests run it end to end through the module reference and assert the exact values: $87,425 claimed · $77,425 requested · $3,500 price variance · $225 pending · $3,725 under review · $83,700 corrected · $10,000 deposit · $73,700 settled · AP $0 · $83,700 cash out.

1. **Documents** (`supplier_world.py`, `supplier_docs.py`): quote with terms (price changes need mutual written agreement; fuel surcharge tied to the weekly diesel index), acknowledged PO, the weekend-delivery and waiting-charge email threads, invoice BM-23104 and its corrected revision. Rendered reproducibly; every line becomes an immutable source fragment (`frag_<doc>_p<page>_l<line>`).
2. **Extraction** (`extractions.py`): a labelled fixture (or, from step C, Claude) says what each document contains. Every material value cites fragments of its own document, its quote must match them after whitespace normalization, and every money value must appear in its quote. Missing facts are null with a reason. Bad evidence = an `invalid` run and nothing recorded.
3. **Records**: purchase, terms, change requests, supplier acceptances, invoice, revisions and lines go through reducers. A corrected invoice supersedes the earlier revision only with an evidenced notice for the same supplier and number. An email saying "approved" is never recorded as an approval.
4. **Assessment** (`commercial.py`, no model calls): per line, claimed vs. accepted vs. pending vs. variance; independent holds (`PRICE_VARIANCE`, `PROPOSED_CHARGE`, `RECEIPT_NOT_VERIFIED`, ...); a fingerprint of every input; the proposed payment is the full balance requested or $0, never silently less. A charge the supplier confirmed but we haven't decided in the app goes to whoever has authority for that amount (purchasing up to its limit, otherwise the owner), and nothing is drafted to the supplier until it's decided.
5. **Books** (`supplier_ledger.py`): CONTRACT §9.6 journals with idempotent ids.

## Intake and the worker (step B core, done)

1. **Intake** (`intake.py`, sync): keeps the original bytes and SHA-256, records the document and its fragments (and the email, for `.eml`), and queues `process_document`. The document id comes from the bytes, so receiving a file twice records nothing new and queues no second job. Any PDF or email that isn't a known fixture is cut into one fragment per text line. In fixture mode it goes to review, because there's no labelled extraction for it and nothing is guessed.
2. **`process_document`** (`supplier_pipeline.py`, agent): fixture extraction (live Claude in step C), evidence check, then records what the document establishes.
   - A quote and its PO become a purchase once both are read, in either order.
   - An email goes to its supplier's single open purchase. If there are several, it goes to review; if there's none yet, the job retries. An acceptance whose proposal hasn't been read yet also retries.
   - An invoice links by its PO number, retrying until that purchase is on file, then is assessed. A line that names a change not on file yet retries too; a charge that names no change is recorded unlinked and disputed (a surprise charge). When there are differences, the clarification is drafted to the simulated outbox.
3. **Reassessment:** every drain round and every few seconds of polling, the worker reassesses any open invoice whose inputs changed (a receipt attestation, a purchasing decision, a new email). It records a new assessment only when the fingerprint changed.
4. **Outbox:** a person approves the draft (`approve_outbox`); `send_outbox` marks it sent with a `simulated-` delivery ref. Nothing leaves the laptop.
5. **Failures:** the module retries a failed job (10 s, 20 s backoff, three attempts) and hands a dead worker's job to another after its 5-minute lease. Anything a person must look at ends with the document in `needs_review`, with the reason in an `invalid` extraction run: no labelled extraction, bad evidence, ambiguous linking, or retries run out (any document type; an invoice revision it backs also gets `EXTRACTION_REVIEW`). A failure never produces an approval. Handlers are idempotent, so a retried job never duplicates a record.

## Live extraction (step C, done)

- **Strict schemas** (`live_extract.py`, `output_config.format`): every property required, no `anyOf`, no field named reasoning/thinking/trace/rationale. Facts are one generic item in an array (`{name, found, value, quote, fragments, missing_reason}`), because separate objects per fact were rejected as "compiled grammar is too large". Code turns not-found into null and compares enums case-insensitively. Output takes the fixture shape, so the evidence check and recording are the same in both modes.
- **Calls:** an email is one call, given the change requests on file. A PDF is two: classify, then that kind's schema; an invoice is given the change requests its lines may bill. Streaming, `max_tokens` 32k, effort `medium`, thinking at the model default, no fallbacks. Each run records the model that answered, latency and tokens.
- **Order:** an invoice PDF waits for emails received before it, which may hold the changes it bills. A retry reuses the validated extraction instead of calling Claude again.
- **Failures:** a refusal, a 4xx or a cut-off answer sends the document to review (no retry); timeouts, 429 and 5xx retry, then go to review. Never an approval.
- **Prompt injection** (`injection.py`): fixed patterns over every fragment (a PDF's hidden text included) plus Claude's `instructions_found`. An invoice is still recorded and gets `PROMPT_INJECTION`; any other document goes to review. Never followed. The scan flags none of the 9 real documents.
- **Clarifications** wait until nothing else from that supplier is still being read; the sweep drafts them afterwards.

**Measured** (`scripts/check_extraction.py`, 2026-10-25, `claude-opus-5-5`, effort medium, no fallback): 27/27 labelled fields correct; all exact values reproduced ($87,425 claimed, $83,700 authorised, $3,500 variance, $225 pending; corrected $83,700, $73,700 proposed, no holds after receipt). Claude time per document: emails 3–7 s, PO 11 s, quote and invoices 19–22 s (classify about 3 s of that). One run; numbers will vary.

## Payment and settlement (step E, done)

1. **Proposal from the assessment** (`supplier_pipeline.propose_payment`): whenever a recorded assessment proposes more than $0 and the supplier has a verified payee, the agent proposes exactly that amount, with the deposit it applies, to the verified account. One proposal per assessment; the module denies any other amount and cancels older pending ones.
2. **Owner approval** (in the app): `approve_supplier_payment` with the fingerprint of the assessment the owner saw. The module checks the six eligibility rules (active revision, no open holds, receipt attested, verified payee, latest fingerprint and amount, deposit fits). If any fails, approval is denied with the reasons.
3. **Gateway** (`supplier_gateway.pay_supplier`, the `pay_supplier` job):
   - **Before paying:** it recomputes the fingerprint from the current rows. If an input changed since approval, it doesn't pay; it logs the changed inputs on the invoice timeline, and the sweep then reassesses, which makes the approval stale. If no input changed but the fingerprint differs, it prints `FINGERPRINT MISMATCH with the module` and doesn't pay.
   - **Paying:** `start_payment` (the module re-checks everything and marks the approval stale on any mismatch), then one Nessie transfer per idempotency key (`nessie.pay_once`, which survives a timeout after the bank accepted it).
   - **Afterwards:** `record_payment`, the deposit allocation, and the §9.6 journals (bill at the authorised amount, deposit applied, settlement). A retry after a crash finds the payment already recorded and finishes the bookkeeping exactly once.
   - **Simulated** throughout ("Nessie sandbox (simulated)").
4. **Result** (tested): $73,700 settled to the account ending 2290, AP $0, prepayment $0, $83,700 cash out including the deposit, one transfer, approval `used`.

## Key files

| File | What |
|---|---|
| `countersign/reducers.py` | The only place that knows reducer argument order (CONTRACT §4 and §9.4, v2.2) |
| `countersign/fake_store.py` | Runnable Python copy of the module's rules, for tests; the TypeScript module mirrors it |
| `countersign/commercial.py` | v2 deterministic assessment, holds, fingerprint, bill-posting gate |
| `countersign/extractions.py` | v2 evidence validation and recording; fixture loader |
| `countersign/intake.py` | v2 intake: bytes, SHA-256, document, fragments, email, `process_document` job |
| `countersign/supplier_pipeline.py` | v2 job handlers: `process_document` (fixture or live), `reassess` (+ the stale sweep), `send_outbox`, give-up path |
| `countersign/live_extract.py` | v2 live extraction: strict schemas, the Claude calls, live output to the fixture shape |
| `countersign/injection.py` | Prompt-injection patterns over a document's fragments |
| `countersign/extraction_score.py` | Labelled fields vs. the answer key (tests, `check_extraction.py`, scorecard only) |
| `countersign/supplier_world.py`, `supplier_docs.py` | v2 fictional world, document rendering and fragments |
| `countersign/supplier_ledger.py` | v2 journals |
| `countersign/supplier_agent.py` | v2 Droid agent: the nine tools, the draft validator, the session and its scripted fallback |
| `countersign/supplier_gateway.py` | v2 gateway: fingerprint re-check, start_payment, Nessie (simulated), deposit allocation, journals |
| `countersign/clarify.py` | v2 clarification to the supplier: deterministic template until step C |
| `countersign/supplier_seed.py` | v2 seeding, plus `RecordingStore` / `export_seeds` / `replay` for `data/seeds/` (`scripts/export_supplier_seed.py`; see `data/README.md`) |
| `countersign/money.py` | Integer cents and integer-thousandth quantities; exact extension |
| `countersign/checks.py`, `decide.py` | v1 deterministic checks and decision rules |
| `countersign/agent.py` | v1 Droid agent, scripted agent, compromised-agent demo, "why?" chat |
| `countersign/pipeline.py` | v1 seed, intake, agent tools, gateway (pays once, even after a timeout), ledger |
| `countersign/world.py`, `attacks.py` | v1 company, history, demo pile and scam generator |
| `countersign/worker.py` | Job worker: ready jobs (backoff, expired leases), v1 and v2 handlers, reassessment sweep; holds only the agent, gateway and sync keys |

## Module reference coverage (CONTRACT §9.4)

Implemented in `fake_store.py` and `reducers.py`: setup and records, amendments, invoices and assessment, holds, receipt attestation, payee decisions, the outbox (`draft_outbox`, `approve_outbox`, `mark_outbox`), supplier payments (`propose_supplier_payment`, `approve_supplier_payment`, `reject_supplier_payment`, `start_payment` re-check, `record_payment`, `record_deposit_allocation`, with the module's `makeStale`), and the job rules (attempts, leases, backoff, §9.5 kinds). Rules beyond the contract text that the TypeScript module should mirror: a new change request can't be created as authorised (the stored classification follows the in-app decision and supplier acceptance); a pre-established contact's email and phone can't change, and a contact can't become pre-established later; payee profiles, documents and invoice lines are immutable; lines go only on the active revision.

Not yet: CONTRACT v2.2 (`decide_disputed_line`, `resolve_hold` refusing money holds).

## Run against the SpacetimeDB module

v2 (supplier invoices):

```bash
uv run --project core python scripts/setup_actors.py         # once per fresh module (now includes purchasing and receiver)
uv run --project core python scripts/load_supplier_seed.py   # the demo's opening state; --all adds the reply and revision 2
uv run --project core python scripts/run_worker.py           # only after the check passes: processes documents, reassesses, sends (simulated)
```

Right after loading, `load_supplier_seed.py` compares the module with the Python reference (`countersign/seed_check.py`). It replays the same seed locally and compares the rows the seed created, column by column, skipping columns that legitimately differ: timestamps, identities, request ids, auto-increment ids and `audit_log`. It also checks, per invoice, that the fingerprint Python computes from the module's rows equals the module's latest assessment; otherwise the worker would record an extra version. Any difference prints as a `MISMATCH` line (exit code 2); `--check-only` runs the comparison without loading. Not yet run against a live module from this branch.

v1 (subcontractor bills):

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
- **v2:** one Droid session per invoice revision, inside that invoice's `process_document` job (`countersign/supplier_agent.py`, `AGENT_MODE=droid`).
  - **What runs first:** code records the deterministic assessment and holds before Droid starts, so the numbers are on screen.
  - **Droid's tools:** only the brief's nine (`get_invoice_bundle`, `get_term_version`, `get_source_fragment`, `get_authority_policy`, `list_open_holds`, `run_check`, `open_hold`, `draft_clarification`, `propose_supplier_payment`); built-in tools are removed with `restrict_tools`, and no tool exposes `origin`.
  - **Holds:** `open_hold` only takes amountless codes (`PROMPT_INJECTION`, `SUPPLIER_RISK`, `DUPLICATE_REVIEW`, `EXTRACTION_REVIEW`) with a cited fragment.
  - **Payment:** `propose_supplier_payment` takes no amount.
  - **Drafts:** Droid writes the clarification body, and code validates it before saving. It rejects amounts that aren't in the assessment, a missing disputed line or ask, short-pay wording, bank/payment/remittance details, links, email addresses, phone numbers, and any text a document tried to instruct us with. Code sets the recipient and subject.
  - **Timeline:** every step goes to `agent_step`.
  - **Fallback:** if Droid is unavailable, fails (a failed run is never mistaken for one that chose to do nothing), or passes its 120 s limit, or ends without a needed draft or proposal, the scripted rules finish, and the timeline says so.
  - **Timing:** two Claude calls (~25 s) plus at most ~140 s of Droid keeps the job well inside the 5-minute lease.
  - **Real run:** `scripts/try_droid.py` runs one real session on invoice BM-23104 revision 1. It needs the `droid` CLI and `FACTORY_API_KEY`.

## Known gaps (as of this commit)

- File preview for the nine BayMix documents: `GET /` lists them and `GET /files/{source_file_id}` serves the PDF or `.eml` from the seed when `storage_path` is empty. Audit export is still open.
- Judge page: `sneak_charge` opens the matching hold on the active revision and never pays.
- A first real Droid run (needs `FACTORY_API_KEY`), the citation-backed "why?" explanation (a separate call that can't change amounts), and a small call that reads the fuel-surcharge parameters for the fuel variant.
- Variants: scoped amendment, fuel surcharge (Apify diesel actor still unset — license actor too), supplier risk (CRS sandbox keys are wired; mapping of the live BLJ payload is still coarse).
- Settlement decisions on disputed lines (`decide_disputed_line`, CONTRACT v2.2): next, now that step B's core works. Until then, money holds clear only through a corrected invoice.
