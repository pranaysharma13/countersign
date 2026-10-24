# Countersign — Spec

The single source of truth for the team. If code and this file disagree, fix one of them.

## 1. One-liner

Countersign is the payables clerk for small general contractors. It pays subs on time, refuses to be scammed, and only the owner's tap moves money.

**Seats it fills (for Hyphenate):** accounts-payable clerk and vendor-risk analyst.

## 2. The company (demo world)

A fictional small general contractor in California, run by its owner, with an outside bookkeeper.

- About 8 subcontractors (framing, electrical, plumbing, drywall, roofing, concrete, HVAC, painting).
- Each sub has a subcontract: schedule of values, retainage %, change-order rules, lien waiver requirements, bank account and phone on file.
- About 6 months of bill and payment history.
- Messy on purpose: partial billing, retainage, change orders, conditional vs. unconditional lien waivers, a few late bills.

## 3. People and roles

| Role | Who | Can do |
|---|---|---|
| `owner` | The GC's owner | Approve or reject payments, approve bank changes, override holds |
| `bookkeeper` | Outside bookkeeper | Approve policies and contract terms the agent learned |
| `agent` | Countersign AI | Read records, run checks, propose payments, ask questions, propose policies |
| `gateway` | Payment service | The only role that can send money, and only for approved proposals |
| `sync` | Inbox and bank sync jobs | Create bills and bank records from sources |
| `admin` | One-time setup script | Register the other roles. Never used by the agent. |

Exact roles, tables, reducers and states: see [docs/CONTRACT.md](docs/CONTRACT.md).

**Hard rules, enforced in the database, never in a prompt:**
- The agent can never approve anything, including its own proposals.
- The AI can add holds, never remove them: deterministic rules decide what's payable.
- Some failed checks (bank mismatch, license, identity) are hard stops that even the owner can't override; the fix is bank-change verification.
- Every payment needs the owner's approval. There is no auto-pay amount.
- Bank details can only change with owner approval after outside verification.
- Only the gateway holds the bank key.
- Every change and every denied attempt is written to the audit log in the same transaction.
- Money is stored as whole cents (integers), never decimals.
- If any check fails to run, the bill is held, never paid.

## 4. How a bill flows

1. **Intake:** a bill arrives (inbox sync, upload, or the "scam us" page) and becomes a work item. Raw source (email, PDF) is kept and linked.
2. **Read:** Claude extracts structured fields from the PDF. Text in documents is data, never instructions.
3. **Investigate:** a Factory Droid session starts for the work item and runs the checks with our tools only (its file and shell tools are off). Each step streams to the screen.
4. **Decide:** deterministic rules in code turn check results into: propose payment, hold, or reject.
5. **Approve:** the owner sees the evidence on their phone and approves or rejects.
6. **Pay:** the gateway sends the payment (Nessie) with a one-time request ID, so it never pays twice, and posts the ledger entry.
7. **Record:** every step goes to the audit log with a before/after diff and the reason.

**Work item states:** `new → reading → investigating → proposed → approved → paying → paid`, or `held` / `closed_held` / `override_requested` / `rejected` / `needs_info` / `failed` (details in CONTRACT §3.5).

**SpacetimeDB is the bus.** The web asks Python to do work by inserting `job` rows; Python polls, claims and finishes them. Judges' phones only ever talk to SpacetimeDB and the web app.

## 5. Checks (what it catches)

| Check | Source |
|---|---|
| Bank details differ from the contract on file | Contract + Nessie account owner |
| Sub is fake or unlicensed | State license board (Apify) |
| Liens, judgments, identity problems | CRS sandbox |
| Duplicate bill | Bill history |
| Billing above the contract's schedule of values | Contract |
| Unapproved change order | Contract + change-order log |
| Missing lien waiver | Contract rules + attachments |
| Fake "owner" email ordering payment | Verified owner channel |
| Bank details quietly edited | Audit log |
| Line items don't add up to the total | The bill itself |
| One bill split to dodge review | Bill history |

