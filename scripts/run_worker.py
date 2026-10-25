"""Run the job worker (agent + gateway + sync). Leave it running during the demo.

    uv run --project core python scripts/run_worker.py
"""

import _path  # noqa: F401

from countersign.config import settings
from countersign.worker import run_forever, worker_store


def main() -> None:
    mode = "mocks" if settings.use_mocks else "live services"
    print(f"Countersign worker polling {settings.spacetimedb_uri}/{settings.spacetimedb_database} with {mode}. Ctrl-C to stop.")
    run_forever(worker_store())


if __name__ == "__main__":
    main()
