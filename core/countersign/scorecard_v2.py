"""Scorecard v2 (supplier invoices): every scenario run offline through the real pipeline (intake ->
process_document jobs -> assessment -> holds -> proposal, and for BM-23104 the owner's approval and the
gateway on the mock bank), compared with the hand-written answer key data/answer_keys/scorecard_v2.json.

Nothing expected comes from the code under test: the key's holds and amounts were worked out from the
documents and SPEC §8. Measured here: hold precision and recall, exact amounts, authorised changes paid,
false holds on clean documents. The live extraction result is a recorded measurement (it costs API calls),
reported with its source. Writes data/scorecard_v2.json and data/scorecard_v2.md (the slide).

    uv run --project core python scripts/run_scorecard_v2.py
"""

from __future__ import annotations

import copy
import json
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import intake, sandbox, supplier_agent, supplier_pipeline, worker
from . import reducers as R
from . import supplier_ledger as L
from .commercial import POLICY_VERSION
from .companion_seed import seed_companion_parties
from .companion_world import (CEDAR_DOCS, CEDAR_INVOICE_ID, CEDAR_QTY_MILLI, HARBOR_DOCS, HARBOR_INVOICE_ID, HP_QTY_MILLI,
                              NL_QTY_MILLI, NORTHLINE_DOCS, NORTHLINE_INVOICE_ID, PEAK_DOCS, PEAK_INVOICE_ID, PF_QTY_MILLI,
                              REDLINE_DOCS, REDLINE_INVOICE_ID, RH_QTY_MILLI, VALLEY_DOCS, VALLEY_INVOICE_ID, VS_QTY_MILLI)
from .config import DATA_DIR
from .fake_store import FakeStore
from .integrations import nessie
from .money import fmt
from .store import Store
from .supplier_docs import file_bytes
from .supplier_seed import seed_setup
from .supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, REPLY_1, REV2_ID,
                             SCOPED_DATE_1, SCOPED_QTY_1, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3, WEEKEND_CR_ID)

KEY_PATH = DATA_DIR / "answer_keys" / "scorecard_v2.json"
OUT_JSON = DATA_DIR / "scorecard_v2.json"
OUT_MD = DATA_DIR / "scorecard_v2.md"
RUNS_DIR = DATA_DIR / "runs"
RECEIPT = "RECEIPT_NOT_VERIFIED"
SCOPED_CRS = {"scoped_qty": (SCOPED_QTY_1, "cr_baymix_hemix_final120"), "scoped_date": (SCOPED_DATE_1, "cr_baymix_hemix_from_oct19")}
COMPANIONS = {  # scenario: (documents, invoice, attested quantity, unit)
    "cedar_clean": (CEDAR_DOCS, CEDAR_INVOICE_ID, CEDAR_QTY_MILLI, "sheet"),
    "northline_bank_email": (NORTHLINE_DOCS, NORTHLINE_INVOICE_ID, NL_QTY_MILLI, "ton"),
    "harbor_injection": (HARBOR_DOCS, HARBOR_INVOICE_ID, HP_QTY_MILLI, "crate"),
    "valley_po_ceiling": (VALLEY_DOCS, VALLEY_INVOICE_ID, VS_QTY_MILLI, "ton"),
    "redline_unapproved_fuel": (REDLINE_DOCS, REDLINE_INVOICE_ID, RH_QTY_MILLI, "load"),
    "peak_crs_risk": (PEAK_DOCS, PEAK_INVOICE_ID, PF_QTY_MILLI, "panel"),
}
# Recorded, not re-run: it costs about 14 API calls. A newer data/runs/extraction_*.json replaces it.
RECORDED_LIVE_EXTRACTION = {
    "source": "scripts/check_extraction.py, recorded in core/README.md (commit 407f834)", "date": "2026-10-25",
    "model": "claude-opus-5-5", "effort": "medium", "fallback": "none", "documents": 9,
    "labelled_fields_correct": 27, "labelled_fields": 27, "exact_values_reproduced": True,
    "values": "$87,425 claimed, $83,700 authorised, $3,500 variance, $225 pending; corrected $83,700, $73,700 proposed, "
              "no holds after receipt",
    "note": "One run; numbers will vary. Not re-run for this scorecard.",
}
# What the first runs of this scorecard found, fixed on py/core before the numbers below were measured.
FOUND_AND_FIXED = [
    ("Peak PF-77: the document pipeline never asked CRS, so SUPPLIER_RISK was missed and $1,650 was proposed to a "
     "supplier with a civil judgment. The pipeline now checks CRS (mock test identities) on every invoice."),
    ("Harbor HP-220: a $740 payment was proposed while PROMPT_INJECTION was open (the hold sits beside the "
     "assessment's checks). No payment is proposed while any such hold is open."),
]
BM_TABLES = ("invoice", "invoice_revision", "invoice_line", "hold", "assessment", "payee_profile", "proposal", "outbox",
             "payment", "ledger_line")


