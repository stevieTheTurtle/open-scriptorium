"""Metadata extraction — mirrors Zotero's approach.

Priority order (same as Zotero):
  1. DOI found in PDF → CrossRef API (full structured metadata)
  2. arXiv ID found in PDF → arXiv API
  3. Heuristic extraction from PDF text (title from largest font, authors from header)

CrossRef and arXiv APIs are free with no API key required.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Optional

import fitz  # PyMuPDF
import httpx

# ── Regex patterns ─────────────────────────────────────────────────────────────

# DOI: matches 10.NNNN/anything-not-whitespace  (Zotero's pattern)
_DOI_RE = re.compile(
    r'\b(10\.\d{4,9}/[^\s"<>{}\[\]|\\^`\x00-\x1f]+)',
    re.IGNORECASE,
)

# arXiv IDs: new format YYMM.NNNNN and old format hep-th/XXXXXXX etc.
_ARXIV_NEW = re.compile(r'\barXiv[:\s]+([\d]{4}\.[\d]{4,5}(?:v\d+)?)\b', re.IGNORECASE)
_ARXIV_URL = re.compile(r'arxiv\.org/(?:abs|pdf)/([\d]{4}\.[\d]{4,5}(?:v\d+)?|[a-z\-]+/\d{7})', re.IGNORECASE)
_ARXIV_OLD = re.compile(r'\b([a-z\-]+/\d{7})\b')  # e.g. hep-th/9901001

# Cleanup trailing punctuation from DOI matches
_DOI_TRAIL = re.compile(r'[.,;)\]>]+$')

_TIMEOUT = 8.0  # seconds per request
_HEADERS = {"User-Agent": "ResearchAssistant/1.0 (mailto:user@localhost)"}  # polite pool


# ── Text extraction helpers ────────────────────────────────────────────────────

def _first_pages_text(doc: fitz.Document, n: int = 3) -> str:
    """Extract plain text from first N pages."""
    parts = []
    for i in range(min(n, len(doc))):
        parts.append(doc[i].get_text("text"))
    return "\n".join(parts)


def _extract_doi(text: str) -> Optional[str]:
    m = _DOI_RE.search(text)
    if not m:
        return None
    doi = _DOI_TRAIL.sub("", m.group(1))
    return doi


def _extract_arxiv_id(text: str) -> Optional[str]:
    for pat in (_ARXIV_NEW, _ARXIV_URL, _ARXIV_OLD):
        m = pat.search(text)
        if m:
            return m.group(1)
    return None


# ── CrossRef API ──────────────────────────────────────────────────────────────

def _lookup_crossref(doi: str) -> Optional[dict]:
    url = f"https://api.crossref.org/works/{doi}"
    try:
        resp = httpx.get(url, headers=_HEADERS, timeout=_TIMEOUT, follow_redirects=True)
        if resp.status_code != 200:
            return None
        data = resp.json().get("message", {})
    except Exception:
        return None

    # Title
    titles = data.get("title", [])
    title = titles[0].strip() if titles else None

    # Authors → "First Last" format
    authors = []
    for a in data.get("author", []):
        given = a.get("given", "").strip()
        family = a.get("family", "").strip()
        if family and given:
            authors.append(f"{given} {family}")
        elif family:
            authors.append(family)

    # Year
    year = None
    for date_field in ("published", "published-print", "published-online", "issued"):
        dp = data.get(date_field, {}).get("date-parts", [[]])
        if dp and dp[0]:
            year = int(dp[0][0])
            break

    # Abstract (CrossRef sometimes has it, often doesn't)
    abstract = data.get("abstract", "").strip() or None
    if abstract:
        # Strip JATS XML tags CrossRef sometimes includes
        abstract = re.sub(r"<[^>]+>", " ", abstract).strip()
        abstract = re.sub(r"\s+", " ", abstract)

    # Venue
    venue_parts = data.get("container-title", [])
    venue = venue_parts[0].strip() if venue_parts else None

    if not title:
        return None

    return {
        "title": title,
        "authors": authors,
        "year": year,
        "abstract": abstract,
        "venue": venue,
        "doi": doi,
        "source": "crossref",
    }


# ── arXiv API ─────────────────────────────────────────────────────────────────

def _lookup_arxiv(arxiv_id: str) -> Optional[dict]:
    # Strip version suffix for lookup
    base_id = re.sub(r'v\d+$', '', arxiv_id)
    url = f"https://export.arxiv.org/api/query?id_list={base_id}"
    try:
        resp = httpx.get(url, headers=_HEADERS, timeout=_TIMEOUT)
        if resp.status_code != 200:
            return None
        root = ET.fromstring(resp.text)
    except Exception:
        return None

    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "arxiv": "http://arxiv.org/schemas/atom",
    }

    entry = root.find("atom:entry", ns)
    if entry is None:
        return None

    title_el = entry.find("atom:title", ns)
    title = " ".join((title_el.text or "").split()) if title_el is not None else None

    authors = []
    for author_el in entry.findall("atom:author", ns):
        name_el = author_el.find("atom:name", ns)
        if name_el is not None and name_el.text:
            authors.append(name_el.text.strip())

    year = None
    pub_el = entry.find("atom:published", ns)
    if pub_el is not None and pub_el.text:
        m = re.match(r"(\d{4})", pub_el.text)
        if m:
            year = int(m.group(1))

    summary_el = entry.find("atom:summary", ns)
    abstract = " ".join((summary_el.text or "").split()) if summary_el is not None else None

    if not title:
        return None

    return {
        "title": title,
        "authors": authors,
        "year": year,
        "abstract": abstract or None,
        "venue": "arXiv",
        "doi": None,
        "arxiv_id": arxiv_id,
        "source": "arxiv",
    }


# ── Heuristic fallback (improved) ────────────────────────────────────────────

def _heuristic(doc: fitz.Document, first_page_text: str) -> dict:
    """Font-size title + pattern-based author/year extraction."""
    title = _heuristic_title(doc)
    authors = _heuristic_authors(first_page_text)
    year = _heuristic_year(first_page_text)
    abstract = _heuristic_abstract(first_page_text)
    return {
        "title": title or "Untitled",
        "authors": authors,
        "year": year,
        "abstract": abstract,
        "venue": None,
        "doi": None,
        "source": "heuristic",
    }


def _heuristic_title(doc: fitz.Document) -> Optional[str]:
    """Largest font text block on page 1 = title (Zotero's heuristic)."""
    try:
        page = doc[0]
        blocks = page.get_text("dict")["blocks"]
        candidates: list[tuple[float, str]] = []
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span.get("text", "").strip()
                    size = span.get("size", 0)
                    if text and size > 10 and len(text) > 5:
                        candidates.append((size, text))
        if not candidates:
            return None
        # Group spans by font size, take largest group
        candidates.sort(key=lambda x: -x[0])
        max_size = candidates[0][0]
        title_parts = [t for s, t in candidates if abs(s - max_size) < 1.5]
        title = " ".join(title_parts[:8])  # max 8 spans
        return re.sub(r"\s+", " ", title).strip()[:300] or None
    except Exception:
        return None


def _heuristic_authors(text: str) -> list[str]:
    """Look for author-like lines in first 50 lines."""
    authors: list[str] = []
    lines = [l.strip() for l in text.splitlines() if l.strip()][:60]

    # Pattern: lines with comma-separated names near the top
    name_pat = re.compile(
        r"^([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)"
        r"(?:\s*[,;&]\s*[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)*$"
    )
    for line in lines[1:20]:
        if name_pat.match(line) and len(line) < 200:
            parts = re.split(r"[,;&]+", line)
            for p in parts:
                p = p.strip()
                if 4 < len(p) < 60 and p:
                    authors.append(p)
            if authors:
                break

    # Fallback: look for "Author: ..." or "Authors: ..." line
    if not authors:
        for line in lines[:30]:
            m = re.match(r"(?:authors?|by)\s*:?\s*(.+)", line, re.IGNORECASE)
            if m:
                raw = m.group(1)
                parts = re.split(r"[,;&]+", raw)
                authors = [p.strip() for p in parts if p.strip() and len(p.strip()) < 60]
                break

    return authors[:20]


def _heuristic_year(text: str) -> Optional[int]:
    years = re.findall(r'\b(20[0-2]\d|19[89]\d)\b', text[:3000])
    if years:
        from collections import Counter
        return int(Counter(years).most_common(1)[0][0])
    return None


def _heuristic_abstract(text: str) -> Optional[str]:
    m = re.search(
        r'(?i)\babstract\b[:\s—\-]*(.+?)(?=\n\s*\n|\b(?:introduction|keywords|1[\.\s])\b)',
        text,
        re.DOTALL,
    )
    if m:
        ab = re.sub(r"\s+", " ", m.group(1)).strip()
        return ab[:2000] if len(ab) > 30 else None
    return None


# ── Public API ────────────────────────────────────────────────────────────────

def extract_metadata(doc: fitz.Document) -> dict:
    """
    Extract bibliographic metadata from a PDF document.
    Tries DOI→CrossRef, arXiv ID→arXiv API, then heuristic fallback.
    Returns dict with keys: title, authors, year, abstract, venue, doi, source.
    """
    text = _first_pages_text(doc, n=3)
    first_page = doc[0].get_text("text") if len(doc) > 0 else ""

    # 1. DOI → CrossRef
    doi = _extract_doi(text)
    if doi:
        result = _lookup_crossref(doi)
        if result:
            # Fill missing abstract from PDF if CrossRef didn't have it
            if not result.get("abstract"):
                result["abstract"] = _heuristic_abstract(first_page)
            return result

    # 2. arXiv ID → arXiv API
    arxiv_id = _extract_arxiv_id(text)
    if arxiv_id:
        result = _lookup_arxiv(arxiv_id)
        if result:
            if not result.get("abstract"):
                result["abstract"] = _heuristic_abstract(first_page)
            return result

    # 3. PDF embedded metadata
    embedded = doc.metadata or {}
    emb_title = embedded.get("title", "").strip()
    emb_author = embedded.get("author", "").strip()
    if emb_title and len(emb_title) > 5:
        authors = [a.strip() for a in re.split(r"[;,]", emb_author) if a.strip()] if emb_author else []
        year = _heuristic_year(text)
        return {
            "title": emb_title,
            "authors": authors,
            "year": year,
            "abstract": _heuristic_abstract(first_page),
            "venue": None,
            "doi": None,
            "source": "pdf_metadata",
        }

    # 4. Full heuristic
    return _heuristic(doc, first_page)
