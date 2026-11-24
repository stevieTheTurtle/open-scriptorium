"""MCP server exposing the research assistant knowledge base.

Claude Code registers this via:
    claude mcp add --scope user research-assistant -- \\
        C:\\Users\\stefa\\Desktop\\ResearchAssistant\\.venv\\Scripts\\python.exe -m mcp_server
"""
from __future__ import annotations

# ── CRITICAL: silence all stdout before any imports ──────────────────────────
# MCP uses stdin/stdout for JSON-RPC. Any non-protocol bytes (progress bars,
# warnings, download logs) from sentence-transformers / chromadb / HF Hub
# corrupt the pipe and crash the session.
import os
import sys

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "0")

# Redirect stdout → stderr so library prints don't corrupt MCP pipe.
# We restore it right before mcp.run() which needs real stdout.
import io
_real_stdout = sys.stdout
sys.stdout = sys.stderr  # library noise goes to stderr (safe)

# ── Imports (may print during first-run model download) ─────────────────────
import json
import logging
from pathlib import Path

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp.server.fastmcp import FastMCP

from core.database import get_paper, init_db, list_papers
from core.ingest import ingest_pdf, remove_paper
from core.retrieval import get_context_for_query
from core.arxiv import download_pdf, fetch_arxiv, search_arxiv
from core.settings import get_arxiv_enabled

init_db()

# Pre-warm embedding model now (at server startup) so first tool call is fast.
# This runs while stdout is still redirected → library prints go to stderr.
from core.embeddings import get_provider as _get_provider
_get_provider()  # loads + caches model into memory

mcp = FastMCP(
    "Research Assistant",
    instructions=(
        "You manage a local research paper knowledge base AND optionally arXiv search.\n\n"
        "TOOL SELECTION — choose strictly:\n"
        "• User asks about THEIR papers / their collection / what they have indexed → use search_papers (local KB only)\n"
        "• User explicitly asks to search NEW papers online / on arXiv / discover literature → use search_arxiv_papers\n"
        "• NEVER mix these two sources in one answer without clearly labelling each.\n\n"
        "CITATION RULES (mandatory):\n"
        "(1) Cite every claim inline as [Ref N] matching the evidence block number.\n"
        "(2) The tool response contains a block marked "
        "'--- REFERENCES BLOCK (copy verbatim to your response) ---'. "
        "Copy it EXACTLY as-is under '## References' at the end of your answer — "
        "do not reformat, abbreviate, or reorder entries.\n"
        "(3) Never state facts from retrieved papers without a [Ref N] citation.\n\n"
        "Tools: search_papers, get_paper_detail, list_all_papers, add_paper, remove_paper_from_db, "
        "search_arxiv_papers, fetch_arxiv_paper."
    ),
)


@mcp.tool()
def search_papers(query: str, top_k: int = 8) -> str:
    """Search the LOCAL knowledge base — papers the user has already indexed.

    Use this when the user asks about papers in their collection, their library,
    papers they have, or any research question to be answered from existing papers.
    This does NOT search the internet or arXiv — it only searches locally stored papers.
    """
    return get_context_for_query(query, top_k=top_k)


@mcp.tool()
def get_paper_detail(paper_id: str) -> str:
    """Get full metadata for a specific paper by its ID.

    Returns title, authors, year, abstract, tags, and file location.
    """
    paper = get_paper(paper_id)
    if paper is None:
        return f"Paper {paper_id!r} not found."
    return json.dumps(paper.model_dump(mode="json"), indent=2)


@mcp.tool()
def list_all_papers(tag: str = "", year: int = 0) -> str:
    """List all papers in the knowledge base, optionally filtered by tag or year.

    Pass tag='' and year=0 to list everything.
    """
    papers = list_papers(
        tag=tag if tag else None,
        year=year if year else None,
    )
    if not papers:
        return "No papers found."

    lines = [f"Total: {len(papers)} papers\n"]
    for p in sorted(papers, key=lambda x: x.title.lower()):
        authors_str = ", ".join(p.authors[:2]) + (" et al." if len(p.authors) > 2 else "")
        year_str = f" ({p.year})" if p.year else ""
        tags_str = f" [{', '.join(p.tags)}]" if p.tags else ""
        lines.append(f"• {p.title}{year_str}{tags_str}")
        if authors_str:
            lines.append(f"  Authors: {authors_str}")
        lines.append(f"  ID: {p.id}  |  {p.chunk_count} chunks  |  {p.page_count} pages")
    return "\n".join(lines)


@mcp.tool()
def add_paper(pdf_path: str, tags: str = "") -> str:
    """Add a PDF paper to the knowledge base by file path.

    tags: comma-separated list of tags (e.g. 'ml,transformers,nlp')
    """
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    result = ingest_pdf(Path(pdf_path), tags=tag_list)
    if result.success:
        return f"Added: {result.title!r} ({result.chunk_count} chunks, ID: {result.paper_id})"
    return f"Failed: {result.error}"


@mcp.tool()
def remove_paper_from_db(paper_id: str) -> str:
    """Remove a paper and all its chunks from the knowledge base by paper ID."""
    ok = remove_paper(paper_id)
    return f"Removed paper {paper_id}." if ok else f"Paper {paper_id!r} not found."


