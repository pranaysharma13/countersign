# Brief for the Python developer's AI (v2)

Paste this whole file as your first message to Claude Code, opened at the repo root.

---

You're working with one human on a 3-person team at Cal Hacks 13.0 (hard deadline **Sunday 9:00 AM PT**; judging 10:30 AM). We're building **Countersign**: it checks every supplier invoice against what was actually agreed (quote, purchase order, email thread) and prepares a payment the controller can trust. Your human owns **all Python**: `core/`, `data/`, `scripts/`. Another teammate owns TypeScript (`db/` SpacetimeDB module, `web/` Next.js). A third owns the pitch (`pitch/`).

## Read these first
1. `SPEC.md` (v2): product, roles, statuses, the demo scenario with exact numbers.
2. `docs/CONTRACT.md` §0–§6 and **§9**: you call reducers over HTTP with **positional JSON arrays in the documented order** and read with SQL. Add every §9 reducer to `core/countersign/reducers.py` (the only place that knows argument order) and to `fake_store.py` (the runnable reference of the rules).
3. `docs/ARCHITECTURE.md` and `docs/BUILDBUY_PROMPT.md` (detailed requirements; **not** its Postgres stack).
4. `CLAUDE.md`, `docs/CHECKLIST.md` (your items are **PY**).

## What already exists (v1, keep it working)
Store client, reducer wrappers, the in-memory reference (`fake_store.py`), the job worker, the Droid agent restricted to our tools, the gateway (pays once, even after a timeout), balanced journals, the scam generator, and 16 passing tests for the subcontractor pay-application flow.

## Build order (SPEC §11)
- **A.** Fixture documents for the primary scenario: quote PDF with terms, acknowledged PO, two email threads, invoice, corrected invoice. Plus the answer key (separate from model inputs), commercial checks and exact-value tests: $87,425 · $77,425 · $3,500 · $225 · $3,725 · $83,700 · $10,000 · $73,700 · AP $0 · cash out $83,700.
- **B.** Intake (`process_document` jobs), worker retries and leases, holds, receipt and deposit logic, all against the real module.
- **C.** Live Claude extraction with a strict JSON schema (`output_config.format` or `strict: true` tools) and email classification (proposed / accepted / declined, scope, authority). Every material field references a `source_fragment` that must exist and match after whitespace normalization; otherwise `EXTRACTION_REVIEW`. `AI_MODE=fixture` uses labeled fixtures and says so. Reassess automatically when a new document arrives.
- **D.** Support the web: file preview, email intake endpoint.
- **E.** Version-bound approval, settlement through Nessie, deposit allocation once, journals (CONTRACT §9.6), audit export.

**Variants:**
- **Scoped amendment:** $172 for later deliveries only. Apply it to that scope, or ask for the allocation.
- **Bank change:** `PAYEE_CHANGE_PENDING` survives an invoice correction.
- **Fuel surcharge:** an Apify Actor scrapes the public weekly diesel price index; the check recomputes the allowed surcharge.
- **Supplier risk:** CRS business credit and public records before any deposit.
- **Prompt injection.**
- **Judge page:** `sneak_charge` jobs.

## Rules for the agent
- Claude interprets; code decides. Arithmetic, limits, permissions, duplicates, deposit allocation, eligibility, journals and idempotency are deterministic Python or module rules.
- Never fill a missing price, acceptance, date, quantity, bank verification or tax rate from general knowledge: null with a reason.
- A proposed charge is not an accepted one. "Waiting charges may apply" doesn't prove 90 minutes. An internal approval only counts when made in the app by an authorized person.
- **Never silently pay less.** Draft a clarification asking for a corrected invoice or an agreed credit.
- Keep legitimate charges. Not every difference is supplier misconduct.
- Droid tools (read-only + proposals): `get_invoice_bundle`, `get_term_version`, `get_source_fragment`, `get_authority_policy`, `list_open_holds`, `run_check`, `open_hold`, `draft_clarification`, `propose_supplier_payment`. Built-in file and shell tools stay off (`restrict_tools`). Every step goes to `agent_step`.
- The "why?" explanation can use Claude citations in a **separate** call that can't change amounts or approvals.

## Tests that must exist
The exact primary values; a legitimate extra accepted; a proposed extra kept pending; price variance; the scoped amendment; late amendment; a forwarded "approved" email doesn't count; purchasing over its limit is denied; a duplicate PDF; a corrected invoice supersedes; the deposit is applied once; a stale approval blocks payment; a bank change holds; prompt injection; a Claude timeout leads to review, never approval; worker restart; double submission and double settlement are no-ops; journals balance.
