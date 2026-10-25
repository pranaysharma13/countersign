"""Job worker (CONTRACT §4.5): poll queued jobs, claim with the assignee's role, do the work, finish.

The worker holds only the agent, gateway and sync tokens. It never holds the owner's key.
"""

from __future__ import annotations

import json
import random
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from . import agent
from . import reducers as R
from .attacks import ATTACK_TYPES, make_attack, make_legit_case
from .ids import short_uuid
from .pipeline import ingest, pay_proposal
from .scorecard import run_offline
from .store import Store
from .world import build_world

WORKER_ROLES = {"agent", "gateway", "sync"}
_world = build_world()


def worker_store() -> Store:
    """A store holding only the worker's own keys (never owner/bookkeeper/admin)."""
    from .config import settings
    from .store import SpacetimeStore, get_store

    if settings.store_backend == "fake":
        return get_store()
    return SpacetimeStore(tokens={k: v for k, v in settings.tokens.items() if k in WORKER_ROLES})


def _live_state(store: Store, sub_id: str | None, rng: random.Random) -> tuple[str, dict[str, int], str]:
    """Pick a sub (or use the given one) and return (sub_id, billed-to-date per line, next period label),
    so generated bills continue from what's really been billed, not from the September seed."""
    from datetime import datetime

    from .pipeline import NOT_GENUINE_STATES

    states = {w["entity_id"]: w["state"] for w in store.rows("work_item", kind="bill")}
    lines_by_bill: dict[str, list[dict[str, Any]]] = {}
    for l in store.rows("bill_line"):
        lines_by_bill.setdefault(l["bill_id"], []).append(l)
    options = [c for c in _world.contracts if c.project_id == "prj_oak" and (sub_id in (None, c.sub_id))]
    rng.shuffle(options)
    best: tuple[str, dict[str, int], str] | None = None
    for c in options:
        billed: dict[str, int] = {}
        latest = datetime(2026, 9, 1)
        for b in store.rows("bill", contract_id=c.id):
            if states.get(b["id"]) in NOT_GENUINE_STATES:
                continue
            for l in lines_by_bill.get(b["id"], []):
                billed[l["contract_line_code"]] = billed.get(l["contract_line_code"], 0) + int(l["this_period_cents"])
            try:
                latest = max(latest, datetime.strptime(b["period_label"], "%B %Y"))
            except ValueError:
                pass
        nxt = datetime(latest.year + (latest.month == 12), latest.month % 12 + 1, 1).strftime("%B %Y")
        remaining = sum(l.scheduled_cents for l in c.lines) - sum(billed.get(l.code, 0) for l in c.lines)
        best = best or (c.sub_id, billed, nxt)
        if remaining > 0:
            return c.sub_id, billed, nxt
    assert best is not None
    return best


def _scam(store: Store, p: dict[str, Any]) -> dict[str, Any]:
    attack = p.get("attack_type", "bank_change")
    if attack not in ATTACK_TYPES:
        raise ValueError(f"unknown attack_type {attack}")
    rng = random.Random()
    sub_id, billed, period = _live_state(store, p.get("sub_id") or None, rng)
    case = make_attack(_world, attack, rng, sub_id=sub_id,
                       amount_cents=int(p["amount_cents"]) if p.get("amount_cents") else None,
                       urgency_note=str(p.get("urgency_note", ""))[:600], new_bank_last4=str(p.get("new_bank_last4", ""))[:4],
                       case_id=f"judge_{short_uuid()}", billed_before=billed, period_label=period)
    case.doc.origin = "scam_page"
    for extra in case.extra_prior:  # split bill: the first half arrives too
        extra.origin = "scam_page"
        ingest(store, _world, extra, "scam_page")
    return {"work_item_id": ingest(store, _world, case.doc, "scam_page"), "attack_type": attack}


