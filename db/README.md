# db/ — SpacetimeDB module

**Owner:** TypeScript developer · **Branch:** `ts/app`

The system of work: tables, roles, allowed state changes, separation of duties, the job bus and the audit log. All approval and payment rules are enforced here. Built exactly to [`docs/CONTRACT.md`](../docs/CONTRACT.md).

## Layout

| File | What |
|---|---|
| `src/schema.ts` | Every table from CONTRACT §3 (names kept snake_case: `CaseConversionPolicy.None`) |
| `src/constants.ts` | Enum lists, check codes, `HARD_STOP_CHECKS`, job kind permissions |
| `src/request.ts` | The request pattern: duplicate check → role check → audit + `request_result`. Never throws on denial. |
| `src/logic.ts` | Reducer bodies, `(ctx, sender, ...args)` so tests can act as any role |
| `src/index.ts` | The reducers. **Parameter order = CONTRACT §4** (Python calls them positionally). |
| `test/rules.test.ts` | Rule tests run in-process with `spacetimedb/server/test-utils` |

## Status

- P0 reducers (§4.1–4.5): done and tested.
- P1 (§4.6–4.9: bank changes, change orders, policies, questions, chat, scorecard): tables exist, reducers next.

## Run

```bash
cd db
npm install
npm test            # 22 rule tests, no server needed
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
