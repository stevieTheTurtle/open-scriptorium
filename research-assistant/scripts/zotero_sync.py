"""Incremental sync: Zotero library PDFs -> Research Assistant "Zotero" collection.

- Reads a *copy* of zotero.sqlite (+ WAL) so it never touches or locks the live DB.
- Indexes every PDF attachment (imported or linked) that is not in Zotero's trash.
- Uses Zotero metadata (title, authors, year, abstract, citation key) instead of
  guessing from the PDF, and tags each paper with its Zotero collections/tags.
- Idempotent: only new or changed PDFs are embedded; metadata/tags are refreshed
  every run; papers removed from Zotero are removed from the index (index only —
  Zotero itself is never modified).

Usage:
    .venv\\Scripts\\python.exe scripts\\zotero_sync.py [--limit N] [--set-active]
Env:
    ZOTERO_DIR  Zotero data directory (default: parent folder of this project)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def _detect_zotero_dir() -> Path:
    if env := os.environ.get("ZOTERO_DIR"):
        return Path(env).expanduser()
    candidates = [ROOT.parent, Path.home() / "Zotero"]
    for child in sorted(Path.home().glob("OneDrive*")):
        candidates.append(child / "ZoteroDocuments")
    for c in candidates:
        if (c / "zotero.sqlite").is_file():
            return c
    return Path.home() / "Zotero"


COLLECTION = os.environ.get("RA_ZOTERO_COLLECTION", "Zotero")
ZOTERO_DIR = _detect_zotero_dir()

from core import collections as ra_collections  # noqa: E402
from core.config import get_config  # noqa: E402

DATA_DIR = get_config().get_data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
STATE_PATH = DATA_DIR / "zotero_sync_state.json"
LOCK_PATH = DATA_DIR / "zotero_sync.lock"
LOG_PATH = DATA_DIR / "zotero_sync.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("zotero_sync")


# ── Zotero reading ────────────────────────────────────────────────────────────

def _snapshot_zotero_db(tmpdir: Path) -> Path:
    src = ZOTERO_DIR / "zotero.sqlite"
    if not src.exists():
        raise FileNotFoundError(f"zotero.sqlite not found in {ZOTERO_DIR}")
    dst = tmpdir / "zotero.sqlite"
    shutil.copy2(src, dst)
    wal = ZOTERO_DIR / "zotero.sqlite-wal"
    if wal.exists():
        shutil.copy2(wal, tmpdir / "zotero.sqlite-wal")
    return dst


def _collection_paths(c: sqlite3.Connection) -> dict[int, str]:
    rows = c.execute("SELECT collectionID, collectionName, parentCollectionID FROM collections").fetchall()
    by_id = {r[0]: (r[1], r[2]) for r in rows}
    out: dict[int, str] = {}
    for cid in by_id:
        parts, cur, seen = [], cid, set()
        while cur is not None and cur in by_id and cur not in seen:
            seen.add(cur)
            name, parent = by_id[cur]
            parts.append(name)
            cur = parent
        out[cid] = "/".join(reversed(parts))
    return out


def read_zotero_pdfs() -> dict[str, dict]:
    """Return {attachmentKey: {path, title, authors, year, abstract, tags}}."""
    with tempfile.TemporaryDirectory() as td:
        db = _snapshot_zotero_db(Path(td))
        c = sqlite3.connect(str(db))
        try:
            return _read(c)
        finally:
            c.close()


def _read(c: sqlite3.Connection) -> dict[str, dict]:
    deleted = {r[0] for r in c.execute("SELECT itemID FROM deletedItems")}
    coll_paths = _collection_paths(c)

    def field(item_id: int, name: str) -> str | None:
        r = c.execute(
            """SELECT v.value FROM itemData d
               JOIN fields f ON f.fieldID = d.fieldID
               JOIN itemDataValues v ON v.valueID = d.valueID
               WHERE d.itemID = ? AND f.fieldName = ?""",
            (item_id, name),
        ).fetchone()
        return r[0] if r else None

    rows = c.execute(
        """SELECT a.itemID, ai.key, a.parentItemID, a.linkMode, a.path
           FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID
           WHERE a.contentType = 'application/pdf'"""
    ).fetchall()

    out: dict[str, dict] = {}
    for att_id, att_key, parent_id, link_mode, path in rows:
        if att_id in deleted or (parent_id is not None and parent_id in deleted) or not path:
            continue
        if path.startswith("storage:"):
            pdf = ZOTERO_DIR / "storage" / att_key / path[len("storage:"):]
        elif os.path.isabs(path):
            pdf = Path(path)
        else:  # "attachments:" relative to a base dir — not resolvable here
            continue

        meta_id = parent_id if parent_id is not None else att_id
        title = field(meta_id, "title") or pdf.stem
        date = field(meta_id, "date") or ""
        m = re.search(r"\b(1[89]\d\d|20\d\d)\b", date)
        year = int(m.group(1)) if m else None
        abstract = field(meta_id, "abstractNote")
        citekey = field(meta_id, "citationKey")

        authors = [
            (f"{fn} {ln}".strip() if fn else ln)
            for ln, fn in c.execute(
                """SELECT cr.lastName, cr.firstName FROM itemCreators ic
                   JOIN creators cr ON cr.creatorID = ic.creatorID
                   WHERE ic.itemID = ? ORDER BY ic.orderIndex""",
                (meta_id,),
            )
        ]

        tags: list[str] = []
        if citekey:
            tags.append(f"@{citekey}")
        for (cid,) in c.execute("SELECT collectionID FROM collectionItems WHERE itemID = ?", (meta_id,)):
            if cid in coll_paths:
                tags.append(f"coll:{coll_paths[cid]}")
        for (name,) in c.execute(
            "SELECT t.name FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID = ?",
            (meta_id,),
        ):
            tags.append(name)

        out[att_key] = {
            "path": str(pdf),
            "title": title,
            "authors": authors,
            "year": year,
            "abstract": abstract,
            "tags": tags,
        }
    return out


# ── Notification ──────────────────────────────────────────────────────────────

def notify(title: str, body: str) -> None:
    """Windows toast via built-in PowerShell/WinRT (no extra packages). Never raises."""
    if os.name != "nt":
        return
    import subprocess

    def esc(s: str) -> str:
        return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                 .replace('"', "&quot;").replace("'", "''"))

    ps = f"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>{esc(title)}</text><text>{esc(body)}</text></binding></visual></toast>')
$app = '{{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"""
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=30, capture_output=True,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Notification failed: %s", e)


