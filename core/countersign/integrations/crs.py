"""CRS Credit API sandbox: business public records (liens, judgments, bankruptcies)
and identity verification. Provided test identities only.

Real mode: logs in for a bearer token. The exact business/public-records endpoints
come from the CRS Postman collection (emailed after signup); fill BUSINESS_REPORT_PATH
and map fields in `_normalize_business` once it arrives. Until then mock mode is used.
"""

from __future__ import annotations

import os
import time
from functools import lru_cache
from typing import Any

import httpx

from ..config import settings

# Cal Hacks sandbox PitchPoint BLJ path; override with CRS_BUSINESS_REPORT_PATH.
BUSINESS_REPORT_PATH = os.getenv("CRS_BUSINESS_REPORT_PATH") or "/pp/fcrablj/data"

_MOCK: dict[str, dict[str, Any]] = {
    "crs_test_business_02": {"liens": [], "judgments": [{"type": "civil judgment", "amount_cents": 1_240_000, "filed": "2025-11-03",
                                                          "creditor": "Electrical supply house"}], "bankruptcies": []},
    "crs_test_business_05": {"liens": [{"type": "mechanics lien", "amount_cents": 380_000, "filed": "2026-08-19",
                                        "claimant": "Roofing materials supplier"}], "judgments": [], "bankruptcies": []},
}

_token: tuple[str, float] | None = None


def _login() -> str:
    global _token
    if _token and _token[1] > time.time():
        return _token[0]
    r = httpx.post(f"{settings.crs_base_url}/users/login",
                   json={"username": settings.crs_username, "password": settings.crs_password}, timeout=30)
    r.raise_for_status()
    body = r.json()
    token = body.get("token") or body.get("access_token") or body.get("accessToken") or ""
    _token = (token, time.time() + 25 * 60)
    return token


def _normalize_business(raw: dict[str, Any]) -> dict[str, Any]:
    # TODO(PY): map real field names from the Postman collection.
    return {"liens": raw.get("liens", []), "judgments": raw.get("judgments", []),
            "bankruptcies": raw.get("bankruptcies", []), "raw_keys": sorted(raw.keys())}


@lru_cache(maxsize=256)
def business_report(crs_ref: str) -> dict[str, Any]:
    if settings.use_mocks or not BUSINESS_REPORT_PATH or not settings.crs_username:
        rep = _MOCK.get(crs_ref, {"liens": [], "judgments": [], "bankruptcies": []})
        return {**rep, "crs_ref": crs_ref, "source": "mock"}
    try:
        token = _login()
        r = httpx.post(f"{settings.crs_base_url}{BUSINESS_REPORT_PATH}", json={"reference": crs_ref},
                       headers={"Authorization": f"Bearer {token}"}, timeout=60)
        r.raise_for_status()
        return {**_normalize_business(r.json()), "crs_ref": crs_ref, "source": "crs"}
    except (httpx.HTTPError, ValueError, KeyError):
        rep = _MOCK.get(crs_ref, {"liens": [], "judgments": [], "bankruptcies": []})
        return {**rep, "crs_ref": crs_ref, "source": "mock_fallback"}


def verify_identity(crs_ref: str, otp_passed: bool = True) -> dict[str, Any]:
    """Identity verification for a bank change. Mock: passes for known test refs."""
    ok = crs_ref.startswith("crs_test_") and otp_passed
    return {"result": "pass" if ok else "fail", "method": "crs_idv", "crs_ref": crs_ref,
            "source": "mock" if settings.use_mocks else "sandbox_rule"}
