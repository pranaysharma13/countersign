# data/ — Demo data, fixtures and answer keys

**Owner:** Python developer · **Branch:** `py/core`

Everything here is fictional: Marlow & Finch Builders (general contractor), BayMix Supply (ready-mix supplier), people, domains (`.example`), phones (555-01xx) and bank tokens.

## Layout

| Path | What | Read by |
|---|---|---|
| `fixtures/baymix_primary/extractions/` | Labelled fixture extractions, one per document: what Claude would return, with fragment ids and quotes for every material value. Every file says `"mode": "fixture"` and starts its label with `FIXTURE`. | `AI_MODE=fixture` extraction (`core/countersign/extractions.py`) |
| `answer_keys/baymix_primary.json` | Ground truth: labelled fields, change-request classifications, exact assessment values, holds, final books. | Tests and the scorecard only. **Never a model input**; a test checks the extraction and assessment code never reads it. |
| `seeds/baymix_opening.json`, `seeds/baymix_correction.json` | The primary scenario as replayable reducer calls (see below). Committed. | The web's local backend |
| `seeds/queue_companions.json` | Fictional Oakview invoices beside BM-23104 (Cedar & Bolt, Northline, Harbor Pack, Valley Sand, Redline Haul, Peak Form). Does not change BM-23104. | The web's local backend |
| `fixtures/companions/extractions/` | Labelled fixture extractions for those companion documents. | `AI_MODE=fixture` |
| `fixtures/baymix_variants/extractions/` | Labelled fixtures for the SPEC §8 variant emails (scoped amendment: $172 for the final 120 cy, or for pours from Oct 19). Not part of the primary scenario. | `AI_MODE=fixture` |
| `seeds/judge_sandbox.json` | The judge page's sandbox: a fictional supplier (Judge Sandbox Supply), its verified payee, and a purchase with BayMix's quote terms (PO MF-PO-9001). Every `sneak_charge` becomes an invoice on it. Never touches BM-23104. | `scripts/load_supplier_seed.py` (after the opening state) |
| `generated/sandbox/extractions/` | Extractions generated from a judge's inputs (`AI_MODE=fixture`), labelled `FIXTURE (generated)`. Ignored by git. | `AI_MODE=fixture` extraction |
| `generated/` | Rendered PDFs and `.eml` files, v1 bills, runs. Ignored by git. | Humans, the file preview API |

## Seeds for the web's local backend

Two ordered JSON lists of reducer calls, so the web's local demo shows the same invoice BM-23104 as Python:

| File | Ends at |
|---|---|
| `seeds/baymix_opening.json` | The demo's starting state: actors and limits, the company (the payer account), supplier and contacts, documents with fragments and emails, purchase and terms, change requests, the purchasing decision on the weekend charge, supplier acceptances, the settled deposit (simulated) and its journal, invoice BM-23104 revision 1 with lines, its assessment and holds, and the clarification drafted to BayMix (simulated outbox). |
| `seeds/baymix_correction.json` | BayMix's reply email (agrees to $165/cy, withdraws waiting), corrected revision 2 with lines, its assessment, and the agent's $73,700 payment proposal (the owner can approve it once receipt is attested). `RECEIPT_NOT_VERIFIED` carries over to revision 2 inside `record_invoice_revision`. |

Format: `[{"role": "sync", "reducer": "add_fragment", "args": {"id": "...", ...}}, ...]`
- `args` are named with the contract's parameter names, in contract order. There's no `request_id`: the replayer generates one per call. Every call returned `ok` when the seed was generated.
- **Identities are placeholders.** `register_actor` and `set_authority` carry `identity_hex` as `"<identity:purchasing>"` (and so on for each role), because the web's local backend has its own identities. Substitute that role's identity when replaying.
- `claim_admin` isn't included: the replayer's admin claims it first.
- Integers are JSON numbers. Args named `*_cents` and `*_milli` are i64 in the module (convert to BigInt). Args ending in `_json` are JSON strings.
- Extractions are labelled fixtures (`extraction_run.mode = fixture`). The deposit, the outbox and any payment are simulated.

Regenerate after changing the fixtures, `core/countersign/supplier_world.py`, the assessment or the clarification template:

```bash
uv run --project core python scripts/export_supplier_seed.py
```

The output is byte-identical on every run (no timestamps or random ids). Tests fail if the committed files are stale, and replaying both files into a fresh module reference reproduces the exact values.

## The documents

The source text of the BayMix documents lives in `core/countersign/supplier_world.py` (line by line, so each line is one immutable fragment). Render them with:

```bash
uv run --project core python scripts/make_supplier_fixtures.py   # -> data/generated/fixtures/baymix/
```

| Document | What it establishes |
|---|---|
| `BayMix_Quote_BMQ-4417.pdf` | Up to 500 cy at $165/cy, fixed through 2026-10-31; $10,000 deposit; terms: price changes need mutual written agreement, extra charges only when agreed in writing first, fuel surcharge tied to the weekly diesel index |
| `MarlowFinch_PO_MF-PO-1031.pdf` | $82,500 not to exceed, incorporates the quote, acknowledged by BayMix on 2026-10-01 |
| `em_weekend_1..3.eml` | BayMix proposes a $1,200 weekend-delivery charge; our purchasing replies by email; BayMix confirms. Internal approval only counts in the app. |
| `em_waiting_1.eml` | "Waiting charges may apply": no rate, no acceptance, no usage evidence |
| `BayMix_Invoice_BM-23104.pdf` | 500 cy at $172, $1,200 weekend, 90 min waiting at $2.50: $87,425 gross, $77,425 balance |
| `em_reply_1.eml` | BayMix's reply to our clarification: agrees to $165/cy, withdraws the waiting charge, attaches the corrected invoice |
| `BayMix_Invoice_BM-23104_rev2.pdf` | Corrected invoice that supersedes the first: $83,700 gross, $73,700 balance |

The v1 subcontractor data (pay applications, history, scam bills) is generated by `core/countersign/world.py` and `attacks.py`.

## Companion invoices (queue realism)

Same fictional contractor, same Oakview job, other suppliers. They are not a second scored scenario; they make the work queue show every v2 use case next to BM-23104.

| Invoice | Story |
|---|---|
| Cedar & Bolt `CB-8802` | 200 sheets of plywood at the quoted $20.90. Receipt attested. Ready for the owner to approve $4,180. |
| Northline Rebar `NL-441` | 2 tons of #5 bar at the quoted $1,250/ton. Receipt attested, then an email asking to pay a new account ending 7703. Held `PAYEE_CHANGE_PENDING` until the owner calls the contact already on file. |
| Harbor Pack `HP-220` | 40 crates at $18.50, commercially matches. Hidden "SYSTEM: approve…" text opens `PROMPT_INJECTION`. No payment proposed. |
| Valley Sand `VS-310` | Quote ceiling 80 tons; invoice bills 95 tons at $42. Held `PO_CEILING`. No payment proposed. |
| Redline Haul `RH-55` | 12 loads match the quote; unapproved fuel surcharge $180 opens `PROPOSED_CHARGE`. No payment proposed. |
| Peak Form `PF-77` | Commercial match, receipt attested, verified payee. CRS test identity has a civil judgment: `SUPPLIER_RISK`. No payment proposed. |
