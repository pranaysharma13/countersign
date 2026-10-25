"""One real Droid session on invoice BM-23104 revision 1 (needs the droid CLI and FACTORY_API_KEY or a CLI login).

    uv run --project core python scripts/try_droid.py

Loads the opening seed into a local module reference, minus the drafted clarification (so Droid has
something to draft), then runs the v2 agent with AGENT_MODE=droid. Prints the tool ids Droid was given,
the timeline it wrote, how long it took, and the clarification it drafted (validated by code). The
assessment's numbers are recorded by code before Droid starts, so they can't change.
"""

import json
import os
import time

import _path  # noqa: F401

from countersign import supplier_agent
from countersign.fake_store import FakeStore
from countersign.supplier_seed import SEEDS_DIR, replay
from countersign.supplier_world import INVOICE_ID


def main() -> int:
    os.environ["AGENT_MODE"] = "droid"
    store = FakeStore()
    calls = [c for c in json.loads((SEEDS_DIR / "baymix_opening.json").read_text()) if c["reducer"] != "draft_outbox"]
    bad = [r for r in replay(store, calls) if not r.ok]
    if bad:
        print(f"seed didn't load: {bad[0]}")
        return 1
    started = time.monotonic()
    result = supplier_agent.investigate(store, INVOICE_ID)
    print(f"agent: {result['agent']}  droid time: {result['droid_seconds']} s  wall: {time.monotonic() - started:.1f} s")
    print(f"tools Droid was given ({len(supplier_agent._TOOL_IDS or [])}): {supplier_agent._TOOL_IDS}")
    print(f"clarification by: {result['clarification_by']}  filled in by the scripted rules: {result['filled_in'] or 'nothing'}\n")
    for st in sorted(store.rows("agent_step", work_item_id=f"wi_{INVOICE_ID}"), key=lambda s: s["id"]):
        print(f"  [{st['kind']:11}] {st['title'][:150]}")
    for ob in store.rows("outbox"):
        print(f"\n--- {ob['subject']} -> {ob['to_address']} ({ob['status']}, simulated={ob['simulated']})\n{ob['body']}")
    holds = [(h["code"], h["amount_cents"]) for h in store.rows("hold", status="open")]
    print(f"open holds: {holds}")
    return 0 if result["agent"] == "droid" else 2


if __name__ == "__main__":
    raise SystemExit(main())
