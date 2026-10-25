# Countersign — Interface Contract (v2.1)

The agreement between the TypeScript side (`db/`, `web/`) and the Python side (`core/`, `data/`, `scripts/`).
**Both sides build against this file.** Changing it needs both coders to agree, a version bump at the top, and a note in team chat.

> **v2 (supplier invoices) is in §9.** It only *adds* tables, reducers, roles and job kinds; nothing in §0–§6 is renamed or removed. Build §9 next; the v1 flow (subcontractor pay applications) stays as a second capability.

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
- `request_bank_change(request_id, id, sub_id, new_account_ref, new_last4, new_owner_name, requested_via)` — `sync`, `agent` — creates `bank_change` (`pending`), a work item `wi_<id>` of kind `bank_change` (state `held`, `entity_id` = the bank change id), and a proposal `prop_<id>` of kind `bank_change` (`payee_account_ref` = the new account).
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

## 7. Reference implementation

`core/countersign/fake_store.py` is a runnable Python copy of these rules, used for Python tests before the real module is up. If the module and the fake disagree, this file decides; raise it in team chat.

## 8. Changelog
- v1 — initial contract.
- v1 clarification — §4.6: IDs of the work item and proposal that `request_bank_change` creates.
- v2 — §9 supplier invoices: new roles `purchasing` and `receiver`, 21 new tables, new reducers and job kinds. `check_code` becomes free text (non-empty). Additive only.
- v2.1 — §9.8 clarifications: purchasing limit for a rate change without a scoped quantity, holds that survive a corrected revision, rejecting a payee change.

---

## 9. Supplier invoices (v2)

Product context: [SPEC.md](../SPEC.md). Detailed requirements: [BUILDBUY_PROMPT.md](BUILDBUY_PROMPT.md). All §1 conventions apply (snake_case, caller-chosen string IDs, `request_id` first, the request pattern, denials return normally, everything public).

### 9.1 Additions to v1

- **Roles:** add `purchasing` (approves change requests within its limit) and `receiver` (attests receipt). `register_actor` accepts them.
- **`work_item.kind`:** add `supplier_invoice` (one per invoice; `entity_id` = invoice id).
- **`proposal.kind`:** add `supplier_payment` (created by `propose_supplier_payment`, approved only by `approve_supplier_payment`, never by `decide_proposal`).
- **`check_result.check_code`:** free text from v2 (must be non-empty). Python uses codes like `price_terms`, `extra_charges`, `po_ceiling`, `duplicate`, `extraction`, `receipt`, `payee`, `deposit`, `fuel_surcharge`, `supplier_risk`, `prompt_injection`.
- **Quantities** are integers in thousandths: `_milli` columns, `t.i64()` (500 yd = `500000`). Units are strings (`cy`, `min`, `ea`). Never compare different units.
- **Ledger accounts:** add `supplier_prepayment` and `job_material_cost:<project_id>`.

### 9.2 New tables

Column order is declaration order. `PK` = primary key. All `_cents` and `_milli` are `t.i64()`.

**authority** — `identity: identity PK`, `role`, `limit_cents: i64` (0 = no approval authority), `project_scope` (`*` or a project id)

**supplier** — `id PK`, `name`, `email_domain`, `phone_on_file`, `crs_ref`, `status` (`active|on_hold|blocked`), `created_at: timestamp`

**supplier_contact** — `id PK`, `supplier_id` (index), `name`, `email`, `phone`, `title`, `pre_established: bool` (true only for contacts set up by `sync`/`admin` before any dispute; used for payee verification)

**payee_profile** — `id PK` (= `<supplier_id>:v<version>`), `supplier_id` (index), `version: u32`, `account_ref` (Nessie, never shown in full), `last4`, `bank_name`, `status` (`verified|pending|rejected|superseded`), `requested_via` (`seed|email|portal`), `verified_by_role`, `verified_via_contact_id`, `created_at: timestamp`
- At most one `verified` profile per supplier.

**document** — `id PK`, `kind` (`quote|terms|po|invoice|email|other`), `source_file_id`, `sha256`, `filename`, `pages: u32`, `status` (`received|extracted|validated|needs_review|failed`), `created_at: timestamp`

**source_fragment** — `id PK`, `document_id` (index), `page: u32` (0 for email), `email_message_id`, `line_start: u32`, `line_end: u32`, `text`, `created_at: timestamp`
- **Immutable.** Re-adding the same id with the same text = `duplicate`; with different text = **denied**.

