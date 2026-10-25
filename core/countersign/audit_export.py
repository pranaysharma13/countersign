"""Audit export for one supplier invoice (SPEC step E): every audit_log row about it, oldest first,
denied attempts included, with a summary of where it stands. Read-only and deterministic for the
same rows (except `exported_at`).

"About it" = the invoice, its revisions, lines, holds and assessments; its work item, proposals,
approvals and payments; settlement decisions and their notices and change requests; receipt
attestations and deposit allocations; its documents, source files and extraction runs; the jobs that
handled them; its purchase, terms, change requests and deposits; its supplier, contacts and payee
profiles; and its journals. A denial caught before the module knew which record it was about has no
entity id and can't be attributed to an invoice, so it isn't here (the full audit_log has it).

Account tokens are masked: CONTRACT says account_ref is never shown in full.
"""

from __future__ import annotations

import csv
import io
import json
import re
from datetime import UTC, datetime
from typing import Any

from .store import Store, StoreError, one
from .supplier_ledger import balances

NOTES = [
    ("This is the application's append-only history (audit_log, written in the same reducer as each change, "
     "denials included). It is not cryptographically tamper-evident."),
    "Payments are simulated (Nessie sandbox or mock). Receipt attestations are MANUALLY_CONFIRMED, never machine-verified.",
    ("A denial caught before the module identified the record (for example a role that may not call the reducer at all) "
     "has no entity id, so it can't be attributed to this invoice; it is in the full audit_log."),
    "Source fragments are immutable and not listed one by one; their documents are.",
]
CSV_COLUMNS = ("id", "at", "actor_role", "actor_identity", "action", "entity_type", "entity_id", "outcome", "reason",
               "request_id", "before_json", "after_json")
_ACCOUNT = re.compile(r"account_ref$")


class UnknownInvoice(LookupError):
    pass


