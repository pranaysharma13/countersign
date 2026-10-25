"""The bill pipeline on top of the store: seed, intake, investigation tools, gateway, ledger.

`AgentTools` are the only actions the agent has. The scripted agent (agent.run_scripted)
and the Droid agent (agent.run_droid) both use them, so every step is logged the same way.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from . import reducers as R
from .checks import BILL_CHECKS, CheckContext, CheckOutcome, run_check
from .config import FILES_DIR
from .decide import Decision, decide
from .extract import extract_bill
from .ids import sha256_hex, sha8, short_uuid
from .integrations import crs, license, nessie
from .money import fmt
from .pdfs import render_bill
from .store import Store, StoreError, one
from .world import BillDoc, World

NOT_GENUINE_STATES = {"held", "closed_held", "rejected", "failed", "override_requested", "needs_info"}


class PipelineError(RuntimeError):
    pass


def _ok(res: R.Result, what: str) -> R.Result:
    if not res.ok:
        raise PipelineError(f"{what}: {res.outcome} {res.message}")
    return res


# --------------------------------------------------------------------------- seed


def load_seed(store: Store, world: World, *, owner: Store | None = None) -> dict[str, int]:
    """Load the company, subs, contracts and paid history. `owner` confirms contracts and
    approves change orders (seed only; the running worker never holds the owner key)."""
    co = world.company
    _ok(R.upsert_company(store, "sync", co.id, co.name, co.owner_name, co.state, co.bank_account_ref, co.bank_last4), "company")
    for p in world.projects:
        _ok(R.upsert_project(store, "sync", p.id, p.name, p.address, "active"), "project")
    for s in world.subs:
        _ok(R.upsert_sub(store, "sync", s.id, s.name, s.trade, s.license_number, "CA", s.contact_email, s.email_domain,
                         s.phone_on_file, s.bank_account_ref, s.bank_last4, s.name, s.crs_ref, "active"), f"sub {s.id}")
    from .world import BANK_CHANGE_CLAUSE

    for c in world.contracts:
        _ok(R.upsert_contract(store, "sync", c.id, c.sub_id, c.project_id, c.title, c.value_cents, c.retainage_bps,
                              c.payment_terms_days, c.lien_waiver_rule, BANK_CHANGE_CLAUSE, ""), f"contract {c.id}")
        for line in c.lines:
            _ok(R.upsert_contract_line(store, "sync", f"{c.id}:{line.code}", c.id, line.code, line.description,
                                       line.scheduled_cents), "contract line")
    for chg in world.change_orders:
        _ok(R.upsert_change_order(store, "sync", chg.id, chg.contract_id, chg.number, chg.description, chg.amount_cents), "co")
    if owner is not None:
        for c in world.contracts:
            _ok(R.confirm_contract(owner, "owner", c.id), f"confirm {c.id}")
        for chg in world.change_orders:
            if chg.approved:
                _ok(R.decide_change_order(owner, "owner", chg.id, True, "seed"), "approve co")

    balance = co.opening_balance_cents
    for doc in world.history:
        _record_history_bill(store, world, doc)
        balance -= doc.net_cents
    _ok(R.record_bank_snapshot(store, "sync", f"snap_seed", co.bank_account_ref, balance, "2026-10-01"), "snapshot")
    client = nessie.client()
    if isinstance(client, nessie.MockNessie):
        client.balances[co.bank_account_ref] = balance
    return {"subs": len(world.subs), "contracts": len(world.contracts), "history_bills": len(world.history)}


def _record_history_bill(store: Store, world: World, doc: BillDoc) -> None:
    _ok(R.record_bill(store, "sync", doc.id, doc.sub_id, doc.contract_id, "", doc.invoice_number, doc.bill_date,
                      doc.due_date, doc.period_label, doc.amount_cents, doc.retainage_cents, doc.remit_bank_name,
                      world.sub(doc.sub_id).bank_account_ref, doc.remit_account_last4, doc.from_address, doc.has_lien_waiver,
                      {"remit_routing": doc.remit_routing, "seed": True}), f"bill {doc.id}")
    for i, l in enumerate(doc.lines):
        _ok(R.record_bill_line(store, "sync", f"{doc.id}:{i}", doc.id, l.code, l.description, l.this_period_cents,
                               l.previous_cents, l.percent_complete_bps), "bill line")
    project = next(c.project_id for c in world.contracts if c.id == doc.contract_id)
    for jid, lines in journals_for_payment(doc.id, project, doc.amount_cents, doc.retainage_cents):
        _ok(R.post_journal(store, "sync", f"{jid}", doc.bill_date, f"{doc.vendor_name} {doc.invoice_number}", "seed", doc.id,
                           lines), "journal")


def journals_for_payment(bill_id: str, project_id: str, gross: int, retainage: int) -> list[tuple[str, list[dict[str, Any]]]]:
    net = gross - retainage
    accrual = [{"account": f"job_cost:{project_id}", "debit_cents": gross, "credit_cents": 0},
               {"account": "accounts_payable", "debit_cents": 0, "credit_cents": net}]
    if retainage:
        accrual.append({"account": "retainage_payable", "debit_cents": 0, "credit_cents": retainage})
    payment = [{"account": "accounts_payable", "debit_cents": net, "credit_cents": 0},
               {"account": "cash", "debit_cents": 0, "credit_cents": net}]
    return [(f"jrnl_{bill_id}_accrual", accrual), (f"jrnl_{bill_id}_payment", payment)]


# --------------------------------------------------------------------------- intake


def ingest(store: Store, world: World, doc: BillDoc, origin: str, *, received_at_iso: str = "2026-10-24T09:00:00") -> str:
    """A bill arrives (upload, inbox, scam page...): save the PDF + email, record the source, open a work item, queue it."""
    project = next((p for p in world.projects if p.id == doc.project_id), None)
    pdf_path = render_bill(doc, world.company, project, FILES_DIR / f"{doc.id}.pdf")
    src_id = f"src_{sha8(pdf_path.read_bytes())}"
    final_pdf = FILES_DIR / f"{src_id}.pdf"
    pdf_path.replace(final_pdf)
    pdf_path.with_suffix(".json").replace(final_pdf.with_suffix(".json"))
    final_pdf.with_suffix(".email.json").write_text(json.dumps(
        {"from": doc.from_address, "subject": doc.subject, "body": doc.email_body}, indent=1))
    _ok(R.record_source_file(store, src_id, origin if origin in {"email", "upload", "scam_page", "legit_page", "scorecard"} else "upload",
                             f"{doc.invoice_number}.pdf", sha256_hex(final_pdf.read_bytes()), received_at_iso,
                             doc.from_address, doc.subject, str(final_pdf)), "source file")
    # Placeholder bill so the web can show the arrival right away; the agent fills it after reading the PDF.
    _ok(R.record_bill(store, "sync", doc.id, "", "", src_id, "", "", "", "", 0, 0, "", "", "", doc.from_address, False,
                      {"status": "awaiting_extraction"}), "placeholder bill")
    wi_id = f"wi_{doc.id}"
    summary = f"{doc.subject or doc.invoice_number} (from {doc.from_address})"
    _ok(R.create_work_item(store, "sync", wi_id, "bill", doc.id, origin, summary), "work item")
    _ok(R.enqueue_job(store, "sync", f"job_bill_{doc.id}", "process_bill", {"work_item_id": wi_id}), "job")
    return wi_id


# --------------------------------------------------------------------------- agent tools


class AgentTools:
    """Everything the agent can do. Reads + findings + proposals. No approvals, no payments."""

    def __init__(self, store: Store, work_item_id: str):
        self.s = store
        self.wi_id = work_item_id
        wi = one(store, "work_item", id=work_item_id)
        if wi is None:
            raise PipelineError(f"unknown work item {work_item_id}")
        self.wi = wi
        self.bill_id = str(wi["entity_id"])
        self.src_id = str((one(store, "bill", id=self.bill_id) or {}).get("source_file_id", ""))
        self._ctx: CheckContext | None = None
        self.outcomes: dict[str, CheckOutcome] = {}

    # -- logging
    def step(self, kind: str, title: str, detail: Any = None) -> None:
        R.log_agent_step(self.s, self.wi_id, kind, title, detail or {})

    def set_state(self, state: str, note: str = "") -> None:
        R.set_work_item_state(self.s, self.wi_id, state, note)

    # -- read
    def read_bill(self) -> dict[str, Any]:
        """Extract the bill's printed fields, match the vendor and contract, and record the bill."""
        src = one(self.s, "source_file", id=self.src_id)
        if src is None:
            raise PipelineError("source file missing")
        pdf = Path(src["storage_path"])
        fields, text = extract_bill(pdf)
        email_path = pdf.with_suffix(".email.json")
        email = json.loads(email_path.read_text()) if email_path.exists() else {"from": src.get("from_address", ""), "subject": "", "body": ""}
        sub = self._match_sub(fields)
        contract_id = self._match_contract(sub, fields)
        extracted = {k: v for k, v in fields.items() if k != "lines"}
        _ok(R.record_bill(self.s, "agent", self.bill_id, sub["id"] if sub else "", contract_id, self.src_id,
                          str(fields.get("invoice_number", "")), str(fields.get("bill_date", "")), str(fields.get("due_date", "")),
                          str(fields.get("period_label", "")), int(fields.get("amount_cents") or 0),
                          int(fields.get("retainage_cents") or 0), str(fields.get("remit_bank_name", "")),
                          "", str(fields.get("remit_account_last4", "")), email["from"], bool(fields.get("has_lien_waiver")),
                          extracted), "record bill")
        for i, l in enumerate(fields.get("lines", [])):
            _ok(R.record_bill_line(self.s, "agent", f"{self.bill_id}:{i}", self.bill_id, str(l.get("code", "")),
                                   str(l.get("description", "")), int(l.get("this_period_cents") or 0),
                                   int(l.get("previous_cents") or 0), int(l.get("percent_complete_bps") or 0)), "bill line")
        self._raw = {"fields": fields, "text": text, "email": email, "sub": sub, "contract_id": contract_id}
        return {"vendor": fields.get("vendor_name"), "matched_sub": sub["id"] if sub else None, "contract": contract_id,
                "invoice": fields.get("invoice_number"), "total": fmt(int(fields.get("amount_cents") or 0)),
                "remit_last4": fields.get("remit_account_last4"), "lines": len(fields.get("lines", [])),
                "lien_waiver": fields.get("has_lien_waiver"), "extractor": fields.get("extractor"),
                "instructions_found_in_document": fields.get("instructions_found", [])}

    def _match_sub(self, fields: dict[str, Any]) -> dict[str, Any] | None:
        subs = self.s.rows("sub")
        lic = str(fields.get("vendor_license", "")).strip()
        name = str(fields.get("vendor_name", "")).strip().lower()
        return (next((s for s in subs if lic and s["license_number"] == lic), None)
                or next((s for s in subs if s["name"].lower() == name), None))

    def _match_contract(self, sub: dict[str, Any] | None, fields: dict[str, Any]) -> str:
        if sub is None:
            return ""
        contracts = self.s.rows("contract", sub_id=sub["id"])
        printed = str(fields.get("contract_id", ""))
        if any(c["id"] == printed for c in contracts):
            return printed
        project = str(fields.get("project_name", "")).lower()
        projects = {p["id"]: p["name"].lower() for p in self.s.rows("project")}
        for c in contracts:
            if project and projects.get(c["project_id"]) == project:
                return c["id"]
        return contracts[0]["id"] if len(contracts) == 1 else ""

    def context(self) -> CheckContext:
        if self._ctx is not None:
            return self._ctx
        raw = getattr(self, "_raw", None)
        if raw is None:
            self.read_bill()
            raw = self._raw
        bill = one(self.s, "bill", id=self.bill_id) or {}
        bill = {**bill, "vendor_name": raw["fields"].get("vendor_name", ""), "vendor_license": raw["fields"].get("vendor_license", ""),
                "remit_routing": raw["fields"].get("remit_routing", "")}
        all_lines = self.s.rows("bill_line")
        by_bill: dict[str, list[dict[str, Any]]] = {}
        for l in all_lines:
            by_bill.setdefault(l["bill_id"], []).append(l)
        sub = raw["sub"]
        contract = one(self.s, "contract", id=raw["contract_id"]) if raw["contract_id"] else None
        prior: list[dict[str, Any]] = []
        if sub:
            items = {str(w["entity_id"]): w for w in self.s.rows("work_item", kind="bill")}
            for b in self.s.rows("bill", sub_id=sub["id"]):
                if b["id"] == self.bill_id:
                    continue
                w = items.get(b["id"])
                if w is not None and (w["state"] in NOT_GENUINE_STATES or w.get("origin") == "scorecard"):
                    continue  # held/rejected bills aren't genuine history; scorecard cases are isolated
                prior.append({**b, "lines": by_bill.get(b["id"], [])})
        company = (self.s.rows("company") or [{}])[0]
        snaps = sorted(self.s.rows("bank_snapshot", account_ref=company.get("bank_account_ref", "")), key=lambda r: r["as_of_iso"])
        committed = sum(int(p["amount_cents"]) for p in self.s.rows("proposal", kind="payment")
                        if p["status"] in {"approved", "executing"})
        self._ctx = CheckContext(
            bill=bill, lines=by_bill.get(self.bill_id, []), sub=sub, contract=contract,
            contract_lines=self.s.rows("contract_line", contract_id=raw["contract_id"]) if contract else [],
            change_orders=self.s.rows("change_order", contract_id=raw["contract_id"]) if contract else [],
            prior_bills=prior, doc_text=raw["text"], email_body=raw["email"].get("body", ""),
            subject=raw["email"].get("subject", ""),
            balance_cents=int(snaps[-1]["balance_cents"]) if snaps else None, committed_cents=committed,
        )
        return self._ctx

    def run_check(self, code: str) -> CheckOutcome:
        """Run one deterministic check and record it. External lookups happen here (cached per sub)."""
        ctx = self.context()
        if code == "license" and ctx.license is None:
            number = (ctx.sub or {}).get("license_number") or ctx.bill.get("vendor_license", "") or "0000000"
            try:
                ctx.license = license.lookup(number)
            except Exception as e:  # noqa: BLE001 - fail safe
                ctx.license = None
                self.step("error", "License lookup failed", {"error": str(e)})
        if code == "crs_liens_judgments" and ctx.crs is None:
            try:
                ctx.crs = crs.business_report(ctx.sub["crs_ref"]) if ctx.sub else {"liens": [], "judgments": [], "bankruptcies": []}
            except Exception as e:  # noqa: BLE001
                ctx.crs = None
                self.step("error", "CRS lookup failed", {"error": str(e)})
        out = run_check(code, ctx)
        self.outcomes[code] = out
        R.record_check(self.s, self.wi_id, out.code, out.status, out.summary, out.evidence, out.source)
        return out

    def decide_and_propose(self, extra_holds: list[str] | None = None, *, override_note: str = "") -> Decision:
        """Apply the deterministic rules and file the proposal. The agent may add holds, never remove them."""
        ctx = self.context()
        outcomes = list(self.outcomes.values())
        d = decide(ctx.bill, outcomes, extra_holds)
        if override_note and d.kind == "hold" and not d.hard_stop:
            net = int(ctx.bill["amount_cents"]) - int(ctx.bill.get("retainage_cents", 0))
            d = Decision("payment", net, f"Owner asked to pay despite: {', '.join(d.blocking)}. Owner's note: {override_note}",
                         d.blocking, d.warnings)
        evidence = [f"{self.wi_id}:{c}" for c in (d.blocking or [o.code for o in outcomes])]
        prop_id = f"prop_{short_uuid()}"
        if d.kind == "payment" and ctx.sub:
            res = R.propose(self.s, prop_id, self.wi_id, "payment", d.amount_cents, ctx.sub["id"], ctx.sub["bank_account_ref"],
                            d.reason, evidence)
        else:
            res = R.propose(self.s, prop_id, self.wi_id, "hold", d.amount_cents, (ctx.sub or {}).get("id", ""), "", d.reason, evidence)
        if not res.ok:
            self.step("error", "Proposal refused by the database", {"outcome": res.outcome, "message": res.message})
            raise PipelineError(f"propose: {res.message}")
        self.step("decision", "Proposed payment for the owner's approval" if d.kind == "payment" else "Held for the owner",
                  {"proposal_id": prop_id, "reason": d.reason, "blocking": d.blocking, "warnings": d.warnings})
        return d