def load_key() -> dict[str, Any]:
    return json.loads(KEY_PATH.read_text())


@contextmanager
def offline() -> Iterator[nessie.MockNessie]:
    """Fixture extraction, the scripted agent, the mock bank: no API, whatever .env says."""
    saved = (supplier_pipeline.ai_mode, sandbox.ai_mode, supplier_agent.agent_mode, sandbox.FILES_DIR, sandbox.EXTRACTION_DIR)
    bank = nessie.MockNessie()
    with tempfile.TemporaryDirectory() as tmp:
        supplier_pipeline.ai_mode = sandbox.ai_mode = lambda: "fixture"
        supplier_agent.agent_mode = lambda: "scripted"
        sandbox.FILES_DIR, sandbox.EXTRACTION_DIR = Path(tmp) / "sandbox_files", Path(tmp) / "sandbox_extractions"
        nessie.set_client(bank)
        try:
            yield bank
        finally:
            (supplier_pipeline.ai_mode, sandbox.ai_mode, supplier_agent.agent_mode, sandbox.FILES_DIR,
             sandbox.EXTRACTION_DIR) = saved
            nessie.set_client(None)


def _receive(s: Store, doc, files: Path) -> None:
    intake.ingest(s, doc.filename, file_bytes(doc), files_dir=files)
    worker.drain(s)


def _ok(res: R.Result, what: str) -> None:
    if not res.ok:
        raise RuntimeError(f"scorecard setup, {what}: {res.outcome} {res.message}")


def _baymix_before_invoice(files: Path, extra_email=None) -> FakeStore:
    s = FakeStore()
    seed_setup(s)
    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1) + ((extra_email,) if extra_email else ()):
        _receive(s, doc, files)
    _ok(R.decide_change_request(s, "purchasing", WEEKEND_CR_ID, True, "Saturday pour"), "weekend charge")
    _ok(R.record_deposit(s, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref),
        "deposit")
    _ok(L.post(s, "sync", L.deposit_settled(DEPOSIT.id, DEPOSIT.amount_cents, DEPOSIT.settled_on)), "deposit journal")
    return s


def observe(s: Store, invoice_id: str) -> dict[str, Any]:
    """What the pipeline left on the invoice's active revision: open holds, the latest assessment, any proposal."""
    inv = s.rows("invoice", id=invoice_id)[0]
    rev = inv["active_revision_id"]
    a = max(s.rows("assessment", revision_id=rev), key=lambda r: int(r["version"]))
    details = json.loads(a["details_json"] or "{}")
    pending = [p for p in s.rows("proposal", work_item_id=f"wi_{invoice_id}") if p["status"] == "pending"]
    return {
        "invoice_id": invoice_id, "invoice_number": inv["invoice_number"],
        "holds": {h["code"]: int(h["amount_cents"]) for h in s.rows("hold", revision_id=rev, status="open")},
        "amounts": {"claimed_cents": int(a["claimed_cents"]), "authorised_cents": int(a["authorised_cents"]),
                    "under_review_cents": int(a["variance_cents"]) + int(a["pending_cents"]),
                    "proposed_payment_cents": int(a["proposed_payment_cents"])},
        "proposal_cents": int(pending[0]["amount_cents"]) if pending else None,
        "lines": [{"description": l.get("description", ""), "accepted_cents": int(l.get("accepted_cents") or 0)}
                  for l in details.get("lines") or []],
    }


def _bm23104(s: Store) -> dict[str, Any]:
    revs = {r["id"] for r in s.rows("invoice_revision", invoice_id=INVOICE_ID)}
    return {t: copy.deepcopy(sorted((r for r in s.rows(t) if r.get("invoice_id") == INVOICE_ID or r.get("revision_id") in revs
                                     or r.get("id") == INVOICE_ID or r.get("work_item_id") == f"wi_{INVOICE_ID}"),
                                    key=lambda r: str(r.get("id")))) for t in BM_TABLES}


