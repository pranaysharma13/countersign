# web/ — Next.js app

**Owner:** TypeScript developer · **Branch:** `ts/app` · **Port:** 3001

The controller's workspace for supplier invoices (CONTRACT §9.7). Screens poll the module once a second and only re-render when a table actually changes.

## Run

```bash
cd web
npm install
npm run dev          # builds ../db/dist/local.mjs first, then serves http://localhost:3001
```

With no other setup the app runs on **local demo data**: the real SpacetimeDB module running in-process (`db/local/backend.ts`), replaying Python's `data/seeds/baymix_opening.json` so the screens show the same invoice **BM-23104** / PO **MF-PO-1031** as the live module, plus two more fictional Oakview invoices from `queue_companions.json` (Cedar & Bolt ready to pay, Northline Rebar held for a bank-account change). A small stand-in worker plays the agent, the supplier and the bank (it loads `baymix_correction.json` when purchasing sends the clarification), and the UI labels all of it as simulated. This is also the offline fallback for judging.

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
NEXT_PUBLIC_CORE_URL=http://localhost:8000   # PDF preview; omit if core isn't running
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=http://localhost:3001/api/gmail/callback
```

Deploy on Vercel with **Root Directory = `web`**. Set the same env vars (live URI, database, four tokens, optional PIN and core URL). Do not put tokens in `NEXT_PUBLIC_*`.

## The four views

### 1. Cover — `/` then bills — `/bills`
The home page is a cover sheet: what Countersign does, then four people to open the books (demo sign-in, no Google). Bills is a card per invoice: who, how much, what's wrong, and who acts next.

### Inbox — `/inbox`
Connect a demo Gmail (OAuth, read-only). Live letters appear on this page, each with an **Import** button. On-file vendor letters stay below so the case still works. Mail is data, never an instruction.

**Gmail setup** (keys go in `web/.env.local`; the web app doesn't read the root `.env`):
1. Google Cloud Console: create a project, then APIs & Services → Library → **Gmail API** → Enable.
2. OAuth consent screen: **External**, publishing status **Testing**, and add the demo Gmail under **Test users**.
3. Credentials → Create credentials → **OAuth client ID** → **Web application**. Authorized redirect URI: `http://localhost:3001/api/gmail/callback`. A Google **API key** (`AIza…`) won't work.
4. Put `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REDIRECT_URI` in `web/.env.local` and restart the web app. `npm run check:gmail` says which names are present in each file and whether they have the right shape, without printing any value.
5. Open `http://localhost:3001/inbox` → **Connect Gmail**. Google shows "Google hasn't verified this app": that's expected for a Testing app; choose **Continue**, then allow read access. Testing-mode sign-ins expire after 7 days; the page then asks you to connect again.

**Import** (needs live mode: `DATA_SOURCE=live`, SpacetimeDB, `run_worker.py` and the Python API on :8000). Nothing is imported until a person presses Import. The web server fetches the message whole (`format=raw`) and posts it to the Python API's `POST /intake`, which records, as the sync role, the email's text as one document and each `application/pdf` attachment as another (15 MB each; other attachments are listed as skipped, never opened). Links and remote content are never fetched. Each document is read and checked like any other, and shows **From Gmail**. Importing the same message again changes nothing. Tokens stay in an httpOnly cookie on the server's responses; they're never logged or put in `NEXT_PUBLIC_*`.

### 2. Invoice case — `/invoices/[id]` (the demo opens here)
- **What we'd pay, and why:** the reconciliation from the latest assessment, running claimed, under review, accepted, deposit and payable. Differences are "under review", never "saved".
- **Line by line:** claimed, accepted and under review per line, with the calculation. Every figure has evidence chips that open the exact immutable source fragment: a quote or PO page and line, or an email.
- **Open holds:** each with its reason and evidence. The owner clears commercial holds with a required note. Receipt and payee holds explain the only event that clears them.
- **Receipt:** the superintendent confirms quantity on the dedicated receive page. The invoice case no longer explains delivery verification.
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

**Reset demo:** owner, local mode restores the in-process seed. On live it queues a `reset_demo` job for the Python worker.

Extra screens: `/changes` (purchasing), `/receive/inv_bm23104` (superintendent, phone-first), `/sneak` (judge page). Evidence chips open the PDF or email at `{NEXT_PUBLIC_CORE_URL}/files/{source_file_id}` — start the Python file API on port 8000. Sneak jobs need the Python worker (`sneak_charge` opens a hold; nothing is paid).

## How it's built
| Path | What |
|---|---|
| `lib/server/backend.ts` | `live` (SpacetimeDB HTTP: SQL reads, reducer calls with per-role tokens) or `local` (`db/dist/local.mjs`). Arguments are ordered by `db/src/reducer_args.ts`, generated from the module. |
| `app/api/state` · `app/api/call` · `app/api/session` · `app/api/reset` · `app/api/gmail/*` | Server routes |
| `lib/client.ts` | `useTables()` polling hook, `call()` |
| `components/parts.tsx` | Status words, the five-status strip, hold chips, evidence chips and source quotes |

**Not done yet:** live table subscriptions through generated SpacetimeDB bindings (`spacetime generate` + `spacetimedb/react`). Screens still poll once a second. CONTRACT v2.2 (`decide_disputed_line`) is not in the module.