**email_message** — `id PK`, `thread_id` (index), `document_id`, `from_address`, `to_addresses`, `subject`, `original_sent_at_iso`, `ingested_at_iso`, `body_fragment_id`, `from_known_contact: bool`

**extraction_run** — `id PK`, `document_id` (index), `mode` (`live|fixture`), `model`, `prompt_version`, `status` (`ok|invalid|failed`), `error`, `fields_json`, `created_at: timestamp`

**purchase** — `id PK`, `supplier_id`, `project_id`, `description`, `unit`, `currency` (`USD`), `po_number`, `quote_document_id`, `po_document_id`, `status` (`open|contract_review|closed`), `created_at: timestamp`

**term** — `id PK`, `purchase_id` (index), `code` (`unit_price|max_quantity|valid_through|deposit|payment_terms|price_change_rule|extra_charge_rule|fuel_surcharge_rule`), `label`, `amount_cents: i64`, `quantity_milli: i64`, `text`, `scope_json`, `effective_from`, `effective_to`, `status` (`accepted|proposed|declined|superseded`), `source_fragment_ids_json`, `version: u32`

**change_request** — `id PK`, `purchase_id` (index), `kind` (`extra_charge|price_change|quantity_change`), `description`, `amount_cents: i64` (fixed charges), `rate_cents: i64` (per unit), `rate_unit`, `scope_json` (deliveries, orders or dates it applies to), `effective_from`, `original_sent_at_iso`, `ingested_at_iso`, `classification` (`AUTHORISED_FIXED|AUTHORISED_RATE_USAGE_MISSING|PROPOSED|DECLINED|AMBIGUOUS|UNRELATED`), `supplier_acceptance` (`none|proposed|accepted|declined`), `supplier_acceptance_fragment_ids_json`, `requested_by_identity`, `internal_status` (`pending|approved|rejected`), `decided_by_identity`, `decided_by_role`, `decision_note`, `source_fragment_ids_json`, `created_at: timestamp`

**invoice** — `id PK`, `supplier_id` (index), `purchase_id`, `invoice_number`, `invoice_date`, `due_date`, `currency`, `active_revision_id`, `commercial_status` (`pending|matches|differences_under_review|contract_review`), `receipt_status` (`not_required|required|manually_confirmed`), `payee_status` (`verified|change_pending|unverified`), `approval_status` (`none|approved|stale|rejected`), `payment_status` (`not_ready|ready|submitted|settled|failed`), `next_owner_role`, `next_action`, `updated_at: timestamp`

**invoice_revision** — `id PK`, `invoice_id` (index), `revision: u32`, `document_id`, `gross_cents: i64`, `deposit_shown_cents: i64`, `balance_requested_cents: i64`, `supersedes_revision_id`, `status` (`active|superseded`), `created_at: timestamp`

**invoice_line** — `id PK`, `revision_id` (index), `kind` (`material|extra|waiting|fuel|tax|freight|other`), `description`, `quantity_milli: i64`, `unit`, `unit_price_cents: i64`, `amount_cents: i64`, `linked_term_id`, `linked_change_request_id`, `source_fragment_ids_json`

**assessment** — `id PK`, `revision_id` (index), `version: u32`, `fingerprint` (hash of every input the agent used), `policy_version`, `claimed_cents: i64`, `authorised_cents: i64`, `pending_cents: i64`, `variance_cents: i64`, `deposit_available_cents: i64`, `proposed_payment_cents: i64`, `commercial_status`, `summary`, `details_json` (per line: claimed, accepted, pending, calculation, fragment ids, uncertainty), `next_action`, `created_at: timestamp`

**hold** — `id PK`, `revision_id` (index), `code` (`CONTRACT_REVIEW|PRICE_VARIANCE|PROPOSED_CHARGE|USAGE_EVIDENCE_MISSING|PO_CEILING|DUPLICATE_REVIEW|EXTRACTION_REVIEW|RECEIPT_NOT_VERIFIED|PAYEE_CHANGE_PENDING|APPROVAL_STALE|PROMPT_INJECTION|SUPPLIER_RISK`), `status` (`open|resolved|superseded`), `amount_cents: i64`, `reason`, `evidence_json`, `opened_by_role`, `resolved_by_role`, `resolution_note`, `created_at: timestamp`, `resolved_at_iso`

**receipt_attestation** — `id PK`, `invoice_id` (index), `scope`, `quantity_milli: i64`, `unit`, `reason`, `label` (always `MANUALLY_CONFIRMED`), `attested_by_identity`, `attested_by_role`, `created_at: timestamp`

