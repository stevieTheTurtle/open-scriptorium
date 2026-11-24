from __future__ import annotations

import sqlite3
from collections import defaultdict
from pathlib import Path

from core.config import get_config
from core.database import chroma_query, fts_search, get_paper, list_papers, get_sqlite_path
from core.embeddings import get_provider
from core.models import ChunkResult, Paper, SearchResult


def _rrf_score(ranks: list[int], k: int = 60) -> float:
    return sum(1.0 / (k + r) for r in ranks)


def _get_chunk_by_id(chunk_id: str) -> tuple[str, int] | None:
    conn = sqlite3.connect(str(get_sqlite_path()))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT content, page_number FROM chunks WHERE id=?", (chunk_id,)
    ).fetchone()
    conn.close()
    return (row["content"], row["page_number"]) if row else None


def search(query: str, top_k: int | None = None, paper_ids: list[str] | None = None) -> list[SearchResult]:
    cfg = get_config()
    k = top_k or cfg.retrieval.top_k
    rrf_k = cfg.retrieval.rrf_k

    # ── Semantic retrieval ──────────────────────────────────────────────────
    provider = get_provider(cfg)
    query_emb = provider.embed_query(query)
    semantic_hits = chroma_query(query_emb, top_k=k * 2)  # (chunk_id, distance)

    # ── BM25 retrieval ──────────────────────────────────────────────────────
    bm25_hits = fts_search(query, top_k=k * 2)  # (chunk_id, content, score)

    # ── Build rank maps ─────────────────────────────────────────────────────
    semantic_rank: dict[str, int] = {cid: i + 1 for i, (cid, _) in enumerate(semantic_hits)}
    bm25_rank: dict[str, int] = {cid: i + 1 for i, (cid, _, _) in enumerate(bm25_hits)}

    all_chunk_ids = set(semantic_rank) | set(bm25_rank)

    # ── RRF fusion ──────────────────────────────────────────────────────────
    scored: list[tuple[str, float]] = []
    for cid in all_chunk_ids:
        ranks = []
        if cid in semantic_rank:
            ranks.append(semantic_rank[cid])
        if cid in bm25_rank:
            ranks.append(bm25_rank[cid])
        scored.append((cid, _rrf_score(ranks, rrf_k)))

    scored.sort(key=lambda x: x[1], reverse=True)

    # ── Build results grouped by paper ──────────────────────────────────────
    paper_chunks: dict[str, list[ChunkResult]] = defaultdict(list)
    paper_score: dict[str, float] = defaultdict(float)

    conn = sqlite3.connect(str(get_sqlite_path()))
    conn.row_factory = sqlite3.Row

    seen_papers: set[str] = set()

    for chunk_id, score in scored[: k * 3]:
        row = conn.execute(
            "SELECT content, page_number, paper_id FROM chunks WHERE id=?", (chunk_id,)
        ).fetchone()
        if row is None:
            continue
        pid = row["paper_id"]

        if paper_ids and pid not in paper_ids:
            continue

        paper_chunks[pid].append(
            ChunkResult(
                chunk_id=chunk_id,
                content=row["content"],
                page_number=row["page_number"],
                score=score,
            )
        )
        paper_score[pid] = max(paper_score[pid], score)
        seen_papers.add(pid)

    conn.close()

    results: list[SearchResult] = []
    for pid in sorted(seen_papers, key=lambda p: paper_score[p], reverse=True)[:k]:
        paper = get_paper(pid)
        if paper is None:
            continue
        chunks = sorted(paper_chunks[pid], key=lambda c: c.score, reverse=True)[:5]
        results.append(SearchResult(paper=paper, chunks=chunks, score=paper_score[pid]))

    return results


def get_context_for_query(query: str, top_k: int | None = None) -> str:
    """Return formatted context string for LLM consumption with citation markers.

    Format is structured so the LLM naturally produces [Ref N] inline citations.
    Each paper gets a [Ref N] label used both in the evidence blocks and in the
    trailing References section — which Claude should reproduce verbatim at the
    end of its answer.
    """
    results = search(query, top_k=top_k)
    if not results:
        return "No relevant papers found in the knowledge base."

    lines: list[str] = []
    lines.append(f"RETRIEVED EVIDENCE for query: \"{query}\"")
    lines.append("=" * 60)
    lines.append(
        "CITATION INSTRUCTIONS:\n"
        "1. Use [Ref N] inline for every claim derived from these papers.\n"
        "2. At the end of your response, copy the REFERENCES BLOCK below EXACTLY "
        "as written — do not reformat, abbreviate, or paraphrase it.\n"
        "3. Do not invent or omit any reference entry."
    )
    lines.append("")

    ref_entries: list[str] = []

    for i, r in enumerate(results, 1):
        p = r.paper

        # Full author list for APA — "Last, F., Last, F., & Last, F."
        def _fmt_author(name: str) -> str:
            parts = name.strip().split()
            if len(parts) >= 2:
                last = parts[-1]
                initials = " ".join(pt[0] + "." for pt in parts[:-1] if pt)
                return f"{last}, {initials}"
            return name

        if p.authors:
            fmt = [_fmt_author(a) for a in p.authors]
            if len(fmt) == 1:
                authors_apa = fmt[0]
            elif len(fmt) == 2:
                authors_apa = f"{fmt[0]}, & {fmt[1]}"
            elif len(fmt) <= 6:
                authors_apa = ", ".join(fmt[:-1]) + f", & {fmt[-1]}"
            else:
                # APA: first 6 + et al.
                authors_apa = ", ".join(fmt[:6]) + ", et al."
            # Raw list for evidence block header
            authors_display = ", ".join(p.authors[:4]) + (" et al." if len(p.authors) > 4 else "")
        else:
            authors_apa = "Unknown Author"
            authors_display = "Unknown"

        year_str = str(p.year) if p.year else "n.d."
        ref_label = f"[Ref {i}]"

        # Evidence block header
        lines.append(f"{ref_label} **{p.title}**")
        lines.append(f"  Authors : {authors_display}  ({year_str})")
        if "arxiv" in p.tags:
            lines.append(f"  Source  : [arXiv download — added via arXiv search]")
        if p.tags:
            lines.append(f"  Tags    : {', '.join(p.tags)}")
        lines.append(f"  Paper ID: {p.id}")
        lines.append("")

        # Relevant excerpts
        for chunk in r.chunks[:4]:
            lines.append(f"  [p.{chunk.page_number}] {chunk.content.strip()}")
            lines.append("")

        lines.append("-" * 40)

        # Full APA-style reference entry
        source_note = " [arXiv download]" if "arxiv" in p.tags else ""
        ref_entries.append(
            f"{ref_label} {authors_apa} ({year_str}). {p.title}. "
            f"[Paper ID: {p.id[:8]}]{source_note}"
        )

    # ── REFERENCES BLOCK ─────────────────────────────────────────────────────
    # Claude must reproduce this section verbatim at the end of its response.
    lines.append("")
    lines.append("--- REFERENCES BLOCK (copy verbatim to your response) ---")
    for entry in ref_entries:
        lines.append(entry)
    lines.append("--- END REFERENCES BLOCK ---")

    return "\n".join(lines)
