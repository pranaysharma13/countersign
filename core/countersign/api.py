"""Small HTTP API on the demo laptop (port 8000): upload a bill PDF, preview stored files.

Everything else goes through SpacetimeDB. Run: uv run --project core uvicorn countersign.api:app --port 8000
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response

from . import reducers as R
from .config import FILES_DIR
from .ids import sha8, sha256_hex
from .store import get_store, one
from .supplier_docs import file_bytes
from .companion_world import COMPANION_DOCS
from .supplier_world import PRIMARY_DOCS

ALL_DOCS = PRIMARY_DOCS + COMPANION_DOCS

app = FastAPI(title="Countersign core")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"],
                   allow_methods=["GET", "POST"], allow_headers=["*"])
store = get_store()


def _seed_doc(source_file_id: str, filename: str = "") -> object | None:
    if filename:
        found = next((d for d in ALL_DOCS if d.filename == filename), None)
        if found:
            return found
    linked = next((d for d in store.rows("document") if d.get("source_file_id") == source_file_id), None)
    if linked:
        return next((d for d in ALL_DOCS if d.id == linked["id"]), None)
    return next((d for d in ALL_DOCS if d.id == source_file_id), None)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    rows = [(s["id"], s.get("filename") or s["id"]) for s in store.rows("source_file")]
    if not rows:
        rows = [(d.id, d.filename) for d in ALL_DOCS]
    items = "".join(
        f'<li><a href="/files/{sid}">{name}</a> <span style="color:#666">{sid}</span></li>'
        for sid, name in rows
    )
    return (
        "<!doctype html><meta charset=utf-8><title>Countersign files</title>"
        "<body style='font:16px system-ui;max-width:40rem;margin:2rem'>"
        "<h1>Source files</h1><p>Open a document, or use these links from the invoice.</p>"
        f"<ul>{items}</ul></body>"
    )


@app.get("/health")
def health() -> dict[str, str]:
    from .config import settings
    return {
        "status": "ok",
        "ai_mode": settings.ai_mode,
        "mocks": "on" if settings.use_mocks else "off",
        "nessie": "configured" if settings.nessie_api_key else "missing",
        "crs": "configured" if settings.crs_username else "missing",
        "apify": "configured" if settings.apify_token else "missing",
        "claude": "configured" if settings.anthropic_api_key else "missing",
    }


@app.post("/upload")
async def upload(file: UploadFile = File(...), from_address: str = Form(""), subject: str = Form(""), body: str = Form("")) -> dict:
    data = await file.read()
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "PDF files only")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "PDF too large")
    src_id = f"src_{sha8(data)}"
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    path = FILES_DIR / f"{src_id}.pdf"
    path.write_bytes(data)
    path.with_suffix(".email.json").write_text(json.dumps({"from": from_address, "subject": subject, "body": body}))
    R.record_source_file(store, src_id, "upload", Path(file.filename or "bill.pdf").name, sha256_hex(data),
                         "", from_address, subject, str(path))
    bill_id = f"bill_up_{sha8(data)}"
    R.record_bill(store, "sync", bill_id, "", "", src_id, "", "", "", "", 0, 0, "", "", "", from_address, False,
                  {"status": "awaiting_extraction"})
    wi_id = f"wi_{bill_id}"
    R.create_work_item(store, "sync", wi_id, "bill", bill_id, "upload", subject or (file.filename or "Uploaded bill"))
    R.enqueue_job(store, "sync", f"job_bill_{bill_id}", "process_bill", {"work_item_id": wi_id})
    return {"work_item_id": wi_id, "source_file_id": src_id}


_MEDIA = {".pdf": "application/pdf", ".eml": "message/rfc822"}


def _stored_path(storage: str) -> Path | None:
    """A stored file we may serve: a PDF or .eml inside FILES_DIR. Anything else is never read."""
    if not storage:
        return None
    path = Path(storage).resolve()
    if not path.is_relative_to(FILES_DIR.resolve()) or path.suffix.lower() not in _MEDIA or not path.is_file():
        return None
    return path


@app.get("/files/{source_file_id}", response_model=None)
def get_file(source_file_id: str):
    src = one(store, "source_file", id=source_file_id)
    path = _stored_path((src or {}).get("storage_path") or "")
    if path is not None:
        return FileResponse(path, media_type=_MEDIA[path.suffix.lower()])
    doc = _seed_doc(source_file_id, (src or {}).get("filename") or "")
    if doc is None:
        raise HTTPException(404, "unknown file" if src is None else "file not available")
    data = file_bytes(doc)
    media = "message/rfc822" if doc.email else "application/pdf"
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'inline; filename="{doc.filename}"'})
