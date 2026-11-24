"""Re-embed every collection with the embedding provider currently set in config.yaml.

Reads chunks already stored in each collection's metadata.db (no PDF re-parsing,
no metadata lookups), writes a fresh Chroma store to <collection>/chroma_new,
then swaps it in and keeps the previous store as <collection>/chroma_<backup_tag>.

Usage:
    .venv\\Scripts\\python.exe scripts\\reembed.py --backup-tag minilm [--only Zotero]
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import chromadb  # noqa: E402
from chromadb.config import Settings  # noqa: E402

from core.config import get_config  # noqa: E402
from core.embeddings import get_provider  # noqa: E402

BATCH = 64


def reembed_collection(col_dir: Path, provider, backup_tag: str) -> None:
    db = col_dir / "metadata.db"
    if not db.exists():
        print(f"[{col_dir.name}] no metadata.db, skipped", flush=True)
        return
    conn = sqlite3.connect(str(db))
    rows = conn.execute(
        "SELECT id, paper_id, content, page_number, chunk_index FROM chunks ORDER BY paper_id, chunk_index"
    ).fetchall()
    conn.close()

    new_path = col_dir / "chroma_new"
    if new_path.exists():
        shutil.rmtree(new_path)
    client = chromadb.PersistentClient(path=str(new_path), settings=Settings(anonymized_telemetry=False))
    col = client.get_or_create_collection(name="paper_chunks", metadata={"hnsw:space": "cosine"})

    total = len(rows)
    t0 = time.time()
    for i in range(0, total, BATCH):
        batch = rows[i : i + BATCH]
        embs = provider.embed([r[2] for r in batch])
        col.add(
            ids=[r[0] for r in batch],
            embeddings=embs,
            documents=[r[2] for r in batch],
            metadatas=[{"paper_id": r[1], "page_number": r[3], "chunk_index": r[4]} for r in batch],
        )
        done = i + len(batch)
        if done % (BATCH * 50) < BATCH or done == total:
            rate = done / max(time.time() - t0, 1e-6)
            print(f"[{col_dir.name}] {done}/{total} chunks ({rate:.0f}/s)", flush=True)

    count = col.count()
    client._system.stop()
    del col, client
    if count != total:
        raise RuntimeError(f"[{col_dir.name}] count mismatch: chroma={count} sqlite={total}")

    old = col_dir / "chroma"
    backup = col_dir / f"chroma_{backup_tag}"
    if old.exists():
        if backup.exists():
            raise RuntimeError(f"{backup} already exists; not overwriting")
        old.rename(backup)
    new_path.rename(old)
    print(f"[{col_dir.name}] swapped in ({count} chunks); old store kept at {backup.name}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup-tag", required=True)
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()

    cfg = get_config()
    provider = get_provider(cfg)
    print(f"Provider: {cfg.embedding.provider}, dim={provider.dimension()}", flush=True)

    root = cfg.get_data_dir() / "collections"
    dirs = sorted(p for p in root.iterdir() if p.is_dir())
    if args.only:
        dirs = [d for d in dirs if d.name in args.only]
    # Small collections first so failures surface fast.
    dirs.sort(key=lambda d: (d / "metadata.db").stat().st_size if (d / "metadata.db").exists() else 0)
    for d in dirs:
        reembed_collection(d, provider, args.backup_tag)
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
