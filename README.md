# Clerk

**Clerk checks every supplier invoice against what was actually agreed (the quote, the purchase order and the email thread) and prepares a payment the controller can trust.** It keeps legitimate charges, questions the rest with evidence, and never moves money on its own.

Seats it fills: **materials purchasing coordinator** and **accounts-payable exceptions analyst**. The owner stays the one who approves payments.

Built at Cal Hacks 13.0. All companies, people, documents and bank details are fictional.

## The problem

Small general contractors buy materials on quotes, purchase orders and a trail of emails. Weeks later the invoice arrives with a higher unit price, waiting time and extras, some agreed and some only proposed. Busy teams pay it. Fraud is rare; paying more than you agreed happens every month.

## The scenario (BM-23104)

BayMix Supply quoted ready-mix concrete at $165/cy. The invoice bills 500 cy at **$172** (+$3,500), adds 90 minutes of waiting time nobody agreed to ($225), and keeps a $1,200 weekend charge that purchasing *did* approve in the app. Clerk:

1. accepts the $1,200, holds **$3,725 under review** (never "saved" until the supplier agrees) and drafts a clarification;
2. reads BayMix's reply and the corrected **$83,700** invoice;
3. applies the $10,000 deposit once and waits for the superintendent to confirm what arrived;
4. proposes exactly **$73,700**. The owner approves it, and the gateway pays once: AP ends at $0, cash out $83,700 (simulated bank).

If BayMix won't correct the invoice, the owner decides each disputed line in the app ("Accept as billed" or "Pay agreed, dispute the rest", note required). The notice to BayMix must be sent before anything is paid, and the original claim stays on record.

## Measured

| Measure | Result | How |
|---|---|---|
| Hold precision / recall | **28/28 / 28/28** across 18 scenarios | `scripts/run_scorecard_v2.py`: offline through the real pipeline, graded by a hand-written answer key (`data/answer_keys/scorecard_v2.json`) |
| Exact amounts | **73 of 73** | same run: every hold amount, claimed/authorised total, proposal and settlement figure |
| Authorised changes paid or accepted | **2 of 2** | the $1,200 weekend charge paid in the $73,700; $172 accepted on exactly the 120 cy it was approved for |
| False holds on clean documents | **0** on 4 | Cedar & Bolt, BM-23104 revision 2, two judge-page controls |
| Judge submissions changing BM-23104 | **0** of 8 | each sandbox kind, byte-for-byte comparison |
| Live Claude extraction | **27/27** labelled fields; all exact values reproduced | `scripts/check_extraction.py`, 2026-10-25, `claude-opus-5-5`, 9 documents, one run (recorded, not re-run since) |

