"""Deterministic decision rules: check results -> propose payment or hold.

The AI can add holds (extra_holds), never remove them. Any failed or errored check
holds the bill. Warnings are shown to the owner but don't block a proposal.
Payment always goes to the account on file, never to bank details on the bill.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .checks import CheckOutcome
from .money import fmt

HARD_STOP_CHECKS = {"bank_mismatch", "quiet_bank_edit", "license", "crs_identity"}

# Order in which reasons are explained (most serious first).
SEVERITY = ["bank_mismatch", "license", "crs_identity", "prompt_injection", "fake_owner_instruction", "sender_domain",
            "duplicate", "split_bill", "math_mismatch", "overbilling", "unapproved_change_order", "lien_waiver_missing",
            "crs_liens_judgments", "cash_available"]


@dataclass
class Decision:
    kind: str  # payment | hold
    amount_cents: int
    reason: str
    blocking: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    hard_stop: bool = False


def decide(bill: dict[str, Any], outcomes: list[CheckOutcome], extra_holds: list[str] | None = None) -> Decision:
    by_code = {o.code: o for o in outcomes}
    blocking = [o.code for o in outcomes if o.status in {"fail", "error"}]
    blocking.sort(key=lambda c: SEVERITY.index(c) if c in SEVERITY else len(SEVERITY))
    warnings = [o.code for o in outcomes if o.status == "warn"]
    net = int(bill["amount_cents"]) - int(bill.get("retainage_cents", 0))

    if blocking or extra_holds:
        parts = [by_code[c].summary for c in blocking[:3]] + list(extra_holds or [])
        lead = by_code[blocking[0]].summary if blocking else (extra_holds or [""])[0]
        reason = f"Hold: {lead}"
        if len(parts) > 1:
            reason += f" Also: {' '.join(parts[1:3])}"
        return Decision("hold", net, reason, blocking, warnings, any(c in HARD_STOP_CHECKS for c in blocking))

    reason = f"Pay {fmt(net)} to the account on file ({fmt(int(bill['amount_cents']))} less {fmt(int(bill.get('retainage_cents', 0)))} retainage). All checks passed"
    reason += f"; note: {' '.join(by_code[c].summary for c in warnings)}" if warnings else "."
    return Decision("payment", net, reason, [], warnings)
