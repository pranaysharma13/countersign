# Handoff: Python side (core/, data/, scripts/), session of 2026-10-25

For the next session working on the Python side. Read `CLAUDE.md` first; this file only says where things stand.

**State (finish session).** Python work is on `py/core`; the module and web fixes the teammates agreed to are on
`fix/finish` (which merges `py/core`). Neither is merged to `main` yet. Python suite: 220 passed. `db/` vitest: 77 passed on
`fix/finish`. The web build needs `fix/finish` (the `billStory`/`nextStep` fix lives there), so check `py/core` together
with it: merge both into a throwaway branch and run all four checks.

**How this user works.** Plan first and get agreement before building anything non-trivial. PRs are merged with a merge
commit once the user says so. The repo has no CI, so run both suites before every push.

## What this session shipped

| PR | What | Where |
|---|---|---|
| #16 | `/files/{id}` serves a stored path only inside `FILES_DIR` and only `.pdf`/`.eml` (`message/rfc822`); otherwise the seed document or 404 | `api.py`, `tests/test_api_files.py` |
| #18 | CONTRACT v2.2 (§9.9) settlement decisions, Python side and the reference module | `fake_store.py`, `reducers.py`, `commercial.py`, `supplier_gateway.py`, `tests/test_supplier_settlement.py` |
| #19 | Judge sandbox: every `sneak_charge` is a real invoice through intake -> `process_document` -> assessment on a fictional sandbox supplier; never BM-23104; plus the invoice payee-change path | `sandbox.py`, `data/seeds/judge_sandbox.json`, `tests/test_judge_sandbox.py` |
| #20 | v1 Droid agent reports a failed run with Droid's own error (ErrorEvent / RunFailure -> `DroidFailed`) | `agent.py`, `tests/test_agent_droid.py` |
| #22 | Bank-change emails go through the payee path (SPEC §8); Northline's seed uses it | `supplier_pipeline.record_payee_changes`, `tests/test_bank_change_email.py` |
| #23 | Audit export `GET /invoices/{id}/audit` (JSON or `?format=csv`) | `audit_export.py`, `tests/test_audit_export.py` |
| #24 | Scoped amendment (SPEC §8): a date-scoped price never covers deliveries outside it | `commercial.period_fit`, `variant_fixtures.py`, `tests/test_scoped_amendment.py` |

### Finish session (py/core and fix/finish)
| What | Where |
|---|---|
| Seed for "BayMix won't correct" (§9.9): both lines decided pay-agreed, notices sent, receipt attested, $73,700 proposed | `settlement_seed.py`, `data/seeds/baymix_wont_correct.json` |
| `load_supplier_seed.py` skips a seed the module already matches (after `reset_demo_v2.py`) | `scripts/load_supplier_seed.py` |
| Cited "why?" explanation, read-only, fixture mode | `why.py`, `api.py` (`GET /invoices/{id}/why`), `tests/test_why.py` |
| No payment proposed while `PROMPT_INJECTION` / `SUPPLIER_RISK` (or any non-stale hold) is open | `supplier_pipeline.propose_payment` |
| CRS asked on every recorded invoice; `SUPPLIER_RISK` on public records (mock test identities) | `supplier_pipeline.supplier_risk` |
| Scorecard v2: 18 scenarios through the real pipeline vs a hand-written key | `scorecard_v2.py`, `data/answer_keys/scorecard_v2.json`, `data/scorecard_v2.{json,md}` |
| fix/finish: web build, judge page from the job result, audit link, v2.2 in the module + UI, Why? button | `db/`, `web/` |

### Rules worth knowing before you touch these
- **v2.2 (reference module).** `resolve_hold` denies the four money holds whatever their status. A money hold closes only
  when it covers at least one disputed line, so `PO_CEILING` clears only through a correction. An active
  `pay_agreed_dispute_rest` notice that isn't `sent` blocks approval *and* `start_payment` ("notice to supplier not sent");
  the gateway checks it too. `record_payment` sets `partially_settled` when such a decision is active.
- **Assessment details.** Each line in `details_json.lines` carries `line_id`, `hold_code` (`''` or a money hold; other
  codes move to `review_hold_code`), `pending_cents` and `variance_cents`. Settlement decisions apply only while their
  amount equals the line's disputed amount. Decisions and the delivery period are fingerprint inputs **only when
  present / relevant**, so older fingerprints and seeds don't move.
