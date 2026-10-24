# Brief for the TypeScript developer's AI

Paste this whole file as your first message to Claude Code, opened at the repo root.

---

You're working with one human on a 3-person team at Cal Hacks 13.0 (hard submission deadline **Sunday 9:00 AM PT**; judging 10:30 AM). We're building **Countersign**, an AI payables clerk for small general contractors. Your human owns **all TypeScript**: the SpacetimeDB module (`db/`) and the Next.js web app (`web/`). Another teammate owns all Python (`core/`, `data/`, `scripts/`). A third teammate owns the pitch and docs (`pitch/`).

## Read these first, in order
1. `SPEC.md` — what we're building and why.
2. `docs/CONTRACT.md` — **the interface between your code and the Python side. Follow it exactly.** Table names, column names and order, reducer names and **argument order** (Python calls reducers with positional JSON arrays), roles, states, check codes, job kinds.
3. `docs/TRACKS.md` — what each judge wants to see. SpacetimeDB, Hyphenate and Factory judges will look at your screens.
4. `CLAUDE.md` — rules that must never break.
5. `docs/CHECKLIST.md` — timeline; your items are marked **TS**.

## The product in one paragraph
Small contractors pay subcontractors $20k–80k at a time with no finance team, and scammers send fake "we changed banks" emails. Countersign reads each subcontract once, picks up every bill, checks it (bank account on file, license, CRS liens/identity, duplicates, overbilling vs. the schedule of values, unapproved change orders, missing lien waivers, prompt injection), and proposes a payment or a hold. **It never moves money.** The owner approves on their phone, and only the gateway pays. Every action, including denied attempts, is in the audit log. Judges can write their own scam on a "scam us" page from their phones and watch it get caught live.

## Your boundaries
- You edit only `db/` and `web/`. Never edit `core/`, `data/`, `scripts/` or `pitch/`.
- Shared files (`SPEC.md`, `CLAUDE.md`, `docs/*`, `.env.example`, `.gitignore`) change only after your human agrees with the Python developer. If the contract needs a change, propose it to your human; don't change names on your own.
- Work on branch `ts/app`. Pull `main` often, merge small working pieces into `main`.

## Part 1 — SpacetimeDB module (`db/`)

**Go/no-go check, first hour (target 3:45 PM):** create the module with `spacetime init --lang typescript`, using the `spacetimedb` npm package (2.13.0 is current). Publish locally with `spacetime start` + `spacetime publish`. Add one table and one reducer; tell your human the exact curl command that calls it with a positional JSON array, so the Python developer can verify the HTTP path. Confirm SQL names are snake_case exactly as written (else set `CASE_CONVERSION_POLICY: CaseConversionPolicy.None`).

**Then build P0 from `docs/CONTRACT.md` (target 5:30 PM), then P1 (target midnight).** Implementation notes:
- Write one helper that every mutating reducer uses: duplicate `request_id` check → role lookup in `actor` (unregistered = `public`) → on denial write `audit_log` (`outcome: 'denied'`) and `request_result`, then **return without throwing** (a throw rolls back the denial row). Same for invalid input (`request_result.outcome = 'invalid'`).
- Every successful change writes `audit_log` with `before_json` / `after_json` in the same reducer.
- Enforce every hard rule in CONTRACT §2 and §3.4/§3.5 in code: separation of duties, payee account must match the sub on file, no quiet bank edits, `HARD_STOP_CHECKS` on "pay anyway", state transitions per role, `post_journal` must balance, job enqueue permissions and the `public` limit of 3 queued.
- `decide_proposal` creates the follow-up jobs (`pay_proposal`, `prepare_override_payment`) itself.
- Money columns are `t.i64()` (bigint in TS). Convert carefully for display.
- Write unit tests for the rules with `spacetimedb/server/test-utils` and Vitest (it runs reducers in-process). Must-test: agent can't approve; owner can't approve own proposal; payment to a non-matching account is denied; bank fields can't change via `upsert_sub`; "pay anyway" denied on a hard-stop check; journal must balance; duplicate `request_id` is a no-op; denials leave an audit row.
- Generate client bindings into `web/` with `spacetime generate --lang typescript`.
- At midnight, publish to **Maincloud** as database `countersign` for the demo.

## Part 2 — Web app (`web/`, Next.js, port 3001)

Connect with the SpacetimeDB React integration (`spacetimedb/react`) and subscribe to tables; every screen updates live. Persona tokens (owner, bookkeeper) come from `web/.env.local` via a small server route gated by `DEMO_PIN` (see CONTRACT §6). Judges' phones connect anonymously.

**Screens, in priority order:**
- **P0 by 7 PM**
  1. **Inbox / work items:** list with state, sub, amount, risk, time; filter by state.
  2. **Work item detail:** the bill (fields + line items vs. contract), **live agent steps** (`agent_step` streaming in), check results with pass/fail and evidence, the current proposal, and that item's audit trail. On the laptop, embed the PDF from `NEXT_PUBLIC_CORE_URL/files/{source_file_id}`.
  3. **Phone approval screen** (mobile first): pending proposals with amount, payee and last4, the key evidence, and buttons: Approve / Reject for payments; Agree / Pay anyway for holds. Show the module's denial message when "pay anyway" is refused.
- **P1 by midnight**
  4. **"Scam us" page** (mobile, opened by QR code): pick an attack type, sub and amount, write an urgency note, submit (`enqueue_job` kind `scam_submit`, CONTRACT §5). Then follow the work item live and show the verdict and which check caught it. Clearly labeled as a test console with fictional companies. Also a "send a real bill" button (`legit_submit`).
  5. **Live counter** (on dashboard and scam page): attacks · blocked · money lost.
  6. **Payment run:** this week's pending payment proposals vs. latest `bank_snapshot`; select and approve several.
  7. **Audit log:** filterable, denied rows highlighted.
  8. **Subs & contracts:** contract terms the agent read, schedule of values, "Confirm" for owner/bookkeeper; bank change requests with verification status.
  9. **"Why?" chat** on the work item (`ask_why`, answers with citations that link to audit rows).
- **P2 by 4 AM**
  10. **Scorecard:** scams caught, real bills wrongly held, dollars protected, per-attack table (`score_run`, `score_case`).
  11. **Books:** ledger lines grouped by journal, totals per account.
  12. **Demo control panel** (owner only): compromised-agent button (`compromised_agent_demo` job), reset (`reset_demo`), persona switch.

**Design:** calm, trustworthy finance tool. Money right-aligned in tabular figures, clear red/amber/green states, large tap targets on the phone screens, no clutter. The demo opens on the work item detail screen, so make that one great.

## When you're blocked
- Python side not ready? Insert rows yourself through reducers with a small dev script so screens can be built.
- Contract unclear? Ask your human to check with the Python developer; write the question in team chat, don't guess names.

## Definition of done for each piece
Typechecks, tests pass, works against a locally published module, merged into `main`, and your human has clicked through it.
