"""Local, zero-LLM supporting-citation finder for selected LaTeX or PDF prose.

Pipeline:
1. Clean selected LaTeX/PDF text (strip macros, citations, comments, repair line-break hyphens/ligatures).
2. Hybrid recall: ChromaDB semantic search + sanitized OR-based FTS5 BM25 fused via weighted RRF.
3. Local CrossEncoder reranking (sentence-transformers CrossEncoder, supporting both single-logit
   MS-MARCO/BGE rerankers and 3-class NLI entailment models) with a graceful offline lexical fallback.
4. Sentence-level verbatim quote extraction inside top reranked chunks to pinpoint the exact
   1-2 supporting sentences and page number.
"""
from __future__ import annotations

import logging
import math
import re
import sqlite3
import threading
import time
from typing import Any, Callable, Optional

from core.config import get_config
from core.database import (
    chroma_query,
    fts_search_or,
    get_paper,
    get_sqlite_path,
    resolve_filtered_paper_ids,
)
from core.embeddings import get_provider

logger = logging.getLogger(__name__)

# ─── Text cleaning ───────────────────────────────────────────────────────────

_LIGATURES = str.maketrans({
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u00a0": " ",
})

_DROP_COMMANDS_RE = re.compile(
    r"\\(?:cite[a-zA-Z]*|parencite|textcite|autocite|footcite|nocite|"
    r"ref|eqref|cref|Cref|pageref|autoref|nameref|label|index|footnote|marginpar|"
    r"gls[a-zA-Z]*|acr[a-zA-Z]*)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{[^{}]*\}"
)

_UNWRAP_COMMANDS = frozenset({
    "textbf", "textit", "emph", "underline", "texttt", "textsc", "textrm",
    "textsf", "text", "mathrm", "mathbf", "mathit", "enquote", "mbox", "hbox",
    "citeauthor", "title", "section", "subsection", "subsubsection", "paragraph",
    "caption", "hl", "textcolor",
})

_LATEX_COMMENT_RE = re.compile(r"(?m)(?<!\\)%.*$")
_LINE_HYPHEN_RE = re.compile(r"([A-Za-z])-\s*\r?\n\s*([a-z])")
_INLINE_HYPHEN_BREAK_RE = re.compile(r"([A-Za-z]{2,})-\s+([a-z]{2,})")


def _unwrap_braced_commands(text: str) -> str:
    """Unwrap formatting macros like \\textbf{foo} -> foo (handling nested braces)."""
    out = text
    for _ in range(5):
        changed = False
        i = 0
        n = len(out)
        buf: list[str] = []
        while i < n:
            if out[i] == "\\":
                m = re.match(r"\\([A-Za-z]+)\*?", out[i:])
                if m and m.group(1) in _UNWRAP_COMMANDS:
                    j = i + m.end()
                    # Skip optional [...] args and extra first brace arg for \textcolor{color}{text}
                    while j < n and out[j].isspace():
                        j += 1
                    while j < n and out[j] == "[":
                        end_opt = out.find("]", j + 1)
                        if end_opt == -1:
                            break
                        j = end_opt + 1
                        while j < n and out[j].isspace():
                            j += 1
                    if m.group(1) == "textcolor" and j < n and out[j] == "{":
                        depth = 0
                        k = j
                        while k < n:
                            if out[k] == "{":
                                depth += 1
                            elif out[k] == "}":
                                depth -= 1
                                if depth == 0:
                                    j = k + 1
                                    break
                            k += 1
                        while j < n and out[j].isspace():
                            j += 1
                    if j < n and out[j] == "{":
                        depth = 0
                        k = j
                        while k < n:
                            if out[k] == "{":
                                depth += 1
                            elif out[k] == "}":
                                depth -= 1
                                if depth == 0:
                                    buf.append(out[j + 1 : k])
                                    i = k + 1
                                    changed = True
                                    break
                            k += 1
                        else:
                            buf.append(out[i])
                            i += 1
                        continue
            buf.append(out[i])
            i += 1
        out = "".join(buf)
        if not changed:
            break
    return out


