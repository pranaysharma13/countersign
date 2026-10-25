# Master checklist (v2: supplier invoices)

Owners: **PY** = Python developer (+ their AI) · **TS** = TypeScript developer · **PD** = pitch & docs teammate · **ALL** = everyone.
Tick items off in this file (small commits) or in team chat.

## Now
- [ ] **ALL** Read `SPEC.md` (v2) and `docs/CONTRACT.md` §9. Nobody pastes `docs/BUILDBUY_PROMPT.md` into Claude Code as a standalone prompt.
- [ ] **TS** Push whatever exists to `ts/app` now, even unfinished, so integration can start.
- [ ] **PY** Keys: Anthropic, Factory (`droid` CLI), CRS sandbox, Nessie, Apify. Run `scripts/check_droid.py`.
- [ ] **PD** Devpost project created, teammates added. Contractor interview: how do you check supplier invoices against quotes and email changes? Ever paid a price increase you never agreed to?
- [ ] **PD** Booths: CRS (which test businesses show liens/judgments/bankruptcy; is business credit in the sandbox), Apify (diesel price index Actor for Best Actor), Hyphenate (run the new one-liner past them).

## By ~8:30 PM
- [ ] **TS + PY** CONTRACT v2 agreed in team chat.
- [ ] **PY** Step A: fixture documents (quote, PO, emails, invoice, corrected invoice), answer key, commercial checks, exact-value tests.
- [ ] **TS** SpacetimeDB go/no-go (if not done): Python calls a reducer over HTTP, web shows the row live.

## By ~11 PM
- [ ] **TS** §9 "A" reducers published locally, with Vitest tests for: separation of duties, purchasing limit, immutable fragments, deposit applied once, stale approvals, eligibility re-check at `start_payment`, agent can't resolve holds.
- [ ] **PY** Step B: intake, worker (retries, leases), holds, receipt and deposit logic against the real module.
- [ ] **ALL** Primary scenario end to end with fixtures: $87,425 claimed → holds → clarification → corrected $83,700 → receipt attested → approval → $73,700 settled, AP $0.

## By ~1 AM
- [ ] **PY** Step C: live Claude extraction (strict schema) + email classification with fragment validation; automatic reassessment on new documents.
- [ ] **TS** Step D: four views on live data (work queue, purchase record, invoice case, approval review); source viewer opens the real PDF page or email.
- [ ] **TS** Publish to Maincloud; web on Vercel.
- [ ] **PD** **Devpost draft submitted.** Research pack: how ready-mix pricing, waiting time and fuel surcharges are usually written (sources required).

## By 4:00 AM: feature freeze
- [ ] **PY** Step E (version-bound approval, settlement, ledger, audit export) + variants: scoped amendment, bank change, fuel surcharge (Apify), supplier risk (CRS), prompt injection, "sneak a charge" judge page.
- [ ] **PY** Scorecard measured and locked (extraction accuracy, exception precision/recall, authorized changes accepted, latency, human decisions).
- [ ] **TS** Judge page, stale-approval warnings, disabled buttons that say why.
- [ ] **PD** Slides with measured numbers only.
- [ ] **ALL** Nothing new after 4 AM, only fixes.

## 4:00 → 8:00 AM
- [ ] **ALL** Demo reset works; full run-through on the demo laptop.
- [ ] **PD + ALL** 5+ timed rehearsals (2- and 3-minute versions), Q&A drill.
- [ ] **PD** Demo video (opens with the moment), README: setup, architecture, **where Droid runs**, CRS data use, real vs. simulated, live vs. fixture.
- [ ] **PY** Apify Actor published (if built).

## By 8:30 AM: final submission (deadline 9:00 AM, hard)
- [ ] **PY** Repo public; scan full git history for secrets.
- [ ] **PD** Devpost final: every track selected, video, image, repo link, all teammates.

## Judging (10:30 AM – 12:30 PM)
- [ ] **ALL** All three at the table the whole time; laptop charged; demo reset; offline backup video; QR code for the judge page.
