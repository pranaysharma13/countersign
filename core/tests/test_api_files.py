"""GET /files/{id}: serve stored files only from FILES_DIR; seed documents as a fallback; 404 otherwise."""

import pytest
from fastapi.testclient import TestClient

from countersign import api
from countersign import reducers as R
from countersign.fake_store import FakeStore
from countersign.companion_world import VS_INVOICE
from countersign.supplier_world import PRIMARY_DOCS


@pytest.fixture()
def client(tmp_path, monkeypatch):
    s = FakeStore()
    monkeypatch.setattr(api, "store", s)
    monkeypatch.setattr(api, "FILES_DIR", tmp_path / "files")
    (tmp_path / "files").mkdir()
    return s, tmp_path, TestClient(api.app)


def row(s, src_id, storage, filename="x.pdf"):
    assert R.record_source_file(s, src_id, "upload", filename, "0" * 64, "", "", "", str(storage)).ok


@pytest.mark.parametrize("target", ["env", "passwd", "traversal"])
def test_paths_outside_files_dir_are_404(client, target):
    s, tmp, c = client
    (tmp / ".env").write_text("ANTHROPIC_API_KEY=secret")
    storage = {"env": tmp / ".env", "passwd": "/etc/passwd", "traversal": tmp / "files" / ".." / ".env"}[target]
    row(s, "src_evil", storage)
    r = c.get("/files/src_evil")
    assert r.status_code == 404
    assert b"secret" not in r.content and b"root:" not in r.content


def test_non_document_inside_files_dir_is_404(client):
    s, tmp, c = client
    (tmp / "files" / "notes.json").write_text("{}")
    row(s, "src_json", tmp / "files" / "notes.json")
    assert c.get("/files/src_json").status_code == 404


def test_stored_pdf_and_eml_inside_files_dir(client):
    s, tmp, c = client
    (tmp / "files" / "a.pdf").write_bytes(b"%PDF-1.4 test")
    (tmp / "files" / "b.eml").write_bytes(b"Subject: hi\n\nbody")
    row(s, "src_pdf", tmp / "files" / "a.pdf")
    row(s, "src_eml", tmp / "files" / "b.eml", "b.eml")
    r = c.get("/files/src_pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF")
    r = c.get("/files/src_eml")
    assert r.status_code == 200 and r.headers["content-type"].startswith("message/rfc822")


def test_seed_fallback_when_storage_is_empty(client):
    c = client[2]
    eml = next(d for d in PRIMARY_DOCS if d.email)
    pdf = next(d for d in PRIMARY_DOCS if not d.email)
    assert c.get(f"/files/{eml.id}").headers["content-type"].startswith("message/rfc822")
    assert c.get(f"/files/{pdf.id}").headers["content-type"] == "application/pdf"


def test_unknown_id_is_404(client):
    assert client[2].get("/files/src_nope").status_code == 404


def test_companion_seed_pdf_by_document_id(client):
    r = client[2].get(f"/files/{VS_INVOICE.id}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF")
