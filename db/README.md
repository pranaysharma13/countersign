# db/ — SpacetimeDB module

**Owner:** TypeScript developer · **Branch:** `ts/app`

The system of work: tables, roles, allowed state changes, separation of duties, the job bus and the audit log. All approval and payment rules are enforced here. Built exactly to [`docs/CONTRACT.md`](../docs/CONTRACT.md).

## Layout

| File | What |
|---|---|
| `src/schema.ts` | Every table from CONTRACT §3 (names kept snake_case: `CaseConversionPolicy.None`) |
| `src/constants.ts` | Enum lists, check codes, `HARD_STOP_CHECKS`, job kind permissions |
| `src/request.ts` | The request pattern: duplicate check → role check → audit + `request_result`. Never throws on denial. |
| `src/logic.ts` | v1 reducer bodies (§4), `(ctx, sender, ...args)` so tests can act as any role |
| `src/logic_v2.ts` | v2 supplier-invoice reducer bodies (§9), incl. the six payment-eligibility rules |
| `src/index.ts` | The reducers. **Parameter order = CONTRACT §4** (Python calls them positionally). |
| `test/rules.test.ts` | v1 rule tests (in-process, `spacetimedb/server/test-utils`) |
| `test/v2.test.ts` | v2: the BayMix scenario end to end ($87,425 → $73,700, AP $0, cash out $83,700) + rule tests |

## Status

- **All 66 reducers in CONTRACT v2 exist** with the exact argument order (checked by script against the contract text).
- v1 P0 + P1 and v2 §9 "A" and "B": done. 46 tests pass.

## Run

```bash
cd db
npm install
npm test            # 46 rule tests, no server needed
npm run typecheck

# Live (needs the spacetime CLI: https://spacetimedb.com/install)
spacetime start                                   # local server on :3000
spacetime publish --server local countersign      # from db/
spacetime logs --server local countersign
```

## Calling a reducer from Python / curl (go/no-go check)

Reducer args are a **positional JSON array** in CONTRACT order. `i64` money values can be sent as JSON numbers.

```bash
# 1. Get an identity + token
TOKEN=$(curl -s -X POST http://localhost:3000/v1/identity | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 2. Claim admin (first caller only)
curl -s -X POST http://localhost:3000/v1/database/countersign/call/claim_admin \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '["req-0001"]'

# 3. Read the outcome
curl -s -X POST http://localhost:3000/v1/database/countersign/sql \
  -H "Authorization: Bearer $TOKEN" \
  -d "SELECT * FROM request_result WHERE request_id = 'req-0001'"
```

## Rules enforced in code (beyond the contract's minimum)

These came out of "the AI can add holds, never remove them" and "fail safe". Python should expect them:

- `set_work_item_state` (agent): only **out of** `new`, `reading`, `investigating`, `needs_info`. The agent can't move a `held` or `proposed` item back.
- `propose` payment: only from `investigating` or `override_requested`; the payee must be the bill's sub; amount ≤ bill amount; contract confirmed. **Denied if any check on the item is `fail` or `error`** (except non-hard-stop failures after an owner override). Hard-stop failures always deny.
- `record_check`: a check already at `fail` can't be rewritten to anything else.
- `cancel_proposal`: the agent can only cancel payment proposals, never holds.
- `decide_proposal` and `start_payment` re-check that the payee account still matches the account on file.
- `create_work_item` with an existing id returns `ok` with message `already exists` (safe for re-syncs).

## v2 behaviour Python should know (beyond CONTRACT §9)

- `approve_supplier_payment` denial message = a **JSON array** of `blocked_reasons` strings. `APPROVAL_STALE` doesn't block the approval that clears it.
- Approval id is `appr_<proposal_id>`; the pay job is `job_pay_<proposal_id>`; the send job is `job_send_<outbox_id>`.
- A `supplier_payment` proposal stores `{invoice_id, revision_id, assessment_id, deposit_allocation_cents, payee_profile_id}` in `evidence_json`.
- New revision: commercial holds on the old one → `superseded`; `RECEIPT_NOT_VERIFIED` and `PAYEE_CHANGE_PENDING` are **carried over** (id `<old hold id>~<new revision id>`). Work item goes back to `investigating`.
- Module-created holds: `hold_<rev>_PAYEE_CHANGE_PENDING_<profile id>`, `hold_<rev>_APPROVAL_STALE_<approval id>`.
- `decide_change_request`: owner without an `authority` row is unlimited; anyone else needs one (limit 0 otherwise). Rate charges need `scope_json.max_quantity_milli` (or `quantity_milli`); exposure = `amount_cents + ceil(rate_cents × qty / 1000)`.
- `upsert_supplier` can't change `phone_on_file`; a `pre_established` contact can't be edited or created by promotion.
- `record_email.from_known_contact` = exact (case-insensitive) match on a contact email. Lookalikes are false.
- Jobs: `claim_job` sets a 5-minute lease and `attempts + 1`; an expired lease can be re-claimed. `finish_job(ok=false)` re-queues with backoff (10s, 20s…) until 3 attempts, then `failed`.
- `post_journal.ref_type` also accepts `deposit` and `invoice`.
- `decide_proposal` on a `supplier_payment` is denied (use `approve_supplier_payment`).