_ARXIV_DISABLED_MSG = (
    "arXiv online search is currently DISABLED. "
    "The user can enable it via the toggle button in the Research Assistant web UI. "
    "Do not attempt to search arXiv while it is disabled."
)

_ARXIV_COLLECTION = "arXiv Downloads"


def _ensure_arxiv_collection() -> None:
    """Create the arXiv Downloads collection if it doesn't exist."""
    from core.collections import create_collection
    try:
        create_collection(_ARXIV_COLLECTION, "Papers fetched from arXiv search")
    except ValueError:
        pass  # already exists


def _ingest_into_arxiv_collection(pdf_path: Path, extra_tags: list[str]) -> tuple[bool, str]:
    """Switch to arXiv Downloads collection, ingest, switch back. Returns (success, message)."""
    from core.collections import get_active_name, set_active_collection
    prev = get_active_name()
    _ensure_arxiv_collection()
    try:
        set_active_collection(_ARXIV_COLLECTION)
        init_db()
        tags = list({"arxiv", *extra_tags})
        result = ingest_pdf(pdf_path, tags=tags)
        if result.success:
            msg = f"Added to '{_ARXIV_COLLECTION}': {result.chunk_count} chunks, ID: {result.paper_id}"
        else:
            msg = f"Ingest failed: {result.error}"
        return result.success, msg
    finally:
        set_active_collection(prev)
        init_db()


@mcp.tool()
def search_arxiv_papers(query: str, max_results: int = 10) -> str:
    """Search arXiv.org for NEW papers online — NOT the local knowledge base.

    Use this ONLY when the user explicitly asks to find new papers, search arXiv,
    discover recent literature, or look up papers online.
    Do NOT use this for questions about the user's existing collection — use search_papers instead.

    Requires arXiv search to be enabled in the Research Assistant UI.
    Returns titles, authors, year, categories, abstract snippets, and arXiv IDs.
    """
    if not get_arxiv_enabled():
        return _ARXIV_DISABLED_MSG

    try:
        results = search_arxiv(query, max_results=max_results)
    except Exception as exc:
        return f"arXiv API error: {exc}"

    if not results:
        return "No results found on arXiv."

    lines = [f"arXiv search results for: {query!r}  ({len(results)} results)\n"]
    for i, r in enumerate(results, 1):
        authors_str = ", ".join(r.authors[:3]) + (" et al." if len(r.authors) > 3 else "")
        cats = ", ".join(r.categories[:3])
        snippet = r.abstract[:300].replace("\n", " ")
        lines.append(
            f"[{i}] {r.title}\n"
            f"    arXiv ID: {r.arxiv_id}  |  {r.year}  |  {cats}\n"
            f"    Authors: {authors_str}\n"
            f"    {snippet}…\n"
            f"    URL: {r.abs_url}"
        )
    return "\n\n".join(lines)


@mcp.tool()
def fetch_arxiv_paper(
    arxiv_id: str,
    add_to_kb: bool = False,
    extra_tags: str = "",
) -> str:
    """Fetch a paper from arXiv by ID and optionally add it to the knowledge base.

    arxiv_id: arXiv paper ID, e.g. '2305.10601' or '2305.10601v2'.
    add_to_kb: if True, download the PDF and add it to the 'arXiv Downloads' collection.
               The PDF is saved to data/arxiv_downloads/ named after the paper title.
               The paper is auto-tagged 'arxiv' and attributed as an arXiv download in RAG.
    extra_tags: additional comma-separated tags (beyond the automatic 'arxiv' tag).

    Requires arXiv search to be enabled in the Research Assistant UI.
    """
    if not get_arxiv_enabled():
        return _ARXIV_DISABLED_MSG

    try:
        result = fetch_arxiv(arxiv_id)
    except Exception as exc:
        return f"arXiv API error: {exc}"

    if result is None:
        return f"No paper found for arXiv ID {arxiv_id!r}."

    authors_str = ", ".join(result.authors[:5]) + (" et al." if len(result.authors) > 5 else "")
    cats = ", ".join(result.categories[:5])
    lines = [
        f"Title:      {result.title}",
        f"arXiv ID:   {result.arxiv_id}",
        f"Authors:    {authors_str}",
        f"Year:       {result.year}",
        f"Published:  {result.published}",
        f"Categories: {cats}",
        f"URL:        {result.abs_url}",
        "",
        result.abstract,
    ]

    if add_to_kb:
        from core.config import get_config
        dl_dir = get_config().get_data_dir() / "arxiv_downloads"
        try:
            pdf_path = download_pdf(result, dl_dir)
            lines.append(f"\nDownloaded: {pdf_path}")
            tag_list = [t.strip() for t in extra_tags.split(",") if t.strip()]
            ok, msg = _ingest_into_arxiv_collection(pdf_path, tag_list)
            lines.append(msg)
        except Exception as exc:
            lines.append(f"\nDownload/ingest failed: {exc}")

    return "\n".join(lines)


def run() -> None:
    # Restore real stdout so MCP JSON-RPC pipe works correctly.
    sys.stdout = _real_stdout
    mcp.run(transport="stdio")


if __name__ == "__main__":
    run()