def run_baymix(files: Path, bank: nessie.MockNessie) -> dict[str, dict[str, Any]]:
    s = _baymix_before_invoice(files)
    _receive(s, INVOICE_R1, files)
    out = {"baymix_r1": observe(s, INVOICE_ID)}
    for ob in s.rows("outbox", status="draft"):  # purchasing sends the clarification (simulated)
        _ok(R.approve_outbox(s, "purchasing", ob["id"]), "clarification")
    worker.drain(s)
    _receive(s, REPLY_1, files)
    _receive(s, INVOICE_R2, files)
    _ok(R.attest_receipt(s, "att_bm_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour"), "receipt")
    worker.drain(s)
    r2 = observe(s, INVOICE_ID)
    proposal = next((p for p in s.rows("proposal", work_item_id=f"wi_{INVOICE_ID}") if p["status"] == "pending"), None)
    if proposal is not None:  # the owner approves in the app; the gateway pays on the mock bank
        fp = max(s.rows("assessment", revision_id=REV2_ID), key=lambda a: int(a["version"]))["fingerprint"]
        _ok(R.approve_supplier_payment(s, "owner", proposal["id"], fp, "Matches the corrected invoice"), "approval")
        worker.drain(s)
    bal = L.balances(s.rows("ledger_line"))
    r2["settlement"] = {"settled_cents": sum(int(t["amount_cents"]) for t in bank.transfers),
                        "accounts_payable_end_cents": bal.get(L.AP, 0), "supplier_prepayment_end_cents": bal.get(L.PREPAYMENT, 0),
                        "cash_out_cents": -bal.get(L.CASH, 0)}
    r2["simulated_payment"] = True
    out["baymix_r2"] = r2
    return out


def run_scoped(scenario: str, files: Path) -> dict[str, Any]:
    email, cr_id = SCOPED_CRS[scenario]
    s = _baymix_before_invoice(files, email)
    _ok(R.decide_change_request(s, "owner", cr_id, True, "High-early mix for the late pours"), cr_id)
    _receive(s, INVOICE_R1, files)
    return observe(s, INVOICE_ID)


def run_companion(scenario: str, files: Path) -> dict[str, Any]:
    docs, invoice_id, qty_milli, unit = COMPANIONS[scenario]
    s = FakeStore()
    seed_setup(s)
    seed_companion_parties(s)
    for doc in docs:
        _receive(s, doc, files)
    _ok(R.attest_receipt(s, f"att_{scenario}", invoice_id, "Everything on the invoice", qty_milli, unit, "Counted on site"),
        f"{scenario} receipt")
    worker.drain(s)
    return observe(s, invoice_id)


def run_sandbox(scenarios: list[dict[str, Any]], files: Path) -> tuple[dict[str, dict[str, Any]], bool]:
    """Each submission in its own store (so one kind's pending bank change can't show on another), from the
    BM-23104 opening plus the sandbox, as a judge would find it. BM-23104 must be identical afterwards."""
    out, untouched = {}, True
    for sc in scenarios:
        s = _baymix_before_invoice(files)
        _receive(s, INVOICE_R1, files)
        sandbox.seed_sandbox(s)
        before = _bm23104(s)
        sb = sc["sandbox"]
        job_id = f"job_scorecard_{sc['id']}"
        _ok(R.enqueue_job(s, "public", job_id, "sneak_charge",
                          {"kind": sb["kind"], "amount_cents": sb["amount_cents"], "note": sb.get("note", "")}), job_id)
        worker.drain(s)
        result = json.loads(s.rows("job", id=job_id)[0]["result_json"])
        inv = next(i for i in s.rows("invoice") if i["invoice_number"] == result.get("invoice_number"))
        obs = observe(s, inv["id"])
        _, ext = sandbox.build(job_id, sb["kind"], sb["amount_cents"], sb.get("note", ""))  # the document as submitted
        obs["submitted_lines"] = [{k: l[k] for k in ("description", "quantity_milli", "unit_price_cents", "amount_cents")}
                                  for l in ext["lines"]]
        obs["bm23104_untouched"] = _bm23104(s) == before
        untouched &= obs["bm23104_untouched"]
        out[sc["id"]] = obs
    return out, untouched


def expected_holds(sc: dict[str, Any], obs: dict[str, Any]) -> dict[str, int]:
    """The key's holds. A sandbox price rule is applied to the line as the judge submitted it."""
    holds = {}
    for code, want in sc["holds"].items():
        if isinstance(want, dict) and want.get("rule") == "billed_qty_x_unit_minus_quoted":
            line = obs["submitted_lines"][0]
            want = line["quantity_milli"] * (line["unit_price_cents"] - want["quoted_unit_cents"]) // 1000
        holds[code] = int(want)
    return holds


