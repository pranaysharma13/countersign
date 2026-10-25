"""Capital One Nessie: the company's bank account, balances and transfers.

Transfers carry an idempotency key in the description ("cs:<proposal_id>"), and the
gateway looks for an existing transfer with that key before sending, so a timeout
never causes a second payment.
"""

from __future__ import annotations

import threading
from typing import Any

import httpx

from ..config import settings


class NessieError(RuntimeError):
    pass


class MockNessie:
    def __init__(self, opening_balance_cents: int = 412_000_00):
        self.balances: dict[str, int] = {"acct_company_operating": opening_balance_cents}
        self.transfers: list[dict[str, Any]] = []
        self.fail_next_after_send = False  # simulate a timeout after the bank accepted the transfer
        self._lock = threading.Lock()

    def balance_cents(self, account_ref: str) -> int:
        return self.balances.get(account_ref, 0)

    def find_transfer(self, payer_ref: str, key: str) -> dict[str, Any] | None:
        return next((t for t in self.transfers if t["payer"] == payer_ref and t["description"] == key), None)

    def transfer(self, payer_ref: str, payee_ref: str, amount_cents: int, key: str) -> dict[str, Any]:
        with self._lock:
            if self.balances.get(payer_ref, 0) < amount_cents:
                raise NessieError("insufficient funds")
            t = {"_id": f"tr_{len(self.transfers) + 1:05d}", "payer": payer_ref, "payee": payee_ref,
                 "amount_cents": amount_cents, "description": key, "status": "executed"}
            self.transfers.append(t)
            self.balances[payer_ref] -= amount_cents
            self.balances[payee_ref] = self.balances.get(payee_ref, 0) + amount_cents
            if self.fail_next_after_send:
                self.fail_next_after_send = False
                raise TimeoutError("bank timed out after accepting the transfer")
            return t


class RealNessie:
    """Thin client. Nessie amounts are dollars (numbers); we convert at the edge only."""

    def __init__(self) -> None:
        self.base = settings.nessie_base_url.rstrip("/")
        self.key = settings.nessie_api_key
        self.http = httpx.Client(timeout=30)

    def _get(self, path: str) -> Any:
        r = self.http.get(f"{self.base}{path}", params={"key": self.key})
        if r.status_code >= 300:
            raise NessieError(f"GET {path}: {r.status_code} {r.text[:200]}")
        return r.json()

    def balance_cents(self, account_ref: str) -> int:
        acct = self._get(f"/accounts/{account_ref}")
        return int(round(float(acct.get("balance", 0)) * 100))

    def find_transfer(self, payer_ref: str, key: str) -> dict[str, Any] | None:
        for t in self._get(f"/accounts/{payer_ref}/transfers"):
            if t.get("description") == key:
                return t
        return None

    def transfer(self, payer_ref: str, payee_ref: str, amount_cents: int, key: str) -> dict[str, Any]:
        body = {"medium": "balance", "payee_id": payee_ref, "amount": amount_cents / 100, "description": key}
        r = self.http.post(f"{self.base}/accounts/{payer_ref}/transfers", params={"key": self.key}, json=body)
        if r.status_code >= 300:
            raise NessieError(f"transfer: {r.status_code} {r.text[:200]}")
        data = r.json()
        created = data.get("objectCreated", data)
        return {"_id": created.get("_id", ""), **created}


_client: MockNessie | RealNessie | None = None


def pay_once(bank: "MockNessie | RealNessie", payer_ref: str, payee_ref: str, amount_cents: int, key: str) -> tuple[dict[str, Any], bool]:
    """Pay exactly once per idempotency key: an existing transfer is reused, and after a timeout the bank
    is asked whether it took the transfer before giving up. Returns (transfer, recovered)."""
    transfer = bank.find_transfer(payer_ref, key)
    if transfer is not None:
        return transfer, True
    try:
        return bank.transfer(payer_ref, payee_ref, amount_cents, key), False
    except TimeoutError:
        transfer = bank.find_transfer(payer_ref, key)  # did the bank take it before timing out?
        if transfer is None:
            raise
        return transfer, True


def client() -> MockNessie | RealNessie:
    global _client
    if _client is None:
        _client = MockNessie() if settings.use_mocks or not settings.nessie_api_key else RealNessie()
    return _client


def set_client(c: MockNessie | RealNessie) -> None:
    global _client
    _client = c
