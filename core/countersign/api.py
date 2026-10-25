"""Small HTTP API on the demo laptop (port 8000): upload a bill PDF, take in a received email (`POST /intake`), preview
stored files, export an invoice's audit.

Everything else goes through SpacetimeDB. Run: uv run --project core uvicorn countersign.api:app --port 8000
"""

from __future__ import annotations

import base64
import binascii
import json
from pathlib import Path
from typing import Literal

import anthropic
import httpx

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field

from . import audit_export, intake, why
from . import reducers as R
from .config import FILES_DIR
from .ids import sha8, sha256_hex
from .store import StoreError, get_store, one
from .supplier_docs import file_bytes
from .companion_world import COMPANION_DOCS
from .sandbox import SANDBOX_DOCS
from .supplier_world import PRIMARY_DOCS, VARIANT_DOCS

ALL_DOCS = PRIMARY_DOCS + COMPANION_DOCS + SANDBOX_DOCS + VARIANT_DOCS

app = FastAPI(title="Clerk core")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"],
                   allow_methods=["GET", "POST"], allow_headers=["*"])
store = get_store()


def _seed_doc(source_file_id: str, filename: str = "") -> object | None:
    """Seed PDFs resolve without a live store row. Store lookup is a fallback only."""
    if filename:
        found = next((d for d in ALL_DOCS if d.filename == filename), None)
        if found:
            return found
    found = next((d for d in ALL_DOCS if d.id == source_file_id), None)
    if found:
        return found
    try:
        linked = next((d for d in store.rows("document") if d.get("source_file_id") == source_file_id), None)
    except Exception:
        linked = None
    if not linked:
        return None
    return next((d for d in ALL_DOCS if d.id == linked["id"] or d.filename == linked.get("filename")), None)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    try:
        rows = [(s["id"], s.get("filename") or s["id"]) for s in store.rows("source_file")]
    except Exception:
        rows = []
    seen = {name for _, name in rows}
    for d in ALL_DOCS:
        if d.filename not in seen:
            rows.append((d.id, d.filename))
            seen.add(d.filename)
    items = "".join(
        f'<li><a href="/files/{sid}">{name}</a> <span style="color:#666">{sid}</span></li>'
        for sid, name in rows
    )
    return (
        "<!doctype html><meta charset=utf-8><title>Clerk files</title>"
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


class MailIn(BaseModel):
    source: Literal["gmail"]
    message_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    raw_base64url: str = Field(max_length=56 * 1024 * 1024)  # 40 MB decoded
    received_at_iso: str = Field("", max_length=40)


@app.post("/intake")
def intake_mail(mail: MailIn, x_countersign_intake: str = Header("")) -> dict:
    """One received email (Gmail's `format=raw`), sent by the web server when a person presses Import. Recorded as
    the sync role: the body becomes one document, each PDF attachment another, and each is queued for reading.
    Mail is data: nothing in it is followed or fetched. Sending the same message again records nothing new.

    The `X-Countersign-Intake` header can't be sent cross-site without a CORS preflight, which only the web app's
    origin passes, so another page in the browser can't post mail here."""
    if x_countersign_intake != "1":
        raise HTTPException(403, "missing X-Countersign-Intake header")
    try:
        raw = base64.urlsafe_b64decode(mail.raw_base64url + "=" * (-len(mail.raw_base64url) % 4))
    except (binascii.Error, ValueError):
        raise HTTPException(400, "the message isn't valid base64url") from None
    try:
        result = intake.ingest_mail(store, raw, {"source": mail.source, f"{mail.source}_message_id": mail.message_id},
                                    mail.received_at_iso, files_dir=FILES_DIR)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except (StoreError, httpx.HTTPError) as e:
        raise HTTPException(503, f"Couldn't reach SpacetimeDB to record the email ({type(e).__name__})") from None
    except RuntimeError as e:  # the module refused a record
        raise HTTPException(502, str(e)) from None
    return {"source": mail.source, "message_id": mail.message_id, **result}


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
    src = None
    try:
        src = one(store, "source_file", id=source_file_id)
    except Exception:
        src = None
    path = _stored_path((src or {}).get("storage_path") or "")
    if path is not None:
        return FileResponse(path, media_type=_MEDIA[path.suffix.lower()])
    doc = _seed_doc(source_file_id, (src or {}).get("filename") or "")
    if doc is None:
        raise HTTPException(404, "unknown file" if src is None else "file not available")
    data = file_bytes(doc)
    media = "message/rfc822" if doc.email else "application/pdf"
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'inline; filename="{doc.filename}"'})


@app.get("/invoices/{invoice_id}/audit", response_model=None)
def invoice_audit(invoice_id: str, fmt: str = Query("json", alias="format", pattern="^(json|csv)$")):
    """Everything recorded about one invoice, oldest first, denials included. Read-only."""
    try:
        export = audit_export.invoice_audit(store, invoice_id)
    except audit_export.UnknownInvoice:
        raise HTTPException(404, "unknown invoice") from None
    if fmt == "csv":
        return Response(content=audit_export.to_csv(export), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="audit_{invoice_id}.csv"'})
    return export


@app.get("/invoices/{invoice_id}/why", response_model=None)
def invoice_why(invoice_id: str, line: str = "", hold: str = ""):
    """A cited explanation of one line or one hold, from its own source documents. Read-only: it can't change
    amounts, holds or approvals."""
    try:
        return why.explain(store, invoice_id, line_id=line, hold_id=hold)
    except why.NotFound as e:
        raise HTTPException(404, str(e)) from None
    except anthropic.APIError as e:
        raise HTTPException(502, f"Couldn't get an explanation from Claude right now ({type(e).__name__})") from None