# --------------------------------------------------------------------------- gateway


def pay_proposal(store: Store, proposal_id: str) -> dict[str, Any]:
    """Gateway: pay an approved proposal exactly once, then post the books."""
    p = one(store, "proposal", id=proposal_id)
    if p is None:
        raise PipelineError("unknown proposal")
    if one(store, "payment", id=proposal_id):
        return {"status": "already_paid"}
    if p["status"] == "approved":
        res = R.start_payment(store, proposal_id)
        if not res.ok:
            raise PipelineError(f"start_payment: {res.message}")
    elif p["status"] != "executing":
        raise PipelineError(f"proposal is {p['status']}")
    company = store.rows("company")[0]
    payer, key = company["bank_account_ref"], f"cs:{proposal_id}"
    bank = nessie.client()
    try:
        transfer, recovered = nessie.pay_once(bank, payer, p["payee_account_ref"], int(p["amount_cents"]), key)
    except nessie.NessieError as e:
        R.record_payment(store, proposal_id, "", "failed", str(e))
        return {"status": "failed", "error": str(e)}
    _ok(R.record_payment(store, proposal_id, str(transfer["_id"]), "sent", ""), "record payment")

    wi = one(store, "work_item", id=p["work_item_id"]) or {}
    bill_id = str(wi.get("entity_id", ""))
    bill = one(store, "bill", id=bill_id)
    if bill:
        contract = one(store, "contract", id=bill["contract_id"]) or {}
        gross, ret = int(bill["amount_cents"]), int(bill["retainage_cents"])
        if gross - ret != int(p["amount_cents"]):  # owner-approved override amount: book what was actually paid
            gross, ret = int(p["amount_cents"]), 0
        for jid, lines in journals_for_payment(bill_id, contract.get("project_id", "unassigned"), gross, ret):
            R.post_journal(store, "gateway", jid, "2026-10-24", f"Payment {proposal_id}", "payment", proposal_id, lines)
    try:
        bal = bank.balance_cents(payer)
        R.record_bank_snapshot(store, "gateway", f"snap_{proposal_id}", payer, bal, "2026-10-24T12:00:00")
    except Exception:  # noqa: BLE001 - balance refresh is best-effort
        pass
    return {"status": "sent", "transfer_id": transfer["_id"], "recovered_from_timeout": recovered}


# --------------------------------------------------------------------------- helpers for others


def check_codes() -> list[str]:
    return [c for c, _ in BILL_CHECKS]


def bill_doc_to_dict(doc: BillDoc) -> dict[str, Any]:
    return asdict(doc)


__all__ = ["AgentTools", "PipelineError", "ingest", "load_seed", "pay_proposal", "journals_for_payment", "StoreError"]
