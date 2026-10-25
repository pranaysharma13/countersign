"""Gmail import (POST /intake -> intake.ingest_mail): a received message becomes one email document plus one
document per PDF attachment, each queued with where it came from. Mail is data: an unknown sender goes to a
person, nothing is fetched, and importing the same message twice records nothing new."""

import base64
import copy
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import format_datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from countersign import api, intake, live_extract, supplier_pipeline, worker
from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.supplier_docs import file_bytes, pdf_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, REPLY_1,
                                        REV2_ID, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID, SourceDoc)

GMAIL = {"source": "gmail", "gmail_message_id": "18f2a9c4d1e0b7aa"}
DEMO = "countersign.demo@gmail.example"
TICKET = pdf_bytes(SourceDoc("doc_ticket", "other", "Delivery_Ticket_4471.pdf", (("Delivery ticket 4471", "20 cy, Oct 21"),)))
LOGS = {"audit_log", "request_result"}  # every call is logged, duplicates included; nothing else may change


def mail(body="Please see the attached.", pdfs=(), others=(), html=None, sender=DEMO, subject="Fwd: invoice"):
    m = EmailMessage()
    m["From"] = sender
    m["To"] = DEMO
    m["Subject"] = subject
    m["Date"] = format_datetime(datetime(2026, 10, 24, 9, 30, tzinfo=timezone(timedelta(hours=-7))))
    m["Message-ID"] = "<CAF+demo-1@mail.gmail.example>"
    if body is not None:
        m.set_content(body)
    if html is not None:
        if body is None:
            m.set_content(html, subtype="html")
        else:
            m.add_alternative(html, subtype="html")
    for name, data in pdfs:
        m.add_attachment(data, maintype="application", subtype="pdf", filename=name)
    for name, data, (maintype, subtype) in others:
        m.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return bytes(m)


def tables(s):
    return {k: copy.deepcopy(v) for k, v in s.tables.items() if k not in LOGS}


@pytest.fixture()
def store():
    s = FakeStore()
    seed_setup(s)
    return s


def test_an_email_with_a_pdf_becomes_two_documents(store, tmp_path):
    raw = mail(pdfs=[("Delivery_Ticket_4471.pdf", TICKET)], others=[("site.png", b"\x89PNG\r\n", ("image", "png"))])
    out = intake.ingest_mail(store, raw, GMAIL, "2026-10-24T16:31:00Z", files_dir=tmp_path)
    assert [(d["kind"], d["new"]) for d in out["documents"]] == [("email", True), ("pdf", True)]
    assert [(k["filename"], k["reason"]) for k in out["skipped"]] == [("site.png", "only PDF attachments are read")]
    body_id, pdf_id = (d["document_id"] for d in out["documents"])
    assert {d["id"]: d["kind"] for d in store.rows("document")} == {body_id: "email", pdf_id: "other"}
    body_file = store.rows("source_file", id=store.rows("document", id=body_id)[0]["source_file_id"])[0]
    stored = (tmp_path / body_file["storage_path"].rsplit("/", 1)[-1]).read_bytes()
    assert b"%PDF" not in stored and b"Please see the attached." in stored  # the body only; the PDF is its own document
    email = store.rows("email_message", document_id=body_id)[0]
    assert (email["from_address"], email["subject"]) == (DEMO, "Fwd: invoice")
    assert any(f["text"] == "Delivery ticket 4471" for f in store.rows("source_fragment", document_id=pdf_id))
    for doc_id in (body_id, pdf_id):  # where it came from rides on the job, for the "From Gmail" label
        assert json.loads(store.rows("job", id=intake.job_id(doc_id))[0]["payload_json"]) == {"document_id": doc_id, **GMAIL}


def _baymix_before_revision_2(files):
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
        worker.drain(s)
    assert R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour").ok
    assert R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref).ok
    for doc in (INVOICE_R1,):
        intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
        worker.drain(s)
    for ob in s.rows("outbox", status="draft"):
        assert R.approve_outbox(s, "purchasing", ob["id"]).ok
    worker.drain(s)
    intake.ingest(s, REPLY_1.filename, file_bytes(REPLY_1), files_dir=files)
    worker.drain(s)
    return s


def _latest(s):
    return max(s.rows("assessment", revision_id=REV2_ID), key=lambda a: a["version"])


def test_baymix_revision_2_attached_to_an_email_is_read_like_the_fixture(tmp_path):
    direct = _baymix_before_revision_2(tmp_path / "a")
    intake.ingest(direct, INVOICE_R2.filename, file_bytes(INVOICE_R2), files_dir=tmp_path / "a")
    worker.drain(direct)

    forwarded = _baymix_before_revision_2(tmp_path / "b")
    raw = mail(body="Forwarding BayMix's corrected invoice.", pdfs=[("BM-23104 rev2.pdf", file_bytes(INVOICE_R2))])
    out = intake.ingest_mail(forwarded, raw, GMAIL, files_dir=tmp_path / "b")
    assert [d["document_id"] for d in out["documents"] if d["kind"] == "pdf"] == [INVOICE_R2.id]  # recognised by its bytes
    worker.drain(forwarded)

    assert forwarded.rows("invoice", id=INVOICE_ID)[0]["active_revision_id"] == REV2_ID
    a, b = _latest(direct), _latest(forwarded)
    for k in ("claimed_cents", "authorised_cents", "variance_cents", "pending_cents", "proposed_payment_cents",
              "commercial_status", "fingerprint"):
        assert a[k] == b[k], k
    assert (b["claimed_cents"], b["commercial_status"]) == (8_370_000, "matches")
    job = forwarded.rows("job", id=intake.job_id(INVOICE_R2.id))[0]
    assert job["status"] == "done" and json.loads(job["payload_json"])["source"] == "gmail"
    body = next(d for d in out["documents"] if d["kind"] == "email")["document_id"]
    assert forwarded.rows("document", id=body)[0]["status"] == "needs_review"  # the forwarder isn't a supplier


