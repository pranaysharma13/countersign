"""Contractor license lookup (California CSLB) via Apify.

Real mode runs the Apify Actor named in APIFY_LICENSE_ACTOR with {"licenseNumber": ...}
and expects {number, name, status, classification, expires}. Mock mode answers from
the demo world. Results are cached per license number for the run.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx

from ..config import settings
from ..world import SUBS

_TRADE_CLASS = {"framing": "C-5 Framing", "electrical": "C-10 Electrical", "plumbing": "C-36 Plumbing",
                "drywall": "C-9 Drywall", "roofing": "C-39 Roofing", "concrete": "C-8 Concrete",
                "hvac": "C-20 HVAC", "painting": "C-33 Painting"}


def _mock(number: str) -> dict[str, Any]:
    for s in SUBS:
        if s.license_number == number:
            return {"number": number, "name": s.name, "status": "active", "classification": _TRADE_CLASS[s.trade],
                    "expires": "2027-06-30", "source": "mock"}
    if number.startswith("99"):
        return {"number": number, "name": "", "status": "expired", "classification": "", "expires": "2024-01-31", "source": "mock"}
    return {"number": number, "name": "", "status": "not_found", "classification": "", "expires": "", "source": "mock"}


@lru_cache(maxsize=256)
def lookup(number: str) -> dict[str, Any]:
    if settings.use_mocks or not (settings.apify_token and settings.apify_license_actor):
        return _mock(number)
    actor = settings.apify_license_actor.replace("/", "~")
    url = f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
    r = httpx.post(url, params={"token": settings.apify_token}, json={"licenseNumber": number}, timeout=90)
    r.raise_for_status()
    items = r.json()
    if not items:
        return {"number": number, "status": "not_found", "source": "apify"}
    item = dict(items[0])
    item.setdefault("number", number)
    item["source"] = "apify"
    return item
