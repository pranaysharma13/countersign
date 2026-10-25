"""Deterministic checks (CONTRACT §3.4). Pure functions: same input, same verdict.

Each returns a CheckOutcome with evidence a person can verify. The agent decides
which to run and explains them; it never overrides a failed check.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .money import apply_bps, fmt
from .world import BANK_CHANGE_CLAUSE


@dataclass
class CheckOutcome:
    code: str
    status: str  # pass | fail | warn | error | skipped
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    source: str = "contract"


@dataclass
class CheckContext:
    bill: dict[str, Any]
    lines: list[dict[str, Any]]
    sub: dict[str, Any] | None
    contract: dict[str, Any] | None
    contract_lines: list[dict[str, Any]]
    change_orders: list[dict[str, Any]]
    prior_bills: list[dict[str, Any]]  # same sub, genuine (not held/rejected), with "lines"
    doc_text: str = ""
    email_body: str = ""
    subject: str = ""
    license: dict[str, Any] | None = None
    crs: dict[str, Any] | None = None
    balance_cents: int | None = None
    committed_cents: int = 0


def _domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].strip().lower() if "@" in address else ""


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# ---------------------------------------------------------------- vendor & money movement


def bank_mismatch(ctx: CheckContext) -> CheckOutcome:
    b, sub = ctx.bill, ctx.sub
    if sub is None:
        return CheckOutcome("bank_mismatch", "fail", "Vendor isn't a sub on file, so there's no verified account to pay.",
                            {"vendor": b.get("vendor_name", "")})
    billed = {"bank": b.get("remit_bank_name", ""), "routing": b.get("remit_routing", ""), "last4": b.get("remit_account_last4", "")}
    on_file = {"bank": sub.get("bank_name", ""), "routing": sub.get("routing", ""), "last4": sub.get("bank_last4", "")}
    if not billed["last4"]:
        return CheckOutcome("bank_mismatch", "pass", "No remit instructions on the bill; payment goes to the account on file.",
                            {"on_file": on_file})
    differs = billed["last4"] != on_file["last4"] or (billed["routing"] and on_file["routing"] and billed["routing"] != on_file["routing"])
    if differs:
        at_file = f" at {on_file['bank']}" if on_file["bank"] else ""
        return CheckOutcome(
            "bank_mismatch", "fail",
            f"Bill asks for payment to account ****{billed['last4']} at {billed['bank'] or 'an unknown bank'}; "
            f"the account on file is ****{on_file['last4']}{at_file}. Bank changes need a call to the number on file.",
            {"on_bill": billed, "on_file": on_file, "contract_clause": BANK_CHANGE_CLAUSE})
    return CheckOutcome("bank_mismatch", "pass", f"Remit-to matches the account on file (****{on_file['last4']}).",
                        {"on_file": on_file})


def sender_domain(ctx: CheckContext) -> CheckOutcome:
    sent_from = _domain(ctx.bill.get("from_address", ""))
    if ctx.sub is None:
        return CheckOutcome("sender_domain", "fail", f"Sender {sent_from or 'unknown'} doesn't belong to any sub on file.",
                            {"from": ctx.bill.get("from_address", "")}, "history")
    expected = (ctx.sub.get("email_domain") or "").lower()
    if not sent_from:
        return CheckOutcome("sender_domain", "skipped", "Uploaded by hand; no sender to compare.", {}, "history")
    if sent_from == expected:
        return CheckOutcome("sender_domain", "pass", f"Sent from {sent_from}, the sub's domain on file.", {"expected": expected}, "history")
    dist = _edit_distance(sent_from, expected)
    lookalike = dist <= 3
    summary = (f"Sent from {sent_from}, a lookalike of {expected} ({dist} character{'s' if dist != 1 else ''} different)."
               if lookalike else f"Sent from {sent_from}; the sub's domain on file is {expected}.")
    return CheckOutcome("sender_domain", "fail", summary, {"from": sent_from, "expected": expected, "edit_distance": dist}, "history")


def license_check(ctx: CheckContext) -> CheckOutcome:
    lic = ctx.license
    if lic is None:
        return CheckOutcome("license", "error", "License lookup unavailable; holding to be safe.", {}, "apify")
    status = str(lic.get("status", "")).lower()
    expected_no = (ctx.sub or {}).get("license_number", "") or ctx.bill.get("vendor_license", "")
    if status != "active":
        return CheckOutcome("license", "fail", f"License #{lic.get('number', expected_no)} is {status or 'not found'} at the state board.",
                            dict(lic), "apify")
    if expected_no and lic.get("number") and lic["number"] != expected_no:
        return CheckOutcome("license", "fail", f"License on the bill ({lic['number']}) isn't the license on file ({expected_no}).",
                            dict(lic), "apify")
    return CheckOutcome("license", "pass", f"License #{lic.get('number')} is active ({lic.get('classification', '')}).", dict(lic), "apify")


def crs_liens_judgments(ctx: CheckContext) -> CheckOutcome:
    rep = ctx.crs
    if rep is None:
        return CheckOutcome("crs_liens_judgments", "error", "CRS lookup unavailable; holding to be safe.", {}, "crs")
    if rep.get("bankruptcies") or rep.get("fraud_alert"):
        return CheckOutcome("crs_liens_judgments", "fail", "CRS shows a bankruptcy or fraud alert on this business.", dict(rep), "crs")
    liens, judgments = rep.get("liens", []), rep.get("judgments", [])
    if liens or judgments:
        total = sum(int(x.get("amount_cents", 0)) for x in liens + judgments)
        return CheckOutcome("crs_liens_judgments", "warn",
                            f"CRS shows {len(liens)} lien(s) and {len(judgments)} judgment(s) totaling {fmt(total)}. "
                            "Collect an unconditional waiver from their suppliers before final payment.", dict(rep), "crs")
    return CheckOutcome("crs_liens_judgments", "pass", "No liens, judgments or bankruptcies on file at CRS.", dict(rep), "crs")


# ---------------------------------------------------------------- bill vs. contract and history


def math_mismatch(ctx: CheckContext) -> CheckOutcome:
    total = sum(int(l["this_period_cents"]) for l in ctx.lines)
    printed = int(ctx.bill["amount_cents"])
    if total != printed:
        return CheckOutcome("math_mismatch", "fail",
                            f"Line items add up to {fmt(total)} but the bill's total is {fmt(printed)} ({fmt(printed - total)} unexplained).",
                            {"lines_total_cents": total, "printed_total_cents": printed}, "document")
    if ctx.contract:
        expected_ret = apply_bps(printed, int(ctx.contract["retainage_bps"]))
        if int(ctx.bill.get("retainage_cents", 0)) != expected_ret:
            return CheckOutcome("math_mismatch", "warn",
                                f"Retainage shown is {fmt(int(ctx.bill.get('retainage_cents', 0)))}; the contract's "
                                f"{int(ctx.contract['retainage_bps']) / 100:.0f}% is {fmt(expected_ret)}.",
                                {"expected_retainage_cents": expected_ret}, "contract")
    return CheckOutcome("math_mismatch", "pass", f"Lines add up to the total ({fmt(total)}).", {}, "document")


def _co_by_number(ctx: CheckContext) -> dict[str, dict[str, Any]]:
    return {co["number"]: co for co in ctx.change_orders}


def overbilling(ctx: CheckContext) -> CheckOutcome:
    if ctx.contract is None:
        return CheckOutcome("overbilling", "fail", "No subcontract on file to bill against.", {})
    scheduled = {l["code"]: int(l["scheduled_value_cents"]) for l in ctx.contract_lines}
    for co in ctx.change_orders:
        if co["status"] == "approved":
            scheduled[co["number"]] = int(co["amount_cents"])
    billed_before: dict[str, int] = {}
    for pb in ctx.prior_bills:
        if pb.get("contract_id") != ctx.bill.get("contract_id"):
            continue
        for l in pb.get("lines", []):
            billed_before[l["contract_line_code"]] = billed_before.get(l["contract_line_code"], 0) + int(l["this_period_cents"])
    problems = []
    for l in ctx.lines:
        code = l["contract_line_code"]
        if code.startswith("CO-") and code not in scheduled:
            continue  # unapproved_change_order reports this
        if code not in scheduled:
            problems.append({"code": code, "issue": "not in the schedule of values", "billed_cents": int(l["this_period_cents"])})
            continue
        to_date = billed_before.get(code, 0) + int(l["this_period_cents"])
        if to_date > scheduled[code]:
            problems.append({"code": code, "scheduled_cents": scheduled[code], "billed_to_date_cents": to_date,
                             "over_by_cents": to_date - scheduled[code]})
    if problems:
        p = problems[0]
        summary = (f"{p['code']} would be billed to {fmt(p['billed_to_date_cents'])} against a scheduled value of "
                   f"{fmt(p['scheduled_cents'])} ({fmt(p['over_by_cents'])} over)." if "over_by_cents" in p
                   else f"{p['code']} isn't in the subcontract's schedule of values.")
        return CheckOutcome("overbilling", "fail", summary, {"lines": problems})
    return CheckOutcome("overbilling", "pass", "Every line is within its scheduled value.", {"billed_before": billed_before})


def unapproved_change_order(ctx: CheckContext) -> CheckOutcome:
    cos = _co_by_number(ctx)
    for l in ctx.lines:
        code = l["contract_line_code"]
        if code.startswith("CO-"):
            co = cos.get(code)
            if co is None:
                return CheckOutcome("unapproved_change_order", "fail", f"Bill includes {code}, which doesn't exist on this subcontract.",
                                    {"code": code})
            if co["status"] != "approved":
                return CheckOutcome("unapproved_change_order", "fail",
                                    f"Bill includes {code} ({co['description']}, {fmt(int(co['amount_cents']))}), which is still "
                                    f"{co['status']}. Approve the change order first.", {"change_order": co})
    return CheckOutcome("unapproved_change_order", "pass", "No unapproved change orders billed.", {})


def lien_waiver_missing(ctx: CheckContext) -> CheckOutcome:
    rule = (ctx.contract or {}).get("lien_waiver_rule", "none")
    if rule == "conditional_progress_each_bill" and not ctx.bill.get("has_lien_waiver"):
        return CheckOutcome("lien_waiver_missing", "fail",
                            "The subcontract requires a conditional progress lien waiver with each bill; none is attached.",
                            {"rule": rule}, "document")
    return CheckOutcome("lien_waiver_missing", "pass", "Conditional progress lien waiver attached." if rule != "none"
                        else "No lien waiver required.", {"rule": rule}, "document")


def _line_signature(lines: list[dict[str, Any]]) -> tuple[tuple[str, int], ...]:
    return tuple(sorted((l["contract_line_code"], int(l["this_period_cents"])) for l in lines))


def duplicate(ctx: CheckContext) -> CheckOutcome:
    inv = ctx.bill.get("invoice_number", "")
    sig = _line_signature(ctx.lines)
    for pb in ctx.prior_bills:
        if inv and pb.get("invoice_number") == inv:
            return CheckOutcome("duplicate", "fail", f"Invoice {inv} was already recorded on {pb.get('bill_date')}.",
                                {"previous_bill": pb.get("id")}, "history")
        if pb.get("contract_id") == ctx.bill.get("contract_id") and _line_signature(pb.get("lines", [])) == sig:
            return CheckOutcome("duplicate", "fail",
                                f"Same line items and amounts as {pb.get('invoice_number')} ({pb.get('period_label')}, "
                                f"{fmt(int(pb.get('amount_cents', 0)))}), resubmitted as {inv}.",
                                {"previous_bill": pb.get("id"), "previous_invoice": pb.get("invoice_number")}, "history")
    return CheckOutcome("duplicate", "pass", "No earlier bill with this number or these amounts.", {}, "history")


def split_bill(ctx: CheckContext) -> CheckOutcome:
    same_period = [pb for pb in ctx.prior_bills
                   if pb.get("contract_id") == ctx.bill.get("contract_id") and pb.get("period_label") == ctx.bill.get("period_label")]
    if same_period:
        total = sum(int(pb.get("amount_cents", 0)) for pb in same_period) + int(ctx.bill["amount_cents"])
        return CheckOutcome("split_bill", "fail",
                            f"Second bill for {ctx.bill.get('period_label')} on this subcontract "
                            f"(with {same_period[0].get('invoice_number')}, {fmt(total)} combined).",
                            {"other_bills": [pb.get("id") for pb in same_period], "combined_cents": total}, "history")
    return CheckOutcome("split_bill", "pass", "One bill for this period.", {}, "history")


# ---------------------------------------------------------------- text aimed at people or at the AI

_OWNER_CLAIM = re.compile(
    r"(owner|dana|ceo|boss|management)[^.\n]{0,60}(already )?(approved|verified|authori[sz]ed|signed off|said to pay|wants this paid)",
    re.I)
_INJECTION = [
    re.compile(r"ignore (all |any )?(previous|prior|earlier)[^.\n]{0,40}(instructions|payment instructions|rules)", re.I),
    re.compile(r"(automated|ai|automatic)[^.\n]{0,30}(accounts payable|ap system|assistant|agent|systems?)", re.I),
    re.compile(r"(approve|pay)[^.\n]{0,25}(immediately|without (review|verification))", re.I),
    re.compile(r"(system|assistant) (prompt|instructions?)", re.I),
]
INJECTION_PATTERNS = _INJECTION  # also used on supplier documents (injection.py)


def fake_owner_instruction(ctx: CheckContext) -> CheckOutcome:
    for source, text in (("email", ctx.email_body), ("document", ctx.doc_text)):
        m = _OWNER_CLAIM.search(text or "")
        if m:
            return CheckOutcome("fake_owner_instruction", "fail",
                                f"The {source} claims the owner approved this (\"{m.group(0).strip()}\"). Approvals only count "
                                "when the owner taps Approve in Countersign.", {"quote": m.group(0), "where": source}, "document")
    return CheckOutcome("fake_owner_instruction", "pass", "No claims of owner approval in the email or bill.", {}, "document")


def prompt_injection(ctx: CheckContext) -> CheckOutcome:
    for source, text in (("document", ctx.doc_text), ("email", ctx.email_body)):
        for pattern in _INJECTION:
            m = pattern.search(text or "")
            if m:
                return CheckOutcome("prompt_injection", "fail",
                                    f"The {source} contains instructions aimed at an automated system (\"{m.group(0).strip()}\"). "
                                    "Treated as data and ignored.", {"quote": m.group(0), "where": source}, "document")
    return CheckOutcome("prompt_injection", "pass", "No instructions aimed at the AI found.", {}, "document")


def cash_available(ctx: CheckContext) -> CheckOutcome:
    if ctx.balance_cents is None:
        return CheckOutcome("cash_available", "skipped", "No bank balance yet.", {}, "nessie")
    net = int(ctx.bill["amount_cents"]) - int(ctx.bill.get("retainage_cents", 0))
    left = ctx.balance_cents - ctx.committed_cents - net
    ev = {"balance_cents": ctx.balance_cents, "committed_cents": ctx.committed_cents, "this_bill_cents": net, "left_cents": left}
    if left < 0:
        return CheckOutcome("cash_available", "warn", f"Balance can't cover this week's run with this bill ({fmt(left)} short).", ev, "nessie")
    return CheckOutcome("cash_available", "pass", f"{fmt(left)} left after this week's approved payments and this bill.", ev, "nessie")


BILL_CHECKS: list[tuple[str, Callable[[CheckContext], CheckOutcome]]] = [
    ("bank_mismatch", bank_mismatch),
    ("sender_domain", sender_domain),
    ("license", license_check),
    ("crs_liens_judgments", crs_liens_judgments),
    ("duplicate", duplicate),
    ("split_bill", split_bill),
    ("overbilling", overbilling),
    ("unapproved_change_order", unapproved_change_order),
    ("lien_waiver_missing", lien_waiver_missing),
    ("math_mismatch", math_mismatch),
    ("fake_owner_instruction", fake_owner_instruction),
    ("prompt_injection", prompt_injection),
    ("cash_available", cash_available),
]
CHECKS_BY_CODE = dict(BILL_CHECKS)


def run_check(code: str, ctx: CheckContext) -> CheckOutcome:
    try:
        return CHECKS_BY_CODE[code](ctx)
    except Exception as e:  # fail safe: an error is a hold, never a pass
        return CheckOutcome(code, "error", f"Check failed to run: {type(e).__name__}. Holding to be safe.", {"error": str(e)})


def run_all(ctx: CheckContext) -> list[CheckOutcome]:
    return [run_check(code, ctx) for code, _ in BILL_CHECKS]
