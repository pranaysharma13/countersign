# web/: Next.js app

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
CARTESIA_API_KEY=...            # verification call to the number on file; never NEXT_PUBLIC_
```

## Host on a domain

The app is a Next.js site. Point a domain at Vercel (or run `next start` on one machine).

**Vercel + custom domain (usual path)**

1. In Vercel: Import the repo. **Root Directory = `web`**. Install is `npm ci && npm --prefix ../db ci` (`web/vercel.json`).
2. Settings → Domains: add `your-domain.example` (and `www` if you want it). Wait for HTTPS.
3. Settings → Environment Variables (Production): copy `web/.env.example`. Minimum:
   - `APP_URL` and `NEXT_PUBLIC_APP_URL` = `https://your-domain.example` (no trailing slash)
   - `CARTESIA_API_KEY` if voice should work
   - `DEMO_PIN` on a public URL so strangers cannot act as Dana
4. For a **shared** demo that keeps writes: `DATA_SOURCE=live` plus Maincloud URI, database name, and the four staff tokens. Vercel serverless cannot keep the in-process local store across requests.
5. Optional: `CORE_URL` to a public Python API (PDF preview, audit, Why, Gmail import). Without it those four stay off; bills and voice still work.
6. Gmail: add `https://your-domain.example/api/gmail/callback` on the OAuth client. Set `GMAIL_REDIRECT_URI` to that same URL, or leave it blank and Clerk derives it from `APP_URL`.
7. Deploy. Open the domain, pick a person, open a bill, press Hear.

**One machine (`next start`)**

```bash
cd web && npm ci && npm run build && npm start   # :3001, then put Caddy/nginx + TLS in front
```

Set `APP_URL` to the https origin. Local mode (`DATA_SOURCE` unset) is fine here because it is one process.

Do not put tokens in `NEXT_PUBLIC_*`. Cookies are Secure on HTTPS. Microphone is allowed on this origin for Cartesia.

## Screens

The top bar carries the main navigation: **Work · Bills · Proof · Banks · Calls · Inbox · Sneak**, plus the walkthrough and the "I am" person picker.

| Route | What it shows |
|---|---|
| `/office` (Work) | Bills that still need a person, then tabs for aging, cash (13 weeks), close, revenue and a plain-language Ask. Downloads the board pack. |
| `/bills` | One card per invoice: who, how much, what's wrong, who acts next. |
| `/proof` | How Clerk stays honest, scored from the live invoices: reads graded against the quote and order, supplier packs, conflicts, lessons, retries and payments. |
| `/banks` | The simulated Oakview job account: books against bank, money held until a person acts, and payees on file. |
| `/calls` | The simulated verification call to a number already on file. |
| `/inbox` | Demo Gmail plus the on-file vendor letters. |
| `/sneak` | Judge page: submit a charge and watch the checks open holds. |

### 1. Cover `/` then bills `/bills`
The home page is a cover sheet: what Clerk does, then Open the books as the owner (demo sign-in, no Google). Bills is a card per invoice: who, how much, what's wrong, and who acts next.

### Inbox `/inbox`
Connect a demo Gmail (OAuth, read-only). Live letters appear on this page, each with an **Import** button. On-file vendor letters stay below so the case still works. Mail is data, never an instruction.

