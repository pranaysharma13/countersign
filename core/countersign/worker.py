"""Job worker (CONTRACT §4.5, §9.5): poll ready jobs, claim with the assignee's role, do the work, finish.

The worker holds only the agent, gateway and sync tokens. It never holds the owner's key.
A failed job is retried by the module with backoff (10 s, 20 s) up to three attempts; a job whose
worker died is re-claimed once its 5-minute lease expires. Handlers are idempotent (caller-chosen
ids), so running one twice never duplicates anything.
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
from . import sandbox, supplier_gateway
from . import supplier_pipeline as v2
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
    # v2 (CONTRACT §9.5)
    "process_document": lambda s, p: v2.process_document(s, p["document_id"]),
    "reassess_invoice": lambda s, p: v2.reassess(s, p["invoice_id"], force=True),
    "send_outbox": lambda s, p: v2.send_outbox(s, p["outbox_id"]),
    "pay_supplier": lambda s, p: supplier_gateway.pay_supplier(s, p["proposal_id"]),
    "sneak_charge": lambda s, p: sandbox.sneak(s, p),
}


MAX_ATTEMPTS = 3  # the module's limit (CONTRACT §9.5 retries)

# When a job runs out of retries: never leave it silently failed; put the work in front of a person.
ON_GIVE_UP: dict[str, Callable[[Store, dict[str, Any], str], None]] = {
    "process_document": lambda s, p, err: v2.give_up_document(s, p["document_id"], err),
}


def _now_ms(store: Store) -> int:
    clock = getattr(store, "now_ms", None)  # the fake store's movable clock; otherwise wall time
    return clock() if callable(clock) else time.time_ns() // 1_000_000


def _due(text: str, now_ms: int) -> bool:
    from datetime import datetime

    return not text or int(datetime.fromisoformat(text).timestamp() * 1000) <= now_ms


def ready_jobs(store: Store) -> list[dict[str, Any]]:
    """Queued jobs past their backoff, and claimed jobs whose lease expired (their worker died)."""
    now = _now_ms(store)
    jobs = [j for j in store.rows("job", status="queued") if _due(j.get("next_attempt_at_iso", ""), now)]
    jobs += [j for j in store.rows("job", status="claimed") if j.get("lease_expires_at_iso") and _due(j["lease_expires_at_iso"], now)]
    return sorted((j for j in jobs if j["assignee_role"] in WORKER_ROLES), key=lambda j: (j.get("created_at", 0), j["id"]))


def run_job(store: Store, job: dict[str, Any]) -> bool | None:
    """None if the claim was refused; otherwise whether the job finished ok."""
    role = job["assignee_role"]
    claim = R.claim_job(store, role, job["id"])
    if claim.outcome != "ok":
        return None
    payload: dict[str, Any] = {}
    try:
        payload = json.loads(job.get("payload_json") or "{}")
        payload["_job_id"] = job["id"]
        handler = HANDLERS.get(job["kind"])
        if handler is None:
            raise NotImplementedError(f"job kind {job['kind']} isn't implemented yet")
        result = handler(store, payload)
        R.finish_job(store, role, job["id"], True, result if isinstance(result, dict) else {"result": result})
        return True
    except Exception as e:  # noqa: BLE001
        if not isinstance(e, v2.NotYet):
            traceback.print_exc()
        error = f"{type(e).__name__}: {str(e)[:300]}"
        if int(job.get("attempts", 0)) + 1 >= MAX_ATTEMPTS and job["kind"] in ON_GIVE_UP:
            try:
                ON_GIVE_UP[job["kind"]](store, payload, error)
            except Exception:  # noqa: BLE001 - the job still finishes as failed
                traceback.print_exc()
        R.finish_job(store, role, job["id"], False, {}, error)
        return False


def drain(store: Store, max_rounds: int = 200) -> int:
    """Run ready jobs until a round claims nothing (single-threaded; used by tests and scripts).
    Jobs waiting out a backoff or a lease are left for later."""
    done = 0
    for _ in range(max_rounds):
        outcomes = [run_job(store, job) for job in ready_jobs(store)]
        done += sum(1 for o in outcomes if o)
        reassessed = v2.reassess_stale(store)
        if all(o is None for o in outcomes) and not reassessed:
            return done
    return done


def run_forever(store: Store, poll_seconds: float = 1.0, threads: int = 4, reassess_every: float = 5.0) -> None:
    in_flight: set[str] = set()
    last_sweep = 0.0
    with ThreadPoolExecutor(max_workers=threads) as pool:
        while True:
            try:
                jobs = [j for j in ready_jobs(store) if j["id"] not in in_flight]
                for job in jobs:
                    in_flight.add(job["id"])
                    fut = pool.submit(run_job, store, job)
                    fut.add_done_callback(lambda _f, jid=job["id"]: in_flight.discard(jid))
                if not in_flight and time.monotonic() - last_sweep >= reassess_every:
                    v2.reassess_stale(store)  # receipt attested, change approved, new email... -> reassess
                    last_sweep = time.monotonic()
            except Exception:  # noqa: BLE001 - keep polling through network blips
                traceback.print_exc()
            time.sleep(poll_seconds)
