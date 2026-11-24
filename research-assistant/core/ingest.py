from __future__ import annotations

import hashlib
import logging
import re
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

import fitz  # PyMuPDF

from core.config import get_config
from core.database import (
    chroma_add_chunks,
    chroma_delete_paper,
    delete_chunks_for_paper,
    delete_paper,
    insert_chunks,
    insert_paper,
    paper_exists_by_hash,
    update_paper_status,
)
from core.embeddings import get_provider
from core.metadata import extract_metadata
from core.models import Chunk, IngestResult, Paper

log = logging.getLogger("ra.ingest")


def _setup_file_logging() -> None:
    log_path = get_config().get_data_dir() / "ingest.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not any(isinstance(h, logging.FileHandler) for h in log.handlers):
        fh = logging.FileHandler(str(log_path), encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(fh)
        log.setLevel(logging.DEBUG)


# ─── PDF Parsing ─────────────────────────────────────────────────────────────

def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _extract_text_by_page(doc: fitz.Document) -> list[tuple[int, str]]:
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if text:
            pages.append((i + 1, text))
    return pages


# ─── Chunking ────────────────────────────────────────────────────────────────

def _chunk_words(text: str, chunk_size: int, overlap: int) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks


def _make_chunks(paper_id: str, pages: list[tuple[int, str]], chunk_size: int, overlap: int) -> list[Chunk]:
    chunks: list[Chunk] = []
    idx = 0
    for page_num, text in pages:
        for part in _chunk_words(text, chunk_size, overlap):
            if not part.strip():
                continue
            chunks.append(Chunk(
                id=f"{paper_id}_{idx}",
                paper_id=paper_id,
                content=part,
                page_number=page_num,
                chunk_index=idx,
            ))
            idx += 1
    return chunks


# ─── Public API ──────────────────────────────────────────────────────────────

def ingest_pdf(
    pdf_path: Path,
    tags: list[str] | None = None,
    force: bool = False,
) -> IngestResult:
    _setup_file_logging()
    cfg = get_config()
    pdf_path = Path(pdf_path).resolve()
    log.info("START ingest: %s", pdf_path.name)

    file_hash = _hash_file(pdf_path)
    existing_id = paper_exists_by_hash(file_hash)
    if existing_id and not force:
        return IngestResult(
            paper_id=existing_id,
            title="",
            chunk_count=0,
            success=False,
            error="Already indexed (same file hash). Use force=True to re-index.",
        )

    paper_id = existing_id or str(uuid.uuid4())

    try:
        doc = fitz.open(str(pdf_path))
        pages = _extract_text_by_page(doc)

        # Zotero-style metadata: DOI→CrossRef, arXiv ID→arXiv API, then heuristic
        meta = extract_metadata(doc)

        paper = Paper(
            id=paper_id,
            title=meta["title"],
            authors=meta["authors"],
            year=meta["year"],
            abstract=meta["abstract"],
            file_path=str(pdf_path),
            file_hash=file_hash,
            added_at=datetime.now(timezone.utc),
            tags=tags or [],
            status="processing",
            page_count=len(doc),
        )
        insert_paper(paper)

        chunks = _make_chunks(
            paper_id, pages, cfg.chunking.chunk_size, cfg.chunking.chunk_overlap
        )

        provider = get_provider(cfg)
        batch_size = 64
        embeddings: list[list[float]] = []
        for i in range(0, len(chunks), batch_size):
            batch = chunks[i : i + batch_size]
            embeddings.extend(provider.embed([c.content for c in batch]))

        if force and existing_id:
            chroma_delete_paper(paper_id)
            delete_chunks_for_paper(paper_id)

        insert_chunks(chunks)
        chroma_add_chunks(chunks, embeddings)

        update_paper_status(paper_id, "indexed", len(chunks))
        doc.close()
        log.info("OK %s — %d chunks", meta["title"][:60], len(chunks))

        return IngestResult(
            paper_id=paper_id,
            title=meta["title"],
            chunk_count=len(chunks),
            success=True,
        )

    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        log.error("FAILED %s\n%s", pdf_path.name, tb)
        try:
            update_paper_status(paper_id, "failed")
        except Exception:
            pass
        return IngestResult(
            paper_id=paper_id,
            title="",
            chunk_count=0,
            success=False,
            error=str(exc),
        )


def remove_paper(paper_id: str) -> bool:
    chroma_delete_paper(paper_id)
    delete_chunks_for_paper(paper_id)
    return delete_paper(paper_id)
