# core/ — Python services

**Owner:** Python developer · **Branch:** `py/core` · **Port:** 8000 (upload + file preview only)

The job worker, the investigation agent (Factory Droid + Claude), deterministic checks, the payment gateway, and the connections to Nessie, CRS and Apify. Every external service has a mock (`USE_MOCKS=true`).

## Setup

```bash
brew install uv            # once
cd core && uv sync && cd ..
uv run --project core pytest core   # 16 tests, all offline
```

## Run against the SpacetimeDB module

```bash
uv run --project core python scripts/setup_actors.py   # once per fresh module; paste tokens into .env / web/.env.local
uv run --project core python scripts/load_seed.py      # company, subs, contracts, 6 months of paid history
uv run --project core python scripts/run_worker.py     # leave running: agent + gateway + sync
uv run --project core python scripts/demo_pile.py moment   # the opening fake bank-change bill
uv run --project core python scripts/demo_pile.py pile     # the other 8 October bills
uv run --project core uvicorn countersign.api:app --port 8000   # PDF upload + preview for the dashboard
```

Other scripts: `smoke_spacetime.py` (go/no-go HTTP check), `check_droid.py` (Droid only sees our tools), `run_scorecard.py` (offline scorecard), `reset_demo.py` (after republishing the module with `--delete-data`).

## Where Droid runs (for the Factory judges)

- **Trigger:** every `process_bill` job (a bill arriving by upload, inbox or the "scam us" page) starts a Droid session (`countersign/agent.py`, `run_droid`).
- **What it can touch:** only five tools we wrote: `read_bill`, `list_checks`, `run_check`, `get_sub_history`, `file_proposal`. Droid's built-in file and shell tools are removed with `restrict_tools`. It can't approve or pay: the database refuses those calls for the `agent` role.
- **Visible work:** every plan, tool call, result and decision is written to the `agent_step` table, which the web app streams live.
- **Fail-safe:** if Droid errors or ends without a proposal, the scripted agent finishes with the same tools and holds the bill.

## Key files

| File | What |
|---|---|
| `countersign/reducers.py` | The only place that knows reducer argument order (matches `docs/CONTRACT.md`) |
| `countersign/fake_store.py` | Runnable Python copy of the module's rules, for tests |
| `countersign/checks.py`, `decide.py` | Deterministic checks and decision rules |
| `countersign/agent.py` | Droid agent, scripted agent, compromised-agent demo, "why?" chat |
| `countersign/pipeline.py` | Seed, intake, agent tools, gateway (pays once, even after a timeout), ledger |
| `countersign/world.py`, `attacks.py` | The fictional company, its history, the demo pile, and the scam generator |
| `countersign/worker.py` | Job worker; holds only the agent, gateway and sync keys |

## Known gaps (as of this commit)

- CRS: real business-report endpoint and field mapping wait on the Postman collection (`integrations/crs.py`).
- Apify: needs our license-lookup Actor (`APIFY_LICENSE_ACTOR`).
- Gmail intake, contract reading (`read_contract`), bank-change verification flow: not built yet.
