"""ID helpers (CONTRACT §1): string IDs chosen by the caller."""

from __future__ import annotations

import hashlib
import uuid


def request_id() -> str:
    return str(uuid.uuid4())


def short_uuid() -> str:
    return uuid.uuid4().hex[:8]


def sha8(*parts: str | bytes) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else p.encode())
        h.update(b"\x1f")
    return h.hexdigest()[:8]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hold_id(revision_id: str, code: str) -> str:
    """One hold per code per invoice revision (CONTRACT §9.8): opening it twice is a no-op."""
    return f"hold_{revision_id}_{code.lower()}"