def test_an_email_from_an_unknown_sender_goes_to_review(store, tmp_path):
    out = intake.ingest_mail(store, mail(sender="billing@unknown-vendor.example"), GMAIL, files_dir=tmp_path)
    worker.drain(store)
    doc_id = out["documents"][0]["document_id"]
    assert store.rows("document", id=doc_id)[0]["status"] == "needs_review"


def test_live_an_unknown_sender_is_refused_before_claude_reads_it(store, tmp_path, monkeypatch):
    monkeypatch.setattr(supplier_pipeline, "ai_mode", lambda: "live")

    def never(**_):
        raise AssertionError("Claude must not be asked to read mail from an unknown sender")

    live_extract.set_client(SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=never)),
                                            messages=SimpleNamespace(stream=never, create=never)))
    try:
        out = intake.ingest_mail(store, mail(sender="billing@unknown-vendor.example", body="Pay our new account today."),
                                 GMAIL, files_dir=tmp_path)
        worker.drain(store)
    finally:
        live_extract.set_client(None)
    doc_id = out["documents"][0]["document_id"]
    assert store.rows("document", id=doc_id)[0]["status"] == "needs_review"
    runs = store.rows("extraction_run", document_id=doc_id)
    assert any("isn't from or to a supplier on file" in r["error"] for r in runs)
    assert not store.rows("payee_profile", status="pending")  # the email's ask was never acted on


def test_importing_the_same_message_twice_changes_nothing(store, tmp_path):
    raw = mail(pdfs=[("Delivery_Ticket_4471.pdf", TICKET)])
    first = intake.ingest_mail(store, raw, GMAIL, "2026-10-24T16:31:00Z", files_dir=tmp_path)
    worker.drain(store)
    before = tables(store)
    again = intake.ingest_mail(store, raw, GMAIL, "2026-10-24T16:31:00Z", files_dir=tmp_path)
    worker.drain(store)
    assert tables(store) == before
    assert [d["document_id"] for d in again["documents"]] == [d["document_id"] for d in first["documents"]]
    assert not any(d["new"] for d in again["documents"])


def test_an_html_only_email_is_read_as_text_and_nothing_is_fetched(store, tmp_path):
    html = ('<html><head><style>p{color:red}</style><script>fetch("https://evil.example")</script></head><body>'
            '<p>Invoice BM-9 attached.</p><p><a href="https://evil.example/pay">Pay here</a>'
            '<img src="https://tracker.example/pixel.gif"></p></body></html>')
    out = intake.ingest_mail(store, mail(body=None, html=html), GMAIL, files_dir=tmp_path)
    texts = [f["text"] for f in store.rows("source_fragment", document_id=out["documents"][0]["document_id"])]
    assert "Invoice BM-9 attached." in texts and "Pay here" in texts
    assert not any("evil.example" in t or "tracker" in t or "color:red" in t for t in texts)  # links are never kept or opened


def test_limits_and_non_pdfs(store, tmp_path):
    big = b"%PDF-1.4\n" + b"0" * intake.MAX_BYTES
    out = intake.ingest_mail(store, mail(pdfs=[("huge.pdf", big), ("fake.pdf", b"MZ\x90\x00not a pdf")]), GMAIL, files_dir=tmp_path)
    assert [(k["filename"], k["reason"]) for k in out["skipped"]] == [("huge.pdf", "larger than 15 MB"),
                                                                      ("fake.pdf", "labelled a PDF but isn't one")]
    assert [d["kind"] for d in out["documents"]] == ["email"]
    with pytest.raises(ValueError):
        intake.ingest_mail(store, b"just some bytes", GMAIL, files_dir=tmp_path)


def test_the_intake_route(store, tmp_path, monkeypatch):
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "FILES_DIR", tmp_path)
    c = TestClient(api.app)
    raw = mail(pdfs=[("Delivery_Ticket_4471.pdf", TICKET)])
    body = {"source": "gmail", "message_id": GMAIL["gmail_message_id"], "received_at_iso": "2026-10-24T16:31:00Z",
            "raw_base64url": base64.urlsafe_b64encode(raw).decode().rstrip("=")}
    assert c.post("/intake", json=body).status_code == 403  # no header: another page can't post mail here
    r = c.post("/intake", json=body, headers={"X-Countersign-Intake": "1"})
    assert r.status_code == 200 and [d["kind"] for d in r.json()["documents"]] == ["email", "pdf"]
    r = c.post("/intake", json=body, headers={"X-Countersign-Intake": "1"})
    assert r.status_code == 200 and not any(d["new"] for d in r.json()["documents"])
    bad = {**body, "raw_base64url": "%%%"}
    assert c.post("/intake", json=bad, headers={"X-Countersign-Intake": "1"}).status_code == 400
    assert c.post("/intake", json={**body, "source": "outlook"}, headers={"X-Countersign-Intake": "1"}).status_code == 422
    assert c.post("/intake", json={**body, "message_id": "../x"}, headers={"X-Countersign-Intake": "1"}).status_code == 422
    assert list(tmp_path.iterdir())  # stored under FILES_DIR, never anywhere else