# ── Sync ──────────────────────────────────────────────────────────────────────

def _load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            log.warning("Corrupt state file, starting fresh")
    return {}


def _save_state(state: dict) -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    tmp.replace(STATE_PATH)


PENDING_WINDOW_S = 600


def _recently_changed(folder: Path) -> bool:
    """True if a Zotero attachment folder was modified in the last few minutes."""
    try:
        return time.time() - folder.stat().st_mtime < PENDING_WINDOW_S
    except OSError:
        return False


def _acquire_lock() -> bool:
    if LOCK_PATH.exists() and time.time() - LOCK_PATH.stat().st_mtime < 6 * 3600:
        return False
    LOCK_PATH.write_text(str(os.getpid()))
    return True


def sync(limit: int | None = None, set_active: bool = False, notify_user: bool = True) -> int:
    # Work on the Zotero collection without changing the user's active choice.
    if COLLECTION not in {c["name"] for c in ra_collections.list_collections()}:
        ra_collections.create_collection(COLLECTION, "Full Zotero library (auto-synced)")
    ra_collections.get_active_name = lambda: COLLECTION  # type: ignore[assignment]

    from core import database as db
    from core import ingest as ingest_mod

    db.reset_db()
    db.init_db()

    items = read_zotero_pdfs()
    state = _load_state()
    log.info("Zotero PDFs: %d | already in index: %d", len(items), len(state))

    # 1. Removed from Zotero -> remove from index
    for key in [k for k in state if k not in items]:
        pid = state.pop(key)["paper_id"]
        if pid and not any(v["paper_id"] == pid for v in state.values()):
            ingest_mod.remove_paper(pid)
        log.info("Removed %s (no longer in Zotero)", key)
    _save_state(state)

    # 2. New / changed PDFs -> ingest
    # Zotero imports a PDF under its original name and renames it a few seconds later
    # (after metadata retrieval). A file that vanished from a recently changed
    # attachment folder is "pending": skipped now, not recorded, retried next sync.
    pending = 0
    todo = []
    for key, it in items.items():
        p = Path(it["path"])
        try:
            st = p.stat()
        except FileNotFoundError:
            if _recently_changed(p.parent):
                pending += 1
                log.info("PENDING %s (attachment changing in Zotero); will retry", p.name)
            continue
        prev = state.get(key)
        if prev and prev["size"] == st.st_size and abs(prev["mtime"] - st.st_mtime) < 2:
            continue
        todo.append((key, it, st, prev))
    if limit:
        todo = todo[:limit]
    log.info("To index: %d", len(todo))

    ok = failed = 0
    new_titles: list[str] = []
    for i, (key, it, st, prev) in enumerate(todo, 1):
        meta = {
            "title": it["title"], "authors": it["authors"], "year": it["year"],
            "abstract": it["abstract"], "venue": None, "doi": None,
        }
        ingest_mod.extract_metadata = lambda _doc, _m=meta: _m  # skip network lookups
        try:
            res = ingest_mod.ingest_pdf(
                Path(it["path"]), tags=it["tags"], force=bool(prev and prev.get("paper_id"))
            )
        except FileNotFoundError:
            pending += 1
            log.info("PENDING %s (renamed or moved by Zotero during sync); will retry", Path(it["path"]).name)
            continue
        if res.success or (res.error or "").startswith("Already indexed"):
            state[key] = {"paper_id": res.paper_id, "size": st.st_size, "mtime": st.st_mtime}
            ok += 1
            if res.success:
                new_titles.append(it["title"])
        else:
            failed += 1
            # Remember the failure so it is retried only when the file changes.
            state[key] = {"paper_id": None, "size": st.st_size, "mtime": st.st_mtime, "failed": True}
            log.warning("FAILED %s: %s", it["path"], res.error)
        if i % 10 == 0 or i == len(todo):
            _save_state(state)
            log.info("[%d/%d] ok=%d failed=%d", i, len(todo), ok, failed)

    # 3. Refresh metadata/tags from Zotero for everything indexed
    refreshed = 0
    for key, s in state.items():
        if not s.get("paper_id"):
            continue
        it, paper = items.get(key), db.get_paper(s["paper_id"])
        if not it or not paper:
            continue
        new = paper.model_copy(update={
            "title": it["title"], "authors": it["authors"], "year": it["year"],
            "abstract": it["abstract"] or paper.abstract, "tags": it["tags"],
        })
        if new != paper:
            db.insert_paper(new)
            refreshed += 1
    _save_state(state)
    n_failed_total = sum(1 for s in state.values() if s.get("failed"))
    log.info("Done. indexed=%d failed=%d pending=%d metadata_refreshed=%d total=%d (of which unreadable: %d)",
             ok, failed, pending, refreshed, len(state), n_failed_total)
    if pending:
        # Machine-readable marker: Open Scriptorium schedules a follow-up sync.
        log.info("RETRY_PENDING %d", pending)

    if notify_user and (new_titles or failed):
        head = f"{len(new_titles)} new paper{'s' if len(new_titles) != 1 else ''} indexed"
        if failed:
            head += f", {failed} failed (see zotero_sync.log)"
        shown = [t[:70] for t in new_titles[:3]]
        if len(new_titles) > 3:
            shown.append(f"+{len(new_titles) - 3} more")
        notify(f"Research Assistant: {head}", "\n".join(shown) or "Check data\\zotero_sync.log")

    if set_active:
        ra_collections._set_active_raw(COLLECTION)
        log.info("Active collection set to %s", COLLECTION)
    return 1 if failed and not ok else 0


