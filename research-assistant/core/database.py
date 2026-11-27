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


def get_chunks_for_paper(
    paper_id: str,
    page_from: int | None = None,
    page_to: int | None = None,
) -> list[Chunk]:
    conn = _get_conn()
    sql = "SELECT * FROM chunks WHERE paper_id=?"
    params: list = [paper_id]
    if page_from is not None:
        sql += " AND page_number>=?"
        params.append(page_from)
    if page_to is not None:
        sql += " AND page_number<=?"
        params.append(page_to)
    sql += " ORDER BY chunk_index"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [Chunk(id=r["id"], paper_id=r["paper_id"], content=r["content"],
                  page_number=r["page_number"], chunk_index=r["chunk_index"]) for r in rows]


def resolve_paper_ref(ref: str) -> Optional[Paper]:
    """Resolve a paper by full ID, 6+ char ID prefix, or @citekey (with or without @)."""
    cleaned = (ref or "").strip()
    if not cleaned:
        return None
    if not cleaned.startswith("@"):
        exact = get_paper(cleaned)
        if exact is not None:
            return exact
    key_norm = cleaned.lstrip("@").lower()
    target_tag = f"@{key_norm}"
    papers = list_papers()
    for p in papers:
        if any(t.lower() == target_tag for t in p.tags):
            return p
    if not cleaned.startswith("@") and len(cleaned) >= 6:
        prefix = cleaned.lower()
        matches = [p for p in papers if p.id.lower().startswith(prefix)]
        if len(matches) == 1:
            return matches[0]
    return None


def resolve_filtered_paper_ids(
    *,
    paper_ids: list[str] | None = None,
    citekeys: list[str] | None = None,
    tags: list[str] | None = None,
    author: str | None = None,
    year: int | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
) -> list[str] | None:
    """Resolve metadata and paper-target filters into a list of matching paper IDs.

    Returns ``None`` when no filters are active (meaning search the entire collection),
    or a concrete list of matching paper IDs (possibly empty if no paper matches).
    """
    clean_pids = [p.strip() for p in (paper_ids or []) if p and p.strip()]
    clean_keys = [k.strip().lstrip("@").lower() for k in (citekeys or []) if k and k.strip().lstrip("@")]
    clean_tags = [t.strip().lower() for t in (tags or []) if t and t.strip()]
    clean_author = (author or "").strip().lower()
    has_year = year is not None or year_from is not None or year_to is not None

    if not (clean_pids or clean_keys or clean_tags or clean_author or has_year):
        return None

    conn = _get_conn()
    sql = "SELECT * FROM papers WHERE 1=1"
    params: list = []
    if year is not None:
        sql += " AND year=?"
        params.append(year)
    if year_from is not None:
        sql += " AND year IS NOT NULL AND year>=?"
        params.append(year_from)
    if year_to is not None:
        sql += " AND year IS NOT NULL AND year<=?"
        params.append(year_to)
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    papers = [_row_to_paper(r) for r in rows]

    # Explicit paper targets (paper_ids / citekeys): union of specified targets.
    if clean_pids or clean_keys:
        pid_lowers = [p.lower() for p in clean_pids]
        target_key_tags = {f"@{k}" for k in clean_keys}
        targeted: list[Paper] = []
        for p in papers:
            pid_l = p.id.lower()
            id_match = any(
                pid_l == target or (len(target) >= 6 and pid_l.startswith(target))
                for target in pid_lowers
            )
            key_match = bool(target_key_tags) and any(
                t.lower() in target_key_tags for t in p.tags
            )
            if id_match or key_match:
                targeted.append(p)
        papers = targeted

    # Metadata filters (AND across tags and author).
    if clean_tags:
        def _has_tag(paper_tags_lower: list[str], req: str) -> bool:
            if req in paper_tags_lower:
                return True
            if req.startswith("coll:"):
                prefix = req.rstrip("/") + "/"
                return any(pt.startswith(prefix) for pt in paper_tags_lower)
            return False

        papers = [
            p for p in papers
            if all(_has_tag([t.lower() for t in p.tags], req) for req in clean_tags)
        ]

    if clean_author:
        papers = [
            p for p in papers
            if any(clean_author in a.lower() for a in p.authors)
        ]

    return [p.id for p in papers]


def count_chunks_for_papers(paper_ids: list[str] | None = None) -> int:
    conn = _get_conn()
    try:
        if paper_ids is None:
            row = conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()
            return int(row["n"]) if row else 0
        if not paper_ids:
            return 0
        if len(paper_ids) <= 900:
            placeholders = ",".join("?" for _ in paper_ids)
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM chunks WHERE paper_id IN ({placeholders})",
                paper_ids,
            ).fetchone()
            return int(row["n"]) if row else 0
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS _ra_cnt_ids (id TEXT PRIMARY KEY)")
        conn.execute("DELETE FROM _ra_cnt_ids")
        conn.executemany("INSERT OR IGNORE INTO _ra_cnt_ids (id) VALUES (?)", [(p,) for p in paper_ids])
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM chunks c JOIN _ra_cnt_ids f ON f.id = c.paper_id"
        ).fetchone()
        return int(row["n"]) if row else 0
    finally:
        conn.close()


def delete_chunks_for_paper(paper_id: str) -> None:
    conn = _get_conn()
    with conn:
        conn.execute("DELETE FROM chunks WHERE paper_id=?", (paper_id,))
    conn.close()


