"""Persistent app-level settings stored at data/settings.json."""
from __future__ import annotations

import json
from pathlib import Path


def _settings_path() -> Path:
    from core.config import get_config
    p = get_config().get_data_dir()
    p.mkdir(parents=True, exist_ok=True)
    return p / "settings.json"


_DEFAULTS: dict = {
    "arxiv_search_enabled": False,
}


def load_settings() -> dict:
    p = _settings_path()
    if not p.exists():
        return dict(_DEFAULTS)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return {**_DEFAULTS, **data}
    except Exception:
        return dict(_DEFAULTS)


def save_settings(settings: dict) -> dict:
    merged = {**_DEFAULTS, **settings}
    _settings_path().write_text(json.dumps(merged, indent=2), encoding="utf-8")
    return merged


def get_arxiv_enabled() -> bool:
    return bool(load_settings().get("arxiv_search_enabled", False))
