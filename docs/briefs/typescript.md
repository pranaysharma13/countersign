# Brief for the TypeScript developer's AI (v2)

Paste this whole file as your first message to Claude Code, opened at the repo root.

---

You're working with one human on a 3-person team at Cal Hacks 13.0 (hard submission deadline **Sunday 9:00 AM PT**; judging 10:30 AM). We're building **Countersign**: it checks every supplier invoice against what was actually agreed (quote, purchase order, email thread) and prepares a payment the controller can trust. Your human owns **all TypeScript**: the SpacetimeDB module (`db/`) and the Next.js app (`web/`). Another teammate owns all Python (`core/`, `data/`, `scripts/`). A third owns the pitch (`pitch/`).

## Read these first, in order
1. `SPEC.md` (v2): the product, the demo scenario and its exact numbers.
2. `docs/CONTRACT.md`: **§0–§6 (v1) and §9 (v2) are the interface with Python. Follow them exactly**: table and column names, reducer names and **argument order** (Python calls reducers with positional JSON arrays), roles, statuses, hold codes, job kinds.
3. `docs/ARCHITECTURE.md`: the flow, and how the teammate's Postgres spec maps onto SpacetimeDB.
4. `docs/BUILDBUY_PROMPT.md`: detailed requirements. **Use it for detail only. Don't build its PostgreSQL stack.**
5. `CLAUDE.md`: rules that must never break. `docs/CHECKLIST.md`: your items are marked **TS**.

## Your boundaries
- Edit only `db/` and `web/`. Shared files change only after your human agrees with the Python developer.
- Branch `ts/app`. **Push early and often**; merge working pieces into `main`.

## Part 1: SpacetimeDB module (`db/`)
- If not done: the go/no-go check (one table, one reducer, Python calls it over HTTP, web shows the row live).
- Keep the v1 tables and reducers (§3–§4). Then build **§9 "A" reducers first** (needed for the primary scenario by ~11 PM), then "B".
- One helper for every mutating reducer: duplicate `request_id` → role lookup in `actor` (unregistered = `public`) → on denial write `audit_log` + `request_result` and **return without throwing**.
- Enforce in code (and test with Vitest via `spacetimedb/server/test-utils`):
  - Separation of duties: the requester can't decide their own change request, the proposer can't approve their own payment, and the agent can never approve.
  - The purchasing limit (`authority.limit_cents`) and project scope.
  - Source fragments are immutable.
  - Each deposit is applied at most once and never above its amount.
  - A new revision supersedes the old one's holds and makes approvals stale; a changed assessment fingerprint or payee profile also makes approvals stale.
  - `approve_supplier_payment` eligibility (all six rules in §9.4), returning `blocked_reasons`.
  - `start_payment` re-checks the bound approval.
  - Only the owner may resolve holds, and only the commercial ones; receipt and payee holds clear only through their own events.
  - `invoice_line` math is exact.
  - Journals balance.
- Money and quantities are `t.i64()` (bigint in TS); quantities are thousandths (`_milli`). Format carefully for display.
- Publish to **Maincloud** as `countersign` for the demo (by ~1 AM).

## Part 2: Web app (`web/`, Next.js, port 3001)
Subscribe to tables with `spacetimedb/react`; every screen updates live. Persona tokens (owner/controller, purchasing, receiver, bookkeeper) come from `web/.env.local` through a small server route gated by `DEMO_PIN`, clearly labeled as demo mode.

**Four views (CONTRACT §9.7), in this order:**
1. **Work queue:** supplier, project, invoice, requested balance, due date, the five statuses, open holds, next owner, next action. Honest `live` / `fixture` / `simulated` labels.
2. **Invoice case** (the demo opens here):
   - Line by line: claimed vs. accepted vs. pending, with the calculation.
   - Each figure links to its source fragment, opening the real PDF page from `NEXT_PUBLIC_CORE_URL/files/{source_file_id}` or the email message.
   - The email thread, live agent steps (`agent_step`), clarification drafts with an approve-to-send button, corrected revisions, and a timeline.
3. **Approval review:**
   - Exact amount, revision and masked payee.
   - The receipt attestation (labeled MANUALLY_CONFIRMED) and the evidence.
   - Approve / reject / request info. A disabled button always shows the `blocked_reasons`.
   - A stale-approval warning, then settlement and the ledger.
4. **Purchase record:** quote and terms, PO, supplier acknowledgment, approved changes (who approved, under what limit), deposit, validity, source viewer.

**Also:**
- A receiver screen for the superintendent to attest receipt, on a phone.
- A purchasing screen to decide change requests.
- The judge page, "Sneak a charge past it" (`sneak_charge` job): it shows the resulting holds live.

**Design:** calm, precise finance tool. Money right-aligned in tabular figures, statuses as plain words with clear colors, no fake savings counters or decorative feeds. Handle loading, empty, unreadable PDF, model timeout, forbidden role, and waiting-for-a-person states.

## When blocked
Insert rows yourself through reducers with a small dev script so screens can be built. If the contract is unclear, ask your human to check with the Python developer; don't guess names.