_FTS_STOPWORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "between",
    "both", "but", "by", "can", "could", "did", "do", "does", "during", "each",
    "for", "from", "had", "has", "have", "having", "he", "her", "here", "hers",
    "him", "his", "how", "in", "into", "is", "it", "its", "may", "might", "more",
    "most", "must", "no", "nor", "not", "of", "on", "one", "only", "or", "other",
    "our", "out", "over", "same", "shall", "she", "should", "so", "some", "such",
    "than", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "those", "through", "to", "too", "under", "up", "use", "used",
    "using", "very", "was", "we", "were", "what", "when", "where", "which",
    "while", "who", "will", "with", "within", "without", "would",
})


def build_fts_or_query(text: str, max_terms: int = 24) -> str:
    """Sanitize free-form prose into a safe OR-based SQLite FTS5 MATCH expression."""
    import re
    raw_tokens = re.findall(r"[A-Za-z0-9]{2,}", text or "")
    if not raw_tokens:
        return ""
    seen: set[str] = set()
    content_tokens: list[str] = []
    fallback_tokens: list[str] = []
    for tok in raw_tokens:
        low = tok.lower()
        if low in seen:
            continue
        seen.add(low)
        fallback_tokens.append(low)
        if low not in _FTS_STOPWORDS:
            content_tokens.append(low)
    terms = (content_tokens or fallback_tokens)[:max_terms]
    return " OR ".join(f'"{t}"' for t in terms)


def _execute_fts_query(
    match_expr: str,
    top_k: int,
    paper_ids: list[str] | None = None,
) -> list[tuple[str, str, float]]:
    if paper_ids is not None and not paper_ids:
        return []
    conn = _get_conn()
    try:
        if paper_ids is None:
            rows = conn.execute(
                """SELECT c.id, c.content, bm25(chunks_fts) AS score
                   FROM chunks_fts
                   JOIN chunks c ON c.rowid = chunks_fts.rowid
                   WHERE chunks_fts MATCH ?
                   ORDER BY score
                   LIMIT ?""",
                (match_expr, top_k),
            ).fetchall()
        elif len(paper_ids) <= 900:
            placeholders = ",".join("?" for _ in paper_ids)
            rows = conn.execute(
                f"""SELECT c.id, c.content, bm25(chunks_fts) AS score
                    FROM chunks_fts
                    JOIN chunks c ON c.rowid = chunks_fts.rowid
                    WHERE chunks_fts MATCH ? AND c.paper_id IN ({placeholders})
                    ORDER BY score
                    LIMIT ?""",
                [match_expr, *paper_ids, top_k],
            ).fetchall()
        else:
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS _ra_fts_ids (id TEXT PRIMARY KEY)")
            conn.execute("DELETE FROM _ra_fts_ids")
            conn.executemany(
                "INSERT OR IGNORE INTO _ra_fts_ids (id) VALUES (?)",
                [(pid,) for pid in paper_ids],
            )
            rows = conn.execute(
                """SELECT c.id, c.content, bm25(chunks_fts) AS score
                   FROM chunks_fts
                   JOIN chunks c ON c.rowid = chunks_fts.rowid
                   JOIN _ra_fts_ids f ON f.id = c.paper_id
                   WHERE chunks_fts MATCH ?
                   ORDER BY score
                   LIMIT ?""",
                (match_expr, top_k),
            ).fetchall()
    finally:
        conn.close()
    return [(r["id"], r["content"], abs(float(r["score"]))) for r in rows]


def fts_search_or(
    query: str,
    top_k: int = 30,
    paper_ids: list[str] | None = None,
) -> list[tuple[str, str, float]]:
    """Sanitized OR-based FTS5 BM25 search safe for arbitrary prose/sentences."""
    if paper_ids is not None and not paper_ids:
        return []
    match_expr = build_fts_or_query(query)
    if not match_expr:
        return []
    try:
        return _execute_fts_query(match_expr, top_k=top_k, paper_ids=paper_ids)
    except sqlite3.OperationalError:
        return []


def fts_search(
    query: str,
    top_k: int = 20,
    paper_ids: list[str] | None = None,
) -> list[tuple[str, str, float]]:
    """Returns (chunk_id, content, bm25_score) ordered by relevance."""
    if paper_ids is not None and not paper_ids:
        return []
    try:
        hits = _execute_fts_query(query, top_k=top_k, paper_ids=paper_ids)
    except sqlite3.OperationalError:
        return fts_search_or(query, top_k=top_k, paper_ids=paper_ids)
    if not hits:
        return fts_search_or(query, top_k=top_k, paper_ids=paper_ids)
    return hits


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


def chroma_query(
    embedding: list[float],
    top_k: int = 10,
    paper_ids: list[str] | None = None,
) -> list[tuple[str, float]]:
    """Returns (chunk_id, distance) list, optionally filtered to ``paper_ids``."""
    if paper_ids is not None and not paper_ids:
        return []
    _, col = _get_chroma()
    where: dict | None = None
    n_results = max(1, int(top_k))
    if paper_ids is not None:
        if len(paper_ids) == 1:
            where = {"paper_id": paper_ids[0]}
        else:
            where = {"paper_id": {"$in": list(paper_ids)}}
        available = count_chunks_for_papers(paper_ids)
        if available == 0:
            return []
        n_results = min(n_results, available)
    else:
        total = col.count()
        if total == 0:
            return []
        n_results = min(n_results, total)

    kwargs: dict = {
        "query_embeddings": [embedding],
        "n_results": n_results,
        "include": ["distances"],
    }
    if where is not None:
        kwargs["where"] = where

    results = col.query(**kwargs)
    ids = results["ids"][0]
    distances = results["distances"][0]
    return list(zip(ids, distances))


def init_db() -> None:
    from core.collections import bootstrap
    bootstrap()
    init_sqlite()
    _get_chroma()
