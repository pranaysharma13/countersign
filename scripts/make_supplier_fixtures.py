"""Write the BayMix fixture documents (quote, PO, emails, invoice, corrected invoice) to look at.

    uv run --project core python scripts/make_supplier_fixtures.py

Output: data/generated/fixtures/baymix/ (ignored by git). Same bytes every run.
"""

import _path  # noqa: F401

from countersign.config import GENERATED_DIR
from countersign.ids import sha256_hex
from countersign.supplier_docs import fragments, write_all
from countersign.supplier_world import PRIMARY_DOCS


def main() -> None:
    out = GENERATED_DIR / "fixtures" / "baymix"
    paths = write_all(PRIMARY_DOCS, out)
    for doc in PRIMARY_DOCS:
        path = paths[doc.id]
        print(f"{doc.kind:8} {path.name:40} {len(fragments(doc)):>3} fragments  sha256 {sha256_hex(path.read_bytes())[:12]}")
    print(f"\nWrote {len(paths)} files to {out}")


if __name__ == "__main__":
    main()
