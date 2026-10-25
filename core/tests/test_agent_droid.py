"""The v1 Droid agent's stream events and fallback, without the droid CLI. A failed Droid run is reported
with Droid's own error, never as a run that chose to file nothing."""

from datetime import UTC, datetime, timedelta

import pytest
from droid_sdk import AssistantMessage, ErrorEvent, ErrorType, RunFailure, ToolCall

from countersign import agent, pipeline
from countersign.fake_store import FakeStore
from countersign.integrations import nessie
from countersign.pipeline import AgentTools, ingest, load_seed
from countersign.supplier_agent import DroidFailed
from countersign.worker import drain
from countersign.world import build_world

NOW = datetime.now(UTC)


@pytest.fixture()
def bill(tmp_path, monkeypatch):
    """One v1 bill received and queued (process_bill), not yet investigated."""
    monkeypatch.setattr(pipeline, "FILES_DIR", tmp_path)
    nessie.set_client(nessie.MockNessie())
    store, world = FakeStore(), build_world()
    load_seed(store, world, owner=store)
    doc = world.current[0]
    ingest(store, world, doc, "upload")
    yield store, f"wi_{doc.id}"
    nessie.set_client(None)


def failure():
    return RunFailure(subtype="error_during_execution", text="", messages=(), usage=None, duration=timedelta(0),
                      turn_count=0, session_id="s")


def steps(store, wi_id):
    return store.rows("agent_step", work_item_id=wi_id)


def test_events_go_on_the_timeline_and_a_failed_run_raises_with_droids_message(bill):
    store, wi_id = bill
    t, done, errors = AgentTools(store, wi_id), {}, []
    agent._on_event(t, AssistantMessage(id="m1", content=(), text="Reading the bill first.", created_at=NOW, updated_at=NOW),
                    done, errors)
    for n in (1, 2):
        agent._on_event(t, ToolCall(name="countersign__run_check", tool_use_id=f"tu{n}", input={"code": "math"}), done, errors)
    assert [(s["kind"], s["title"]) for s in steps(store, wi_id)][-3:] == [
        ("thought", "Reading the bill first."), ("tool_call", "run_check"), ("tool_call", "run_check")]
    assert store.rows("work_item", id=wi_id)[0]["state"] == "investigating"

    agent._on_event(t, ErrorEvent(message="No access token available", error_type=ErrorType.ERROR, timestamp=NOW), done, errors)
    with pytest.raises(DroidFailed, match="No access token available"):
        agent._on_event(t, failure(), done, errors)
    with pytest.raises(DroidFailed, match="error_during_execution"):  # no message: the failure's own subtype
        agent._on_event(t, failure(), {}, [])


def test_a_failed_droid_run_falls_back_visibly_with_the_real_error(bill, monkeypatch):
    store, wi_id = bill
    monkeypatch.setenv("AGENT_MODE", "droid")

    def no_token(s, w):
        raise DroidFailed("No access token available")

    monkeypatch.setattr(agent, "run_droid", no_token)
    drain(store)
    fallback = [s for s in steps(store, wi_id) if s["kind"] == "error"]
    assert [s["title"] for s in fallback] == ["Droid unavailable (DroidFailed); scripted agent takes over"]
    assert "No access token available" in fallback[0]["detail_json"]
    assert not any("ended without filing" in s["title"] for s in steps(store, wi_id))
    assert store.rows("proposal", work_item_id=wi_id)  # the scripted rules still filed one
