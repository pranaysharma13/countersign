"""Small HTTP API on the demo laptop (port 8000): upload a bill PDF, preview stored files.

Everything else goes through SpacetimeDB. Run: uv run --project core uvicorn countersign.api:app --port 8000
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import reducers as R
from .config import FILES_DIR
from .ids import sha8, sha256_hex
from .store import get_store, one

app = FastAPI(title="Countersign core")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"],
                   allow_methods=["GET", "POST"], allow_headers=["*"])
store = get_store()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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


@app.get("/files/{source_file_id}")
def get_file(source_file_id: str) -> FileResponse:
    src = one(store, "source_file", id=source_file_id)
    if src is None:
        raise HTTPException(404, "unknown file")
    path = Path(src["storage_path"]).resolve()
    if FILES_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404, "file not available")
    return FileResponse(path, media_type="application/pdf")