def grade(sc: dict[str, Any], obs: dict[str, Any]) -> dict[str, Any]:
    want, got = expected_holds(sc, obs), obs["holds"]
    amounts = [{"what": f"{code} hold", "expected": want[code], "got": got[code]} for code in want if code in got]
    amounts += [{"what": k, "expected": v, "got": obs["amounts"].get(k)} for k, v in (sc.get("amounts") or {}).items()]
    amounts.append({"what": "payment proposed", "expected": sc.get("proposal_cents"), "got": obs["proposal_cents"]})
    for k, v in (sc.get("settlement") or {}).items():
        amounts.append({"what": k, "expected": v, "got": (obs.get("settlement") or {}).get(k)})
    for a in amounts:
        a["exact"] = a["expected"] == a["got"]
    return {
        "id": sc["id"], "title": sc["title"], "group": sc["group"], "clean": sc["clean"],
        "invoice_number": obs["invoice_number"], "expected_holds": want, "actual_holds": got,
        "caught": sorted(set(want) & set(got)), "missed": sorted(set(want) - set(got)), "false": sorted(set(got) - set(want)),
        "amounts": amounts, "all_exact": all(a["exact"] for a in amounts), "why": sc["why"],
        **({"bm23104_untouched": obs["bm23104_untouched"]} if "bm23104_untouched" in obs else {}),
    }


def _ratio(n: int, d: int) -> float | None:
    return round(n / d, 4) if d else None


def _pr(rows: list[dict[str, Any]], skip: set[str] = frozenset()) -> dict[str, Any]:
    tp = sum(len([c for c in r["caught"] if c not in skip]) for r in rows)
    fp = sum(len([c for c in r["false"] if c not in skip]) for r in rows)
    fn = sum(len([c for c in r["missed"] if c not in skip]) for r in rows)
    return {"true_positive": tp, "false_positive": fp, "false_negative": fn,
            "precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn)}


def live_extraction() -> dict[str, Any]:
    runs = sorted(RUNS_DIR.glob("extraction_*.json")) if RUNS_DIR.exists() else []
    if not runs:
        return RECORDED_LIVE_EXTRACTION
    r = json.loads(runs[-1].read_text())  # what scripts/check_extraction.py writes
    models = sorted({d.get("model", "") for d in r.get("documents", [])} - {""})
    return {"source": f"data/runs/{runs[-1].name}", "date": r.get("at", "")[:10], "model": ", ".join(models) or r.get("requested_model"),
            "effort": r.get("effort"), "documents": len(r.get("documents", [])),
            "labelled_fields_correct": r["field_accuracy"]["correct"], "labelled_fields": r["field_accuracy"]["total"],
            "exact_values_reproduced": all(v["ok"] for v in r["exact_values"].values()),
            "holds_open_after_receipt": r.get("holds_open_after_receipt"), "note": "One run; numbers will vary."}


def run(key: dict[str, Any] | None = None) -> dict[str, Any]:
    key = key or load_key()
    by_id = {sc["id"]: sc for sc in key["scenarios"]}
    with offline() as bank, tempfile.TemporaryDirectory() as tmp:
        files = Path(tmp)
        obs = run_baymix(files / "baymix", bank)
        for sid in SCOPED_CRS:
            obs[sid] = run_scoped(sid, files / sid)
        for sid in COMPANIONS:
            obs[sid] = run_companion(sid, files / sid)
        sandbox_obs, untouched = run_sandbox([sc for sc in key["scenarios"] if "sandbox" in sc], files / "sandbox")
        obs.update(sandbox_obs)
    rows = [grade(by_id[sid], obs[sid]) for sid in by_id]
    per_code: dict[str, dict[str, int]] = {}
    for r in rows:
        for bucket, codes in (("caught", r["caught"]), ("missed", r["missed"]), ("false", r["false"])):
            for c in codes:
                per_code.setdefault(c, {"caught": 0, "missed": 0, "false": 0})[bucket] += 1
    changes = []
    for ch in key["authorised_changes"]:
        o = obs[ch["scenario"]]
        line = next((l for l in o["lines"] if ch["line_description_contains"] in l["description"]), None)
        paid = (o.get("settlement") or {}).get("settled_cents")
        changes.append({"id": ch["id"], "title": ch["title"], "scenario": ch["scenario"],
                        "accepted_expected": ch["accepted_cents"], "accepted_got": line["accepted_cents"] if line else None,
                        "paid_expected": ch["paid_in_cents"], "paid_got": paid if ch["paid_in_cents"] is not None else None})
        changes[-1]["ok"] = (changes[-1]["accepted_got"] == ch["accepted_cents"]
                             and changes[-1]["paid_got"] == ch["paid_in_cents"])
    clean = [r for r in rows if r["clean"]]
    amounts = [a for r in rows for a in r["amounts"]]
    return {
        "generated_by": "scripts/run_scorecard_v2.py", "answer_key": "data/answer_keys/scorecard_v2.json",
        "mode": "offline: fixture extraction (AI_MODE=fixture), scripted agent, mock bank (simulated payment), FakeStore",
        "policy_version": POLICY_VERSION,
        "summary": {
            "scenarios": len(rows),
            "holds": _pr(rows), "holds_excluding_receipt": _pr(rows, {RECEIPT}),
            "exact_amounts": sum(a["exact"] for a in amounts), "amounts_checked": len(amounts),
            "authorised_changes_ok": sum(c["ok"] for c in changes), "authorised_changes": len(changes),
            "clean_documents": len(clean), "false_holds_on_clean_documents": sum(len(r["false"]) for r in clean),
            "bm23104_untouched_by_sandbox": untouched,
        },
        "per_code": dict(sorted(per_code.items())),
        "scenarios": rows,
        "authorised_changes": changes,
        "live_extraction": live_extraction(),
        "found_and_fixed": FOUND_AND_FIXED,
    }


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x * 100:.0f}%"


