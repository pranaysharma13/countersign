"""Render the v2 fixture documents (PDF and .eml) and cut their immutable source fragments.

One fragment per non-blank line, id `frag_<doc>_p<page>_l<line>` (email: page 0), plus one
`frag_<doc>_body` fragment per email. Extraction must cite these ids; a cited fragment has to
exist and its text has to match after whitespace normalization (CONTRACT §9.2, SPEC §6).
PDFs are rendered with reportlab's invariant mode, so the bytes and SHA-256 are reproducible.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

from .supplier_world import SourceDoc

W, H = letter
_MARKERS = (("## ", "Helvetica-Bold", 11, 18), ("# ", "Helvetica-Bold", 15, 22), ("= ", "Courier", 8.5, 13))


@dataclass(frozen=True)
class Fragment:
    id: str
    document_id: str
    page: int  # 0 for email
    email_message_id: str
    line_start: int
    line_end: int
    text: str


def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def text_matches(quoted: str, stored: str) -> bool:
    """A quoted passage counts only if it equals the stored fragment after whitespace normalization."""
    return normalize_ws(quoted) == normalize_ws(stored)


def _strip_marker(line: str) -> tuple[str, str, float, float]:
    for marker, font, size, leading in _MARKERS:
        if line.startswith(marker):
            return line[len(marker):], font, size, leading
    return line, "Helvetica", 9, 13


def fragment_id(document_id: str, page: int, line: int | None = None) -> str:
    base = f"frag_{document_id.removeprefix('doc_')}"
    return f"{base}_body" if line is None else f"{base}_p{page}_l{line}"


def fragments(doc: SourceDoc) -> list[Fragment]:
    out: list[Fragment] = []
    msg_id = doc.email.message_id if doc.email else ""
    for page_no, lines in enumerate(doc.pages, start=0 if doc.email else 1):
        for line_no, raw in enumerate(lines, start=1):
            text = _strip_marker(raw)[0]
            if text.strip():
                out.append(Fragment(fragment_id(doc.id, page_no, line_no), doc.id, page_no, msg_id, line_no, line_no, text))
    if doc.email:
        body = doc.pages[0]
        out.append(Fragment(fragment_id(doc.id, 0), doc.id, 0, msg_id, 1, len(body), email_body(doc)))
    return out


def email_body(doc: SourceDoc) -> str:
    assert doc.email is not None
    return "\n".join(doc.pages[0]) + "\n"


def render_pdf(doc: SourceDoc, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=letter, invariant=1)
    c.setTitle(doc.filename.removesuffix(".pdf").replace("_", " "))
    for page_no, lines in enumerate(doc.pages, start=1):
        y = H - 0.9 * inch
        for i, raw in enumerate(lines):
            text, font, size, leading = _strip_marker(raw)
            if size > 9 and i:
                y -= 6  # room above a heading
            if text.strip():
                c.setFont(font, size)
                c.drawString(0.75 * inch, y, text)
            y -= leading if text.strip() else 8
        c.setFont("Helvetica", 7)
        c.drawRightString(W - 0.75 * inch, 0.5 * inch, f"Page {page_no} of {len(doc.pages)}")
        c.showPage()
    c.save()
    return path


def render_eml(doc: SourceDoc) -> bytes:
    meta = doc.email
    assert meta is not None
    msg = EmailMessage()
    msg["Message-ID"] = f"<{meta.message_id}@countersign.example>"
    msg["From"] = meta.from_address
    msg["To"] = meta.to_addresses
    msg["Subject"] = meta.subject
    msg["Date"] = format_datetime(datetime.fromisoformat(meta.sent_at_iso))
    msg["X-Countersign-Thread"] = meta.thread_id
    msg.set_content(email_body(doc))
    return bytes(msg)


def write(doc: SourceDoc, out_dir: Path) -> Path:
    path = out_dir / doc.filename
    if doc.email:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(render_eml(doc))
        return path
    return render_pdf(doc, path)


def write_all(docs: tuple[SourceDoc, ...], out_dir: Path) -> dict[str, Path]:
    return {d.id: write(d, out_dir) for d in docs}
