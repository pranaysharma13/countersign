# Countersign — Interface Contract (v1)

The agreement between the TypeScript side (`db/`, `web/`) and the Python side (`core/`, `data/`, `scripts/`).
**Both sides build against this file.** Changing it needs both coders to agree, a version bump at the top, and a note in team chat.

---

## 0. How the pieces talk

```
 judges' phones / owner's phone / dashboard (web, Next.js)
        │  subscribe to tables, call reducers (spacetimedb SDK)
        ▼
 SpacetimeDB module (db/)  ◀── the single source of truth + the bus
        ▲
        │  HTTP: call reducers, run SQL (poll every ~1 s)
 Python worker + gateway (core/)  ──▶ Claude, Factory Droid, Nessie, CRS, Apify, Gmail, Cartesia
```

- **SpacetimeDB is the bus.** The web never needs to reach the Python service, except for file upload and file preview on the laptop.
- When the web wants Python to do something (process an upload, answer "why?", run the scam a judge wrote), it **inserts a `job` row**. Python polls for queued jobs, claims them, does the work, and finishes them.
- Python never needs a SpacetimeDB client SDK. It uses two HTTP endpoints:
  - `POST {SPACETIMEDB_URI}/v1/database/{SPACETIMEDB_DATABASE}/call/{reducer}`, body = **JSON array of positional arguments**, header `Authorization: Bearer <token>`.
  - `POST {SPACETIMEDB_URI}/v1/database/{SPACETIMEDB_DATABASE}/sql`, body = SQL text.
- **Because reducer arguments are positional, argument order in §4 is part of the contract.** Declare reducer params in exactly that order.

### Ports and hosting

