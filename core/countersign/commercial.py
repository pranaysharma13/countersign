"""Commercial assessment of one supplier invoice revision (SPEC §6.4). Deterministic: no model calls.

Claude turns documents into records; this module decides, line by line, what is authorised,
what is pending and what is a variance, and which holds block payment. It never pays less
silently: the proposed payment is the full balance requested when everything claimed is
authorised, otherwise $0 and a request for a corrected invoice or an agreed credit. The one
exception is the owner's recorded decision on each disputed line (CONTRACT §9.9): then the
agreed part is proposed and the disputed rest stays open.
Same inputs -> same numbers -> same fingerprint.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from . import reducers as R
from .checks import CheckOutcome
from .ids import hold_id
from .money import extend_up, fmt, fmt_qty
from .store import Store, StoreError, dumps, one

POLICY_VERSION = "commercial-2026-10-24.1"
COMMERCIAL_HOLDS = {"PRICE_VARIANCE", "PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING", "PO_CEILING", "DUPLICATE_REVIEW",
                    "EXTRACTION_REVIEW", "CONTRACT_REVIEW", "PROMPT_INJECTION"}
MONEY_HOLDS = {"PRICE_VARIANCE", "PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING", "PO_CEILING"}  # the module reads these per line
HOLD_ORDER = ["CONTRACT_REVIEW", "EXTRACTION_REVIEW", "DUPLICATE_REVIEW", "PRICE_VARIANCE", "PROPOSED_CHARGE",
              "USAGE_EVIDENCE_MISSING", "PO_CEILING", "PROMPT_INJECTION", "SUPPLIER_RISK", "RECEIPT_NOT_VERIFIED",
              "PAYEE_CHANGE_PENDING", "APPROVAL_STALE"]
VOLATILE = {"created_at", "updated_at", "at"}  # plus identities: who acted is enforced by the module, not an amount input


@dataclass(frozen=True)
class HoldSpec:
    code: str
    amount_cents: int
    reason: str
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class LineResult:
    line_id: str
    kind: str
    description: str
    claimed_cents: int
    accepted_cents: int = 0
    pending_cents: int = 0
    variance_cents: int = 0
    status: str = ""  # accepted | variance | pending | review
    classification: str = ""
    hold_code: str = ""
    calculation: str = ""
    uncertainty: str = ""
    fragment_ids: list[str] = field(default_factory=list)
    awaiting_decision_by: str = ""  # the supplier confirmed it; only our in-app decision is missing (role with authority)
    decision: str = ""  # the owner's settlement decision that applies to this line (§9.9), if any
    decision_id: str = ""

    @property
    def disputed_cents(self) -> int:
        return self.pending_cents + self.variance_cents if self.hold_code in MONEY_HOLDS else 0


@dataclass
class InvoiceBundle:
    """Everything the assessment reads, as stored rows (CONTRACT §9.2 column names)."""

    invoice: dict[str, Any]
    revision: dict[str, Any]
    lines: list[dict[str, Any]]
    purchase: dict[str, Any] | None
    terms: list[dict[str, Any]] = field(default_factory=list)
    change_requests: list[dict[str, Any]] = field(default_factory=list)
    deposits: list[dict[str, Any]] = field(default_factory=list)
    allocations: list[dict[str, Any]] = field(default_factory=list)
    attestations: list[dict[str, Any]] = field(default_factory=list)
    payee_profiles: list[dict[str, Any]] = field(default_factory=list)
    document: dict[str, Any] | None = None
    others: list[dict[str, Any]] = field(default_factory=list)  # same supplier: {"invoice","revision","lines","document"}
    authorities: list[dict[str, Any]] = field(default_factory=list)  # who may decide changes, and up to what amount
    decisions: list[dict[str, Any]] = field(default_factory=list)  # active settlement decisions on this revision (§9.9)
    delivery_period: dict[str, str] | None = None  # {"from", "to"} from the revision's validated reading, if it says


@dataclass
class Assessment:
    revision_id: str
    claimed_cents: int
    authorised_cents: int
    pending_cents: int
    variance_cents: int
    under_review_cents: int
    balance_requested_cents: int
    deposit_available_cents: int
    deposit_applied_cents: int
    conditional_payment_cents: int
    proposed_payment_cents: int
    commercial_status: str
    holds: list[HoldSpec]
    checks: list[CheckOutcome]
    lines: list[LineResult]
    clarification_points: list[str]
    summary: str
    next_action: str
    next_owner_role: str
    fingerprint: str
    policy_version: str = POLICY_VERSION
    inputs: dict[str, Any] = field(default_factory=dict)  # input_digest: which rows the fingerprint covers

    def hold_amounts(self) -> dict[str, int]:
        return {h.code: h.amount_cents for h in self.holds}

    def details(self) -> dict[str, Any]:
        return {"lines": [_line_detail(l) for l in self.lines], "checks": [asdict(c) for c in self.checks],
                "holds": [asdict(h) for h in self.holds], "deposit_applied_cents": self.deposit_applied_cents,
                "conditional_payment_cents": self.conditional_payment_cents,
                "under_review_cents": self.under_review_cents, "clarification_points": self.clarification_points,
                "note": "Amounts under review are not savings until the supplier agrees.", "inputs": self.inputs}


def _line_detail(l: LineResult) -> dict[str, Any]:
    """The module reads `line_id`, `hold_code`, `pending_cents` and `variance_cents` of every line (§9.9), and
    `hold_code` is '' or a money hold there; a line's other review code is kept as `review_hold_code`."""
    d = asdict(l)
    if l.hold_code and l.hold_code not in MONEY_HOLDS:
        d["hold_code"], d["review_hold_code"] = "", l.hold_code
    return d