def main() -> int:
    global ZOTERO_DIR, COLLECTION
    ap = argparse.ArgumentParser()
    ap.add_argument("--zotero-dir", type=Path, default=None, help="Path to Zotero data directory containing zotero.sqlite")
    ap.add_argument("--collection", type=str, default=None, help="Target Research Assistant collection name")
    ap.add_argument("--limit", type=int, default=None, help="index at most N new PDFs (testing)")
    ap.add_argument("--set-active", action="store_true", help="make Zotero the active collection")
    ap.add_argument("--no-notify", action="store_true", help="no Windows notification")
    ap.add_argument("--test-notify", action="store_true", help="show a test notification and exit")
    args = ap.parse_args()
    if args.zotero_dir is not None:
        ZOTERO_DIR = args.zotero_dir.expanduser().resolve()
    if args.collection:
        COLLECTION = args.collection
    if args.test_notify:
        notify("Research Assistant", "Test notification: Zotero sync notifications work.")
        return 0
    if not _acquire_lock():
        log.info("Another sync is running; exiting.")
        return 0
    try:
        return sync(args.limit, args.set_active, notify_user=not args.no_notify)
    except Exception:
        log.exception("Sync crashed")
        if not args.no_notify:
            notify("Research Assistant: Zotero sync crashed", "See data\\zotero_sync.log")
        return 2
    finally:
        LOCK_PATH.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