def _codes(holds: dict[str, int]) -> str:
    return ", ".join(f"{c} {fmt(v)}" if v else c for c, v in holds.items()) or "none"


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    h, hx = s["holds"], s["holds_excluding_receipt"]
    le = report["live_extraction"]
    lines = [
        "# Countersign scorecard v2 (measured)", "",
        (f"{s['scenarios']} scenarios run offline through the real pipeline, graded against a hand-written answer key "
        "(`data/answer_keys/scorecard_v2.json`). Payments are simulated (mock bank)."), "",
        "| Measure | Result |", "|---|---|",
        f"| Hold precision | {_pct(h['precision'])} ({h['true_positive']} of {h['true_positive'] + h['false_positive']} holds opened were expected) |",
        f"| Hold recall | {_pct(h['recall'])} ({h['true_positive']} of {h['true_positive'] + h['false_negative']} expected holds opened) |",
        f"| Recall without the receipt hold | {_pct(hx['recall'])} ({hx['true_positive']} of {hx['true_positive'] + hx['false_negative']}) |",
        f"| Exact amounts | {s['exact_amounts']} of {s['amounts_checked']} |",
        f"| Authorised changes paid or accepted in full | {s['authorised_changes_ok']} of {s['authorised_changes']} |",
        f"| False holds on clean documents | {s['false_holds_on_clean_documents']} on {s['clean_documents']} clean documents |",
        f"| BM-23104 untouched by every judge submission | {'yes' if s['bm23104_untouched_by_sandbox'] else 'NO'} |",
        (f"| Live extraction (Claude, {le.get('date', '')}) | {le.get('labelled_fields_correct', '?')}/{le.get('labelled_fields', '?')} "
        f"labelled fields, exact values {'reproduced' if le.get('exact_values_reproduced') else 'see run'} (recorded, {le.get('documents', '?')} documents) |"),
        "", "| Scenario | Expected holds | Countersign held | Amounts | |", "|---|---|---|---|---|",
    ]
    for r in report["scenarios"]:
        ok = not r["missed"] and not r["false"] and r["all_exact"]
        n = sum(a["exact"] for a in r["amounts"])
        mark = "ok" if ok else "MISSED " + ", ".join(r["missed"]) if r["missed"] else "CHECK"
        lines.append(f"| {r['title']} | {_codes(r['expected_holds'])} | {_codes(r['actual_holds'])} | {n}/{len(r['amounts'])} | {mark} |")
    misses = [r for r in report["scenarios"] if r["missed"] or r["false"] or not r["all_exact"]]
    if misses:
        lines += ["", "**Not as expected:**"]
        for r in misses:
            wrong = [f"{a['what']} expected {a['expected']}, got {a['got']}" for a in r["amounts"] if not a["exact"]]
            lines.append(f"- {r['title']}: " + "; ".join(
                ([f"missed {', '.join(r['missed'])}"] if r["missed"] else []) +
                ([f"unexpected {', '.join(r['false'])}"] if r["false"] else []) + wrong))
    lines += ["", "**Found by this scorecard's first runs, fixed before these numbers:**"]
    lines += [f"- {f}" for f in report["found_and_fixed"]]
    lines += ["", f"Live extraction source: {le['source']}. {le.get('note', '')}".strip(), ""]
    return "\n".join(lines)


def write(report: dict[str, Any]) -> None:
    OUT_JSON.write_text(json.dumps(report, indent=1) + "\n")
    OUT_MD.write_text(markdown(report))