def _legit(store: Store, p: dict[str, Any]) -> dict[str, Any]:
    rng = random.Random()
    sub_id, billed, period = _live_state(store, p.get("sub_id") or None, rng)
    case = make_legit_case(_world, rng, sub_id=sub_id, case_id=f"legit_{short_uuid()}", billed_before=billed,
                           period_label=period)
    case.doc.origin = "legit_page"
    return {"work_item_id": ingest(store, _world, case.doc, "legit_page")}


def _scorecard(store: Store, p: dict[str, Any]) -> dict[str, Any]:
    results, totals = run_offline()
    run_id = f"run_{short_uuid()}"
    R.record_score_run(store, run_id, "running", totals)
    for r in results:
        R.record_score_case(store, f"{run_id}:{r.case.doc.id}", run_id, r.case.expected.attack_type, r.case.expected.expected,
                            r.actual, r.correct, r.case.doc.net_cents, "")
    R.record_score_run(store, run_id, "done", totals)
    return {"run_id": run_id, **{k: v for k, v in totals.items() if k != "per_type"}}


def _reset(store: Store, p: dict[str, Any]) -> dict[str, Any]:
    # The module has no deletes, and re-delivering the same bills would (correctly) be flagged as duplicates.
    # A clean reset is: republish the module with --delete-data, then `scripts/reset_demo.py`.
    raise NotImplementedError("Reset = republish the module with --delete-data, then run scripts/reset_demo.py")


HANDLERS: dict[str, Callable[[Store, dict[str, Any]], Any]] = {
    "process_bill": lambda s, p: agent.investigate(s, p["work_item_id"]),
    "answer_why": lambda s, p: agent.answer_why(s, p["work_item_id"], p["message_id"]),
    "prepare_override_payment": lambda s, p: agent.prepare_override(s, p["work_item_id"], p.get("note", "")),
    "compromised_agent_demo": lambda s, p: agent.compromised_agent_demo(s, p["work_item_id"]),
    "resume_work_item": lambda s, p: agent.run_scripted(s, p["work_item_id"]),
    "pay_proposal": lambda s, p: pay_proposal(s, p["proposal_id"]),
    "scam_submit": _scam,
    "legit_submit": _legit,
    "scorecard_run": _scorecard,
    "reset_demo": _reset,
}


def run_job(store: Store, job: dict[str, Any]) -> bool:
    role = job["assignee_role"]
    claim = R.claim_job(store, role, job["id"])
    if claim.outcome != "ok":
        return False
    try:
        payload = json.loads(job.get("payload_json") or "{}")
        handler = HANDLERS.get(job["kind"])
        if handler is None:
            raise NotImplementedError(f"job kind {job['kind']} isn't implemented yet")
        result = handler(store, payload)
        R.finish_job(store, role, job["id"], True, result if isinstance(result, dict) else {"result": result})
        return True
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        R.finish_job(store, role, job["id"], False, {}, f"{type(e).__name__}: {str(e)[:300]}")
        return False


def drain(store: Store) -> int:
    """Run queued jobs until none are left (single-threaded; used by tests and scripts)."""
    done = 0
    while True:
        jobs = [j for j in store.rows("job", status="queued") if j["assignee_role"] in WORKER_ROLES]
        if not jobs:
            return done
        jobs.sort(key=lambda j: j.get("created_at", 0))
        for job in jobs:
            done += int(run_job(store, job))


def run_forever(store: Store, poll_seconds: float = 1.0, threads: int = 4) -> None:
    in_flight: set[str] = set()
    with ThreadPoolExecutor(max_workers=threads) as pool:
        while True:
            try:
                jobs = [j for j in store.rows("job", status="queued")
                        if j["assignee_role"] in WORKER_ROLES and j["id"] not in in_flight]
                for job in sorted(jobs, key=lambda j: j.get("created_at", 0)):
                    in_flight.add(job["id"])
                    fut = pool.submit(run_job, store, job)
                    fut.add_done_callback(lambda _f, jid=job["id"]: in_flight.discard(jid))
            except Exception:  # noqa: BLE001 - keep polling through network blips
                traceback.print_exc()
            time.sleep(poll_seconds)