def _iso(at: Any) -> str:
    """Timestamps as ISO 8601 UTC: microseconds (the fake store) or SpacetimeDB's {"__timestamp_micros_...": n}."""
    if isinstance(at, dict) and len(at) == 1:
        at = next(iter(at.values()))
    if isinstance(at, int) and not isinstance(at, bool):
        return datetime.fromtimestamp(at / 1_000_000, UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    return str(at or "")


def _mask(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: (f"…{str(v)[-4:]}" if _ACCOUNT.search(k) and v else _mask(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask(v) for v in value]
    return value


def _masked_json(raw: Any) -> str:
    if not raw:
        return ""
    try:
        return json.dumps(_mask(json.loads(raw)), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, json.JSONDecodeError):
        return str(raw)


def _ids(rows: list[dict[str, Any]], key: str = "id") -> set[str]:
    return {str(r[key]) for r in rows if r.get(key) not in (None, "")}


def _related(store: Store, inv: dict[str, Any]) -> dict[str, Any]:
    invoice_id, wi = inv["id"], f"wi_{inv['id']}"
    revisions = store.rows("invoice_revision", invoice_id=invoice_id)
    rev_ids = _ids(revisions)
    documents = [d for r in revisions for d in store.rows("document", id=r["document_id"])]
    doc_ids = _ids(documents)
    decisions = store.rows("settlement_decision", invoice_id=invoice_id) if _has(store, "settlement_decision") else []
    proposals = store.rows("proposal", work_item_id=wi)
    prop_ids = _ids(proposals)
    outboxes = store.rows("outbox", invoice_id=invoice_id)
    purchase_id, supplier_id = inv.get("purchase_id") or "", inv["supplier_id"]
    deposits = store.rows("deposit", purchase_id=purchase_id) if purchase_id else []
    journal_refs = {invoice_id} | prop_ids | _ids(deposits)
    ledger = [l for l in store.rows("ledger_line") if str(l.get("ref_id")) in journal_refs]
    runs = [r for d in doc_ids for r in store.rows("extraction_run", document_id=d)]
    ids = ({invoice_id, wi, purchase_id, supplier_id} | rev_ids | doc_ids | prop_ids | _ids(outboxes) | _ids(decisions)
           | {d["change_request_id"] for d in decisions if d.get("change_request_id")}
           | {str(d["source_file_id"]) for d in documents if d.get("source_file_id")}
           | {f"appr_{p}" for p in prop_ids} | _ids(runs) | _ids(deposits) | _ids(ledger, "journal_id")
           | {h for r in rev_ids for h in _ids(store.rows("hold", revision_id=r))}
           | {a for r in rev_ids for a in _ids(store.rows("assessment", revision_id=r))}
           | {ln for r in rev_ids for ln in _ids(store.rows("invoice_line", revision_id=r))}
           | _ids(store.rows("receipt_attestation", invoice_id=invoice_id))
           | _ids(store.rows("deposit_allocation", invoice_id=invoice_id))
           | (_ids(store.rows("term", purchase_id=purchase_id)) | _ids(store.rows("change_request", purchase_id=purchase_id))
              if purchase_id else set())
           | _ids(store.rows("supplier_contact", supplier_id=supplier_id))
           | _ids(store.rows("payee_profile", supplier_id=supplier_id)))
    mentions = {invoice_id} | doc_ids | prop_ids | _ids(outboxes) | _ids(decisions)
    ids |= {j["id"] for j in store.rows("job") if any(m and m in (j.get("payload_json") or "") for m in mentions)}
    ids.discard("")
    return {"ids": ids, "revisions": revisions, "decisions": decisions, "proposals": proposals, "runs": runs,
            "ledger": ledger, "work_item_id": wi}


def _has(store: Store, table: str) -> bool:
    """A module without the v2.2 tables still exports everything else."""
    try:
        store.rows(table, id="__probe__")
        return True
    except StoreError:
        return False


def invoice_audit(store: Store, invoice_id: str) -> dict[str, Any]:
    inv = one(store, "invoice", id=invoice_id)
    if inv is None:
        raise UnknownInvoice(invoice_id)
    rel = _related(store, inv)
    events = sorted((r for r in store.rows("audit_log") if str(r.get("entity_id")) in rel["ids"]),
                    key=lambda r: (int(r["id"]) if str(r.get("id", "")).isdigit() else 0, _iso(r.get("at"))))
    active = inv.get("active_revision_id") or ""
    latest = max(store.rows("assessment", revision_id=active), key=lambda a: a["version"], default=None) if active else None
    approvals = store.rows("payment_approval", invoice_id=invoice_id)
    payments = [p for pid in sorted(_ids(rel["proposals"])) for p in store.rows("payment", id=pid)]
    return {
        "invoice": {k: inv.get(k) for k in ("id", "invoice_number", "supplier_id", "purchase_id", "invoice_date", "due_date",
                                             "currency", "active_revision_id", "commercial_status", "receipt_status",
                                             "payee_status", "approval_status", "payment_status", "next_owner_role",
                                             "next_action")},
        "exported_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revisions": [{k: r.get(k) for k in ("id", "revision", "document_id", "gross_cents", "deposit_shown_cents",
                                              "balance_requested_cents", "supersedes_revision_id", "status")}
                      for r in sorted(rel["revisions"], key=lambda r: r["revision"])],
        "open_holds": [{k: h.get(k) for k in ("id", "code", "amount_cents", "reason")}
                       for h in store.rows("hold", revision_id=active, status="open")] if active else [],
        "latest_assessment": {k: latest.get(k) for k in ("id", "version", "fingerprint", "policy_version", "claimed_cents",
                                                         "authorised_cents", "pending_cents", "variance_cents",
                                                         "proposed_payment_cents", "commercial_status", "summary")}
        if latest else None,
        "extraction_runs": [{k: r.get(k) for k in ("id", "document_id", "mode", "model", "prompt_version", "status", "error")}
                            for r in sorted(rel["runs"], key=lambda r: r["id"])],
        "settlement_decisions": [{k: d.get(k) for k in ("id", "invoice_line_id", "decision", "amount_cents", "status",
                                                        "outbox_id", "change_request_id", "decided_by_role")}
                                 for d in sorted(rel["decisions"], key=lambda d: d["id"])],
        "approvals": [{k: a.get(k) for k in ("id", "proposal_id", "amount_cents", "deposit_allocation_cents", "revision_id",
                                             "assessment_fingerprint", "status", "stale_reason")}
                      for a in sorted(approvals, key=lambda a: a["id"])],
        "payments": [{"proposal_id": p["proposal_id"], "amount_cents": p["amount_cents"], "status": p["status"],
                      "transfer_id": p.get("nessie_transfer_id", ""), "simulated": True} for p in payments],
        "ledger": {"lines": [{k: l.get(k) for k in ("journal_id", "entry_date", "ref_type", "ref_id", "account", "debit_cents",
                                                   "credit_cents")} for l in rel["ledger"]],
                   "balances": balances(rel["ledger"])},
        "events": [{**{k: r.get(k) for k in CSV_COLUMNS}, "at": _iso(r.get("at")),
                    "before_json": _masked_json(r.get("before_json")), "after_json": _masked_json(r.get("after_json"))}
                   for r in events],
        "denied": sum(1 for r in events if r.get("outcome") == "denied"),
        "timeline": [{"at": _iso(s.get("at")), "kind": s["kind"], "title": s["title"]}
                     for s in sorted(store.rows("agent_step", work_item_id=rel["work_item_id"]),
                                     key=lambda s: int(s["id"]) if str(s.get("id", "")).isdigit() else 0)],
        "notes": NOTES,
    }


def _cell(value: Any) -> str:
    """CSV cells that a spreadsheet would run as a formula are prefixed: document text is data."""
    text = "" if value is None else str(value)
    return f"'{text}" if text[:1] in {"=", "+", "-", "@", "\t", "\r"} else text


def to_csv(export: dict[str, Any]) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(CSV_COLUMNS)
    for e in export["events"]:
        w.writerow([_cell(e.get(c)) for c in CSV_COLUMNS])
    return out.getvalue()