# ---------------------------------------------------------------- decision records


def effective_classification(cr: dict[str, Any]) -> str:
    """Re-derived from the decision records every time, never trusted from a stored label or an email.
    Authorised = approved in the app by someone other than the requester, AND accepted by the supplier."""
    if cr["internal_status"] == "rejected" or cr["supplier_acceptance"] == "declined":
        return "DECLINED"
    approved = cr["internal_status"] == "approved" and cr["decided_by_identity"] not in {"", cr["requested_by_identity"]}
    if approved and cr["supplier_acceptance"] == "accepted":
        return "AUTHORISED_RATE_USAGE_MISSING" if cr["rate_cents"] else "AUTHORISED_FIXED"
    stored = cr.get("classification", "PROPOSED")
    return stored if stored in {"AMBIGUOUS", "UNRELATED"} else "PROPOSED"


def _accepted_term(b: InvoiceBundle, code: str) -> dict[str, Any] | None:
    found = [t for t in b.terms if t["code"] == code and t["status"] == "accepted"]
    return max(found, key=lambda t: t["version"]) if found else None


def _scope(row: dict[str, Any]) -> dict[str, Any]:
    return json.loads(row.get("scope_json") or "{}")


def _frags(row: dict[str, Any]) -> list[str]:
    return list(json.loads(row.get("source_fragment_ids_json") or "[]"))


# ---------------------------------------------------------------- line by line


def period_fit(period: dict[str, str] | None, scope: dict[str, Any]) -> str:
    """How an amendment's date or delivery scope covers an invoice's deliveries: "all", "none" or "partial".
    Unknown deliveries, or a scope by delivery reference that the invoice line can't show, are "partial"."""
    start, end, refs = scope.get("from") or "", scope.get("to") or "", scope.get("delivery_refs") or []
    if not start and not end:
        return "partial" if refs else "all"
    if not period or not period.get("from") or not period.get("to"):
        return "partial"
    if (start and period["to"] < start) or (end and period["from"] > end):
        return "none"
    return "all" if (not start or period["from"] >= start) and (not end or period["to"] <= end) and not refs else "partial"


def _scope_text(scope: dict[str, Any]) -> str:
    start, end, refs = scope.get("from") or "", scope.get("to") or "", scope.get("delivery_refs") or []
    when = (f"deliveries from {start} to {end}" if start and end else f"deliveries from {start}" if start
            else f"deliveries through {end}" if end else "")
    return ", ".join(x for x in (when, f"deliveries {', '.join(refs)}" if refs else "") if x) or "its scope"


def _period_text(period: dict[str, str] | None) -> str:
    return f"{period['from']} to {period['to']}" if period and period.get("from") and period.get("to") else "on unstated dates"