**Gmail setup** (keys go in `web/.env.local`; the web app doesn't read the root `.env`):
1. Google Cloud Console: create a project, then APIs & Services → Library → **Gmail API** → Enable.
2. OAuth consent screen: **External**, publishing status **Testing**, and add the demo Gmail under **Test users**.
3. Credentials → Create credentials → **OAuth client ID** → **Web application**. Authorized redirect URI: `http://localhost:3001/api/gmail/callback`. A Google **API key** (`AIza…`) won't work.
4. Put `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and `GMAIL_REDIRECT_URI` in `web/.env.local` and restart the web app. `npm run check:gmail` says which names are present in each file and whether they have the right shape, without printing any value.
5. Open `http://localhost:3001/inbox` → **Connect Gmail**. Google shows "Google hasn't verified this app": that's expected for a Testing app; choose **Continue**, then allow read access. Testing-mode sign-ins expire after 7 days; the page then asks you to connect again.

**Import** (needs live mode: `DATA_SOURCE=live`, SpacetimeDB, `run_worker.py` and the Python API on :8000). Nothing is imported until a person presses Import. The web server fetches the message whole (`format=raw`) and posts it to the Python API's `POST /intake`, which records, as the sync role, the email's text as one document and each `application/pdf` attachment as another (15 MB each; other attachments are listed as skipped, never opened). Links and remote content are never fetched. Each document is read and checked like any other, and shows **From Gmail**. Importing the same message again changes nothing. Tokens stay in an httpOnly cookie on the server's responses; they're never logged or put in `NEXT_PUBLIC_*`.

### 2. Invoice case `/invoices/[id]` (the demo opens here)
- **What we'd pay, and why:** the reconciliation from the latest assessment, running claimed, under review, accepted, deposit and payable. Differences are "under review", never "saved".
- **Line by line:** claimed, accepted and under review per line, with the calculation. Every figure has evidence chips that open the exact immutable source fragment: a quote or PO page and line, or an email.
- **Open holds:** each with its reason and evidence. The owner clears commercial holds with a required note. Receipt and payee holds explain the only event that clears them.
- **Receipt:** the superintendent confirms quantity on the dedicated receive page. The invoice case no longer explains delivery verification.
- **Revisions:** a corrected invoice supersedes the old one, which stays on record.
- **Clarification to the supplier:** the agent's draft and a button for purchasing to send it (simulated delivery).
- **Emails:** the thread about the purchase. A sender not on file is flagged.
- **What Clerk did:** the agent's steps (`agent_step`), live.
- **Record:** the audit trail for this invoice, newest first, including refused attempts.

### 3. Approval review `/invoices/[id]/approve`
- The exact amount, revision, deposit applied, masked payee and who proposed it.
- **Approve / Reject**, with an optional note. The approve button mirrors the module's six eligibility rules; when it's disabled it lists every reason. The module re-checks on click, and its `blocked_reasons` are shown if it refuses.
- An out-of-date approval warning when the revision, assessment or payee changed after approval.
- **Payee:** the verified account, plus any pending bank change. The owner clears a change only by calling a contact that was on file before the request. Cartesia speaks both sides of that simulated call; code decides yes or no from the transcript. There is no one-click “verified”.
- **Receipt:** the superintendent's attestation.
- **Settlement and books:** the payment (simulated Nessie in local mode), the deposit applied once, the journal lines, AP for the invoice and cash paid for the purchase.

### 4. Purchase record `/purchases/[id]`
- **What was agreed:** accepted quote terms and the PO, each citing its source, plus the supplier's acknowledgment.
- **Changes since:** each change request with its classification, our approval (who, within what limit) and the supplier's acceptance, tracked separately.
- **Deposit:** amount, how it was paid, and where it has been applied.
- **Supplier contacts on file:** marks which ones can verify bank changes.
- **Source documents:** every document and its quoted fragments.

## Demo mode and roles
The top bar's "I am" picker sets the persona (owner, purchasing, superintendent, bookkeeper). It's stored in an http-only cookie and gated by `DEMO_PIN` when set. Tokens stay on the server: the browser calls `/api/call`, and the server calls the module as that persona. The module enforces every rule itself, so the UI can't grant extra power. In production each employee would sign in individually.

**Reset demo:** owner, local mode restores the in-process seed. On live it queues a `reset_demo` job for the Python worker.

Extra screens: `/changes` (purchasing), `/receive/inv_bm23104` (superintendent, phone-first), `/sneak` (judge page). Evidence chips open the PDF or email at `{NEXT_PUBLIC_CORE_URL}/files/{source_file_id}`. Start the Python file API on port 8000. Sneak jobs need the Python worker (`sneak_charge` opens a hold; nothing is paid).

## How it's built
| Path | What |
|---|---|
| `lib/server/backend.ts` | `live` (SpacetimeDB HTTP: SQL reads, reducer calls with per-role tokens) or `local` (`db/dist/local.mjs`). Arguments are ordered by `db/src/reducer_args.ts`, generated from the module. |
| `app/api/state` · `app/api/call` · `app/api/session` · `app/api/reset` · `app/api/gmail/*` · `app/api/voice/*` | Server routes |
| `lib/client.ts` | `useTables()` polling hook, `call()` |
| `components/parts.tsx` | Status words, the five-status strip, hold chips, evidence chips and source quotes |
| `components/Shell.tsx` | Top bar, navigation and person picker |
| `app/globals.css` | One stylesheet. Under 1080px the navigation moves to its own row; under 640px wide tables stack into labelled rows so nothing scrolls sideways. |

## Cartesia (verification call)

Voice is how a bank change clears. Clerk calls a `pre_established` number already on the quote, not a number from the email that asked for the change. Sonic 3.6 speaks Clerk and the pickup; Ink Whisper transcribes the reply; `verdictFromTranscript` in `lib/voice.ts` requires a yes plus the new last four (or a strong confirm). Accept and reject go through `decide_payee_profile` with the transcript in the note. The module still refuses any contact that was not on file.

Office uses the same voices to read the books and to take a spoken ask. A payment that is ready still needs a spoken readback of the amount and last four before Approve unlocks. Each attempt is kept in a local voice record with a fingerprint. The key stays on the server (`CARTESIA_API_KEY` in `web/.env.local`). Routes are staff-gated, rate-limited, and 503 if the key is missing. The call is labeled simulated; the voices are live. Limitation: this is not a PSTN bridge. Cartesia does not dial the real phone. When `DEMO_PIN` is set, the staff session locks after 12 minutes idle.

**Not done yet:** live table subscriptions through generated SpacetimeDB bindings (`spacetime generate` + `spacetimedb/react`). Screens still poll once a second. CONTRACT v2.2 (`decide_disputed_line`) is not in the module.
