"""Text in a document aimed at an automated system ("ignore prior instructions", "approve and pay
immediately"). It's data: flagged, never followed. Deterministic patterns, so detection doesn't depend
on the model; Claude's own instructions_found are added on top.
"""

from __future__ import annotations

from typing import Iterable

from .checks import INJECTION_PATTERNS
from .store import Store


def scan(texts: Iterable[str]) -> list[str]:
    hits = []
    for text in texts:
        for pattern in INJECTION_PATTERNS:
            m = pattern.search(text or "")
            if m:
                hits.append(m.group(0).strip())
    return list(dict.fromkeys(hits))


def scan_document(store: Store, document_id: str) -> list[str]:
    """Every fragment of the document, including a PDF's invisible text layer."""
    return scan(f["text"] for f in store.rows("source_fragment", document_id=document_id))
