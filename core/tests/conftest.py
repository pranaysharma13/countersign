"""Keep pytest offline even when the repo-root .env has live keys.

load_dotenv does not override existing variables, so these must be set before
any countersign import. Tests never call Claude, Nessie, CRS or Apify.
"""

import os

os.environ["USE_MOCKS"] = "true"
os.environ["AI_MODE"] = "fixture"
os.environ.setdefault("AGENT_MODE", "scripted")
