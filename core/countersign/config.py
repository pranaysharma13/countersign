"""Settings loaded from the repo-root .env. Never print secrets."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
GENERATED_DIR = DATA_DIR / "generated"
FILES_DIR = GENERATED_DIR / "files"

load_dotenv(REPO_ROOT / ".env")


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    use_mocks: bool = field(default_factory=lambda: _flag("USE_MOCKS", True))
    ai_mode: str = field(default_factory=lambda: os.getenv("AI_MODE", "fixture").strip().lower() or "fixture")  # fixture | live
    store_backend: str = field(default_factory=lambda: os.getenv("STORE_BACKEND", "spacetime"))

    spacetimedb_uri: str = field(default_factory=lambda: os.getenv("SPACETIMEDB_URI", "http://localhost:3000"))
    spacetimedb_database: str = field(default_factory=lambda: os.getenv("SPACETIMEDB_DATABASE", "countersign"))
    tokens: dict[str, str] = field(
        default_factory=lambda: {
            role: os.getenv(f"SPACETIMEDB_{role.upper()}_TOKEN", "")
            for role in ("admin", "agent", "gateway", "sync", "owner", "bookkeeper", "purchasing", "receiver")
        }
    )

    anthropic_api_key: str = field(default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", ""))
    # `or`: a blank line copied from .env.example (ANTHROPIC_MODEL=) must still get the default
    anthropic_model: str = field(default_factory=lambda: os.getenv("ANTHROPIC_MODEL") or "claude-opus-5-5")
    extraction_effort: str = field(default_factory=lambda: os.getenv("EXTRACTION_EFFORT") or "medium")  # Opus 5.5's default
    extraction_timeout: float = field(default_factory=lambda: float(os.getenv("EXTRACTION_TIMEOUT") or "120"))
    factory_api_key: str = field(default_factory=lambda: os.getenv("FACTORY_API_KEY", ""))
    droid_model: str = field(default_factory=lambda: os.getenv("DROID_MODEL", ""))

    nessie_api_key: str = field(default_factory=lambda: os.getenv("NESSIE_API_KEY", ""))
    nessie_base_url: str = field(default_factory=lambda: os.getenv("NESSIE_BASE_URL", "http://api.nessieisreal.com"))

    crs_base_url: str = field(default_factory=lambda: os.getenv("CRS_BASE_URL", "https://api-sandbox.stitchcredit.com:443/api"))
    crs_username: str = field(default_factory=lambda: os.getenv("CRS_USERNAME", ""))
    crs_password: str = field(default_factory=lambda: os.getenv("CRS_PASSWORD", ""))

    apify_token: str = field(default_factory=lambda: os.getenv("APIFY_TOKEN", ""))
    apify_license_actor: str = field(default_factory=lambda: os.getenv("APIFY_LICENSE_ACTOR", ""))

    core_url: str = field(default_factory=lambda: os.getenv("CORE_URL", "http://localhost:8000"))


settings = Settings()