**deposit** — `id PK`, `purchase_id`, `supplier_id`, `amount_cents: i64`, `status` (`approved|settled`), `transfer_ref`, `approved_by_role`, `created_at: timestamp`

**deposit_allocation** — `id PK`, `deposit_id` (index), `invoice_id`, `amount_cents: i64`, `created_at: timestamp`
- Module rejects (`invalid`) any allocation that takes a deposit's total above its amount, or a second allocation of the same deposit to the same invoice.

**outbox** — `id PK`, `invoice_id`, `to_contact_id`, `to_address`, `subject`, `body`, `status` (`draft|approved|sent|failed`), `simulated: bool` (always true in the demo), `created_by_role`, `approved_by_role`, `delivery_ref`, `created_at: timestamp`

**payment_approval** — `id PK`, `proposal_id` (index), `invoice_id`, `revision_id`, `amount_cents: i64`, `deposit_allocation_cents: i64`, `payee_profile_id`, `assessment_fingerprint`, `policy_version`, `approved_by_identity`, `status` (`active|stale|used`), `stale_reason`, `created_at: timestamp`

**Job table additions:** add columns `attempts: u32`, `next_attempt_at_iso`, `lease_expires_at_iso`. New kinds below.

### 9.3 Who may resolve which hold

| Hold | Cleared by |
|---|---|
| `PRICE_VARIANCE`, `PROPOSED_CHARGE`, `USAGE_EVIDENCE_MISSING`, `PO_CEILING`, `DUPLICATE_REVIEW`, `EXTRACTION_REVIEW`, `CONTRACT_REVIEW`, `PROMPT_INJECTION`, `SUPPLIER_RISK` | A corrected revision (old revision's holds become `superseded` and the agent re-assesses the new one), **or** `owner` via `resolve_hold` with a note |
| `RECEIPT_NOT_VERIFIED` | Only `attest_receipt` covering the billed quantity (module resolves it automatically) |
| `PAYEE_CHANGE_PENDING` | Only an approved `decide_payee_profile` (module resolves it automatically) |
| `APPROVAL_STALE` | Only a new `approve_supplier_payment` |

**The agent can open holds but never resolve them.** `resolve_hold` by `agent` = denied.

### 9.4 Reducers

`request_id` is always first. **A** = needed by ~11 PM for the primary scenario; **B** = by 4 AM.

**Setup and records (A)**
- `set_authority(request_id, identity_hex, role, limit_cents, project_scope)` — `admin`
- `upsert_supplier(request_id, id, name, email_domain, phone_on_file, crs_ref, status)` — `sync`, `admin`
- `upsert_supplier_contact(request_id, id, supplier_id, name, email, phone, title, pre_established)` — `sync`, `admin` (`pre_established = true` only allowed for `admin`/`sync` at seed time)
- `add_payee_profile(request_id, id, supplier_id, version, account_ref, last4, bank_name, requested_via)` — `sync`, `agent`, `admin`. `admin` may create it as `verified` (seed: `requested_via = 'seed'`); everyone else creates `pending`, which sets every open invoice of that supplier to `payee_status = change_pending` and opens `PAYEE_CHANGE_PENDING` on its active revision.
- `record_document(request_id, id, kind, source_file_id, sha256, filename, pages)` — `sync`
- `add_fragment(request_id, id, document_id, page, email_message_id, line_start, line_end, text)` — `sync`, `agent` (immutable; see table)
- `record_email(request_id, id, thread_id, document_id, from_address, to_addresses, subject, original_sent_at_iso, ingested_at_iso, body_fragment_id)` — `sync`. The module sets `from_known_contact` by looking up `supplier_contact.email`.
- `record_extraction_run(request_id, id, document_id, mode, model, prompt_version, status, error, fields_json)` — `agent`. Also sets `document.status`.
- `upsert_purchase(request_id, id, supplier_id, project_id, description, unit, po_number, quote_document_id, po_document_id, status)` — `sync`, `agent`
- `record_term(request_id, id, purchase_id, code, label, amount_cents, quantity_milli, text, scope_json, effective_from, effective_to, status, source_fragment_ids_json, version)` — `sync`, `agent`. **Invalid** unless every fragment id exists.
- `record_deposit(request_id, id, purchase_id, supplier_id, amount_cents, status, transfer_ref)` — `sync`, `gateway` (demo: seeded as `settled`)

**Amendments (A)**
- `propose_change_request(request_id, id, purchase_id, kind, description, amount_cents, rate_cents, rate_unit, scope_json, effective_from, original_sent_at_iso, ingested_at_iso, classification, supplier_acceptance, source_fragment_ids_json)` — `agent`, `sync`, `purchasing` (a person can request one in the app). `requested_by_identity` = caller.
- `record_supplier_acceptance(request_id, change_request_id, supplier_acceptance, fragment_ids_json)` — `agent`, `sync`
- `decide_change_request(request_id, id, approve, note)` — `purchasing`, `owner`. **Denied** if the caller requested it, if the caller's `authority.limit_cents` is below `amount_cents` (fixed) or below `rate_cents × scoped quantity` (rate), or if outside `project_scope`. Approval doesn't create supplier acceptance; both are tracked separately.

**Invoices and assessment (A)**
- `record_invoice(request_id, id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, currency)` — `sync`, `agent`. Creates the `supplier_invoice` work item `wi_<id>` and sets all statuses to their initial values.
- `record_invoice_revision(request_id, id, invoice_id, revision, document_id, gross_cents, deposit_shown_cents, balance_requested_cents, supersedes_revision_id)` — `sync`, `agent`. If `supersedes_revision_id` is set: that revision → `superseded`, its open holds → `superseded`, every `active` payment approval for the invoice → `stale` (reason `revision superseded`). Sets `invoice.active_revision_id`.
- `record_invoice_line(request_id, id, revision_id, kind, description, quantity_milli, unit, unit_price_cents, amount_cents, linked_term_id, linked_change_request_id, source_fragment_ids_json)` — `sync`, `agent`. **Invalid** unless `quantity_milli × unit_price_cents / 1000 = amount_cents` when both are set (exact integer math).
- `record_assessment(request_id, id, revision_id, version, fingerprint, policy_version, claimed_cents, authorised_cents, pending_cents, variance_cents, deposit_available_cents, proposed_payment_cents, commercial_status, summary, details_json, next_action)` — `agent`. Updates `invoice.commercial_status` / `next_action`; any `active` approval whose fingerprint differs → `stale` and opens `APPROVAL_STALE`.
- `open_hold(request_id, id, revision_id, code, amount_cents, reason, evidence_json)` — `agent`, `sync`
- `resolve_hold(request_id, id, note)` — `owner` only, and only for the codes in §9.3's first row. Note required.

**People in the loop (A)**
- `attest_receipt(request_id, id, invoice_id, scope, quantity_milli, unit, reason)` — `receiver`. Label is always `MANUALLY_CONFIRMED`. If the total attested ≥ the material quantity on the active revision (same unit): resolves `RECEIPT_NOT_VERIFIED` and sets `receipt_status = manually_confirmed`.
- `decide_payee_profile(request_id, id, approve, verified_via_contact_id, note)` — `owner`. **Denied** unless `verified_via_contact_id` is a `pre_established` contact of that supplier (never a contact from the request itself). Approve: previous verified profile → `superseded`, this → `verified`, `PAYEE_CHANGE_PENDING` resolved, every approval bound to the old profile → `stale`.

**Clarifications (B)**
- `draft_outbox(request_id, id, invoice_id, to_contact_id, subject, body)` — `agent`. Status `draft`, `simulated = true`.
- `approve_outbox(request_id, id)` — `purchasing`, `owner`. → `approved` and enqueues `send_outbox` (assignee `sync`).
- `mark_outbox(request_id, id, status, delivery_ref)` — `sync` (`sent|failed`).

**Payment (A)**
- `propose_supplier_payment(request_id, id, invoice_id, revision_id, assessment_id, amount_cents, deposit_allocation_cents, payee_profile_id)` — `agent`. Creates a `proposal` of kind `supplier_payment`. **Denied** unless `amount_cents = assessment.proposed_payment_cents`.
- `approve_supplier_payment(request_id, proposal_id, expected_fingerprint, note)` — `owner`, never the proposer. **Eligibility, all inside the reducer** (denied with a JSON list of `blocked_reasons` in the message if any fail):
  1. the proposal's revision is the invoice's active revision;
  2. no `open` hold on that revision;
  3. `receipt_status = manually_confirmed` (or `not_required`);
  4. the payee profile is the supplier's current `verified` one;
  5. `expected_fingerprint` = the latest assessment's fingerprint for that revision;
  6. the deposit allocation fits the deposit's remaining balance.

  On success: `payment_approval` (`active`, bound to all of the above), proposal `approved`, invoice `approval_status = approved`, `payment_status = ready`, and enqueue `pay_supplier` (assignee `gateway`, payload `{"proposal_id"}`).
- `reject_supplier_payment(request_id, proposal_id, note)` — `owner`.
- `start_payment` / `record_payment` (v1 §4.4) also accept `supplier_payment` proposals, with one extra rule: `start_payment` **re-checks** that the approval is still `active` and every bound value still matches; otherwise denied and the approval becomes `stale`. `record_payment` marks the approval `used`, sets `payment_status = settled`.
- `record_deposit_allocation(request_id, id, deposit_id, invoice_id, amount_cents)` — `gateway` (at settlement; see table rules).

### 9.5 New job kinds

| kind | who may enqueue | assignee | payload |
|---|---|---|---|
| `process_document` | `sync`, `owner`, `purchasing` | `agent` | `{"document_id"}` |
| `reassess_invoice` | `sync`, `agent`, `owner` | `agent` | `{"invoice_id"}` |
| `send_outbox` | (created by `approve_outbox`) | `sync` | `{"outbox_id"}` |
| `pay_supplier` | (created by `approve_supplier_payment`) | `gateway` | `{"proposal_id"}` |
| `sneak_charge` | anyone (`public` max 3 queued) | `sync` | `{"kind": "price|extra|waiting|fuel|bank_change|injection", "amount_cents", "note"}` |
| `due_scan` | `owner`, `sync` | `sync` | `{}` |

Retries: the worker increments `attempts` on failure and sets `next_attempt_at_iso` (backoff); a job `claimed` past `lease_expires_at_iso` can be re-claimed. Failed extraction → `EXTRACTION_REVIEW`, never an approved bill.

### 9.6 Journals (fixture accounting)

- Deposit settled: Dr `supplier_prepayment` / Cr `cash`.
- Corrected bill accepted + receipt attested: Dr `job_material_cost:<project>` / Cr `accounts_payable` (gross $83,700).
- Deposit applied: Dr `accounts_payable` / Cr `supplier_prepayment` ($10,000).
- Settlement: Dr `accounts_payable` / Cr `cash` ($73,700). AP ends at $0. Never re-post the original invoice when a correction arrives.

### 9.7 Web views (D)

1. **Work queue:** supplier, project, invoice, requested balance, due date, the five statuses, open holds, next owner, next action, and honest `live` / `fixture` / `simulated` labels.
2. **Purchase record:** quote and terms, PO, supplier acknowledgment, approved changes, deposit, validity, authority evidence, source viewer.
3. **Invoice case:** line by line claimed vs. accepted vs. pending, calculations, source links (open the real PDF page or email), email thread, clarification drafts, corrected revisions, timeline.
4. **Approval review:** exact amount, revision, payee (masked), receipt attestation, evidence, approve / reject / request info, stale warnings, settlement and ledger. A disabled button always says why.

### 9.8 v2.1 clarifications

1. **Purchasing limit for a rate change** (`decide_change_request`). `scope_json` keys, all optional: `{"quantity_milli", "unit", "from", "to", "delivery_refs"}` (`from`/`to` are `YYYY-MM-DD`). For a rate change (`rate_cents > 0`) the exposure checked against `authority.limit_cents` is `rate_cents × quantity_milli / 1000`, rounded up. Without a scoped `quantity_milli`, use the purchase's **remaining ceiling quantity** as the worst case: its latest `accepted` `max_quantity` term minus the `material` quantity on the active revisions of its **settled** invoices (`payment_status = settled`; an unpaid invoice can still be repriced). Units must match (`rate_unit` = the scope's `unit` or `purchase.unit`); if they don't, or there's no accepted `max_quantity` term, the exposure can't be sized and approval is **denied**. The limit applies to approvals only; rejecting a change commits no money.
2. **Holds that survive a correction** (`record_invoice_revision`). When a revision is superseded its open holds become `superseded` as before, but open `RECEIPT_NOT_VERIFIED`, `PAYEE_CHANGE_PENDING` and `SUPPLIER_RISK` holds are reopened on the new revision with the same code, amount, reason and evidence (a correction can't clear them; see §9.3). Holds the module creates (these, and the one `add_payee_profile` opens) use the id `hold_<revision_id>_<code in lowercase>`. `open_hold` with an id that already exists changes nothing (outcome `duplicate`).
3. **Rejecting a payee change** (`decide_payee_profile`, approve = false; still needs a `pre_established` contact). The profile → `rejected`. If the supplier has no other `pending` profile, `PAYEE_CHANGE_PENDING` is resolved on its invoices and `payee_status` returns to `verified` (or `unverified` if it has no verified profile). Approvals bound to the still-verified old profile stay `active`.