## 6. Learning and memory

- **Onboarding:** the agent reads each contract and 6 months of history and proposes rules ("Framing sub: bills monthly, 10% retainage, account ending 4471"). The bookkeeper approves each one.
- **Corrections:** when the owner overrides a hold, the agent proposes a general rule for the bookkeeper to approve.
- **"Why?" chat:** anyone can ask why a bill was held. The answer comes from the audit log, citing entries.

## 7. Proof

- A scam generator creates ~200 scam bills plus ~50 legitimate ones, each with the correct answer.
- Scorecard: scams caught, real bills wrongly held, dollars protected.
- "Scam us" page: judges write their own scam bill and watch it get caught live.
- "Compromised agent" switch: a naive agent tries to pay a scam; the database refuses and logs it.

## 8. Demo (opens with the moment)

1. Fake bank-change bill from a trusted sub → held, with evidence.
2. Owner says "just pay it" → agent holds, citing the contract's bank-change clause and its record.
3. A pile of bills: normal ones proposed, 5 problems caught.
4. A judge's scam from the "scam us" page → caught live.
5. The scorecard.

## 9. Tech

| Piece | Choice |
|---|---|
| Core database, roles, audit log | SpacetimeDB (TypeScript module), fallback SQLite if the 1-hour check fails |
| Agent runtime | Factory Droid SDK (Python), Claude as the model |
| Document reading, "why?" chat | Claude API |
| Bank | Capital One Nessie |
| Vendor risk | CRS sandbox (business credit, public records, identity) |
| License lookup | Apify |
| Inbox | Gmail API (30-minute limit; fallback: upload + "scam us" page) |
| Interface | Next.js, mobile-friendly approval screen |
| Stretch | Cartesia voice call to the sub's number on file |
| Hosting for the demo | SpacetimeDB Maincloud · web on Vercel · Python on the demo laptop (outbound only) |

## 10. Scope

- **Must have:** contracts read and confirmed, bill intake (upload + scam page), 6 core checks (bank change, duplicate, overbilling, unapproved change order, missing lien waiver, license), CRS liens/judgments, weekly payment run vs. Nessie balance, owner approval on phone, gateway, audit log, "just pay it" hold, scorecard.
- **Should have:** Gmail intake, learning from corrections, split bills, quiet bank edits, fake owner email, "why?" chat.
- **Stretch:** Cartesia call, edited-PDF detection, backcharges, negotiation.

## 11. Team

| Who | Owns | Branch | Brief |
|---|---|---|---|
| Python developer (PY) | `core/`, `data/`, `scripts/`: agent, Droid, checks, gateway, integrations, seed data, scam generator, scorecard | `py/core` | [docs/briefs/python.md](docs/briefs/python.md) |
| TypeScript developer (TS) | `db/` SpacetimeDB module, `web/` Next.js app | `ts/app` | [docs/briefs/typescript.md](docs/briefs/typescript.md) |
| Pitch & docs (PD) | `pitch/`, final `README.md`, Devpost, video, research, booths, interviews | `docs/pitch` | [docs/briefs/pitch-and-docs.md](docs/briefs/pitch-and-docs.md) |

Shared files (`SPEC.md`, `CLAUDE.md`, `docs/*`, `.env.example`, `.gitignore`) change only when both coders agree.

## 12. Schedule (Saturday → Sunday)

Full checklist with owners: [docs/CHECKLIST.md](docs/CHECKLIST.md).

| By | Milestone |
|---|---|
| 3:45 PM | SpacetimeDB go/no-go check and Droid tools-off check done |
| 5:30 PM | Module P0 reducers live; seed data loaded |
| 7:00 PM | One bill works end to end |
| Midnight | Demo moment works, real integrations, deployed, Devpost draft |
| 4:00 AM | Feature freeze, scorecard locked |
| 8:30 AM | Final submission (hard deadline 9:00) |
| 10:30 AM | All three at the judging table |
