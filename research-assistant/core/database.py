from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

import chromadb
from chromadb.config import Settings

from core.models import Chunk, Paper


def get_data_dir() -> Path:
    from core.collections import get_active_data_dir
    d = get_active_data_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d


def reset_db() -> None:
    """Clear all singletons — called when active collection switches."""
    global _chroma_client, _collection
    if _chroma_client is not None:
        try:
            _chroma_client._system.stop()
        except Exception:
            pass
    _chroma_client = None
    _collection = None


# ─── SQLite ──────────────────────────────────────────────────────────────────

def get_sqlite_path() -> Path:
    return get_data_dir() / "metadata.db"


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(get_sqlite_path()))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_sqlite() -> None:
    conn = _get_conn()
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS papers (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                authors     TEXT NOT NULL DEFAULT '[]',
                year        INTEGER,
                abstract    TEXT,
                file_path   TEXT NOT NULL,
                file_hash   TEXT NOT NULL,
                added_at    TEXT NOT NULL,
                tags        TEXT NOT NULL DEFAULT '[]',
                status      TEXT NOT NULL DEFAULT 'indexed',
                page_count  INTEGER NOT NULL DEFAULT 0,
                chunk_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id          TEXT PRIMARY KEY,
                paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                content     TEXT NOT NULL,
                page_number INTEGER NOT NULL DEFAULT 0,
                chunk_index INTEGER NOT NULL DEFAULT 0
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content,
                content='chunks',
                content_rowid='rowid',
                tokenize='porter ascii'
            );

            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
                INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
            END;
        """)
    conn.close()


# ─── Paper CRUD ──────────────────────────────────────────────────────────────

def insert_paper(paper: Paper) -> None:
    conn = _get_conn()
    with conn:
        conn.execute(
            # An upsert, not INSERT OR REPLACE: REPLACE deletes the row first, and the
            # ON DELETE CASCADE then wipes every chunk of the paper.
            """INSERT INTO papers
               (id, title, authors, year, abstract, file_path, file_hash,
                added_at, tags, status, page_count, chunk_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, authors=excluded.authors, year=excluded.year,
                 abstract=excluded.abstract, file_path=excluded.file_path,
                 file_hash=excluded.file_hash, added_at=excluded.added_at, tags=excluded.tags,
                 status=excluded.status, page_count=excluded.page_count,
                 chunk_count=excluded.chunk_count""",
            (
                paper.id,
                paper.title,
                json.dumps(paper.authors),
                paper.year,
                paper.abstract,
                paper.file_path,
                paper.file_hash,
                paper.added_at.isoformat(),
                json.dumps(paper.tags),
                paper.status,
                paper.page_count,
                paper.chunk_count,
            ),
        )
    conn.close()


def update_paper_status(paper_id: str, status: str, chunk_count: int = 0) -> None:
    conn = _get_conn()
    with conn:
        conn.execute(
            "UPDATE papers SET status=?, chunk_count=? WHERE id=?",
            (status, chunk_count, paper_id),
        )
    conn.close()


def get_paper(paper_id: str) -> Optional[Paper]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    conn.close()
    return _row_to_paper(row) if row else None


def list_papers(tag: str | None = None, year: int | None = None) -> list[Paper]:
    conn = _get_conn()
    sql = "SELECT * FROM papers WHERE 1=1"
    params: list = []
    if year:
        sql += " AND year=?"
        params.append(year)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    papers = [_row_to_paper(r) for r in rows]
    if tag:
        papers = [p for p in papers if tag in p.tags]
    return papers


def delete_paper(paper_id: str) -> bool:
    conn = _get_conn()
    with conn:
        cur = conn.execute("DELETE FROM papers WHERE id=?", (paper_id,))
    conn.close()
    return cur.rowcount > 0


def paper_exists_by_hash(file_hash: str) -> Optional[str]:
    conn = _get_conn()
    row = conn.execute("SELECT id FROM papers WHERE file_hash=?", (file_hash,)).fetchone()
    conn.close()
    return row["id"] if row else None


def _row_to_paper(row: sqlite3.Row) -> Paper:
    return Paper(
        id=row["id"],
        title=row["title"],
        authors=json.loads(row["authors"]),
        year=row["year"],
        abstract=row["abstract"],
        file_path=row["file_path"],
        file_hash=row["file_hash"],
        added_at=datetime.fromisoformat(row["added_at"]),
        tags=json.loads(row["tags"]),
        status=row["status"],
        page_count=row["page_count"],
        chunk_count=row["chunk_count"],
    )


# ─── Chunk CRUD ──────────────────────────────────────────────────────────────

def insert_chunks(chunks: list[Chunk]) -> None:
    if not chunks:
        return
    conn = _get_conn()
    with conn:
        conn.executemany(
            "INSERT OR REPLACE INTO chunks (id, paper_id, content, page_number, chunk_index) VALUES (?,?,?,?,?)",
            [(c.id, c.paper_id, c.content, c.page_number, c.chunk_index) for c in chunks],
        )
    conn.close()


def get_chunks_for_paper(paper_id: str) -> list[Chunk]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM chunks WHERE paper_id=? ORDER BY chunk_index", (paper_id,)
    ).fetchall()
    conn.close()
    return [Chunk(id=r["id"], paper_id=r["paper_id"], content=r["content"],
                  page_number=r["page_number"], chunk_index=r["chunk_index"]) for r in rows]


def delete_chunks_for_paper(paper_id: str) -> None:
    conn = _get_conn()
    with conn:
        conn.execute("DELETE FROM chunks WHERE paper_id=?", (paper_id,))
    conn.close()


def fts_search(query: str, top_k: int = 20) -> list[tuple[str, str, float]]:
    """Returns (chunk_id, content, bm25_score) ordered by relevance."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT c.id, c.content, bm25(chunks_fts) AS score
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY score
           LIMIT ?""",
        (query, top_k),
    ).fetchall()
    conn.close()
    return [(r["id"], r["content"], abs(float(r["score"]))) for r in rows]


# ─── ChromaDB ────────────────────────────────────────────────────────────────

_chroma_client: chromadb.PersistentClient | None = None
_collection: chromadb.Collection | None = None


def _get_chroma() -> tuple[chromadb.PersistentClient, chromadb.Collection]:
    global _chroma_client, _collection
    if _chroma_client is None:
        chroma_path = str(get_data_dir() / "chroma")
        _chroma_client = chromadb.PersistentClient(
            path=chroma_path,
            settings=Settings(anonymized_telemetry=False),
        )
        _collection = _chroma_client.get_or_create_collection(
            name="paper_chunks",
            metadata={"hnsw:space": "cosine"},
        )
    return _chroma_client, _collection  # type: ignore[return-value]


def chroma_add_chunks(chunks: list[Chunk], embeddings: list[list[float]]) -> None:
    _, col = _get_chroma()
    col.add(
        ids=[c.id for c in chunks],
        embeddings=embeddings,
        documents=[c.content for c in chunks],
        metadatas=[
            {"paper_id": c.paper_id, "page_number": c.page_number, "chunk_index": c.chunk_index}
            for c in chunks
        ],
    )


def chroma_delete_paper(paper_id: str) -> None:
    _, col = _get_chroma()
    col.delete(where={"paper_id": paper_id})


def chroma_query(embedding: list[float], top_k: int = 10) -> list[tuple[str, float]]:
    """Returns (chunk_id, distance) list."""
    _, col = _get_chroma()
    results = col.query(
        query_embeddings=[embedding],
        n_results=top_k,
        include=["distances"],
    )
    ids = results["ids"][0]
    distances = results["distances"][0]
    return list(zip(ids, distances))


def init_db() -> None:
    from core.collections import bootstrap
    bootstrap()
    init_sqlite()
    _get_chroma()
