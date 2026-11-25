"""Pure-stdlib helpers for LaTeX citation evidence notes and BibTeX lookups.

Designed to run in <50 ms without importing heavy RAG/embedding dependencies,
so agents can append/inspect/audit citation notes without loading large JSON or
.bib files into LLM context.
"""
from __future__ import annotations

import json
import os
import re
from datetime import date
from pathlib import Path
from typing import Any, Optional


_JSON_LINE_COMMENT = re.compile(r"(?m)^\s*//.*$")
_JSON_TRAILING_COMMA = re.compile(r",(\s*[}\]])")
_BIB_ENTRY_START = re.compile(r"@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,")
_BIB_FIELD = re.compile(r"\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*")


def _load_json_lenient(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8-sig")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        cleaned = _JSON_TRAILING_COMMA.sub(r"\1", _JSON_LINE_COMMENT.sub("", text))
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            return {}
    return parsed if isinstance(parsed, dict) else {}


def find_workspace_root(start_dir: Optional[Path] = None) -> Path:
    """Walk upward from start_dir looking for .vscode/settings.json or .git."""
    cur = (start_dir or Path.cwd()).resolve()
    for candidate in (cur, *cur.parents):
        if (candidate / ".vscode" / "settings.json").exists():
            return candidate
    for candidate in (cur, *cur.parents):
        if (candidate / ".git").exists():
            return candidate
    return cur


def load_workspace_settings(workspace_root: Path) -> dict[str, Any]:
    return _load_json_lenient(workspace_root / ".vscode" / "settings.json")


def _resolve_rel(workspace_root: Path, raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (workspace_root / p)


def discover_bib_files(explicit: Optional[Path] = None, cwd: Optional[Path] = None) -> list[Path]:
    if explicit is not None:
        return [explicit.resolve()] if explicit.exists() else []
    root = find_workspace_root(cwd)
    settings = load_workspace_settings(root)
    main_file = settings.get("openScriptorium.mainFile")
    search_root = _resolve_rel(root, main_file).parent if isinstance(main_file, str) and main_file.strip() else root
    excluded = {".git", "node_modules", ".scriptorium", "_Old", ".venv", "open-scriptorium"}
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(search_root):
        dirnames[:] = [d for d in dirnames if d not in excluded]
        for fname in sorted(filenames):
            if fname.lower().endswith(".bib"):
                found.append(Path(dirpath) / fname)
    if not found and search_root != root:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in excluded]
            for fname in sorted(filenames):
                if fname.lower().endswith(".bib"):
                    found.append(Path(dirpath) / fname)
    return found


def resolve_notes_file(explicit: Optional[Path] = None, cwd: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    root = find_workspace_root(cwd)
    settings = load_workspace_settings(root)
    configured = settings.get("openScriptorium.citations.notesFile")
    if isinstance(configured, str) and configured.strip():
        return _resolve_rel(root, configured.strip())
    bibs = discover_bib_files(None, cwd)
    if bibs:
        return bibs[0].with_suffix(".notes.json")
    return root / "references.notes.json"


def resolve_status_file(explicit: Optional[Path] = None, cwd: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    root = find_workspace_root(cwd)
    settings = load_workspace_settings(root)
    configured = settings.get("openScriptorium.citations.statusFile")
    if isinstance(configured, str) and configured.strip():
        return _resolve_rel(root, configured.strip())
    out_dir = settings.get("openScriptorium.outDir")
    out_path = _resolve_rel(root, out_dir.strip()) if isinstance(out_dir, str) and out_dir.strip() else root / ".scriptorium" / "build"
    return out_path / "citation_status.json"


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _normalize_note_list(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        return [raw]
    return []


def add_note(
    notes_path: Path,
    *,
    key: str,
    quote: str,
    file_rel: str = "",
    page: Optional[str | int] = None,
    claim: str = "",
    paper_id: str = "",
    added: Optional[str] = None,
) -> dict[str, Any]:
    """Append a verbatim citation evidence note to notes_path without overwriting existing entries."""
    clean_key = key.strip().lstrip("@")
    clean_quote = quote.strip()
    if not clean_key:
        raise ValueError("citekey must not be empty")
    if not clean_quote:
        raise ValueError("quote must not be empty")

    data = _load_json_lenient(notes_path)
    existing = _normalize_note_list(data.get(clean_key))

    note: dict[str, Any] = {"quote": clean_quote}
    if page is not None and str(page).strip() != "":
        page_str = str(page).strip()
        note["page"] = int(page_str) if page_str.isdigit() else page_str
    if file_rel.strip():
        note["file"] = file_rel.strip().replace("\\", "/")
    if claim.strip():
        note["claim"] = claim.strip()
    if paper_id.strip():
        note["paper_id"] = paper_id.strip()
    note["added"] = (added or date.today().isoformat()).strip()

    for prev in existing:
        if prev.get("quote", "").strip() == clean_quote and prev.get("file", "") == note.get("file", ""):
            return {
                "key": clean_key,
                "notes_file": str(notes_path),
                "duplicate": True,
                "count": len(existing),
                "note": prev,
            }

    existing.append(note)
    data[clean_key] = existing
    _write_json_atomic(notes_path, data)
    return {
        "key": clean_key,
        "notes_file": str(notes_path),
        "duplicate": False,
        "count": len(existing),
        "note": note,
    }


def get_notes(notes_path: Path, key: str) -> list[dict[str, Any]]:
    clean_key = key.strip().lstrip("@")
    data = _load_json_lenient(notes_path)
    return _normalize_note_list(data.get(clean_key))


# ─── BibTeX parser ───────────────────────────────────────────────────────────

def _read_bib_value(text: str, start: int) -> tuple[str, int]:
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i >= n:
        return "", i
    if text[i] == "{":
        depth = 0
        for j in range(i, n):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    return text[i + 1 : j], j + 1
        return text[i + 1 :], n
    if text[i] == '"':
        depth = 0
        for j in range(i + 1, n):
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
            elif ch == '"' and depth == 0:
                return text[i + 1 : j], j + 1
        return text[i + 1 :], n
    j = i
    while j < n and text[j] not in ",}\r\n\t ":
        j += 1
    return text[i:j], j


def parse_bib_entries(text: str) -> dict[str, dict[str, Any]]:
    """Parse BibTeX entries into {citekey: {type, fields, raw}}."""
    entries: dict[str, dict[str, Any]] = {}
    n = len(text)
    for m in _BIB_ENTRY_START.finditer(text):
        entry_type = m.group(1).lower()
        if entry_type in {"comment", "string", "preamble"}:
            continue
        key = m.group(2)
        brace_open = text.find("{", m.start())
        depth = 0
        entry_end = n
        for idx in range(brace_open, n):
            if text[idx] == "{":
                depth += 1
            elif text[idx] == "}":
                depth -= 1
                if depth == 0:
                    entry_end = idx + 1
                    break

        fields: dict[str, str] = {}
        i = m.end()
        while i < entry_end - 1:
            fm = _BIB_FIELD.match(text, i)
            if not fm:
                break
            val, next_i = _read_bib_value(text, fm.end())
            fields[fm.group(1).lower()] = re.sub(r"\s+", " ", val).strip()
            i = next_i
            while i < entry_end - 1 and text[i].isspace():
                i += 1
            if i < entry_end - 1 and text[i] == ",":
                i += 1
            else:
                break

        entries[key] = {
            "key": key,
            "type": entry_type,
            "fields": fields,
            "raw": text[m.start() : entry_end].strip(),
        }
    return entries


def get_bib_entry(bib_paths: list[Path], key: str) -> Optional[dict[str, Any]]:
    clean_key = key.strip().lstrip("@")
    for bp in bib_paths:
        if not bp.exists():
            continue
        entries = parse_bib_entries(bp.read_text(encoding="utf-8", errors="replace"))
        if clean_key in entries:
            entry = entries[clean_key]
            entry["bib_file"] = str(bp)
            return entry
    return None


def audit_citations(
    notes_path: Optional[Path],
    status_path: Optional[Path],
    bib_paths: list[Path],
) -> dict[str, Any]:
    """Cross-check BibTeX keys, citation evidence notes, and citation_status.json."""
    bib_keys: set[str] = set()
    for bp in bib_paths:
        if bp.exists():
            bib_keys.update(parse_bib_entries(bp.read_text(encoding="utf-8", errors="replace")).keys())

    notes_raw = _load_json_lenient(notes_path) if notes_path else {}
    note_keys: set[str] = {
        k for k, v in notes_raw.items()
        if not k.startswith("_") and len(_normalize_note_list(v)) > 0
    }

    status_raw = _load_json_lenient(status_path) if status_path else {}
    status_map = status_raw.get("citations") if isinstance(status_raw.get("citations"), dict) else status_raw
    if not isinstance(status_map, dict):
        status_map = {}

    all_keys = sorted(bib_keys | {k for k in status_map if not k.startswith("_")})
    indexed_without_notes: list[str] = []
    yellow_secondhand: list[str] = []
    red_unsourced: list[str] = []
    unknown_without_notes: list[str] = []
    with_notes: list[str] = []

    for k in all_keys:
        has_note = k in note_keys
        if has_note:
            with_notes.append(k)
        st = status_map.get(k) if isinstance(status_map.get(k), dict) else None
        if st is None:
            if not has_note:
                unknown_without_notes.append(k)
            continue
        indexed = st.get("indexed")
        cited_in = st.get("citedIn") or st.get("cited_in")
        if indexed is True:
            if not has_note:
                indexed_without_notes.append(k)
        elif indexed is False:
            count = cited_in.get("count", 0) if isinstance(cited_in, dict) else 0
            if count > 0:
                yellow_secondhand.append(k)
            else:
                red_unsourced.append(k)
        elif not has_note:
            unknown_without_notes.append(k)

    notes_without_bib = sorted(note_keys - bib_keys) if bib_keys else []

    return {
        "notes_file": str(notes_path) if notes_path else None,
        "status_file": str(status_path) if status_path else None,
        "bib_files": [str(p) for p in bib_paths],
        "summary": {
            "total_keys": len(all_keys),
            "with_notes": len(with_notes),
            "indexed_without_notes": len(indexed_without_notes),
            "yellow_secondhand": len(yellow_secondhand),
            "red_unsourced": len(red_unsourced),
            "unknown_without_notes": len(unknown_without_notes),
        },
        "indexed_without_notes": indexed_without_notes,
        "yellow_secondhand": yellow_secondhand,
        "red_unsourced": red_unsourced,
        "unknown_without_notes": unknown_without_notes,
        "notes_without_bib": notes_without_bib,
    }