- **Payee changes.** Invoice and email extractions may carry `payee_change_requests` (the last4 must be in the quote).
  `record_payee_changes` adds a pending profile as `agent`, and the module opens `PAYEE_CHANGE_PENDING`. The verified
  account, or a repeat, records nothing. Live prompt version `extract-v1.2`.
- **Sandbox.** Supplier `sup_sandbox`, PO `MF-PO-9001`, with BayMix's quote terms (renamed). Fixture mode writes a
  generated extraction to `data/generated/sandbox/extractions/`, labelled `FIXTURE (generated)`, model `generated`.
  Fuel opens `USAGE_EVIDENCE_MISSING` (the fuel rule is accepted, the diesel index isn't checked). A sandbox bank change
  leaves a pending profile until the owner rejects it.
- **Scoped prices.** A quantity scope applies to that quantity. A date or delivery scope is checked against the invoice's
  delivery period (from its validated reading): all inside -> the new price; none -> quoted price; partial or unknown
  -> quoted price plus `USAGE_EVIDENCE_MISSING`, asking for delivery tickets.
- **Audit export.** Account tokens are masked; CSV cells starting `= + - @` are prefixed with `'`. A denial without an
  entity id can't be attributed to an invoice (the export says so).

## Seeds and fixtures
- Regenerate everything with `uv run --project core python scripts/export_supplier_seed.py`. Tests fail when anything
  is stale.
- `scripts/load_supplier_seed.py` loads `baymix_opening.json`, then `judge_sandbox.json` (`--all` adds the correction).
  The web's local backend replays `baymix_*` and `queue_companions.json`, not the sandbox.
- Variant documents (`supplier_world.VARIANT_DOCS`) are outside the primary nine. Their fixtures are in
  `data/fixtures/baymix_variants/`.

## Blocked: needs the user (environment settings; never ask for secrets in chat)

| Item | Needs |
|---|---|
| CRS supplier risk (original item 4) | The Postman collection (in the repo or uploaded); `CRS_USERNAME` and `CRS_PASSWORD` as environment secrets; network access to `api-sandbox.stitchcredit.com`. Until then `integrations/crs.py` stays in mock mode. Don't invent a payload mapping. |
| Fuel surcharge from the diesel index | Apify diesel actor id + `APIFY_TOKEN` |
| First real Droid run | `FACTORY_API_KEY` |
| Cited "why?" explanation, live | `ANTHROPIC_API_KEY`, to run it once live. Fixture mode and the request shape are tested. |
| A real SpacetimeDB run (item 3) and Maincloud | The `spacetime` CLI (install.spacetimedb.com is blocked by this environment's network policy) and `spacetime login`. Rehearsed so far against a stand-in that runs the module's code behind the same HTTP API. |

## Open questions (shared files: need both coders)
1. **A v2.2 decision whose amount stops matching** can't be replaced on the same revision: the line still has an `active`
   decision, so a new one is invalid. Nothing is paid meanwhile (the assessment proposes $0). Suggested contract change:
   `record_assessment` supersedes active decisions whose amount no longer matches and reopens their holds.
2. **Superseded decisions' notice drafts** stay `draft` after a correction and could still be sent.
3. ~~Confirm the TypeScript module puts the unsent-notice check in approval as well as `start_payment`.~~ Done on `fix/finish` (`blockedReasons`).

## For the TypeScript side
The three asks from #18, #19 and #23 are done on `fix/finish`, with the teammates' agreement: v2.2 in the module and
the invoice page, the judge page showing the sandbox invoice and its holds, and a "Download audit" link.

## Known quirks
- `tests/test_end_to_end.py::test_stress_judges_every_attack_and_repeated_real_bills` fails only when the live-extraction
  tests fail first: some state leaks between tests when one fails partway. It passes on a clean run.
- Ruff has no config, so its default line length flags `I001` across the repo. Match the surrounding style (long
  wrapped imports); compare against `main` rather than chasing zero.
- The TypeScript PRs #17 and #21 also edited `core/` (`api.py`, companion files). The changes were reviewed and kept (the
  file route's `FILES_DIR` check is intact). Per `CLAUDE.md`, cross-folder edits should go through team chat.
