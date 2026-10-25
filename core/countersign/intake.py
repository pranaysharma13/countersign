"""Intake (sync role): record a received file and queue it for the agent.

The original bytes and SHA-256 are kept, and the document id comes from the bytes, so receiving the
same file twice records nothing new and queues no second job. Known fixture documents keep their
fixture ids and fragments, so labelled extractions line up. Any other PDF or email is cut into one
immutable fragment per text line; in fixture mode it then goes to review (there's no labelled
extraction for it, and nothing is guessed). Emails are parsed as plain text only: no remote content,
no attachments executed.

A whole received message (`ingest_mail`, e.g. Gmail's `format=raw`) is split: its text becomes one email
document and each `application/pdf` attachment its own document, each under the 15 MB limit. Other
attachments are listed as skipped and never opened. An HTML-only body is turned into text here; links
and remote content are never fetched. Where a document came from is kept in its job's payload
(`{"source": "gmail", ...}`), which the web shows as "From Gmail".
"""

from __future__ import annotations

import re
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from functools import lru_cache
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from typing import Any

from . import reducers as R
from .config import FILES_DIR
from .ids import sha8, sha256_hex
from .store import Result, Store
from .supplier_docs import file_bytes
from .supplier_seed import seed_document
from .companion_world import COMPANION_DOCS
from .supplier_world import PRIMARY_DOCS, VARIANT_DOCS, SourceDoc

ALL_DOCS = PRIMARY_DOCS + COMPANION_DOCS + VARIANT_DOCS

MAX_BYTES = 15 * 1024 * 1024
MAX_MESSAGE_BYTES = 40 * 1024 * 1024  # a whole message: Gmail allows 25 MB of attachments, base64 adds a third
MAX_PAGES = 50
MAIL_HEADERS = ("From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References")
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


def document_id_for(data: bytes) -> str:
    """The id `ingest` gives these bytes: a known fixture keeps its own id."""
    sha = sha256_hex(data)
    known = fixture_index().get(sha)
    return known.id if known is not None else f"doc_{sha[:8]}"


def ingest(store: Store, filename: str, data: bytes, received_at_iso: str = "", files_dir: Path | None = FILES_DIR,
           origin: dict[str, str] | None = None) -> str:
    """Record the file and queue `process_document`. Returns the document id. Safe to call twice: the first
    `origin` (e.g. `{"source": "gmail", ...}`) stays on the job."""
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
    _ok(R.enqueue_job(store, "sync", job_id(doc_id), "process_document", {"document_id": doc_id, **(origin or {})}), "job")
    return doc_id


class _Text(HTMLParser):
    """Visible text of an HTML body, nothing else: no links followed, no images or styles loaded."""

    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in {"script", "style", "head", "title"}:
            self._skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "head", "title"}:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.out.append(data)


def html_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    p.close()
    lines = (re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in "".join(p.out).splitlines())
    return "\n".join(ln for ln in lines if ln)


def _body_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain",))
    if part is not None:
        return part.get_content()
    part = msg.get_body(preferencelist=("html",))
    return html_text(part.get_content()) if part is not None else ""


def _body_message(msg: EmailMessage, text: str) -> bytes:
    """The message's headers and text only, as a plain-text email: attachments become their own documents."""
    out = EmailMessage()
    for name in MAIL_HEADERS:
        value = msg.get(name)
        if value is not None:
            try:
                out[name] = " ".join(str(value).split())  # one line: a header can't smuggle in another
            except (ValueError, TypeError):
                continue  # a malformed header is dropped, not guessed at
    out.set_content(text)
    return bytes(out)


def ingest_mail(store: Store, raw: bytes, origin: dict[str, str], received_at_iso: str = "",
                files_dir: Path | None = FILES_DIR) -> dict[str, Any]:
    """Split one received message into documents and queue each. Returns what was recorded (`new` is false
    when the document was already on file) and what was skipped and why. Safe to call twice."""
    if not raw or len(raw) > MAX_MESSAGE_BYTES:
        raise ValueError("the message is empty or larger than 40 MB")
    msg = message_from_bytes(raw, policy=policy.default)
    if not msg["From"]:
        raise ValueError("not an email: there's no From header")
    documents: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []

    def add(filename: str, data: bytes, kind: str) -> None:
        doc_id = document_id_for(data)
        new = not store.rows("document", id=doc_id)
        try:
            ingest(store, filename, data, received_at_iso, files_dir, origin)
        except ValueError as e:  # encrypted, too many pages, not a readable email
            skipped.append({"filename": filename, "content_type": kind, "reason": str(e)})
            return
        documents.append({"document_id": doc_id, "filename": filename, "kind": kind, "new": new})

    text = _body_text(msg)
    ref = re.sub(r"[^A-Za-z0-9_-]", "", str(origin.get("gmail_message_id", "")))[:64] or sha8(raw)
    if text.strip():
        add(f"{origin.get('source', 'mail')}_{ref}.eml", _body_message(msg, text), "email")
    else:
        skipped.append({"filename": "(message body)", "content_type": "text", "reason": "the email has no text"})
    body_parts = {id(p) for p in (msg.get_body(preferencelist=("plain",)), msg.get_body(preferencelist=("html",))) if p}
    for part in msg.walk():
        if part.is_multipart() or id(part) in body_parts:
            continue
        ctype = part.get_content_type()
        name = _safe_name(part.get_filename() or f"attachment.{part.get_content_subtype()}")
        if ctype == "application/pdf":
            data = part.get_payload(decode=True) or b""
            if not data.startswith(b"%PDF"):
                skipped.append({"filename": name, "content_type": ctype, "reason": "labelled a PDF but isn't one"})
            elif len(data) > MAX_BYTES:
                skipped.append({"filename": name, "content_type": ctype, "reason": "larger than 15 MB"})
            else:
                add(name, data, "pdf")
        elif part.get_content_disposition() == "attachment" or ctype not in {"text/plain", "text/html"}:
            skipped.append({"filename": name, "content_type": ctype, "reason": "only PDF attachments are read"})
    return {"documents": documents, "skipped": skipped}
