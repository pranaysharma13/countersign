"""Deliver demo bills into the inbox.

    uv run --project core python scripts/demo_pile.py moment   # just the fake bank-change bill (opens the demo)
    uv run --project core python scripts/demo_pile.py pile     # the other 8 October bills
    uv run --project core python scripts/demo_pile.py all
"""

import sys

import _path  # noqa: F401

from countersign.pipeline import ingest
from countersign.store import get_store
from countersign.world import build_world

MOMENT = "bill_clearflow_oak_bankchange"


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    world, store = build_world(), get_store()
    docs = [d for d in world.current if (which == "all") or (which == "moment") == (d.id == MOMENT)]
    for d in docs:
        print(ingest(store, world, d, "upload"), "-", d.vendor_name, d.invoice_number)


if __name__ == "__main__":
    main()
