"""arXiv API client — search and fetch paper metadata + PDFs."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

import httpx

_BASE = "https://export.arxiv.org/api/query"
_NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
_TIMEOUT = 20.0


@dataclass
class ArxivResult:
    arxiv_id: str
    title: str
    authors: list[str]
    year: int | None
    abstract: str
    pdf_url: str
    abs_url: str
    published: str
    categories: list[str] = field(default_factory=list)


def _parse_feed(xml_text: str) -> list[ArxivResult]:
    root = ET.fromstring(xml_text)
    results: list[ArxivResult] = []
    for entry in root.findall("atom:entry", _NS):
        raw_id = (entry.findtext("atom:id", "", _NS) or "").strip()
        arxiv_id = raw_id.split("/abs/")[-1].split("v")[0]
        title = (entry.findtext("atom:title", "", _NS) or "").strip().replace("\n", " ")
        abstract = (entry.findtext("atom:summary", "", _NS) or "").strip().replace("\n", " ")
        published = (entry.findtext("atom:published", "", _NS) or "")[:10]
        year = int(published[:4]) if published else None

        authors = [
            a.findtext("atom:name", "", _NS) or ""
            for a in entry.findall("atom:author", _NS)
        ]

        pdf_url = ""
        abs_url = f"https://arxiv.org/abs/{arxiv_id}"
        for link in entry.findall("atom:link", _NS):
            if link.get("type") == "application/pdf":
                pdf_url = link.get("href", "")
            elif link.get("rel") == "alternate":
                abs_url = link.get("href", abs_url)

        categories = [
            tag.get("term", "")
            for tag in entry.findall("arxiv:primary_category", _NS)
        ] + [
            cat.get("term", "")
            for cat in entry.findall("atom:category", _NS)
        ]
        categories = list(dict.fromkeys(c for c in categories if c))

        results.append(ArxivResult(
            arxiv_id=arxiv_id,
            title=title,
            authors=authors,
            year=year,
            abstract=abstract,
            pdf_url=pdf_url,
            abs_url=abs_url,
            published=published,
            categories=categories,
        ))
    return results


def search_arxiv(query: str, max_results: int = 10) -> list[ArxivResult]:
    """Search arXiv using the public API."""
    resp = httpx.get(
        _BASE,
        params={"search_query": query, "start": 0, "max_results": max_results},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return _parse_feed(resp.text)


def fetch_arxiv(arxiv_id: str) -> ArxivResult | None:
    """Fetch a single paper by arXiv ID (e.g. '2305.10601' or '2305.10601v2')."""
    clean_id = arxiv_id.strip().split("v")[0]
    resp = httpx.get(_BASE, params={"id_list": clean_id}, timeout=_TIMEOUT)
    resp.raise_for_status()
    results = _parse_feed(resp.text)
    return results[0] if results else None


def _safe_filename(title: str, max_len: int = 120) -> str:
    """Sanitize paper title for use as a filename."""
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", title)
    safe = re.sub(r"\s+", " ", safe).strip()
    return safe[:max_len] if safe else "arxiv_paper"


def download_pdf(result: ArxivResult, dest_dir: Path) -> Path:
    """Download PDF for an arXiv result into dest_dir.

    File is named after the paper title (sanitized). Returns saved path.
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = _safe_filename(result.title) + ".pdf"
    dest = dest_dir / filename
    url = result.pdf_url or f"https://arxiv.org/pdf/{result.arxiv_id}"
    with httpx.stream("GET", url, timeout=120.0, follow_redirects=True) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_bytes(chunk_size=65536):
                f.write(chunk)
    return dest
