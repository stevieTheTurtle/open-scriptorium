"""Multi-collection management.

Each collection is an isolated knowledge base with its own SQLite + ChromaDB.
The active collection is stored in data/.active_collection (plain text filename).
Switching collections resets DB singletons so the next query uses the new path.
"""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _base_data_dir() -> Path:
    from core.config import get_config
    d = get_config().get_data_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _collections_root() -> Path:
    p = _base_data_dir() / "collections"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _registry_path() -> Path:
    return _base_data_dir() / "collections.json"


def _active_path() -> Path:
    return _base_data_dir() / ".active_collection"


# ── Registry ──────────────────────────────────────────────────────────────────

def _load_registry() -> list[dict]:
    p = _registry_path()
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_registry(cols: list[dict]) -> None:
    _registry_path().write_text(json.dumps(cols, indent=2), encoding="utf-8")


# ── Active collection ─────────────────────────────────────────────────────────

def get_active_name() -> str:
    p = _active_path()
    if p.exists():
        name = p.read_text(encoding="utf-8").strip()
        if name:
            return name
    return "default"


def _set_active_raw(name: str) -> None:
    _active_path().write_text(name, encoding="utf-8")
    # Reset DB singletons — next call re-initialises with new path
    from core import database as _db
    _db.reset_db()


def set_active_collection(name: str) -> dict:
    cols = {c["name"]: c for c in _load_registry()}
    if name not in cols:
        raise ValueError(f"Collection '{name}' does not exist.")
    _set_active_raw(name)
    return _get_collection_dict(name)


def get_active_data_dir() -> Path:
    name = get_active_name()
    p = _collections_root() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


# ── CRUD ──────────────────────────────────────────────────────────────────────

def _get_collection_dict(name: str) -> dict:
    active = get_active_name()
    for c in _load_registry():
        if c["name"] == name:
            c["active"] = (name == active)
            return c
    raise KeyError(name)


def list_collections() -> list[dict]:
    active = get_active_name()
    cols = _load_registry()
    for c in cols:
        c["active"] = (c["name"] == active)
    return cols


def create_collection(name: str, description: str = "") -> dict:
    name = name.strip()
    if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9 _\-]{0,49}$', name):
        raise ValueError("Name must start with alphanumeric, max 50 chars, no special chars except - _ space.")
    cols = _load_registry()
    if any(c["name"] == name for c in cols):
        raise ValueError(f"Collection '{name}' already exists.")
    col: dict = {
        "name": name,
        "description": description,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    cols.append(col)
    _save_registry(cols)
    (_collections_root() / name).mkdir(parents=True, exist_ok=True)
    col["active"] = (name == get_active_name())
    return col


def delete_collection(name: str) -> None:
    if name == get_active_name():
        raise ValueError("Cannot delete the active collection. Switch to another first.")
    cols = [c for c in _load_registry() if c["name"] != name]
    _save_registry(cols)
    data_dir = _collections_root() / name
    if data_dir.exists():
        shutil.rmtree(data_dir)


def rename_collection(old_name: str, new_name: str, description: Optional[str] = None) -> dict:
    if old_name == get_active_name():
        raise ValueError("Cannot rename the active collection while it is active.")
    cols = _load_registry()
    for c in cols:
        if c["name"] == old_name:
            old_dir = _collections_root() / old_name
            new_dir = _collections_root() / new_name
            if new_dir.exists():
                raise ValueError(f"'{new_name}' already exists.")
            if old_dir.exists():
                old_dir.rename(new_dir)
            c["name"] = new_name
            if description is not None:
                c["description"] = description
            _save_registry(cols)
            c["active"] = False
            return c
    raise KeyError(old_name)


# ── Bootstrap ─────────────────────────────────────────────────────────────────

def bootstrap() -> None:
    """Ensure at least a 'default' collection exists. Migrate legacy data if needed."""
    base = _base_data_dir()
    cols = _load_registry()
    default_dir = _collections_root() / "default"

    if not cols:
        # First run — check if legacy data exists (pre-collections metadata.db)
        legacy_db = base / "metadata.db"
        legacy_chroma = base / "chroma"
        if legacy_db.exists() or legacy_chroma.exists():
            # Migrate existing data into 'default' collection
            default_dir.mkdir(parents=True, exist_ok=True)
            if legacy_db.exists():
                legacy_db.rename(default_dir / "metadata.db")
            if legacy_chroma.exists():
                legacy_chroma.rename(default_dir / "chroma")
            legacy_uploads = base / "uploads"
            if legacy_uploads.exists():
                legacy_uploads.rename(default_dir / "uploads")

        _save_registry([{
            "name": "default",
            "description": "Default collection",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }])
        _set_active_raw("default")