def clean_pdf_excerpt(raw: str) -> str:
    """Repair only PDF extraction artefacts (line-break hyphens, ligatures, soft spaces)
    while keeping verbatim wording intact."""
    if not raw:
        return ""
    s = raw.translate(_LIGATURES)
    s = _LINE_HYPHEN_RE.sub(r"\1\2", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def clean_claim_text(raw: str) -> str:
    """Clean selected LaTeX or PDF prose into a plain-text claim for retrieval & reranking."""
    if not raw:
        return ""
    s = raw.translate(_LIGATURES)
    # Strip LaTeX comments before collapsing newlines
    s = _LATEX_COMMENT_RE.sub("", s)
    # Repair PDF line-break hyphens (e.g. "inter-\naction" -> "interaction")
    s = _LINE_HYPHEN_RE.sub(r"\1\2", s)
    # Remove citations, cross-refs, labels, footnotes
    for _ in range(3):
        next_s = _DROP_COMMANDS_RE.sub(" ", s)
        if next_s == s:
            break
        s = next_s
    # Unwrap common formatting commands
    s = _unwrap_braced_commands(s)
    # LaTeX escapes and punctuation
    s = s.replace("``", '"').replace("''", '"')
    s = s.replace("---", " — ").replace("--", "–")
    s = s.replace("~", " ")
    s = re.sub(r"\\([%&_$#{}])", r"\1", s)
    s = re.sub(r"\\[,;:! ]", " ", s)
    # Remove inline math delimiters while keeping readable symbols
    s = re.sub(r"\\\(|\\\)|\\\[|\\\]|\$\$|\$", " ", s)
    # Strip remaining control sequences (e.g. \noindent, \par, \alpha -> keep word if Greek? strip command)
    s = re.sub(r"\\[A-Za-z]+\*?(?:\s*\[[^\]]*\])?", " ", s)
    s = s.replace("{", " ").replace("}", " ")
    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ─── Sentence splitting & quote extraction ───────────────────────────────────

_ABBREV_RE = re.compile(
    r"\b(?:et\s+al|e\.g|i\.e|vs|etc|fig|figs|sec|eq|eqs|tab|ref|refs|dr|mr|mrs|ms|prof|no|pp|vol|cf|approx|al)\.$",
    re.IGNORECASE,
)
_INITIAL_RE = re.compile(r"\b[A-Z]\.$")

_STOPWORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "been", "by", "can", "could",
    "do", "does", "for", "from", "had", "has", "have", "in", "into", "is",
    "it", "its", "may", "might", "more", "most", "not", "of", "on", "one",
    "or", "other", "our", "out", "over", "should", "so", "some", "such",
    "than", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "those", "to", "was", "we", "were", "what", "when", "where",
    "which", "while", "who", "will", "with", "would",
})