| Piece | Local | Demo |
|---|---|---|
| SpacetimeDB | `spacetime start` on `http://localhost:3000` | Maincloud, database name `countersign` |
| Web (Next.js) | `http://localhost:3001` (`next dev -p 3001`) | Vercel (so judges' phones can reach it) |
| Python API (upload + file preview only) | `http://localhost:8000` | Runs on the demo laptop; only needs outbound internet |

---

## 1. Conventions

- **Names are snake_case** everywhere in the module: tables, columns, reducers, reducer args. SQL, HTTP calls and generated bindings must use identical names. If the hour-1 check shows names being changed, set `CASE_CONVERSION_POLICY: CaseConversionPolicy.None` in `schema()`.
- **IDs are strings, chosen by the caller.** Formats: `sub_<slug>`, `prj_<slug>`, `ctr_<slug>`, `src_<sha8>`, `bill_<sha8>`, `wi_<...>`, `prop_<uuid8>`, `job_<uuid>`, `pol_<uuid8>`, `q_<uuid8>`, `msg_<uuid8>`, `bc_<uuid8>`, `jrnl_<...>`. Python derives sync IDs from a hash of the source, so re-running a sync never creates duplicates.
- **Money is integer cents**: columns end in `_cents`, type `t.i64()`. Percentages are basis points: `_bps`, `t.u32()` (10% = 1000).
- **Business dates are strings** `YYYY-MM-DD` (bill dates, due dates, seeded history). **System times** use `t.timestamp()`, set from `ctx.timestamp` inside the module.
- **Structured blobs are JSON strings** in columns ending `_json`.
- **Enums are strings.** The module validates them against the lists in §3.
- **All tables are `public: true`** (fictional demo data; lets every screen subscribe without extra rules).
- **Every mutating reducer takes `request_id: string` (a UUID) as its first argument.**

### The request pattern (every mutating reducer)

1. If `request_result` already has this `request_id`, do nothing (outcome `duplicate`). This makes retries safe.
2. Look up the caller's role in `actor` (unregistered = `public`). If the role isn't allowed: write an `audit_log` row with `outcome = 'denied'`, write `request_result` with `outcome = 'denied'` and the reason, and **return normally**.
3. Validate input. If invalid: write `request_result` with `outcome = 'invalid'` and the message, and return normally.
4. Do the work. Write `audit_log` rows with `before_json` / `after_json`, and `request_result` with `outcome = 'ok'`.

**Never throw for expected failures.** A thrown error rolls back the whole transaction, including the "denied" audit row, and the denial log is a demo feature.

Python reads the outcome with `SELECT * FROM request_result WHERE request_id = '<id>'`.

---

## 2. Roles

| Role | Held by | Notes |
|---|---|---|
| `admin` | Setup script only | First caller of `claim_admin`. Registers the other actors. Never used by the agent. |
| `owner` | GC owner (web) | Decides payments, bank changes, change orders, contracts |
| `bookkeeper` | Outside bookkeeper (web) | Decides policies, can confirm contracts |
| `agent` | Python agent process | Reads, records findings, proposes, asks. **Never approves, never pays.** |
| `gateway` | Python gateway process | The only role that records payments and posts payment journals |
| `sync` | Python intake/seed process | Creates records, work items, bank snapshots, score rows |
| `public` | Anyone unregistered (judges' phones) | Can only enqueue `scam_submit` and `legit_submit` jobs (max 3 queued per identity) |

Hard rules the module enforces:
- A proposal can't be decided by the identity that proposed it, and never by `agent`.
- A payment proposal's `payee_account_ref` must equal the sub's `bank_account_ref` on file. Otherwise `propose` is denied.
- A sub's bank fields can't be changed by `upsert_sub` once the sub exists. The only path is an approved `bank_change` proposal with passing verifications (§4.6). Attempts are denied and logged ("quiet bank edit").
- `record_payment` requires the proposal to be `approved` or `executing`, and only one payment per proposal.

---

## 3. Tables

Column order below is the declaration order. `PK` = primary key.

### 3.1 System

**actor** — `identity: identity PK`, `role: string`, `display_name: string`, `created_at: timestamp`

**request_result** — `request_id: string PK`, `reducer: string`, `caller_role: string`, `outcome: string` (`ok|duplicate|denied|invalid`), `message: string`, `created_at: timestamp`

**audit_log** — `id: u64 PK autoInc`, `at: timestamp`, `request_id: string`, `actor_role: string`, `actor_identity: string` (hex), `action: string` (reducer name), `entity_type: string`, `entity_id: string`, `outcome: string` (`ok|denied`), `reason: string`, `before_json: string`, `after_json: string`
- Index `entity_id`.

**job** — `id: string PK`, `kind: string`, `assignee_role: string`, `payload_json: string`, `status: string` (`queued|claimed|done|failed`), `requested_by: string` (identity hex), `claimed_by: string`, `result_json: string`, `error: string`, `created_at: timestamp`, `updated_at: timestamp`
- Index `status`.

**config** — `key: string PK`, `value: string`

### 3.2 Records (the company)

**company** — `id PK`, `name`, `owner_name`, `state`, `bank_account_ref` (Nessie account id), `bank_last4`

**project** — `id PK`, `name`, `address`, `status` (`active|closed`)

**sub** — `id PK`, `name`, `trade`, `license_number`, `license_state`, `contact_email`, `email_domain`, `phone_on_file`, `bank_account_ref`, `bank_last4`, `bank_owner_name`, `crs_ref` (which CRS test identity/business), `status` (`onboarding|active|blocked`), `created_at: timestamp`

**contract** — `id PK`, `sub_id` (index), `project_id`, `title`, `original_value_cents: i64`, `retainage_bps: u32`, `payment_terms_days: u32`, `lien_waiver_rule` (`conditional_progress_each_bill|none`), `bank_change_clause: string` (the clause text, quoted in explanations), `source_file_id`, `status` (`draft|confirmed`), `confirmed_by_role`

**contract_line** — `id PK`, `contract_id` (index), `code`, `description`, `scheduled_value_cents: i64`

**change_order** — `id PK`, `contract_id` (index), `number`, `description`, `amount_cents: i64`, `status` (`pending|approved|rejected`), `decided_by_role`

**source_file** — `id PK`, `kind` (`email|upload|scam_page|legit_page|scorecard|seed|contract`), `filename`, `sha256`, `received_at_iso`, `from_address`, `subject`, `storage_path` (Python serves it at `GET {CORE_URL}/files/{id}`)

**bill** — `id PK`, `sub_id` (index; `''` if unknown), `contract_id`, `source_file_id`, `invoice_number`, `bill_date`, `due_date`, `period_label`, `amount_cents: i64`, `retainage_cents: i64`, `remit_bank_name`, `remit_account_ref`, `remit_account_last4`, `from_address`, `has_lien_waiver: bool`, `extracted_json`

**bill_line** — `id PK`, `bill_id` (index), `contract_line_code`, `description`, `this_period_cents: i64`, `previous_cents: i64`, `percent_complete_bps: u32`

**bank_snapshot** — `id PK`, `account_ref`, `balance_cents: i64`, `as_of_iso`

**ledger_line** — `id: u64 PK autoInc`, `journal_id` (index), `entry_date`, `memo`, `ref_type` (`bill|payment|seed`), `ref_id`, `account`, `debit_cents: i64`, `credit_cents: i64`
- Accounts: `cash`, `accounts_payable`, `retainage_payable`, `job_cost:<project_id>`.

### 3.3 Work (the system of work)

**work_item** — `id PK`, `kind` (`bill|bank_change|contract_onboarding`), `entity_id` (bill id, bank change id, or contract id), `origin` (`inbox|upload|scam_page|legit_page|scorecard|seed`), `state` (see §3.5), `summary`, `risk_level` (`low|medium|high`), `created_at: timestamp`, `updated_at: timestamp`
- Index `state`. **The agent's tools must never expose `origin`** (that would be cheating on the scorecard).

**agent_step** — `id: u64 PK autoInc`, `work_item_id` (index), `at: timestamp`, `kind` (`plan|tool_call|tool_result|thought|decision|error`), `title`, `detail_json`
- What the live investigation screen shows.

**check_result** — `id PK` (= `<work_item_id>:<check_code>`, upserted), `work_item_id` (index), `check_code` (§3.4), `status` (`pass|fail|warn|error|skipped`), `summary`, `evidence_json`, `source` (`contract|history|document|crs|nessie|apify|claude|audit`), `at: timestamp`

**proposal** — `id PK`, `work_item_id` (index), `kind` (`payment|hold|bank_change`), `amount_cents: i64`, `payee_sub_id`, `payee_account_ref`, `reason`, `evidence_json` (list of check_result ids), `status` (`pending|approved|rejected|executing|executed|failed|cancelled`), `proposed_by_role`, `proposed_by_identity`, `decided_by_role`, `decided_by_identity`, `decision_note`, `created_at: timestamp`, `decided_at_iso`

**payment** — `id PK` (= proposal id), `proposal_id`, `nessie_transfer_id`, `amount_cents: i64`, `payee_account_ref`, `status` (`sent|failed`), `error`, `at: timestamp`

**bank_change** — `id PK`, `sub_id`, `new_account_ref`, `new_last4`, `new_owner_name`, `requested_via` (`email|phone|portal`), `status` (`pending|verified|approved|rejected`), `created_at: timestamp`

**verification** — `id PK`, `bank_change_id` (index), `method` (`callback_phone_on_file|crs_idv`), `result` (`pass|fail`), `detail`, `at: timestamp`

**policy** — `id PK`, `scope` (`sub|global`), `sub_id`, `rule_code`, `params_json`, `description`, `evidence_json`, `status` (`proposed|approved|rejected`), `proposed_by_role`, `decided_by_role`

**question** — `id PK`, `work_item_id`, `to_role`, `text`, `options_json`, `status` (`open|answered`), `answer`, `answered_by_role`

**chat_message** — `id PK`, `work_item_id` (index), `author_role` (`owner|bookkeeper|agent`), `text`, `citations_json` (list of `audit_log` ids and `check_result` ids), `at: timestamp`

**score_run** — `id PK`, `status` (`running|done`), `totals_json`, `started_at: timestamp`

**score_case** — `id PK`, `run_id` (index), `attack_type` (or `legit`), `expected` (`pay|hold`), `actual` (`pay|hold|error`), `correct: bool`, `amount_cents: i64`, `work_item_id`

### 3.4 Check codes

| Code | Meaning | Hard stop? |
|---|---|---|
| `bank_mismatch` | Remit-to account ≠ account on file | **Yes** |
| `quiet_bank_edit` | Someone tried to change bank fields outside a bank change | **Yes** |
| `license` | Sub's license missing, expired or not matching (Apify) | **Yes** |
| `crs_identity` | Identity verification failed | **Yes** |
| `crs_liens_judgments` | Liens/judgments found on the sub | No |
| `sender_domain` | Sender domain doesn't match the sub on file (lookalike) | No |
| `duplicate` | Same or near-same bill already recorded | No |
| `overbilling` | Billed beyond the contract's schedule of values | No |
| `unapproved_change_order` | Bills against a change order that isn't approved | No |
| `lien_waiver_missing` | Required lien waiver not attached | No |
| `math_mismatch` | Lines don't add up to the total | No |
| `split_bill` | Bills split to stay under review thresholds | No |
| `fake_owner_instruction` | A document claims the owner ordered payment | No |
| `prompt_injection` | Document contains instructions aimed at the AI | No |
| `cash_available` | Bank balance can't cover this week's run | No |

**Hard stop** = the owner can't override a hold that has a failed hard-stop check. The module returns: `"Can't pay: <summary>. Start a bank change verification instead."` The list lives in the module as `HARD_STOP_CHECKS`.

### 3.5 Work item states

```
new → reading → investigating → proposed ──owner approves──▶ approved → paying → paid
                     │              └──owner rejects──▶ rejected
                     ├──▶ needs_info (question open) ──answered──▶ investigating
                     └──▶ held ──owner agrees──▶ closed_held
                              └──owner "pay anyway"──▶ override_requested → (agent proposes payment) → proposed
any → failed (error)
```

Who moves what:
- `agent` via `set_work_item_state`: only to `reading`, `investigating`, `needs_info`, `failed`.
- `propose`: sets `proposed` (payment) or `held` (hold).
- `decide_proposal`: sets `approved`, `rejected`, `closed_held` or `override_requested`.
- `gateway` via `start_payment` / `record_payment`: `paying`, `paid`, `failed`.

---

## 4. Reducers

Format: `name(args in order)` — allowed roles — effect. `request_id` is always first.
**P0** = needed by ~5:30 PM for the first end-to-end bill. **P1** = by midnight.

### 4.1 Setup — P0
- `claim_admin(request_id)` — anyone, only if no admin exists — caller becomes `admin`.
- `register_actor(request_id, identity_hex, role, display_name)` — `admin` — upsert into `actor`.

### 4.2 Records — P0
- `upsert_company(request_id, id, name, owner_name, state, bank_account_ref, bank_last4)` — `sync`, `admin`
- `upsert_project(request_id, id, name, address, status)` — `sync`, `admin`
- `upsert_sub(request_id, id, name, trade, license_number, license_state, contact_email, email_domain, phone_on_file, bank_account_ref, bank_last4, bank_owner_name, crs_ref, status)` — `sync`, `admin` — on an existing sub, any change to `bank_account_ref`, `bank_last4` or `bank_owner_name` is **denied** and logged.
- `upsert_contract(request_id, id, sub_id, project_id, title, original_value_cents, retainage_bps, payment_terms_days, lien_waiver_rule, bank_change_clause, source_file_id)` — `sync`, `agent` — status `draft` (a confirmed contract can't be edited; denied).
- `upsert_contract_line(request_id, id, contract_id, code, description, scheduled_value_cents)` — `sync`, `agent` — denied if the contract is confirmed.
- `confirm_contract(request_id, contract_id)` — `owner`, `bookkeeper`
- `record_source_file(request_id, id, kind, filename, sha256, received_at_iso, from_address, subject, storage_path)` — `sync`
- `record_bill(request_id, id, sub_id, contract_id, source_file_id, invoice_number, bill_date, due_date, period_label, amount_cents, retainage_cents, remit_bank_name, remit_account_ref, remit_account_last4, from_address, has_lien_waiver, extracted_json)` — `sync`, `agent`
- `record_bill_line(request_id, id, bill_id, contract_line_code, description, this_period_cents, previous_cents, percent_complete_bps)` — `sync`, `agent`
- `record_bank_snapshot(request_id, id, account_ref, balance_cents, as_of_iso)` — `sync`, `gateway`
- `post_journal(request_id, journal_id, entry_date, memo, ref_type, ref_id, lines_json)` — `sync`, `gateway` — `lines_json` = `[{"account","debit_cents","credit_cents"}]`; **invalid unless total debits = total credits** and every line has exactly one side > 0.

### 4.3 Work — P0
- `create_work_item(request_id, id, kind, entity_id, origin, summary)` — `sync`, `agent` — state `new`.
- `set_work_item_state(request_id, id, state, note)` — `agent` — only the targets in §3.5; anything else denied.
- `log_agent_step(request_id, work_item_id, kind, title, detail_json)` — `agent`
- `record_check(request_id, work_item_id, check_code, status, summary, evidence_json, source)` — `agent` — upsert by `<work_item_id>:<check_code>`.
- `propose(request_id, id, work_item_id, kind, amount_cents, payee_sub_id, payee_account_ref, reason, evidence_json)` — `agent` — kinds `payment|hold`. For `payment`: denied unless the sub is `active`, its contract is `confirmed`, and `payee_account_ref` = the sub's account on file. Cancels the item's other `pending` proposals. Sets state `proposed` or `held`.
- `decide_proposal(request_id, proposal_id, approve, note)` — `owner` (also `bookkeeper` is denied for payments) — never the proposer.
  - `payment` + approve → proposal `approved`, item `approved`, enqueue job `pay_proposal` (assignee `gateway`, payload `{"proposal_id"}`).
  - `payment` + reject → `rejected`.
  - `hold` + approve → item `closed_held`.
  - `hold` + reject ("pay anyway") → if any failed check on the item is a hard stop: **denied** with the message in §3.4. Otherwise item `override_requested` and enqueue job `prepare_override_payment` (assignee `agent`, payload `{"work_item_id","note"}`).
  - `bank_change` → see §4.6.
- `cancel_proposal(request_id, id, note)` — `agent`, `owner` — only while `pending`.

### 4.4 Payments — P0
- `start_payment(request_id, proposal_id)` — `gateway` — `approved` → `executing`; item `paying`.
- `record_payment(request_id, proposal_id, nessie_transfer_id, status, error)` — `gateway` — requires `approved|executing`; if a payment row already exists → `duplicate`. `sent` → proposal `executed`, item `paid`. `failed` → proposal `failed`, item `failed`.

### 4.5 Jobs — P0
- `enqueue_job(request_id, id, kind, payload_json)` — roles per kind below. Module sets `assignee_role` from this table:

| kind | who may enqueue | assignee | payload |
|---|---|---|---|
| `process_bill` | `sync` | `agent` | `{"work_item_id"}` |
| `process_upload` | `owner`, `bookkeeper`, `sync` | `sync` | `{"source_file_id"}` |
| `read_contract` | `owner`, `bookkeeper`, `sync` | `agent` | `{"source_file_id","sub_id"}` |
| `scam_submit` | anyone (`public` max 3 queued) | `sync` | see §5 |
| `legit_submit` | anyone (`public` max 3 queued) | `sync` | `{"sub_id"}` |
| `answer_why` | (created by `ask_why`) | `agent` | `{"work_item_id","message_id"}` |
| `prepare_override_payment` | (created by `decide_proposal`) | `agent` | `{"work_item_id","note"}` |
| `pay_proposal` | (created by `decide_proposal`) | `gateway` | `{"proposal_id"}` |
| `resume_work_item` | (created by `answer_question`) | `agent` | `{"work_item_id","question_id"}` |
| `scorecard_run` | `owner`, `bookkeeper` | `sync` | `{"size":250}` |
| `compromised_agent_demo` | `owner` | `agent` | `{"work_item_id"}` |
| `reset_demo` | `owner` | `sync` | `{}` |

- `claim_job(request_id, job_id)` — caller's role must equal `assignee_role`; `queued` → `claimed`.
- `finish_job(request_id, job_id, ok, result_json, error)` — the claimer — → `done`/`failed`. For `scam_submit`/`legit_submit`, `result_json` includes `{"work_item_id"}` so the judge's phone can follow it.

### 4.6 Bank changes — P1
- `request_bank_change(request_id, id, sub_id, new_account_ref, new_last4, new_owner_name, requested_via)` — `sync`, `agent` — creates `bank_change` (`pending`), a work item of kind `bank_change`, and a `bank_change` proposal.
- `record_verification(request_id, id, bank_change_id, method, result, detail)` — `agent`
- `decide_proposal` on a `bank_change` proposal, approve → **denied unless both `callback_phone_on_file` and `crs_idv` have a `pass`**; otherwise updates the sub's bank fields (the only path), bank change `approved`.

### 4.7 Change orders — P1
- `upsert_change_order(request_id, id, contract_id, number, description, amount_cents)` — `sync`, `agent` — status `pending`.
- `decide_change_order(request_id, id, approve, note)` — `owner`

### 4.8 Policies, questions, chat — P1
- `propose_policy(request_id, id, scope, sub_id, rule_code, params_json, description, evidence_json)` — `agent`
- `decide_policy(request_id, id, approve, note)` — `bookkeeper`
- `ask_question(request_id, id, work_item_id, to_role, text, options_json)` — `agent` — item → `needs_info`.
- `answer_question(request_id, id, answer)` — the `to_role` — enqueues `resume_work_item`.
- `ask_why(request_id, id, work_item_id, text)` — `owner`, `bookkeeper` — inserts the `chat_message` and enqueues `answer_why`.
- `post_chat_answer(request_id, id, work_item_id, text, citations_json)` — `agent`

### 4.9 Scorecard — P1
- `record_score_run(request_id, id, status, totals_json)` — `sync`
- `record_score_case(request_id, id, run_id, attack_type, expected, actual, correct, amount_cents, work_item_id)` — `sync`

---

## 5. "Scam us" page payload

`scam_submit` payload (the web form sends this as `payload_json`):

```json
{
  "attack_type": "bank_change | lookalike_domain | prompt_injection | fake_owner | duplicate | overbilling | unapproved_change_order | missing_lien_waiver | split_bill | edited_total | fake_sub",
  "sub_id": "sub_...",
  "amount_cents": 4200000,
  "urgency_note": "free text the judge writes (goes into the email body)",
  "new_bank_last4": "9921",
  "judge_name": "optional"
}
```

Python builds a realistic bill PDF and email from this, runs it through the normal pipeline, and finishes the job with `{"work_item_id": "..."}`. The phone then follows that work item live.

**Live counter** (web computes it): scam jobs → their work items → count total, count not `paid` ("blocked"), and sum `amount_cents` of any that were paid ("money lost", should be $0).

---

## 6. Environment variables

Root `.env` (Python reads it; see `.env.example`). The web uses `web/.env.local`:

| Variable | Used by |
|---|---|
| `NEXT_PUBLIC_SPACETIMEDB_URI`, `NEXT_PUBLIC_SPACETIMEDB_DATABASE` | web |
| `SPACETIMEDB_OWNER_TOKEN`, `SPACETIMEDB_BOOKKEEPER_TOKEN` | web (server side), handed to the client after a `DEMO_PIN` check |
| `DEMO_PIN` | web |
| `NEXT_PUBLIC_CORE_URL` (`http://localhost:8000`) | web, laptop only (upload + PDF preview) |
| `SPACETIMEDB_ADMIN_TOKEN`, `SPACETIMEDB_AGENT_TOKEN`, `SPACETIMEDB_GATEWAY_TOKEN`, `SPACETIMEDB_SYNC_TOKEN` | Python |

`scripts/setup_actors.py` (Python side) creates an identity per role with `POST /v1/identity`, claims admin, registers each actor, and prints the tokens for both env files.

---

## 7. Changelog
- v1 — initial contract.
