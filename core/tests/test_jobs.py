"""Job bus rules (CONTRACT §9.5): attempts, backoff, leases, worker restart; outbox approval."""

import pytest

from countersign import reducers as R
from countersign import worker
from countersign.fake_store import FakeStore
from countersign.supplier_world import INVOICE_ID


@pytest.fixture()
def store():
    return FakeStore()


def job(store, job_id="job_scan"):
    return store.rows("job", id=job_id)[0]


def test_a_failing_job_backs_off_then_stays_failed(store, monkeypatch):
    calls = []
    monkeypatch.setitem(worker.HANDLERS, "due_scan", lambda s, p: calls.append(1) or 1 / 0)
    assert R.enqueue_job(store, "sync", "job_scan", "due_scan", {}).ok
    worker.drain(store)
    j = job(store)
    assert (j["status"], j["attempts"], len(calls)) == ("queued", 1, 1) and "ZeroDivisionError" in j["error"]
    assert R.claim_job(store, "sync", "job_scan").outcome == "denied"  # still in backoff
    worker.drain(store)
    assert len(calls) == 1  # drain doesn't spin on a job that isn't due
    store.advance(10)
    worker.drain(store)
    assert (job(store)["status"], job(store)["attempts"]) == ("queued", 2)
    store.advance(19)
    worker.drain(store)
    assert job(store)["attempts"] == 2  # 20 s backoff the second time
    store.advance(1)
    worker.drain(store)
    assert (job(store)["status"], job(store)["attempts"], len(calls)) == ("failed", 3, 3)


def test_a_flaky_job_succeeds_on_retry(store, monkeypatch):
    calls = []
    monkeypatch.setitem(worker.HANDLERS, "due_scan", lambda s, p: {"n": len(calls)} if calls.append(1) or len(calls) > 1 else 1 / 0)
    assert R.enqueue_job(store, "sync", "job_scan", "due_scan", {}).ok
    worker.drain(store)
    store.advance(10)
    worker.drain(store)
    assert (job(store)["status"], job(store)["attempts"]) == ("done", 2)


def test_a_dead_workers_job_is_reclaimed_after_its_lease(store, monkeypatch):
    monkeypatch.setitem(worker.HANDLERS, "due_scan", lambda s, p: {"ok": True})
    assert R.enqueue_job(store, "sync", "job_scan", "due_scan", {}).ok
    assert R.claim_job(store, "sync", "job_scan").ok  # ...and the worker crashes before finishing
    worker.drain(store)
    assert job(store)["status"] == "claimed"  # lease still running
    store.advance(5 * 60 + 1)
    worker.drain(store)
    assert (job(store)["status"], job(store)["attempts"]) == ("done", 2)
    assert any(a["reason"] == "re-claimed after lease expired" for a in store.rows("audit_log", action="claim_job"))


def test_only_the_assignee_claims_and_only_the_claimer_finishes(store):
    assert R.enqueue_job(store, "sync", "job_scan", "due_scan", {}).ok
    assert R.claim_job(store, "agent", "job_scan").outcome == "denied"
    assert R.claim_job(store, "sync", "job_scan").ok
    assert R.finish_job(store, "agent", "job_scan", True).outcome == "denied"
    assert R.enqueue_job(store, "agent", "job_send_x", "send_outbox", {"outbox_id": "x"}).outcome == "denied"  # module-only kind
    assert R.enqueue_job(store, "sync", "job_doc", "process_document", {"document_id": "d"}).ok
    assert job(store, "job_doc")["assignee_role"] == "agent"


def test_outbox_needs_a_person_to_approve_and_is_marked_once(store):
    from test_supplier_commercial import build

    from countersign.clarify import record_draft
    from countersign.commercial import assess, bundle_from_store

    s = build()
    b = bundle_from_store(s, INVOICE_ID)
    ob = record_draft(s, b, assess(b))
    assert s.rows("invoice", id=INVOICE_ID)[0]["next_owner_role"] == "purchasing"
    assert R.approve_outbox(s, "agent", ob).outcome == "denied"
    assert R.mark_outbox(s, ob, "sent", "x").outcome == "denied"  # not approved yet
    assert R.approve_outbox(s, "purchasing", ob).ok
    assert R.approve_outbox(s, "owner", ob).outcome == "invalid"  # already approved
    assert s.rows("job", id=f"job_send_{ob}")[0]["kind"] == "send_outbox"
    assert s.rows("invoice", id=INVOICE_ID)[0]["next_action"] == "Waiting for the supplier to reply"
    assert R.mark_outbox(s, ob, "sent", "simulated-1").ok
    assert R.mark_outbox(s, ob, "sent", "simulated-2").outcome == "denied"