def split_sentences(text: str) -> list[str]:
    """Split cleaned academic text into sentences while respecting common abbreviations."""
    cleaned = clean_pdf_excerpt(text)
    if not cleaned:
        return []

    raw_parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(\[\"'“])", cleaned)
    merged: list[str] = []
    for part in raw_parts:
        part = part.strip()
        if not part:
            continue
        if merged and (_ABBREV_RE.search(merged[-1]) or _INITIAL_RE.search(merged[-1])):
            merged[-1] = f"{merged[-1]} {part}"
        else:
            merged.append(part)
    return merged


def _tokenize_content(text: str) -> list[str]:
    return [
        t.lower()
        for t in re.findall(r"[A-Za-z0-9]{2,}", text or "")
        if t.lower() not in _STOPWORDS
    ]


def _lexical_support_score(claim: str, passage: str) -> float:
    """Fast, offline token + bigram overlap score in [0, 1] for fallback ranking."""
    claim_toks = _tokenize_content(claim)
    pass_toks = _tokenize_content(passage)
    if not claim_toks or not pass_toks:
        return 0.0
    claim_set = set(claim_toks)
    pass_set = set(pass_toks)
    uni_recall = len(claim_set & pass_set) / max(len(claim_set), 1)
    claim_bi = set(zip(claim_toks, claim_toks[1:]))
    pass_bi = set(zip(pass_toks, pass_toks[1:]))
    bi_recall = (len(claim_bi & pass_bi) / len(claim_bi)) if claim_bi else 0.0
    # Slight penalty for very short fragments or huge walls of text
    length_bonus = 1.0 if 40 <= len(passage) <= 450 else 0.88
    return min(1.0, (0.72 * uni_recall + 0.28 * bi_recall) * length_bonus)


def build_quote_candidates(chunk_text: str, max_candidates: int = 8) -> list[str]:
    """Generate 1-sentence and adjacent 2-sentence verbatim candidate quotes from a chunk."""
    sentences = split_sentences(chunk_text)
    if not sentences:
        cleaned = clean_pdf_excerpt(chunk_text)
        return [cleaned[:480]] if cleaned else []

    candidates: list[str] = []
    seen: set[str] = set()

    def _add(s: str) -> None:
        s = s.strip()
        if len(s) >= 24 and s not in seen:
            seen.add(s)
            candidates.append(s)

    for s in sentences:
        if len(s) <= 520:
            _add(s)
    for i in range(len(sentences) - 1):
        pair = f"{sentences[i]} {sentences[i + 1]}"
        if len(pair) <= 560:
            _add(pair)

    if not candidates:
        fallback = clean_pdf_excerpt(chunk_text)
        return [fallback[:500]] if fallback else []

    return candidates[:max_candidates]


def extract_best_quote(
    claim: str,
    chunk_text: str,
    scorer: Optional[Callable[[list[tuple[str, str]]], list[float]]] = None,
) -> tuple[str, float]:
    """Select the exact 1-2 verbatim sentences inside chunk_text that best support claim."""
    candidates = build_quote_candidates(chunk_text, max_candidates=10)
    if not candidates:
        return clean_pdf_excerpt(chunk_text)[:480], 0.0
    if len(candidates) == 1:
        if scorer:
            scores = scorer([(claim, candidates[0])])
            return candidates[0], float(scores[0]) if scores else 0.0
        return candidates[0], _lexical_support_score(claim, candidates[0])

    if scorer is not None:
        pairs = [(claim, c) for c in candidates]
        scores = scorer(pairs)
        best_idx = max(range(len(candidates)), key=lambda i: scores[i])
        return candidates[best_idx], float(scores[best_idx])

    scores = [_lexical_support_score(claim, c) for c in candidates]
    best_idx = max(range(len(candidates)), key=lambda i: scores[i])
    return candidates[best_idx], float(scores[best_idx])


# ─── Local CrossEncoder reranker (lazy cached singleton) ─────────────────────

_reranker_lock = threading.Lock()
_reranker_cache: dict[str, Any] = {}
_reranker_failed: set[str] = set()


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def _softmax(vals: list[float]) -> list[float]:
    m = max(vals)
    exps = [math.exp(v - m) for v in vals]
    total = sum(exps) or 1.0
    return [e / total for e in exps]


def _score_with_cross_encoder(model: Any, pairs: list[tuple[str, str]]) -> list[float]:
    """Score (claim, passage) pairs into calibrated [0, 1] support scores.

    Supports both single-logit relevance cross-encoders (MS-MARCO, BGE-reranker)
    and 3-class NLI models (entailment / neutral / contradiction).
    """
    if not pairs:
        return []
    raw = model.predict(pairs, show_progress_bar=False)
    # Detect NLI label mapping if multi-class
    entail_idx: Optional[int] = None
    id2label = getattr(getattr(model, "model", None), "config", None)
    id2label = getattr(id2label, "id2label", None) if id2label is not None else None
    if isinstance(id2label, dict) and len(id2label) >= 2:
        for k, v in id2label.items():
            if "entail" in str(v).lower():
                entail_idx = int(k)
                break

    scores: list[float] = []
    for item in raw:
        if hasattr(item, "__len__") and len(item) >= 2:
            vals = [float(x) for x in item]
            probs = _softmax(vals)
            idx = entail_idx if entail_idx is not None and 0 <= entail_idx < len(probs) else 1
            scores.append(probs[idx])
        else:
            val = float(item[0]) if hasattr(item, "__len__") else float(item)
            scores.append(_sigmoid(val))
    return scores


def _get_reranker(model_name: str) -> Optional[Any]:
    if not model_name or model_name in _reranker_failed:
        return None
    with _reranker_lock:
        if model_name in _reranker_cache:
            return _reranker_cache[model_name]
        if model_name in _reranker_failed:
            return None
        try:
            from sentence_transformers import CrossEncoder
            model = CrossEncoder(model_name)
            _reranker_cache[model_name] = model
            return model
        except Exception as exc:
            logger.warning("CrossEncoder '%s' unavailable (%s); falling back to hybrid+lexical ranking.", model_name, exc)
            _reranker_failed.add(model_name)
            return None


def _citekey_from_tags(tags: list[str]) -> str:
    for t in tags or []:
        if isinstance(t, str) and t.startswith("@") and len(t) > 1:
            return t[1:]
    return ""


# ─── End-to-end claim support search ─────────────────────────────────────────

def find_supporting_citations(
    claim: str,
    *,
    top_k: int = 8,
    recall_k: Optional[int] = None,
    use_reranker: bool = True,
    reranker_model: Optional[str] = None,
    paper_ids: Optional[list[str]] = None,
    citekeys: Optional[list[str]] = None,
    tags: Optional[list[str]] = None,
    author: Optional[str] = None,
    year: Optional[int] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    mode: str = "hybrid",
    semantic_weight: Optional[float] = None,
    bm25_weight: Optional[float] = None,
    rrf_k: Optional[int] = None,
) -> dict[str, Any]:
    """Find papers & verbatim sentences in the local library that best support `claim`."""
    t0 = time.perf_counter()
    cfg = get_config()
    clean = clean_claim_text(claim)
    from core.collections import get_active_name
    collection = get_active_name()

    if not clean:
        return {
            "claim": "",
            "raw_claim": claim,
            "reranker": "none",
            "collection": collection,
            "elapsed_ms": 0,
            "results": [],
        }

    resolved_ids = resolve_filtered_paper_ids(
        paper_ids=paper_ids,
        citekeys=citekeys,
        tags=tags,
        author=author,
        year=year,
        year_from=year_from,
        year_to=year_to,
    )
    if resolved_ids is not None and not resolved_ids:
        return {
            "claim": clean,
            "raw_claim": claim,
            "reranker": "none",
            "collection": collection,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "results": [],
        }

    eff_recall = max(top_k * 3, recall_k or cfg.retrieval.recall_k or 30)
    eff_rrf_k = cfg.retrieval.rrf_k if rrf_k is None else max(1, int(rrf_k))
    sem_w = cfg.retrieval.semantic_weight if semantic_weight is None else max(0.0, float(semantic_weight))
    bm25_w = cfg.retrieval.bm25_weight if bm25_weight is None else max(0.0, float(bm25_weight))
    if sem_w == 0.0 and bm25_w == 0.0:
        sem_w, bm25_w = 1.0, 1.0

    # ── Stage 1: Hybrid recall (ChromaDB semantic + sanitized OR FTS5 BM25) ─
    semantic_hits: list[tuple[str, float]] = []
    if mode in ("hybrid", "semantic"):
        try:
            provider = get_provider(cfg)
            query_emb = provider.embed_query(clean)
            semantic_hits = chroma_query(query_emb, top_k=eff_recall, paper_ids=resolved_ids)
        except Exception as exc:
            if mode == "semantic":
                raise
            logger.warning("Semantic recall failed (%s); continuing with FTS5 BM25.", exc)

    bm25_hits: list[tuple[str, str, float]] = []
    if mode in ("hybrid", "bm25"):
        bm25_hits = fts_search_or(clean, top_k=eff_recall, paper_ids=resolved_ids)

    sem_rank = {cid: i + 1 for i, (cid, _) in enumerate(semantic_hits)}
    bm25_rank = {cid: i + 1 for i, (cid, _, _) in enumerate(bm25_hits)}
    all_ids = set(sem_rank) | set(bm25_rank)

    if not all_ids:
        return {
            "claim": clean,
            "raw_claim": claim,
            "reranker": "none",
            "collection": collection,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "results": [],
        }

    fused: list[tuple[str, float]] = []
    for cid in all_ids:
        score = 0.0
        if cid in sem_rank:
            score += sem_w / (eff_rrf_k + sem_rank[cid])
        if cid in bm25_rank:
            score += bm25_w / (eff_rrf_k + bm25_rank[cid])
        fused.append((cid, score))
    fused.sort(key=lambda x: x[1], reverse=True)

    pool_limit = min(len(fused), max(25, top_k * 3))
    candidate_ids = [cid for cid, _ in fused[:pool_limit]]
    rrf_map = dict(fused[:pool_limit])
    recall_rank_map = {cid: i + 1 for i, cid in enumerate(candidate_ids)}

    conn = sqlite3.connect(str(get_sqlite_path()))
    conn.row_factory = sqlite3.Row
    placeholders = ",".join("?" for _ in candidate_ids)
    rows = conn.execute(
        f"SELECT id, paper_id, content, page_number FROM chunks WHERE id IN ({placeholders})",
        candidate_ids,
    ).fetchall()
    conn.close()

    chunk_by_id = {r["id"]: r for r in rows}
    candidates = [chunk_by_id[cid] for cid in candidate_ids if cid in chunk_by_id]

    if not candidates:
        return {
            "claim": clean,
            "raw_claim": claim,
            "reranker": "none",
            "collection": collection,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "results": [],
        }

    # ── Stage 2: Local CrossEncoder reranking (or offline fallback) ─────────
    model_name = (reranker_model or cfg.retrieval.reranker_model or "").strip()
    ce_model = _get_reranker(model_name) if use_reranker and model_name else None

    if ce_model is not None:
        reranker_used = model_name
        chunk_pairs = [(clean, clean_pdf_excerpt(r["content"])) for r in candidates]
        chunk_scores = _score_with_cross_encoder(ce_model, chunk_pairs)
    else:
        reranker_used = "fallback"
        max_rrf = max(rrf_map.values()) or 1.0
        chunk_scores = []
        for r in candidates:
            norm_rrf = rrf_map[r["id"]] / max_rrf
            lex = _lexical_support_score(clean, r["content"])
            chunk_scores.append(0.55 * norm_rrf + 0.45 * lex)

    # Deduplicate by paper, keeping the highest-scoring chunk per paper
    best_by_paper: dict[str, tuple[sqlite3.Row, float]] = {}
    for row, sc in zip(candidates, chunk_scores):
        pid = row["paper_id"]
        prev = best_by_paper.get(pid)
        if prev is None or sc > prev[1]:
            best_by_paper[pid] = (row, sc)

    ranked_papers = sorted(best_by_paper.items(), key=lambda kv: kv[1][1], reverse=True)[:top_k]

    # ── Stage 3: Sentence-level verbatim quote extraction ───────────────────
    # Batch all sentence candidates across the top_k chunks into one CrossEncoder call for speed!
    per_paper_cands: list[list[str]] = [
        build_quote_candidates(row["content"], max_candidates=6)
        for _, (row, _) in ranked_papers
    ]

    if ce_model is not None:
        flat_pairs: list[tuple[str, str]] = []
        slices: list[tuple[int, int]] = []
        for cands in per_paper_cands:
            start = len(flat_pairs)
            for c in cands:
                flat_pairs.append((clean, c))
            slices.append((start, len(flat_pairs)))
        flat_scores = _score_with_cross_encoder(ce_model, flat_pairs) if flat_pairs else []
    else:
        flat_scores = []
        slices = []

    results: list[dict[str, Any]] = []
    for idx, (pid, (row, chunk_score)) in enumerate(ranked_papers):
        paper = get_paper(pid)
        if paper is None:
            continue
        cands = per_paper_cands[idx]
        if ce_model is not None and cands:
            start, end = slices[idx]
            sub_scores = flat_scores[start:end]
            best_i = max(range(len(cands)), key=lambda i: sub_scores[i])
            best_quote = cands[best_i]
            quote_score = sub_scores[best_i]
            final_score = 0.6 * chunk_score + 0.4 * quote_score
        elif cands:
            sub_scores = [_lexical_support_score(clean, c) for c in cands]
            best_i = max(range(len(cands)), key=lambda i: sub_scores[i])
            best_quote = cands[best_i]
            final_score = chunk_score
        else:
            best_quote = clean_pdf_excerpt(row["content"])[:450]
            final_score = chunk_score

        results.append({
            "paper_id": paper.id,
            "citekey": _citekey_from_tags(paper.tags),
            "title": paper.title,
            "authors": paper.authors,
            "year": paper.year,
            "tags": paper.tags,
            "file_path": paper.file_path,
            "page": int(row["page_number"] or 0),
            "quote": best_quote,
            "chunk": clean_pdf_excerpt(row["content"]),
            "score": round(float(final_score), 4),
            "recall_rank": recall_rank_map.get(row["id"], 0),
        })

    # Re-sort after sentence-level refinement
    results.sort(key=lambda r: r["score"], reverse=True)

    return {
        "claim": clean,
        "raw_claim": claim,
        "reranker": reranker_used,
        "collection": collection,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        "results": results,
    }
