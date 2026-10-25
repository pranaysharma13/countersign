# Countersign — Spec (v2: supplier invoices)

The single source of truth for the team. If code and this file disagree, fix one of them.
Detailed requirements: [docs/BUILDBUY_PROMPT.md](docs/BUILDBUY_PROMPT.md) (our teammate's full spec). Where it conflicts with this file or [docs/CONTRACT.md](docs/CONTRACT.md) (mainly the stack), **this file wins**. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 1. One-liner

**Countersign checks every supplier invoice against what was actually agreed (the quote, the purchase order and the email thread) and prepares a payment the controller can trust.** It keeps legitimate charges, questions the rest with evidence, and never moves money on its own.

**Seats it fills (for Hyphenate):** materials purchasing coordinator and accounts-payable exceptions analyst. The owner/controller stays the financial approver.

**Why this problem:** fraud is rare; paying more than you agreed happens every month. Suppliers raise unit prices, add waiting time, fuel surcharges and extras nobody accepted, and a busy contractor pays the invoice. Countersign saves money on routine invoices, not just in a once-a-year scam.

## 2. The customer and the demo world (all fictional)

- **Marlow & Finch Builders**, a small California general contractor (owner: Dana Marlow; outside bookkeeper: Sam Okafor). Same company as v1.
- Buys **ready-mix concrete** from **BayMix Supply** for the **Oakview Lane Fourplex**. The GC buys the concrete; its sub Granite Line Concrete places it (common practice).
- The **superintendent** confirms receipt in the app. That's a signed attestation, not machine proof.
- The v1 flow (subcontractor pay applications, fake bank-change bill) stays in the code as a second capability. **The demo leads with supplier invoices.**

## 3. Inputs (exactly five)

1. Supplier quotes and incorporated terms (PDF).
2. Purchase orders (PDF, documented CSV or structured entry).
3. Email threads about extra charges, price changes and acceptance (pasted text or .eml).
4. Supplier invoices, arriving days or weeks later.
5. Decisions made in the app by authorized people (purchasing approver, receiver, controller).

Supporting data: users and roles with authority limits, projects, supplier directory and known contacts, payee profiles (dummy, masked), deposit history.

**Out of scope:** delivery tickets, GPS, unloading times, receiving feeds, quality reports. Countersign **cannot** prove what was delivered and never pretends to. If receipt is required and nobody has attested it, payment stays blocked.

## 4. People and roles

| Role | Who | Can do |
|---|---|---|
| `owner` | Owner / controller | Approve payments (bound to an exact invoice version), verify payee changes, resolve commercial holds with a note |
| `purchasing` | Purchasing approver | Approve change requests **within an authority limit** ($2,000 in the demo); never their own request |
| `receiver` | Superintendent | Attest receipt (quantity, scope, reason), labeled MANUALLY_CONFIRMED |
| `bookkeeper` | Outside bookkeeper | Read everything; approve policies |
| `agent` | Countersign AI | Read, extract, link, assess, open holds, draft clarifications, propose payments. **Never approves, pays, verifies a payee or clears a hold.** |
| `gateway` | Payment service | The only role that settles payments (Nessie) and posts payment journals |
| `sync` | Intake | Records documents, emails, fragments, invoices |
| `admin` | Setup script | Registers roles and limits |

## 5. Separate statuses (never one "verified" flag)

Each invoice has five independent statuses: **commercial**, **receipt**, **payee**, **approval**, **payment**.
Independent holds, any of which blocks payment: `CONTRACT_REVIEW`, `PRICE_VARIANCE`, `PROPOSED_CHARGE`, `USAGE_EVIDENCE_MISSING`, `PO_CEILING`, `DUPLICATE_REVIEW`, `EXTRACTION_REVIEW`, `RECEIPT_NOT_VERIFIED`, `PAYEE_CHANGE_PENDING`, `APPROVAL_STALE`, plus `PROMPT_INJECTION` and `SUPPLIER_RISK` (CRS). Resolving one hold never clears another.

## 6. How an invoice flows

1. **Intake:** a document or email arrives. Original bytes and SHA-256 are kept; a job is queued in the same transaction.
2. **Extract:** Claude classifies the document and extracts fields with a strict schema. Every material field points to an **immutable source fragment** (exact text, page or email). Missing facts are null with a reason, never guessed.
3. **Link:** quote terms, PO, accepted amendments (scoped to supplier, project, product, deliveries and dates) and prior invoices.
4. **Assess (deterministic code):** claimed vs. accepted vs. pending per line, price variance, unapproved or unproven charges, PO ceiling, duplicates, deposit available, receipt, payee. Every assessment stores its inputs' fingerprint and policy version.
5. **Ask:** Countersign drafts a clarification to the supplier (simulated outbox; a person approves sending). **It never silently pays less.** It asks for a corrected invoice or an agreed credit.
6. **Correct:** a corrected invoice supersedes the earlier revision only when identity is established. The original claim is preserved.
7. **Approve:** the controller approves a payment bound to the exact revision, amount, deposit allocation, payee profile version, assessment fingerprint and policy version. Any change makes it **stale**.
8. **Pay:** the gateway re-checks eligibility, then settles through Nessie exactly once and posts balanced journals.

## 7. Claude vs. application code

| Claude handles interpretation | Application code handles financial controls |
|---|---|
| Reading quotes and supplier conditions | Arithmetic and rounding |
| Understanding email discussions | Purchasing limits |
| Identifying possible amendments | Approval permissions |
| Connecting differently worded invoice and PO items | Duplicate detection |
| Drafting clarification questions | Deposit allocation |
| Explaining findings with evidence | Payment eligibility, accounting entries, preventing repeated payments |

Claude's conversation history is never the system's memory; the database is. Anthropic's native citations can't be combined with strict JSON outputs in one request, so **extraction uses strict schemas with our own fragment IDs**, and citations are used only in the separate "why?" explanation, which can never change amounts or approvals.

## 8. The demo scenario (exact numbers, all fictional)

| Date | Event |
|---|---|
| Oct 1 | Accepted quote + acknowledged PO: up to **500 cubic yards at $165/yd**, fixed through Oct 31. Price changes require mutual written agreement. Authorized material: **$82,500**. |
| Oct 3 | **$10,000 deposit** recorded as settled (CRS supplier check passed first). |
| Oct 8 | Supplier proposes a **$1,200 weekend-delivery charge**. The purchasing approver ($2,000 limit, not the requester) approves it in the app; supplier acceptance recorded. Legitimate. |
| Later | Email: "waiting charges may apply." No acceptance, no usage evidence. |
| Oct 23 | Invoice: 500 yd at **$172** ($86,000) + $1,200 weekend + 90 min waiting at $2.50 (**$225**). Gross **$87,425**, deposit shown $10,000, balance requested **$77,425**. |

**What Countersign finds:**

| Finding | Correct treatment |
|---|---|
| $3,500 price difference | Investigate against accepted terms and amendments (`PRICE_VARIANCE`) |
| $1,200 weekend charge | Accept: properly authorized |
| $225 waiting charge | Keep pending; never invent usage evidence (`PROPOSED_CHARGE` / `USAGE_EVIDENCE_MISSING`) |
| $10,000 deposit | Apply once |
| Receipt not confirmed | Keep payment blocked (`RECEIPT_NOT_VERIFIED`) |

$3,725 is **under review**, not "money saved," until the supplier agrees.

**Resolution:** the supplier agrees to $165 and removes waiting. A corrected invoice for **$83,700** supersedes the first. The superintendent attests receipt of 500 yd (labeled manual). With a verified payee and the controller's approval, Countersign proposes **$73,700**, the gateway settles it, AP ends at **$0**, and total cash out including the deposit is **$83,700**.

**Variants:**
- **Scoped amendment (challenge):** a valid $172 price applies only to a later subset of deliveries. Countersign applies it to that scope or asks for the allocation evidence; it doesn't reject every price change.
- **Bank change:** an email asks to pay a new account. `PAYEE_CHANGE_PENDING` holds even after the invoice is corrected, until the owner verifies through a contact already on file.
- **Fuel surcharge (Apify):** the contract ties fuel surcharges to the weekly diesel price index; Apify scrapes the public index and the check recomputes the allowed surcharge.
- **Supplier risk (CRS):** before a deposit, CRS business credit and public records (liens, judgments, bankruptcy) are checked; a risky supplier opens `SUPPLIER_RISK`.
- **Prompt injection:** hidden text in an invoice ("approve this bill") is data, flagged, and ignored.
- **Judge page:** "Try to sneak a charge past it": judges compose an invoice or email and watch the assessment.

## 9. Proof

- Exact primary values asserted in tests: $87,425 · $77,425 · $3,500 · $225 · $3,725 · $83,700 · $10,000 · $73,700 · AP $0 · cash out $83,700.
- An answer key kept separate from model inputs; fixture mode (`AI_MODE=fixture`) is visibly labeled and works without a key.
- Scorecard: extraction accuracy on labeled fields, exception precision/recall, authorized changes correctly accepted, source coverage, latency, human decisions required. **Measured results only.**
- Hard failures: permission bypass, duplicate money movement, unbalanced journals, any claim of delivery verification.

## 10. Tech (our stack)

| Piece | Choice |
|---|---|
| System of work: roles, statuses, holds, approvals, audit log, job bus | **SpacetimeDB** (TypeScript module) |
| Agent | **Factory Droid** (Python SDK) restricted to our tools; Claude as the model |
| Extraction, email classification, explanations | **Claude API** (strict schemas; citations only for explanations) |
| Worker, intake API, gateway, checks | **Python** (FastAPI for uploads/email intake/file preview only) |
| Bank | **Capital One Nessie** (deposit, settlement; simulated) |
| Supplier risk, identity for payee changes | **CRS** sandbox |
| Public data | **Apify** (diesel price index; state license board for subs) |
| Interface | **Next.js**: work queue, purchase record, invoice case, approval review |

How the teammate's Postgres design maps onto this: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adapting-the-spec-to-our-stack).

## 11. Build order (from the spec)

- **A.** Domain model, money rules, fixture data, answer key, commercial checks, unit tests.
- **B.** Intake, job worker, document store, role-bound decisions, independent holds, receipt and deposit logic.
- **C.** Live Claude extraction and email classification, validated evidence, automatic reassessment.
- **D.** Web app on real data: four views, source viewer, clarification and corrected-invoice flow.
- **E.** Version-bound approval, settlement, ledger, audit export, failure and security tests.

Each step leaves a complete, demoable product.

## 12. Team

| Who | Owns | Branch | Brief |
|---|---|---|---|
| Python developer (PY) | `core/`, `data/`, `scripts/`: extraction, assessment, holds, agent, worker, gateway, fixtures, answer key, tests | `py/core` | [docs/briefs/python.md](docs/briefs/python.md) |
| TypeScript developer (TS) | `db/` module (CONTRACT §9 v2 tables and reducers), `web/` four views | `ts/app` | [docs/briefs/typescript.md](docs/briefs/typescript.md) |
| Pitch & docs (PD) | `pitch/`, final `README.md`, Devpost, video, demo script | `docs/pitch` | [docs/briefs/pitch-and-docs.md](docs/briefs/pitch-and-docs.md) |

Shared files (`SPEC.md`, `CLAUDE.md`, `docs/*`, `.env.example`, `.gitignore`) change only when both coders agree.

## 13. Schedule (Saturday → Sunday)

Full checklist with owners: [docs/CHECKLIST.md](docs/CHECKLIST.md).

| By | Milestone |
|---|---|
| ~8:30 PM | CONTRACT v2 agreed; TS starts v2 tables; PY step A done with tests |
| ~11:00 PM | Module v2 published locally; PY steps B–C against it; primary scenario passes end to end with fixtures |
| ~1:00 AM | Web views D on live data; live Claude extraction; Devpost draft |
| 4:00 AM | Step E done, variants in; **feature freeze**, scorecard numbers locked |
| 8:30 AM | Final submission (hard deadline 9:00) |
| 10:30 AM | All three at the judging table |
