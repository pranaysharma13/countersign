"""Rehearsal: take BM-23104 from the opening state to paid on a live module, with run_worker.py running.

    uv run --project core python scripts/drive_bm23104.py

Plays the people with their own tokens (purchasing sends the clarification, the superintendent attests
receipt, the owner approves), delivers BayMix's reply and the corrected invoice through intake, waits for
the worker between steps, and checks the end state against the answer key. Prints every failed job,
denial and wrong number; exit 0 only if everything matched.
"""

import json
import sys
import time

import _path  # noqa: F401

from countersign import intake
from countersign import reducers as R
from countersign import supplier_ledger as L
from countersign.config import DATA_DIR
from countersign.store import SpacetimeStore, one
from countersign.supplier_docs import file_bytes
from countersign.supplier_world import INVOICE_ID, INVOICE_R2, REPLY_1, REV1_ID, REV2_ID

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())
problems: list[str] = []
started = time.monotonic()


def say(msg: str) -> None:
    print(f"[{time.monotonic() - started:6.1f}s] {msg}", flush=True)


def wait(store: SpacetimeStore, what: str, check, timeout: float = 240) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            say(f"ok: {what}")
            return True
        time.sleep(2)
    problems.append(f"timed out waiting for: {what}")
    say(f"TIMEOUT: {what}")
    return False


def latest(store: SpacetimeStore, revision_id: str) -> dict | None:
    return max(store.rows("assessment", revision_id=revision_id), key=lambda a: int(a["version"]), default=None)


def expect(label: str, got, want) -> None:
    if got != want:
        problems.append(f"{label}: got {got!r}, expected {want!r}")
        say(f"WRONG {label}: got {got!r}, expected {want!r}")
    else:
        say(f"ok: {label} = {got!r}")


def main() -> int:
    s = SpacetimeStore()
    a1 = latest(s, REV1_ID)
    if a1 is None:
        print("No assessment for revision 1: load the opening seed first (reset_demo_v2.py).")
        return 1
    r1 = KEY["revision_1"]
    expect("rev 1 claimed", int(a1["claimed_cents"]), r1["claimed_cents"])
    expect("rev 1 under review", int(a1["variance_cents"]) + int(a1["pending_cents"]), r1["under_review_cents"])

    ob = one(s, "outbox", id=KEY["clarification"]["outbox_id"])
    if ob is None:
        problems.append("no drafted clarification for revision 1")
    elif ob["status"] == "draft":
        res = R.approve_outbox(s, "purchasing", ob["id"])
        say(f"purchasing sends the clarification: {res.outcome} {res.message}")
        wait(s, "clarification sent (simulated)", lambda: (one(s, "outbox", id=ob["id"]) or {}).get("status") == "sent")

    for doc in (REPLY_1, INVOICE_R2):
        say(f"intake: {doc.filename}")
        intake.ingest(s, doc.filename, file_bytes(doc))
    wait(s, "BayMix's reply and the corrected invoice read (live)",
         lambda: all((one(s, "job", id=intake.job_id(d.id)) or {}).get("status") in {"done", "failed"} for d in (REPLY_1, INVOICE_R2)))
    for d in (REPLY_1, INVOICE_R2):
        job = one(s, "job", id=intake.job_id(d.id)) or {}
        if job.get("status") != "done":
            problems.append(f"{d.id}: job {job.get('status')} {job.get('error', '')[:200]}")
    wait(s, "revision 2 assessed", lambda: latest(s, REV2_ID) is not None)
    a2 = latest(s, REV2_ID) or {}
    expect("rev 2 claimed", int(a2.get("claimed_cents", 0)), KEY["revision_2"]["claimed_cents"])
    expect("rev 2 proposed", int(a2.get("proposed_payment_cents", 0)), KEY["revision_2"]["proposed_payment_cents"])

    res = R.attest_receipt(s, "att_drive_500", INVOICE_ID, "All pours, Oct 5-22", 500_000, "cy", "On site for every pour")
    say(f"superintendent attests 500 cy: {res.outcome} {res.message}")
    wait(s, "reassessed after receipt and a payment proposed",
         lambda: (one(s, "invoice", id=INVOICE_ID) or {}).get("receipt_status") == "manually_confirmed"
         and any(p["status"] == "pending" and p["kind"] == "supplier_payment"
                 and json.loads(p["evidence_json"]).get("assessment_id") == (latest(s, REV2_ID) or {}).get("id")
                 for p in s.rows("proposal", work_item_id=f"wi_{INVOICE_ID}")))
    pending = [p for p in s.rows("proposal", work_item_id=f"wi_{INVOICE_ID}") if p["status"] == "pending"]
    if not pending:
        problems.append("no pending payment proposal to approve")
    else:
        p = pending[0]
        res = R.approve_supplier_payment(s, "owner", p["id"], latest(s, REV2_ID)["fingerprint"], "Matches the corrected invoice")
        say(f"owner approves {int(p['amount_cents']) / 100:,.2f}: {res.outcome} {res.message[:200]}")
        if not res.ok:
            problems.append(f"approval {res.outcome}: {res.message}")
        wait(s, "paid", lambda: (one(s, "invoice", id=INVOICE_ID) or {}).get("payment_status") == "settled")
        job = one(s, "job", id=f"job_pay_{p['id']}") or {}
        say(f"pay job: {job.get('status')} {job.get('result_json', '')[:200]} {job.get('error', '')[:200]}")

    bal = L.balances(s.rows("ledger_line"))
    done = KEY["settlement"]
    expect("AP at the end", bal.get(L.AP, 0), done["accounts_payable_end_cents"])
    expect("cash out", -bal.get(L.CASH, 0), done["cash_out_cents"])
    expect("deposit allocations", [(a["deposit_id"], int(a["amount_cents"])) for a in s.rows("deposit_allocation")],
           [("dep_baymix_oak_1", 1_000_000)])
    failed = [j for j in s.rows("job", status="failed")]
    for j in failed:
        problems.append(f"failed job {j['id']} ({j['kind']}): {j['error'][:200]}")
    denied = [a for a in s.rows("audit_log") if a["outcome"] == "denied"]
    for a in denied:
        say(f"note: denied {a['action']} by {a['actor_role']}: {a['reason'][:160]}")
    print("\n" + ("Everything matched." if not problems else f"{len(problems)} problem(s):\n  - " + "\n  - ".join(problems)))
    return 0 if not problems else 2


if __name__ == "__main__":
    sys.exit(main())
