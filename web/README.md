# web/ — Next.js app

**Owner:** TypeScript developer · **Branch:** `ts/app` · **Port:** 3001

The controller's workspace for supplier invoices (CONTRACT §9.7). Every screen polls the module once a second, so changes made by the agent, the gateway or another person show up live.

## Run

```bash
cd web
npm install
npm run dev          # builds ../db/dist/local.mjs first, then serves http://localhost:3001
```

With no other setup the app runs on **local demo data**: the real SpacetimeDB module running in-process (`db/local/backend.ts`), seeded with the SPEC §8 BayMix scenario. A small stand-in worker plays the agent, the supplier and the bank, and the UI labels all of it as simulated. This is also the offline fallback for judging.

To use the published module instead, create `web/.env.local`:

```bash
DATA_SOURCE=live
SPACETIMEDB_URI=https://maincloud.spacetimedb.com   # or http://localhost:3000
SPACETIMEDB_DATABASE=countersign
SPACETIMEDB_OWNER_TOKEN=...        # from scripts/setup_actors.py
SPACETIMEDB_PURCHASING_TOKEN=...
SPACETIMEDB_RECEIVER_TOKEN=...
SPACETIMEDB_BOOKKEEPER_TOKEN=...
DEMO_PIN=...                       # optional; required before any staff action when set
```

## The four views

### 1. Work queue — `/`
One row per supplier invoice, sorted by due date:
- supplier, invoice number and project
- requested balance and due date
- the five independent statuses: commercial, receipt, payee, approval and payment
- open holds, and who acts next and what they need to do

Each row carries an honest label: `Fixture extraction` or `Read live by Claude`, plus `Simulated` in local mode. Click a row to open the invoice case.

### 2. Invoice case — `/invoices/[id]` (the demo opens here)
- **What we'd pay, and why:** the reconciliation from the latest assessment, running claimed, under review, accepted, deposit and payable. Differences are "under review", never "saved".
- **Line by line:** claimed, accepted and under review per line, with the calculation. Every figure has evidence chips that open the exact immutable source fragment: a quote or PO page and line, or an email.
- **Open holds:** each with its reason and evidence. The owner clears commercial holds with a required note. Receipt and payee holds explain the only event that clears them.
- **Receipt:** the superintendent attests the quantity and how they know it. Shown as manually confirmed, never as proof of delivery.
- **Revisions:** a corrected invoice supersedes the old one, which stays on record.
- **Clarification to the supplier:** the agent's draft and a button for purchasing to send it (simulated delivery).
- **Emails:** the thread about the purchase. A sender not on file is flagged.
- **What Countersign did:** the agent's steps (`agent_step`), live.
- **Record:** the audit trail for this invoice, newest first, including refused attempts.

### 3. Approval review — `/invoices/[id]/approve`
- The exact amount, revision, deposit applied, masked payee and who proposed it.
- **Approve / Reject**, with an optional note. The approve button mirrors the module's six eligibility rules; when it's disabled it lists every reason. The module re-checks on click, and its `blocked_reasons` are shown if it refuses.
- An out-of-date approval warning when the revision, assessment or payee changed after approval.
- **Payee:** the verified account, plus any pending bank change. The owner verifies a change only through a contact that was on file before the request.
- **Receipt:** the superintendent's attestation.
- **Settlement and books:** the payment (simulated Nessie in local mode), the deposit applied once, the journal lines, AP for the invoice and cash paid for the purchase.

### 4. Purchase record — `/purchases/[id]`
- **What was agreed:** accepted quote terms and the PO, each citing its source, plus the supplier's acknowledgment.
- **Changes since:** each change request with its classification, our approval (who, within what limit) and the supplier's acceptance, tracked separately.
- **Deposit:** amount, how it was paid, and where it has been applied.
- **Supplier contacts on file:** marks which ones can verify bank changes.
- **Source documents:** every document and its quoted fragments.

## Demo mode and roles
The sidebar's "Acting as" switch sets the persona (owner, purchasing, superintendent, bookkeeper). It's stored in an http-only cookie and gated by `DEMO_PIN` when set. Tokens stay on the server: the browser calls `/api/call`, and the server calls the module as that persona. The module enforces every rule itself, so the UI can't grant extra power. In production each employee would sign in individually.

**Reset demo** (owner, local mode only) restores the opening state.

## How it's built
| Path | What |
|---|---|
| `lib/server/backend.ts` | `live` (SpacetimeDB HTTP: SQL reads, reducer calls with per-role tokens) or `local` (`db/dist/local.mjs`). Arguments are ordered by `db/src/reducer_args.ts`, generated from the module. |
| `app/api/state` · `app/api/call` · `app/api/session` · `app/api/reset` | The only server routes |
| `lib/client.ts` | `useTables()` polling hook, `call()` |
| `components/parts.tsx` | Status words, the five-status strip, hold chips, evidence chips and source quotes |

**Not done yet:** a separate phone-first receiver screen (receipt is on the invoice case for now), the purchasing screen for change requests, the "Sneak a charge past it" judge page (`sneak_charge`), and live subscriptions through generated SpacetimeDB bindings (needs `spacetime generate`; polling until then).
