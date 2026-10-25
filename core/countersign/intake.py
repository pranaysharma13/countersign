"""Intake (sync role): record a received file and queue it for the agent.

The original bytes and SHA-256 are kept, and the document id comes from the bytes, so receiving the
same file twice records nothing new and queues no second job. Known fixture documents keep their
fixture ids and fragments, so labelled extractions line up. Any other PDF or email is cut into one
immutable fragment per text line; in fixture mode it then goes to review (there's no labelled
extraction for it, and nothing is guessed). Emails are parsed as plain text only: no remote content,
no attachments executed.
"""

from __future__ import annotations

import re
from email import message_from_bytes, policy
from email.utils import parsedate_to_datetime
from functools import lru_cache
from io import BytesIO
from pathlib import Path

from . import reducers as R
from .config import FILES_DIR
from .ids import sha8, sha256_hex
from .store import Result, Store
from .supplier_docs import file_bytes
from .supplier_seed import seed_document
from .companion_world import COMPANION_DOCS
from .supplier_world import PRIMARY_DOCS, SourceDoc

ALL_DOCS = PRIMARY_DOCS + COMPANION_DOCS

MAX_BYTES = 15 * 1024 * 1024
MAX_PAGES = 50
_REPLY_PREFIX = re.compile(r"^((re|fwd?):\s*)+", re.I)


@lru_cache(maxsize=1)
def fixture_index() -> dict[str, SourceDoc]:
    return {sha256_hex(file_bytes(d)): d for d in ALL_DOCS}


def job_id(document_id: str) -> str:
    return f"job_doc_{document_id}"


def _ok(res: Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"intake {what}: {res.outcome} {res.message}")


def _safe_name(filename: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ ()-]", "_", Path(filename).name)[:120] or "document"


def _pdf_pages(data: bytes) -> list[list[str]]:
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("encrypted PDFs aren't accepted")
    if len(reader.pages) > MAX_PAGES:
        raise ValueError(f"more than {MAX_PAGES} pages")
    return [[ln for ln in (p.extract_text() or "").splitlines()] for p in reader.pages]


def _record_generic(store: Store, filename: str, data: bytes, sha: str, received_at_iso: str, storage: str) -> str:
    doc_id = f"doc_{sha[:8]}"
    src_id = f"src_{sha[:8]}"
    base = doc_id.removeprefix("doc_")
    if data.startswith(b"%PDF"):
        pages = _pdf_pages(data)
        _ok(R.record_source_file(store, src_id, "upload", filename, sha, received_at_iso, "", "", storage), "source")
        _ok(R.record_document(store, doc_id, "other", src_id, sha, filename, len(pages)), "document")
        for p, lines in enumerate(pages, start=1):
            for n, text in enumerate(lines, start=1):
                if text.strip():
                    _ok(R.add_fragment(store, "sync", f"frag_{base}_p{p}_l{n}", doc_id, p, "", n, n, text), "fragment")
        return doc_id
    msg = message_from_bytes(data, policy=policy.default)
    part = msg.get_body(preferencelist=("plain",))
    if part is None or not msg["From"]:
        raise ValueError("only PDFs and plain-text emails (.eml) are accepted")
    body = part.get_content()
    sent = parsedate_to_datetime(msg["Date"]).isoformat() if msg["Date"] else ""
    subject = str(msg["Subject"] or "")
    message_id = f"em_{sha[:8]}"
    thread = f"thr_{sha8(_REPLY_PREFIX.sub('', subject.strip()).lower())}"
    _ok(R.record_source_file(store, src_id, "email", filename, sha, received_at_iso, str(msg["From"]), subject, storage), "source")
    _ok(R.record_document(store, doc_id, "email", src_id, sha, filename, 0), "document")
    for n, text in enumerate(body.splitlines(), start=1):
        if text.strip():
            _ok(R.add_fragment(store, "sync", f"frag_{base}_p0_l{n}", doc_id, 0, message_id, n, n, text), "fragment")
    _ok(R.add_fragment(store, "sync", f"frag_{base}_body", doc_id, 0, message_id, 1, max(len(body.splitlines()), 1), body),
        "body fragment")
    _ok(R.record_email(store, message_id, thread, doc_id, str(msg["From"]), str(msg["To"] or ""), subject, sent,
                       received_at_iso, f"frag_{base}_body"), "email")
    return doc_id


def ingest(store: Store, filename: str, data: bytes, received_at_iso: str = "", files_dir: Path | None = FILES_DIR) -> str:
    """Record the file and queue `process_document`. Returns the document id. Safe to call twice."""
    if not data or len(data) > MAX_BYTES:
        raise ValueError("empty or larger than 15 MB")
    sha = sha256_hex(data)
    known = fixture_index().get(sha)
    if known is not None:
        seed_document(store, known, files_dir, source_kind="email" if known.email else "upload")
        doc_id = known.id
    else:
        storage = ""
        if files_dir is not None:
            files_dir.mkdir(parents=True, exist_ok=True)
            path = files_dir / f"src_{sha[:8]}_{_safe_name(filename)}"
            path.write_bytes(data)
            storage = str(path)
        doc_id = _record_generic(store, _safe_name(filename), data, sha, received_at_iso, storage)
    _ok(R.enqueue_job(store, "sync", job_id(doc_id), "process_document", {"document_id": doc_id}), "job")
    return doc_id