def _material_line(b: InvoiceBundle, l: dict[str, Any], r: LineResult) -> None:
    unit = (b.purchase or {}).get("unit", "")
    base = _accepted_term(b, "unit_price")
    qty, price = int(l["quantity_milli"]), int(l["unit_price_cents"])
    if l["unit"] != unit:
        r.status, r.hold_code, r.pending_cents = "review", "CONTRACT_REVIEW", r.claimed_cents
        r.uncertainty = f"Billed in {l['unit'] or 'no unit'}, the purchase is in {unit}; units are never converted."
        return
    if base is None:
        r.status, r.hold_code, r.pending_cents = "review", "CONTRACT_REVIEW", r.claimed_cents
        r.uncertainty = "No accepted unit price on the purchase."
        return
    # Accepted price changes apply to their scoped quantity first; the rest stays at the quoted price. A change
    # scoped to dates or deliveries applies only when the invoice's deliveries all fall inside that scope; when
    # they only partly do, nobody knows how much was delivered inside it, so only the quoted price is authorised
    # and the difference waits for allocation evidence (SPEC §8 scoped amendment).
    remaining, allowed, parts, unallocated = qty, 0, [], []
    for cr in sorted(b.change_requests, key=lambda c: c["id"]):
        if cr["kind"] != "price_change" or not effective_classification(cr).startswith("AUTHORISED") or remaining <= 0:
            continue
        scope = _scope(cr)
        fit = period_fit(b.delivery_period, scope)
        if fit == "none":
            continue
        scoped = scope.get("quantity_milli")
        if scoped is None and fit == "partial":
            unallocated.append(cr)
            continue
        take = remaining if scoped is None else min(remaining, int(scoped))
        allowed += take * int(cr["rate_cents"]) // 1000
        parts.append(f"{fmt_qty(take, unit)} x {fmt(int(cr['rate_cents']))} (amendment {cr['id']})")
        remaining -= take
    at_base = remaining * int(base["amount_cents"]) // 1000
    top = max((int(c["rate_cents"]) for c in unallocated), default=0)
    ceiling = allowed + (remaining * top // 1000 if top > int(base["amount_cents"]) else at_base)
    allowed += at_base
    if remaining:
        parts.append(f"{fmt_qty(remaining, unit)} x {fmt(int(base['amount_cents']))} (accepted unit price)")
    r.fragment_ids += _frags(base)
    r.accepted_cents = min(r.claimed_cents, allowed)
    if allowed < r.claimed_cents <= ceiling:  # within what the scoped price could allow: evidence, not a variance
        cr = max(unallocated, key=lambda c: int(c["rate_cents"]))
        r.pending_cents = r.claimed_cents - allowed
        r.fragment_ids += _frags(cr)
        r.status, r.classification, r.hold_code = "pending", "AUTHORISED_RATE_USAGE_MISSING", "USAGE_EVIDENCE_MISSING"
        r.calculation = (f"Allowed {' + '.join(parts)} = {fmt(allowed)}; billed {fmt_qty(qty, unit)} x {fmt(price)} = "
                         f"{fmt(r.claimed_cents)}; up to {fmt(r.pending_cents)} more if delivered inside the scope of {cr['id']}")
        r.uncertainty = (f"The {fmt(int(cr['rate_cents']))} per {unit} price is agreed only for {_scope_text(_scope(cr))}; "
                         f"this invoice covers deliveries {_period_text(b.delivery_period)}. Without delivery tickets "
                         f"showing how much of the {fmt_qty(qty, unit)} was delivered inside that scope, only the quoted "
                         "price is authorised.")
        return
    r.variance_cents = max(r.claimed_cents - allowed, 0)
    r.calculation = (f"Allowed {' + '.join(parts)} = {fmt(allowed)}; billed {fmt_qty(qty, unit)} x {fmt(price)} = "
                     f"{fmt(r.claimed_cents)}" + (f"; difference {fmt(r.variance_cents)}" if r.variance_cents else ""))
    if r.variance_cents:
        r.status, r.hold_code = "variance", "PRICE_VARIANCE"
        rule = _accepted_term(b, "price_change_rule")
        r.uncertainty = ("No accepted amendment covers this price. " + (f"Quote terms: \"{rule['text']}\"" if rule else ""))
    else:
        r.status = "accepted"


def _charge_line(b: InvoiceBundle, l: dict[str, Any], r: LineResult) -> None:
    cr = next((c for c in b.change_requests if c["id"] == l["linked_change_request_id"]), None)
    if cr is None:
        if l["kind"] == "fuel" and _accepted_term(b, "fuel_surcharge_rule"):
            r.status, r.classification, r.hold_code = "pending", "AUTHORISED_RATE_USAGE_MISSING", "USAGE_EVIDENCE_MISSING"
            r.pending_cents = r.claimed_cents
            r.uncertainty = "The fuel surcharge rule is accepted, but the diesel index for the delivery week hasn't been checked."
            return
        rule = _accepted_term(b, "extra_charge_rule")
        r.status, r.classification, r.hold_code, r.pending_cents = "pending", "PROPOSED", "PROPOSED_CHARGE", r.claimed_cents
        r.uncertainty = "Not in the quote or any recorded amendment." + (f" Quote terms: \"{rule['text']}\"" if rule else "")
        return
    r.fragment_ids += _frags(cr) + list(json.loads(cr.get("supplier_acceptance_fragment_ids_json") or "[]"))
    r.classification = cls = effective_classification(cr)
    if cls == "AUTHORISED_FIXED":
        allowed = int(cr["amount_cents"])
        r.accepted_cents, r.variance_cents = min(r.claimed_cents, allowed), max(r.claimed_cents - allowed, 0)
        r.status, r.hold_code = ("variance", "PRICE_VARIANCE") if r.variance_cents else ("accepted", "")
        r.calculation = (f"Agreed flat {fmt(allowed)} (approved in the app by {cr['decided_by_role']}, accepted by the supplier); "
                         f"billed {fmt(r.claimed_cents)}")
        return
    if cls == "AUTHORISED_RATE_USAGE_MISSING":
        scoped, rate = _scope(cr).get("quantity_milli"), int(cr["rate_cents"])
        qty = int(l["quantity_milli"])
        if scoped is not None and l["unit"] == cr["rate_unit"]:
            allowed = min(qty, int(scoped)) * rate // 1000
            r.accepted_cents, r.variance_cents = min(r.claimed_cents, allowed), max(r.claimed_cents - allowed, 0)
            r.status, r.hold_code = ("variance", "PRICE_VARIANCE") if r.variance_cents else ("accepted", "")
            r.calculation = f"Agreed {fmt_qty(int(scoped), cr['rate_unit'])} at {fmt(rate)} = {fmt(allowed)}; billed {fmt(r.claimed_cents)}"
            return
        r.status, r.hold_code, r.pending_cents = "pending", "USAGE_EVIDENCE_MISSING", r.claimed_cents
        r.uncertainty = f"The rate {fmt(rate)}/{cr['rate_unit']} is agreed, but nothing proves {fmt_qty(qty, l['unit'])} was used."
        return
    r.status, r.hold_code, r.pending_cents = "pending", "PROPOSED_CHARGE", r.claimed_cents
    if cls == "PROPOSED" and cr["supplier_acceptance"] == "accepted" and cr["internal_status"] == "pending":
        # Only we can decide this one: nothing goes to the supplier about it.
        r.awaiting_decision_by = decider(b, _exposure(cr, l))
        r.uncertainty = (f"The supplier confirmed this charge in writing; it needs an in-app decision by "
                         f"{r.awaiting_decision_by} (within their limit).")
        return
    rule = _accepted_term(b, "extra_charge_rule")
    r.uncertainty = {"DECLINED": "This charge was declined.",
                     "AMBIGUOUS": "The emails don't clearly agree to this charge."}.get(
        cls, "Mentioned as possible, but never agreed in writing or approved.") + \
        (f" Quote terms: \"{rule['text']}\"" if rule else "")


def _exposure(cr: dict[str, Any], l: dict[str, Any]) -> int:
    rate = int(cr["rate_cents"])
    return int(cr["amount_cents"]) + (extend_up(int(l["quantity_milli"]), rate) if rate else 0)


def decider(b: InvoiceBundle, amount_cents: int) -> str:
    """Who has authority for this amount: the smallest sufficient limit wins (purchasing before the owner)."""
    project = (b.purchase or {}).get("project_id", "")
    able = [a for a in b.authorities if a["role"] in {"purchasing", "owner"} and int(a["limit_cents"]) >= amount_cents
            and a["project_scope"] in {"*", project}]
    return min(able, key=lambda a: (int(a["limit_cents"]), a["role"]))["role"] if able else "owner"


def assess_line(b: InvoiceBundle, l: dict[str, Any]) -> LineResult:
    r = LineResult(l["id"], l["kind"], l["description"], int(l["amount_cents"]), fragment_ids=_frags(l))
    if l["kind"] == "material":
        _material_line(b, l, r)
    elif l["kind"] == "tax":
        r.status, r.hold_code, r.pending_cents = "review", "CONTRACT_REVIEW", r.claimed_cents
        r.uncertainty = "Tax needs a configured rate; it is never estimated."
    else:
        _charge_line(b, l, r)
    return r


def apply_decisions(b: InvoiceBundle, lines: list[LineResult]) -> None:
    """The owner's settlement decisions (§9.9). One applies only while its amount still equals the line's
    disputed amount; otherwise the line is disputed again and needs a new decision."""
    by_line = {d["invoice_line_id"]: d for d in b.decisions}
    for r in lines:
        d = by_line.get(r.line_id)
        disputed = r.disputed_cents
        if d is None or disputed <= 0:
            continue
        if int(d["amount_cents"]) != disputed:
            r.uncertainty = (f"{r.uncertainty} The owner's decision {d['id']} was for {fmt(int(d['amount_cents']))}, "
                             f"but {fmt(disputed)} is disputed now, so it no longer applies.").strip()
            continue
        r.decision, r.decision_id = d["decision"], d["id"]
        if d["decision"] == "accept_as_billed":
            r.calculation = (f"{r.calculation}; the owner accepted the {fmt(disputed)} difference as billed "
                             f"({d['id']})").lstrip("; ")
            r.accepted_cents += disputed
            r.pending_cents = r.variance_cents = 0
            r.status, r.hold_code, r.classification, r.uncertainty = "accepted", "", "AUTHORISED_FIXED", ""
        else:
            r.status = "disputed"
            r.uncertainty = (f"Disputed by the owner's decision {d['id']}: the agreed part is paid, {fmt(disputed)} stays "
                             "open until the supplier sends a corrected invoice or an agreed credit.")


# ---------------------------------------------------------------- checks (each may open holds)

CheckFn = Callable[[InvoiceBundle, list[LineResult]], tuple[CheckOutcome, list[HoldSpec]]]


def _line_holds(lines: list[LineResult], codes: set[str]) -> list[HoldSpec]:
    out: dict[str, list[LineResult]] = {}
    for r in lines:
        if r.hold_code in codes:
            out.setdefault(r.hold_code, []).append(r)
    return [HoldSpec(code, sum(r.variance_cents if code == "PRICE_VARIANCE" else r.pending_cents for r in rs),
                     " ".join(f"{r.description}: {r.calculation or r.uncertainty}".strip() for r in rs),
                     {"line_ids": [r.line_id for r in rs], "fragment_ids": sorted({f for r in rs for f in r.fragment_ids})})
            for code, rs in out.items()]


def check_extraction(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    rev = b.revision
    total = sum(r.claimed_cents for r in lines)
    problems = []
    if not lines:
        problems.append("no invoice lines were read")
    if total != rev["gross_cents"]:
        problems.append(f"lines add up to {fmt(total)} but the gross shown is {fmt(rev['gross_cents'])}")
    if rev["gross_cents"] - rev["deposit_shown_cents"] != rev["balance_requested_cents"]:
        problems.append(f"gross {fmt(rev['gross_cents'])} less deposit {fmt(rev['deposit_shown_cents'])} isn't the balance "
                        f"requested {fmt(rev['balance_requested_cents'])}")
    if problems:
        summary = "Invoice doesn't add up: " + "; ".join(problems) + "."
        return (CheckOutcome("extraction", "fail", summary, {"problems": problems}, "document"),
                [HoldSpec("EXTRACTION_REVIEW", abs(rev["gross_cents"] - total), summary, {"problems": problems})])
    return CheckOutcome("extraction", "pass", f"Lines add up to the gross {fmt(total)}; balance math checks.", {}, "document"), []


def check_contract(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    problems = []
    p = b.purchase
    if p is None:
        problems.append("the invoice isn't linked to a purchase")
    else:
        if p["status"] == "contract_review":
            problems.append("the quote and PO don't establish an agreement (acceptance or acknowledgement missing)")
        for code in ("unit_price", "max_quantity"):
            if _accepted_term(b, code) is None:
                problems.append(f"no accepted {code.replace('_', ' ')} term")
        if b.invoice["currency"] != p.get("currency", "USD"):
            problems.append(f"invoice is in {b.invoice['currency']}, the purchase in {p.get('currency')}")
    problems += [r.uncertainty for r in lines if r.hold_code == "CONTRACT_REVIEW"]
    if problems:
        summary = "Needs contract review: " + "; ".join(problems)
        return (CheckOutcome("contract", "fail", summary, {"problems": problems}, "contract"),
                [HoldSpec("CONTRACT_REVIEW", sum(r.pending_cents for r in lines if r.hold_code == "CONTRACT_REVIEW"),
                          summary, {"problems": problems})])
    return CheckOutcome("contract", "pass", "Accepted quote and acknowledged PO establish the terms.", {}, "contract"), []


def check_price_terms(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    material = [r for r in lines if r.kind == "material"]
    holds = _line_holds(material, {"PRICE_VARIANCE", "USAGE_EVIDENCE_MISSING"})  # the latter: a scoped price, unallocated
    if holds:
        return CheckOutcome("price_terms", "fail", holds[0].reason, {"lines": [asdict(r) for r in material]}, "contract"), holds
    return CheckOutcome("price_terms", "pass", "Material billed at the accepted price.",
                        {"lines": [asdict(r) for r in material]}, "contract"), []


def check_extra_charges(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    extras = [r for r in lines if r.kind not in {"material", "tax"}]
    holds = _line_holds(extras, {"PRICE_VARIANCE", "PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING"})
    kept = [r for r in extras if r.status == "accepted"]
    summary = "; ".join([f"Kept {r.description} ({fmt(r.accepted_cents)}): {r.classification}" for r in kept] +
                        [f"Pending {r.description} ({fmt(r.pending_cents)}): {r.uncertainty}" for r in extras if r.pending_cents]) \
        or "No extra charges billed."
    return CheckOutcome("extra_charges", "fail" if holds else "pass", summary,
                        {"lines": [asdict(r) for r in extras]}, "contract"), holds


def check_po_ceiling(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    cap, base = _accepted_term(b, "max_quantity"), _accepted_term(b, "unit_price")
    unit = (b.purchase or {}).get("unit", "")
    if cap is None:
        return CheckOutcome("po_ceiling", "skipped", "No accepted maximum quantity (contract check covers it).", {}, "contract"), []
    this = sum(int(l["quantity_milli"]) for l in b.lines if l["kind"] == "material" and l["unit"] == unit)
    before = sum(int(l["quantity_milli"]) for o in b.others if o["invoice"]["purchase_id"] == b.invoice["purchase_id"]
                 for l in o["lines"] if l["kind"] == "material" and l["unit"] == unit)
    ceiling = int(cap["quantity_milli"])
    ev = {"ceiling_milli": ceiling, "billed_before_milli": before, "this_invoice_milli": this, "unit": unit}
    if before + this > ceiling:
        over = before + this - ceiling
        amount = over * int(base["amount_cents"]) // 1000 if base else 0
        summary = (f"Billed {fmt_qty(before + this, unit)} to date against a maximum of {fmt_qty(ceiling, unit)} "
                   f"({fmt_qty(over, unit)} over). Deliveries above the maximum need a written change.")
        return CheckOutcome("po_ceiling", "fail", summary, ev, "contract"), [HoldSpec("PO_CEILING", amount, summary, ev)]
    return CheckOutcome("po_ceiling", "pass", f"{fmt_qty(before + this, unit)} billed to date of {fmt_qty(ceiling, unit)} allowed.",
                        ev, "contract"), []


def check_duplicate(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    sha = (b.document or {}).get("sha256", "")
    for o in b.others:
        reason = ""
        if sha and (o.get("document") or {}).get("sha256") == sha:
            reason = f"the same PDF was already recorded as invoice {o['invoice']['invoice_number']}"
        elif o["invoice"]["invoice_number"] == b.invoice["invoice_number"]:
            reason = f"invoice number {b.invoice['invoice_number']} was already recorded without a correction notice"
        elif o["revision"]["gross_cents"] == b.revision["gross_cents"] and o["invoice"]["invoice_date"] == b.invoice["invoice_date"]:
            reason = f"same amount and date as invoice {o['invoice']['invoice_number']}"
        if reason:
            summary = f"Possible duplicate: {reason}."
            ev = {"other_invoice_id": o["invoice"]["id"]}
            return CheckOutcome("duplicate", "fail", summary, ev, "history"), [HoldSpec("DUPLICATE_REVIEW", b.revision["gross_cents"], summary, ev)]
    return CheckOutcome("duplicate", "pass", "No earlier invoice with this file, number, or amount and date.", {}, "history"), []


def deposit_numbers(b: InvoiceBundle) -> tuple[int, int]:
    """(available to this invoice, already applied to this invoice). A deposit is applied once."""
    settled = sum(int(d["amount_cents"]) for d in b.deposits if d["status"] == "settled")
    elsewhere = sum(int(a["amount_cents"]) for a in b.allocations if a["invoice_id"] != b.invoice["id"])
    here = sum(int(a["amount_cents"]) for a in b.allocations if a["invoice_id"] == b.invoice["id"])
    return settled - elsewhere, here


def check_deposit(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    available, _ = deposit_numbers(b)
    shown = int(b.revision["deposit_shown_cents"])
    ev = {"available_cents": available, "shown_cents": shown}
    if shown > available:
        summary = f"Invoice deducts a {fmt(shown)} deposit but only {fmt(available)} of deposits is unapplied."
        return CheckOutcome("deposit", "fail", summary, ev, "history"), [HoldSpec("CONTRACT_REVIEW", shown - available, summary, ev)]
    if shown < available:
        return CheckOutcome("deposit", "warn", f"Invoice deducts {fmt(shown)}; {fmt(available - shown)} of the deposit stays "
                                               "available for later invoices.", ev, "history"), []
    return CheckOutcome("deposit", "pass", f"Deposit of {fmt(shown)} applied once." if shown else "No deposit to apply.", ev, "history"), []


def check_receipt(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    needed: dict[str, int] = {}
    for l in b.lines:
        if l["kind"] == "material":
            needed[l["unit"]] = needed.get(l["unit"], 0) + int(l["quantity_milli"])
    attested: dict[str, int] = {}
    for a in b.attestations:
        attested[a["unit"]] = attested.get(a["unit"], 0) + int(a["quantity_milli"])
    ev = {"billed_milli": needed, "attested_milli": attested, "label": "MANUALLY_CONFIRMED"}
    if needed and all(attested.get(u, 0) >= q for u, q in needed.items()):
        return CheckOutcome("receipt", "pass", "Receipt of " + ", ".join(fmt_qty(q, u) for u, q in needed.items()) +
                            " attested by the superintendent (MANUALLY_CONFIRMED, not machine-verified).", ev, "audit"), []
    missing = ", ".join(fmt_qty(q - attested.get(u, 0), u) for u, q in needed.items() if attested.get(u, 0) < q) or "the billed material"
    summary = f"Nobody has attested receipt of {missing}. Countersign can't verify deliveries; the superintendent must confirm."
    return CheckOutcome("receipt", "fail", summary, ev, "audit"), [HoldSpec("RECEIPT_NOT_VERIFIED", 0, summary, ev)]


def check_payee(b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    verified = [p for p in b.payee_profiles if p["status"] == "verified"]
    pending = [p for p in b.payee_profiles if p["status"] == "pending"]
    if pending:
        summary = (f"A new payee account ending {pending[0]['last4']} was requested via {pending[0]['requested_via']}. "
                   "The owner must verify it by calling a contact already on file.")
        ev = {"pending_profile_ids": [p["id"] for p in pending]}
        return CheckOutcome("payee", "fail", summary, ev, "audit"), [HoldSpec("PAYEE_CHANGE_PENDING", 0, summary, ev)]
    if not verified:
        summary = "No verified payee account on file for this supplier."
        return CheckOutcome("payee", "fail", summary, {}, "audit"), [HoldSpec("PAYEE_CHANGE_PENDING", 0, summary, {})]
    return CheckOutcome("payee", "pass", f"Pays the verified account ending {verified[0]['last4']} ({verified[0]['id']}).",
                        {"payee_profile_id": verified[0]["id"]}, "audit"), []


CHECKS: list[tuple[str, CheckFn, str]] = [
    ("extraction", check_extraction, "EXTRACTION_REVIEW"),
    ("contract", check_contract, "CONTRACT_REVIEW"),
    ("price_terms", check_price_terms, "PRICE_VARIANCE"),
    ("extra_charges", check_extra_charges, "PROPOSED_CHARGE"),
    ("po_ceiling", check_po_ceiling, "PO_CEILING"),
    ("duplicate", check_duplicate, "DUPLICATE_REVIEW"),
    ("deposit", check_deposit, "CONTRACT_REVIEW"),
    ("receipt", check_receipt, "RECEIPT_NOT_VERIFIED"),
    ("payee", check_payee, "PAYEE_CHANGE_PENDING"),
]


def _run(code: str, fn: CheckFn, hold_code: str, b: InvoiceBundle, lines: list[LineResult]) -> tuple[CheckOutcome, list[HoldSpec]]:
    try:
        return fn(b, lines)
    except Exception as e:  # fail safe: a check that can't run is a hold, never a pass
        summary = f"The {code} check couldn't run ({type(e).__name__}); holding to be safe."
        return CheckOutcome(code, "error", summary, {"error": str(e)}), [HoldSpec(hold_code, 0, summary, {"error": str(e)})]


def _merge(holds: list[HoldSpec]) -> list[HoldSpec]:
    """One hold per code per revision (CONTRACT §9.8): amounts add up, reasons are kept."""
    merged: dict[str, HoldSpec] = {}
    for h in holds:
        if h.code in merged:
            m = merged[h.code]
            merged[h.code] = HoldSpec(h.code, m.amount_cents + h.amount_cents, f"{m.reason} {h.reason}", {"parts": [m.evidence, h.evidence]})
        else:
            merged[h.code] = h
    return sorted(merged.values(), key=lambda h: HOLD_ORDER.index(h.code))


# ---------------------------------------------------------------- the assessment


def _canon(row: Any) -> Any:
    if isinstance(row, dict):
        return {k: _canon(v) for k, v in sorted(row.items())
                if k not in VOLATILE and k != "identity" and not k.endswith("_identity")}
    if isinstance(row, list):
        return [_canon(v) for v in row]
    return row


def _identity(inv: dict[str, Any]) -> dict[str, Any]:
    return {k: inv.get(k) for k in ("id", "supplier_id", "purchase_id", "invoice_number", "invoice_date", "due_date",
                                    "currency", "active_revision_id")}


def _row_hash(value: Any) -> str:
    return hashlib.sha256(dumps(_canon(value)).encode()).hexdigest()[:16]


def input_digest(b: InvoiceBundle) -> dict[str, Any]:
    """One short hash per input row, by section. Stored with the assessment, so a later check can say
    which input changed, not only that the fingerprint did. Invoice status columns are outputs of
    assessments, not inputs, so they're left out."""
    rows = lambda rs: {str(r.get("id")): _row_hash(r) for r in rs}  # noqa: E731
    return {
        "policy_version": POLICY_VERSION,
        "invoice": {b.invoice["id"]: _row_hash(_identity(b.invoice))},
        "revision": rows([b.revision]), "lines": rows(b.lines), "purchase": rows([b.purchase] if b.purchase else []),
        "terms": rows(b.terms), "change_requests": rows(b.change_requests), "deposits": rows(b.deposits),
        "allocations": rows(b.allocations), "attestations": rows(b.attestations), "payee_profiles": rows(b.payee_profiles),
        "authorities": {"all": _row_hash(sorted((a["role"], int(a["limit_cents"]), a["project_scope"]) for a in b.authorities))},
        "document": {(b.document or {}).get("id", ""): (b.document or {}).get("sha256", "")},
        "others": {o["invoice"]["id"]: _row_hash({"invoice": _identity(o["invoice"]), "revision": o["revision"], "lines": o["lines"],
                                                  "document_sha256": (o.get("document") or {}).get("sha256", "")})
                   for o in b.others},
        **({"settlement_decisions": rows(b.decisions)} if b.decisions else {}),
        **({"delivery_period": dict(b.delivery_period or {})} if _date_scoped(b) else {}),  # only when it can matter
    }


def _date_scoped(b: InvoiceBundle) -> bool:
    return any(c["kind"] == "price_change" and any(_scope(c).get(k) for k in ("from", "to", "delivery_refs"))
               for c in b.change_requests)


def fingerprint(b: InvoiceBundle) -> str:
    """Hash of every input the assessment read, plus the policy version."""
    return "fp_" + hashlib.sha256(dumps(input_digest(b)).encode()).hexdigest()[:32]


def changed_inputs(before: dict[str, Any], now: dict[str, Any]) -> list[str]:
    """What differs between two input digests, e.g. "attestations att_2 added"."""
    out = []
    if before.get("policy_version") != now.get("policy_version"):
        out.append(f"policy version {before.get('policy_version')} -> {now.get('policy_version')}")
    for section in sorted((set(before) | set(now)) - {"policy_version"}):
        b, n = before.get(section) or {}, now.get(section) or {}
        for key in sorted(set(b) | set(n)):
            if key not in b:
                out.append(f"{section} {key} added")
            elif key not in n:
                out.append(f"{section} {key} removed")
            elif b[key] != n[key]:
                out.append(f"{section} {key} changed")
    return out


def _clarification_points(lines: list[LineResult], holds: list[HoldSpec]) -> list[str]:
    points = []
    for r in lines:
        if r.status == "variance":
            points.append(f"{r.description}: {r.calculation}. {r.uncertainty}".strip())
        elif r.status == "pending" and r.hold_code in {"PROPOSED_CHARGE", "USAGE_EVIDENCE_MISSING"} and not r.awaiting_decision_by:
            points.append(f"{r.description} ({fmt(r.pending_cents)}): {r.uncertainty}")
    if points:
        points.append("Please send a corrected invoice or an agreed credit memo. We'll keep your original invoice on file.")
    return points


def _next(status: str, codes: set[str], under_review: int, proposed: int, lines: list[LineResult]) -> tuple[str, str]:
    if "DUPLICATE_REVIEW" in codes or "EXTRACTION_REVIEW" in codes or "CONTRACT_REVIEW" in codes:
        return "owner", "Review the flagged invoice details before anything else."
    waiting = [r for r in lines if r.awaiting_decision_by]
    if waiting:  # decide our side first, so the supplier gets one complete email afterwards
        who = "owner" if any(r.awaiting_decision_by == "owner" for r in waiting) else waiting[0].awaiting_decision_by
        what = "; ".join(f"{r.description} ({fmt(r.claimed_cents)})" for r in waiting)
        return who, f"Decide in the app: {what}. The supplier confirmed it; nothing goes to the supplier until it's decided."
    if status == "differences_under_review":
        return "purchasing", f"Ask the supplier for a corrected invoice or an agreed credit for the {fmt(under_review)} under review."
    if "RECEIPT_NOT_VERIFIED" in codes:
        return "receiver", "Superintendent: confirm what was received (manual attestation)."
    if "PAYEE_CHANGE_PENDING" in codes or "SUPPLIER_RISK" in codes:
        return "owner", "Verify the payee change by calling a contact already on file."
    if status == "partially_disputed":
        return "owner", (f"Review and approve the {fmt(proposed)} agreed payment once the notice to the supplier is sent; "
                         f"{fmt(under_review)} stays disputed.")
    return "owner", f"Review and approve the {fmt(proposed)} payment."


def assess(b: InvoiceBundle) -> Assessment:
    lines = [assess_line(b, l) for l in sorted(b.lines, key=lambda l: l["id"])]
    apply_decisions(b, lines)
    checks, holds = [], []
    for code, fn, hold_code in CHECKS:
        outcome, hs = _run(code, fn, hold_code, b, lines)
        checks.append(outcome)
        holds += hs
    holds = _merge(holds)
    codes = {h.code for h in holds}
    claimed = sum(r.claimed_cents for r in lines)
    authorised = sum(r.accepted_cents for r in lines)
    pending = sum(r.pending_cents for r in lines)
    variance = sum(r.variance_cents for r in lines)
    available, _ = deposit_numbers(b)
    applied = int(b.revision["deposit_shown_cents"]) if int(b.revision["deposit_shown_cents"]) <= available else 0
    balance = int(b.revision["balance_requested_cents"])
    # A money hold is settled for now when every disputed line it covers has the owner's "pay agreed, dispute
    # the rest" decision. PO_CEILING covers no line, so only a correction settles it.
    disputed_lines = lambda code: [r for r in lines if r.hold_code == code and r.disputed_cents > 0]
    settled = {c for c in codes & MONEY_HOLDS if c != "PO_CEILING" and disputed_lines(c)
               and all(r.decision == "pay_agreed_dispute_rest" for r in disputed_lines(c))}
    status = ("contract_review" if "CONTRACT_REVIEW" in codes
              else "differences_under_review" if (codes & COMMERCIAL_HOLDS) - settled
              else "partially_disputed" if settled else "matches")
    under_review = pending + variance
    # Never silently pay less: all of the balance requested, or nothing and a request for a correction; or,
    # when the owner decided every disputed line, what's authorised (the notice tells the supplier).
    if status == "matches":
        proposed = balance if authorised == claimed and claimed - applied == balance else 0
    elif status == "partially_disputed":
        proposed = authorised - applied if authorised + under_review == claimed and authorised > applied else 0
    else:
        proposed = 0
    owner, action = _next(status, codes, under_review, proposed, lines)
    ours = sum(r.pending_cents for r in lines if r.awaiting_decision_by)
    summary = (f"Claimed {fmt(claimed)}: {fmt(authorised)} authorised, {fmt(variance)} price variance, {fmt(pending)} pending"
               + (f" ({fmt(ours)} of it waits for our own decision). " if ours else ". ")
               + (f"The owner decided every disputed line: {fmt(proposed)} agreed proposed after the {fmt(applied)} deposit; "
                  f"{fmt(under_review)} stays disputed (not savings until the supplier agrees)." if status == "partially_disputed"
                  else f"{fmt(under_review)} under review (not savings until the supplier agrees)." if under_review
                  else f"Everything claimed is authorised; {fmt(proposed)} proposed after the {fmt(applied)} deposit."))
    return Assessment(
        revision_id=b.revision["id"], claimed_cents=claimed, authorised_cents=authorised, pending_cents=pending,
        variance_cents=variance, under_review_cents=under_review, balance_requested_cents=balance,
        deposit_available_cents=available, deposit_applied_cents=applied,
        conditional_payment_cents=max(authorised - applied, 0), proposed_payment_cents=proposed,
        commercial_status=status, holds=holds, checks=checks, lines=lines,
        clarification_points=_clarification_points(lines, holds), summary=summary, next_action=action,
        next_owner_role=owner, fingerprint=fingerprint(b), inputs=input_digest(b))


def ready_to_post_bill(a: Assessment) -> bool:
    """CONTRACT §9.6: the bill is booked only once it's commercially accepted and receipt is attested.
    A partially disputed invoice is booked at what's authorised (§9.9)."""
    return a.commercial_status in {"matches", "partially_disputed"} and "RECEIPT_NOT_VERIFIED" not in a.hold_amounts()


# ---------------------------------------------------------------- store glue


def _sorted(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(rows, key=lambda r: str(r.get("id", "")))


def active_decisions(store: Store, **filters: Any) -> list[dict[str, Any]]:
    """Active settlement decisions (§9.9). A module without the v2.2 table has none. Reading none can only lower
    what's proposed (an undecided disputed line proposes $0), so this never pays more than the decisions allow."""
    try:
        return _sorted(store.rows("settlement_decision", status="active", **filters))
    except StoreError as e:
        if "settlement_decision" in str(e):
            return []
        raise


def _delivery_period(store: Store, document_id: str) -> dict[str, str] | None:
    """The delivery period the revision's latest validated reading cites, or None if it states none."""
    runs = store.rows("extraction_run", document_id=document_id, status="ok")
    if not runs:
        return None
    try:
        ext = json.loads(max(runs, key=lambda r: (r["created_at"], r["id"]))["fields_json"] or "{}")
    except json.JSONDecodeError:
        return None
    value = ((ext.get("fields") or {}).get("delivery_period") or {}).get("value")
    if isinstance(value, dict) and isinstance(value.get("from"), str) and isinstance(value.get("to"), str):
        return {"from": value["from"], "to": value["to"]}
    return None


def bundle_from_store(store: Store, invoice_id: str) -> InvoiceBundle:
    inv = one(store, "invoice", id=invoice_id)
    assert inv is not None, f"unknown invoice {invoice_id}"
    rev = one(store, "invoice_revision", id=inv["active_revision_id"])
    assert rev is not None, f"invoice {invoice_id} has no active revision"
    pid = inv["purchase_id"]
    deposits = _sorted(store.rows("deposit", purchase_id=pid)) if pid else []
    others = []
    for o in _sorted(store.rows("invoice", supplier_id=inv["supplier_id"])):
        if o["id"] == invoice_id or not o["active_revision_id"]:
            continue
        orev = one(store, "invoice_revision", id=o["active_revision_id"])
        others.append({"invoice": o, "revision": orev, "lines": _sorted(store.rows("invoice_line", revision_id=orev["id"])),
                       "document": one(store, "document", id=orev["document_id"])})
    return InvoiceBundle(
        invoice=inv, revision=rev, lines=_sorted(store.rows("invoice_line", revision_id=rev["id"])),
        purchase=one(store, "purchase", id=pid) if pid else None,
        terms=_sorted(store.rows("term", purchase_id=pid)) if pid else [],
        change_requests=_sorted([c for c in store.rows("change_request", purchase_id=pid) if c["kind"] != "settlement"]) if pid else [],
        deposits=deposits,
        allocations=_sorted([a for d in deposits for a in store.rows("deposit_allocation", deposit_id=d["id"])]),
        attestations=_sorted(store.rows("receipt_attestation", invoice_id=invoice_id)),
        payee_profiles=_sorted(store.rows("payee_profile", supplier_id=inv["supplier_id"])),
        authorities=sorted(store.rows("authority"), key=lambda a: (a["role"], str(a["identity"]))),
        document=one(store, "document", id=rev["document_id"]), others=others,
        decisions=active_decisions(store, revision_id=rev["id"]), delivery_period=_delivery_period(store, rev["document_id"]))


def record(store: Store, a: Assessment, role: str = "agent") -> str:
    """Store the assessment and open its holds (idempotent ids). The agent opens holds; it never resolves them."""
    version = len(store.rows("assessment", revision_id=a.revision_id)) + 1
    assessment_id = f"asm_{a.revision_id.removeprefix('rev_')}_v{version}"
    res = R.record_assessment(store, assessment_id, a.revision_id, version, a.fingerprint, a.policy_version, a.claimed_cents,
                              a.authorised_cents, a.pending_cents, a.variance_cents, a.deposit_available_cents,
                              a.proposed_payment_cents, a.commercial_status, a.summary, a.details(), a.next_action)
    if not res.ok:
        raise RuntimeError(f"record_assessment: {res.outcome} {res.message}")
    for h in a.holds:
        R.open_hold(store, role, hold_id(a.revision_id, h.code), a.revision_id, h.code, h.amount_cents, h.reason, h.evidence)
    return assessment_id