The scorecard's first runs found two real defects, fixed before these numbers: the pipeline didn't ask CRS about the supplier (Peak's civil judgment was missed), and a payment could be proposed while a prompt-injection hold was open. Full table: [`data/scorecard_v2.md`](data/scorecard_v2.md).

## Live, fixture, simulated

| Part | In the demo | Live when |
|---|---|---|
| SpacetimeDB module (roles, limits, holds, approvals, audit log, job bus) | **Real code.** Offline, the web app runs the same module in-process. | `DATA_SOURCE=live`, published to a server |
| Claude extraction (quotes, POs, emails, invoices) | `AI_MODE=fixture`: pre-labelled extractions, labelled **FIXTURE** on screen | `AI_MODE=live` + `ANTHROPIC_API_KEY` (measured once, above) |
| Cited "why?" explanation | Fixture: a labelled template citing the same fragments | `AI_MODE=live` (built and tested with a fake client; not yet run live) |
| Factory Droid agent | Scripted agent with the same tools and rules | `AGENT_MODE=droid` + `droid` CLI + `FACTORY_API_KEY` (not yet run for real) |
| Capital One Nessie (deposit, settlement) | **Simulated**: mock bank, every transfer labelled simulated | `USE_MOCKS=false` + `NESSIE_API_KEY` |
| CRS (supplier public records) | **Mock**: provided test identities, labelled "mock test data" | CRS credentials + the Postman collection (not available yet) |
| Supplier emails | Simulated: drafts are "sent" without leaving the app | — |
| Judge page (`/sneak`) | Needs the live worker: each submission is a real invoice on a fictional sandbox supplier, read and checked like any other; extraction generated from your inputs (labelled). Offline the page says it didn't run, and nothing changes | `AI_MODE=live`: Claude reads the PDF |
| Apify diesel index (fuel surcharge) | Not built. A fuel surcharge waits for evidence (`USAGE_EVIDENCE_MISSING`) | — |

## Run it offline (no keys)

```bash
cd web && npm install && npm run dev            # http://localhost:3001 (builds ../db/dist/local.mjs first)
```

The app runs the real SpacetimeDB module in-process with the BayMix seed (invoice **BM-23104**, PO **MF-PO-1031**) and two more fictional Oakview invoices. A stand-in plays the supplier and the bank, labelled simulated. Optional, for PDF previews, the audit download and "Why?":

```bash
cd core && uv sync && cd ..
uv run --project core uvicorn countersign.api:app --port 8000
```

Checks:

```bash
cd core && uv run pytest -q                      # Python: rules, money math, gateway, pipeline, scorecard
cd db && npm install && npx vitest run && npm run typecheck   # module permissions and rules
cd web && npm run build
uv run --project core python scripts/run_scorecard_v2.py      # rewrites data/scorecard_v2.{json,md}
```

Screens: cover `/` (pick a person), bills `/bills`, invoice `/invoices/inv_bm23104`, approval `/invoices/inv_bm23104/approve`, receive `/receive/inv_bm23104`, purchase `/purchases/pur_baymix_oak`, changes `/changes`, judge page `/sneak`.

## Run it live (local SpacetimeDB)

Needs the [spacetime CLI](https://spacetimedb.com/install). Copy `.env.example` to `.env` (never commit it).

```bash
spacetime start                                              # :3000
(cd db && spacetime publish --server local countersign)
uv run --project core python scripts/setup_actors.py        # once per fresh module: paste its lines into .env and web/.env.local
uv run --project core python scripts/reset_demo_v2.py       # roles, limits, BayMix opening, judge sandbox; checks the module against Python
uv run --project core python scripts/load_supplier_seed.py  # loads what's missing and prints any MISMATCH
uv run --project core python scripts/run_worker.py          # leave running: reads documents, reassesses, pays (simulated)
uv run --project core uvicorn countersign.api:app --port 8000
# web/.env.local: DATA_SOURCE=live, SPACETIMEDB_URI=http://localhost:3000, SPACETIMEDB_DATABASE=countersign,
#                 the four staff tokens (owner, purchasing, receiver, bookkeeper), optional DEMO_PIN
cd web && npm run dev
```

`scripts/drive_bm23104.py` then walks BM-23104 to $73,700 settled and checks every number against the answer key.

## Deploy (Maincloud + Vercel)

These logins are yours to do. Tokens go only in `.env`, `web/.env.local` and Vercel's environment settings, never in `NEXT_PUBLIC_*`.

```bash
spacetime login                                              # browser
(cd db && spacetime publish --server maincloud countersign)  # if the name is taken, pick another and use it below
# .env: SPACETIMEDB_URI=https://maincloud.spacetimedb.com  SPACETIMEDB_DATABASE=countersign
uv run --project core python scripts/setup_actors.py
uv run --project core python scripts/reset_demo_v2.py
uv run --project core python scripts/load_supplier_seed.py
uv run --project core python scripts/run_worker.py          # must keep running during judging (judge submissions are jobs)

npm i -g vercel && cd web && vercel login && vercel link     # Root Directory = web
# Vercel settings: Install Command = "npm ci && npm --prefix ../db ci" (the build bundles ../db)
# Env: DATA_SOURCE=live, SPACETIMEDB_URI, SPACETIMEDB_DATABASE, the four staff tokens, DEMO_PIN,
#      NEXT_PUBLIC_CORE_URL (a public URL for the Python API, e.g. a tunnel to :8000; without it, PDF preview,
#      audit download and "Why?" say the API is unreachable)
vercel --prod
```

## Architecture

```
documents (quote, PO, emails, invoices) ─▶ intake (Python API) ─▶ SpacetimeDB ◀──── web (Next.js), every screen live
                                                                    │  ▲
                                         job: process_document ─────┘  │ reducers check role, limits and state,
                                                    ▼                  │ and log every change and every denial
                       Python worker: Claude reads ─▶ evidence validated ─▶ deterministic checks + assessment
                                      ─▶ holds, clarification draft, payment proposal ─▶ owner approves in the app
                                      ─▶ gateway: re-checks inside the module, pays once (Nessie), balanced journals
```

- **Claude interprets, code decides.** Claude reads documents into a strict schema whose every value cites a fragment we validate. Arithmetic, limits, permissions, duplicates, deposit allocation, payment eligibility, journals and idempotency are code.
- **Five separate statuses** (commercial, receipt, payee, approval, payment) and independent holds; resolving one never clears another.
- **The agent can't approve, pay, verify a payee or clear a hold.** The module refuses, logs the attempt, and the refusal shows in the audit trail.
- **Approvals are bound** to the revision, amount, deposit, payee and assessment fingerprint; any change makes them stale.
- **Document and email text is data.** Instructions inside an invoice open `PROMPT_INJECTION`; any other document carrying them goes to review. They're never followed.

Details: [SPEC.md](SPEC.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONTRACT.md](docs/CONTRACT.md) (§9 for supplier invoices).

## Where Droid runs (Factory)

One Droid session per invoice revision, inside that invoice's `process_document` job (`core/countersign/supplier_agent.py`, `AGENT_MODE=droid`):

- Code records the deterministic assessment and holds **before** Droid starts, so Droid can't change a number.
- Droid gets only our nine tools (`get_invoice_bundle`, `get_term_version`, `get_source_fragment`, `get_authority_policy`, `list_open_holds`, `run_check`, `open_hold`, `draft_clarification`, `propose_supplier_payment`). Its built-in file and shell tools are removed with `restrict_tools`.
- `open_hold` takes only amountless codes with a cited fragment. `propose_supplier_payment` takes no amount. Droid's clarification draft is validated by code: no amounts outside the assessment, no short-pay wording, no bank details, links or instructions copied from a document.
- Every step goes to `agent_step` and shows live on the invoice's timeline. If Droid fails or runs past 120 s, the scripted rules finish and the timeline says so.
- `scripts/try_droid.py` runs one real session on BM-23104. **Not yet run with a real key.**

## CRS data

- Only the CRS sandbox's **provided test identities** (each fictional supplier has a `crs_ref` like `crs_test_business_02`).
- What we use: business public records (liens, judgments, bankruptcies). Any record opens `SUPPLIER_RISK` for the owner. Nothing is decided automatically against the supplier.
- When: the pipeline asks for every invoice it records. The hold's reason and evidence say whether the data is mock or live. If live CRS is set up but the call fails, the invoice is held too ("CRS couldn't be reached"), never treated as clean. The judge page's sandbox supplier has no CRS identity, so it isn't checked.
- Today it's **mock**: the sandbox credentials and the Postman collection with the business-report endpoint haven't arrived, so `core/countersign/integrations/crs.py` uses a small table of the test identities. The live call and its field mapping are a placeholder until then.

## Repository layout

| Folder | What lives there | Language |
|---|---|---|
| `db/` | SpacetimeDB module: tables, roles, statuses, holds, approvals, audit log, job bus | TypeScript |
| `core/` | Worker, Claude extraction, Droid agent, checks, gateway, integrations, scorecard | Python |
| `web/` | Bills, invoice case, approval review, receive, changes, judge page | TypeScript (Next.js) |
| `data/` | Fictional documents, fixtures, seeds, answer keys, scorecard | JSON |
| `docs/` | Interface contract, architecture, detailed spec, prize tracks, briefs | Markdown |
| `pitch/` | Devpost draft, demo script | Markdown |

## Sponsor tools

SpacetimeDB (the system of work) · Anthropic Claude (extraction, cited "why?") · Factory Droid (the agent's session, built; not yet run live) · Capital One Nessie (simulated in the demo) · CRS (mock test identities in the demo).
