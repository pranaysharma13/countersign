"""The cited "why?" explanation: from the line's own source documents only, citations mapped back to fragment ids,
fixture mode without a model, and never a write to the store."""

import copy
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from countersign import api, intake, live_extract, why, worker
from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.ids import hold_id
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, PO, PURCHASE_ID, QUOTE, REV1_ID, WAITING_1,
                                        WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

PRICE = "ln_bm23104_r1_1"


@pytest.fixture()
def r1(tmp_path):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        intake.ingest(s, doc.filename, file_bytes(doc), files_dir=tmp_path)
        worker.drain(s)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    intake.ingest(s, INVOICE_R1.filename, file_bytes(INVOICE_R1), files_dir=tmp_path)
    worker.drain(s)
    return s


def snapshot(s):
    return copy.deepcopy(s.tables)


class FakeStream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


class FakeClient:
    """Answers like the Messages API with citations: text blocks, each with content_block_location citations."""

    def __init__(self, msg):
        self.msg, self.params = msg, None
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **params):
        self.params = params
        return FakeStream(self.msg)


def cite(doc_index, start, end, text="cited"):
    return SimpleNamespace(type="content_block_location", document_index=doc_index, start_block_index=start,
                           end_block_index=end, cited_text=text, document_title=None)


def message(blocks, stop_reason="end_turn"):
    return SimpleNamespace(content=blocks, stop_reason=stop_reason, model="claude-opus-5-5", stop_details=None)


def test_fixture_mode_explains_from_the_facts_and_cites_the_lines_sources(r1):
    before = snapshot(r1)
    out = why.explain(r1, INVOICE_ID, line_id=PRICE)
    assert out["mode"] == "fixture" and out["label"].startswith("FIXTURE") and out["status"] == "ok"
    assert "$86,000.00" in out["text"] and "$3,500.00" in out["text"]  # numbers from the assessment, not a model
    cited = {fid for seg in out["segments"] for c in seg["citations"] for fid in c["fragment_ids"]}
    assert "frag_bm_inv_23104_r1_p1_l11" in cited and any(f.startswith("frag_bm_quote_") for f in cited)
    assert {s["document_id"] for s in out["sources"]} >= {"doc_bm_inv_23104_r1", "doc_bm_quote"}
    assert snapshot(r1) == before  # read-only


def test_live_mode_sends_the_sources_as_citable_blocks_and_maps_citations_back(r1, monkeypatch):
    monkeypatch.setattr(why, "ai_mode", lambda: "live")
    fake = FakeClient(message([
        SimpleNamespace(type="thinking", thinking=""),
        SimpleNamespace(type="text", text="The quote fixes $165.00 per cubic yard ", citations=[cite(1, 9, 11)]),
        SimpleNamespace(type="text", text="but the invoice bills $172.00.", citations=[cite(0, 10, 11), cite(7, 0, 1)]),
    ]))
    live_extract.set_client(fake)
    try:
        before = snapshot(r1)
        out = why.explain(r1, INVOICE_ID, line_id=PRICE)
    finally:
        live_extract.set_client(None)
    p = fake.params
    assert p["model"] == "claude-opus-5-5" and p["fallbacks"] == "default" and p["betas"] == ["server-side-fallback-2026-07-01"]
    assert "output_config" in p and "format" not in p["output_config"]  # citations can't be combined with strict output
    docs = [b for b in p["messages"][0]["content"] if b["type"] == "document"]
    assert docs and all(d["citations"] == {"enabled": True} and d["source"]["type"] == "content" for d in docs)
    sent = {d["title"]: [b["text"] for b in d["source"]["content"]] for d in docs}
    assert any("$172.00" in t for t in sent["BayMix_Invoice_BM-23104.pdf"])
    # block ranges map to fragment ids of the right document; an index outside our documents is dropped
    quote = next(i for i, d in enumerate(out["sources"]) if d["document_id"] == "doc_bm_quote")
    assert quote == 1
    first, second = out["segments"]
    assert first["citations"][0]["document_id"] == "doc_bm_quote" and len(first["citations"][0]["fragment_ids"]) == 2
    assert [c["document_id"] for c in second["citations"]] == ["doc_bm_inv_23104_r1"]
    assert out["text"] == "The quote fixes $165.00 per cubic yard but the invoice bills $172.00." and out["mode"] == "live"
    assert snapshot(r1) == before


def test_a_refusal_is_reported_not_raised(r1, monkeypatch):
    monkeypatch.setattr(why, "ai_mode", lambda: "live")
    live_extract.set_client(FakeClient(message([], stop_reason="refusal")))
    try:
        out = why.explain(r1, INVOICE_ID, line_id=PRICE)
    finally:
        live_extract.set_client(None)
    assert out["status"] == "unavailable" and out["text"] == "" and "declined" in out["reason"]


def test_a_hold_can_be_explained_and_unknowns_are_404(r1, monkeypatch):
    monkeypatch.setattr(api, "store", r1)
    c = TestClient(api.app)
    r = c.get(f"/invoices/{INVOICE_ID}/why", params={"line": PRICE})
    assert r.status_code == 200 and r.json()["subject"] == {"kind": "line", "id": PRICE, "title": "Ready-mix concrete 4,000 psi, mix BM-40-34"}
    r = c.get(f"/invoices/{INVOICE_ID}/why", params={"hold": hold_id(REV1_ID, "PRICE_VARIANCE")})
    assert r.status_code == 200 and r.json()["subject"]["kind"] == "hold" and r.json()["segments"][0]["citations"]
    assert c.get(f"/invoices/{INVOICE_ID}/why", params={"line": "ln_nope"}).status_code == 404
    assert c.get(f"/invoices/{INVOICE_ID}/why").status_code == 404
    assert c.get("/invoices/inv_nope/why", params={"line": PRICE}).status_code == 404


def test_the_explanation_never_writes(r1):
    calls = []
    real = r1.call
    r1.call = lambda *a, **k: calls.append(a) or real(*a, **k)
    why.explain(r1, INVOICE_ID, line_id=PRICE)
    why.explain(r1, INVOICE_ID, hold_id=hold_id(REV1_ID, "PROPOSED_CHARGE"))
    assert calls == []
    assert json.loads(json.dumps(why.explain(r1, INVOICE_ID, line_id=PRICE)))  # JSON-safe for the route
