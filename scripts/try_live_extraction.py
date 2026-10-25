"""One real Claude call on one fixture document, to catch a rejected schema or a PDF + strict-output
problem that a fake client can't. Costs one or two API calls.

    uv run --project core python scripts/try_live_extraction.py em_weekend_1
    uv run --project core python scripts/try_live_extraction.py quote
    uv run --project core python scripts/try_live_extraction.py invoice   # BM-23104 rev 1, with the two change requests on file

Prints who answered, latency, tokens, and any evidence problems. Never prints the key.
"""

import json
import sys

import _path  # noqa: F401

from countersign import live_extract
from countersign.config import settings
from countersign.extractions import evidence_problems
from countersign.supplier_docs import file_bytes, fragments
from countersign.supplier_world import INVOICE_R1, QUOTE, WEEKEND_1


def main() -> int:
    which = sys.argv[1] if len(sys.argv) > 1 else "em_weekend_1"
    if not settings.anthropic_api_key:
        print("ANTHROPIC_API_KEY isn't set (repo-root .env).")
        return 1
    doc = {"em_weekend_1": WEEKEND_1, "quote": QUOTE, "invoice": INVOICE_R1}[which]
    on_file = ["baymix_weekend_oct10: Weekend delivery, Saturday Oct 10 pour | flat $1,200.00 | supplier accepted | ours approved",
               "baymix_waiting: Truck waiting time | no rate stated | supplier proposed | ours pending"]
    frags = [{"id": f.id, "page": f.page, "line_start": f.line_start, "text": f.text} for f in fragments(doc)]
    if doc.email:
        meta = {"from_address": doc.email.from_address, "to_addresses": doc.email.to_addresses,
                "subject": doc.email.subject, "original_sent_at_iso": doc.email.sent_at_iso}
        ext = live_extract.read_email(doc.id, meta, frags, on_file=[], ref_prefix="baymix")
    else:
        ext = live_extract.read_pdf(doc.id, file_bytes(doc), frags, on_file if doc is INVOICE_R1 else None)
    problems = evidence_problems(ext, {f["id"]: f["text"] for f in frags})
    for c in ext["calls"]:
        print(f"call: model={c['model']} (asked {c['requested_model']}) latency={c['latency_ms']} ms "
              f"tokens in/out={c['input_tokens']}/{c['output_tokens']} stop={c['stop_reason']}")
    print(json.dumps({k: v for k, v in ext.items() if k != "calls"}, indent=1)[:6000])
    print(f"\nevidence problems: {problems or 'none'}")
    return 0 if not problems else 2


if __name__ == "__main__":
    raise SystemExit(main())
