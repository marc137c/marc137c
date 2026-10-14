"""Configuration loading. Settings live in a TOML file; secrets come from env vars."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

# Østfold municipalities (county 31, from 2024).
OSTFOLD_KOMMUNER = {
    "3101": "Halden",
    "3103": "Moss",
    "3105": "Sarpsborg",
    "3107": "Fredrikstad",
    "3110": "Hvaler",
    "3112": "Råde",
    "3114": "Våler",
    "3116": "Skiptvet",
    "3118": "Indre Østfold",
    "3120": "Rakkestad",
    "3122": "Marker",
    "3124": "Aremark",
}


@dataclass
class Config:
    kommuner: dict[str, str] = field(default_factory=lambda: dict(OSTFOLD_KOMMUNER))
    min_employees: int = 5
    # Sole proprietorships (ENK) count as private persons under markedsføringsloven § 15,
    # so cold email to them needs prior consent. Excluded by default.
    org_forms: list[str] = field(default_factory=lambda: ["AS", "ANS", "DA", "SA", "NUF"])
    min_score: int = 50
    require_email: bool = True
    # Drop a lead when its email is on its own domain and that domain serves a website.
    drop_if_email_domain_has_site: bool = True
    fetch_result_pages: bool = True
    recheck_after_days: int = 30
    max_candidates_per_run: int = 400
    request_delay_seconds: float = 1.0
    data_dir: Path = Path("data")
    output_dir: Path = Path("output")

    # Secrets / integrations (env vars).
    google_places_api_key: str | None = None
    brave_search_api_key: str | None = None
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    notify_to: str | None = None


def load_config(path: str | os.PathLike | None) -> Config:
    cfg = Config()
    if path and Path(path).exists():
        with open(path, "rb") as f:
            raw = tomllib.load(f)
        for key, value in raw.items():
            if not hasattr(cfg, key):
                raise ValueError(f"Unknown config key: {key}")
            if key in ("data_dir", "output_dir"):
                value = Path(value)
            if key == "kommuner" and isinstance(value, list):
                value = {k: OSTFOLD_KOMMUNER.get(k, k) for k in value}
            setattr(cfg, key, value)

    env = os.environ.get
    cfg.google_places_api_key = env("GOOGLE_PLACES_API_KEY") or cfg.google_places_api_key
    cfg.brave_search_api_key = env("BRAVE_SEARCH_API_KEY") or cfg.brave_search_api_key
    cfg.smtp_host = env("SMTP_HOST") or cfg.smtp_host
    cfg.smtp_port = int(env("SMTP_PORT") or cfg.smtp_port)
    cfg.smtp_user = env("SMTP_USER") or cfg.smtp_user
    cfg.smtp_password = env("SMTP_PASSWORD") or cfg.smtp_password
    cfg.notify_to = env("NOTIFY_TO") or cfg.notify_to
    return cfg
