"""Run the BayMix scenario with live Claude extraction and measure it. Costs real API calls (about 14).

    uv run --project core python scripts/check_extraction.py

Every document goes through intake and the worker (AI_MODE=live for this run, whatever .env says),
with the people's actions in between: purchasing approves the weekend charge, the clarification is
sent (simulated), the superintendent attests receipt. Per document: who answered (the model that
actually responded, and whether a fallback did), Claude latency, job wall time, tokens, evidence
problems, and each labelled field against the answer key. Then the scenario's exact values.
Writes data/runs/extraction_<time>.json (ignored by git). Measured results only.
"""

import json
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import _path  # noqa: F401

from countersign import intake, supplier_pipeline, worker
from countersign import reducers as R
from countersign.config import DATA_DIR, settings
from countersign.extraction_score import score
from countersign.fake_store import FakeStore
from countersign.money import fmt
from countersign.supplier_docs import file_bytes
from countersign.supplier_seed import seed_setup
from countersign.supplier_world import (BAYMIX, DEPOSIT, INVOICE_ID, INVOICE_R1, INVOICE_R2, PO, PURCHASE_ID, QUOTE, REPLY_1,
                                        REV1_ID, REV2_ID, WAITING_1, WEEKEND_1, WEEKEND_2, WEEKEND_3)

KEY = json.loads((DATA_DIR / "answer_keys" / "baymix_primary.json").read_text())


def _latest_run(store, doc_id):
    runs = store.rows("extraction_run", document_id=doc_id)
    return max(runs, key=lambda r: (r["created_at"], r["id"])) if runs else None


def main() -> int:
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY isn't set (repo-root .env).")
        return 1
    supplier_pipeline.ai_mode = lambda: "live"
    store, rows, files = FakeStore(), [], Path(tempfile.mkdtemp(prefix="countersign_check_"))
    seed_setup(store)

    def receive(doc):
        intake.ingest(store, doc.filename, file_bytes(doc), files_dir=files)
        started = time.monotonic()
        worker.drain(store)
        wall_ms = int((time.monotonic() - started) * 1000)
        run = _latest_run(store, doc.id)
        ext = json.loads(run["fields_json"] or "{}") if run else {}
        labels = KEY["labelled_fields"].get(doc.id, {})
        rows.append({"document": doc.id, "kind": ext.get("document_kind", ""), "run_status": run["status"] if run else "none",
                     "error": run["error"] if run else "", "model": ext.get("model", ""), "fallback": ext.get("fallback", False),
                     "claude_ms": ext.get("latency_ms", 0), "wall_ms": wall_ms,
                     "calls": [{k: c[k] for k in ("model", "latency_ms", "input_tokens", "output_tokens", "stop_reason")}
                               for c in ext.get("calls", [])],
                     "fields": score(doc.id, ext, labels) if ext else []})

    for doc in (QUOTE, PO, WEEKEND_1, WEEKEND_2, WEEKEND_3, WAITING_1):
        receive(doc)
    weekend = next((c for c in store.rows("change_request") if "weekend" in c["description"].lower()), None)
    if weekend:
        R.decide_change_request(store, "purchasing", weekend["id"], True, "Saturday pour requested by Granite Line")
    R.record_deposit(store, "sync", DEPOSIT.id, PURCHASE_ID, BAYMIX.id, DEPOSIT.amount_cents, "settled", DEPOSIT.transfer_ref)
    receive(INVOICE_R1)
    rev1 = min(store.rows("assessment", revision_id=REV1_ID), key=lambda a: a["version"], default=None)
    for ob in store.rows("outbox", status="draft"):
        R.approve_outbox(store, "purchasing", ob["id"])
    worker.drain(store)
    receive(REPLY_1)
    receive(INVOICE_R2)
    R.attest_receipt(store, "att_check_500", INVOICE_ID, "All pours", 500_000, "cy", "On site for every pour")
    worker.drain(store)
    rev2 = max(store.rows("assessment", revision_id=REV2_ID), key=lambda a: a["version"], default=None)

    fields = [f for r in rows for f in r["fields"]]
    exact = {"rev1_claimed": (rev1 or {}).get("claimed_cents"), "rev1_authorised": (rev1 or {}).get("authorised_cents"),
             "rev1_variance": (rev1 or {}).get("variance_cents"), "rev1_pending": (rev1 or {}).get("pending_cents"),
             "rev2_claimed": (rev2 or {}).get("claimed_cents"), "rev2_proposed": (rev2 or {}).get("proposed_payment_cents")}
    expected = {"rev1_claimed": 8_742_500, "rev1_authorised": 8_370_000, "rev1_variance": 350_000, "rev1_pending": 22_500,
                "rev2_claimed": 8_370_000, "rev2_proposed": 7_370_000}
    report = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "requested_model": settings.anthropic_model,
              "effort": settings.extraction_effort, "documents": rows,
              "field_accuracy": {"correct": sum(f["correct"] for f in fields), "total": len(fields)},
              "exact_values": {k: {"got": exact[k], "expected": expected[k], "ok": exact[k] == expected[k]} for k in expected},
              "holds_open_after_receipt": [h["code"] for h in store.rows("hold", revision_id=REV2_ID, status="open")]}

    print(f"Live extraction check: asked {settings.anthropic_model}, effort {settings.extraction_effort}\n")
    print(f"{'document':24} {'kind':8} {'run':8} {'answered by':18} {'fallback':8} {'claude s':>8} {'wall s':>7} {'tokens in/out':>15} fields")
    for r in rows:
        tin, tout = sum(c["input_tokens"] for c in r["calls"]), sum(c["output_tokens"] for c in r["calls"])
        ok = sum(f["correct"] for f in r["fields"])
        print(f"{r['document']:24} {r['kind']:8} {r['run_status']:8} {r['model']:18} {str(r['fallback']):8} "
              f"{r['claude_ms'] / 1000:8.1f} {r['wall_ms'] / 1000:7.1f} {f'{tin}/{tout}':>15} {ok}/{len(r['fields'])}")
        if r["run_status"] != "ok":
            print(f"    {r['error'][:200]}")
        for f in r["fields"]:
            if not f["correct"]:
                print(f"    wrong {f['field']}: got {f['actual']!r}, expected {f['expected']!r}")
    acc = report["field_accuracy"]
    print(f"\nLabelled fields correct: {acc['correct']}/{acc['total']}")
    for k, v in report["exact_values"].items():
        print(f"  {k:16} {fmt(v['got']) if isinstance(v['got'], int) else v['got']!s:>12}  expected {fmt(v['expected']):>12}  "
              f"{'ok' if v['ok'] else 'MISMATCH'}")
    print(f"  holds open after receipt: {report['holds_open_after_receipt'] or 'none'}")
    out = DATA_DIR / "runs" / f"extraction_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    print(f"\nWrote {out}")
    return 0 if all(v["ok"] for v in report["exact_values"].values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
