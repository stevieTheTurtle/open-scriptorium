from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

# Ensure UTF-8 stdout/stderr on Windows piped subprocesses so Unicode never crashes commands.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

sys.path.insert(0, str(Path(__file__).parent.parent))

import typer

app = typer.Typer(
    name="ra",
    help="Research Assistant — low-token CLI for local paper search, arXiv, and LaTeX citation evidence.",
    add_completion=False,
)


# ─── Fast warm-daemon HTTP client (stdlib only, ~20–50 ms when daemon is running) ──

def _daemon_base_url() -> Optional[str]:
    if os.environ.get("RA_NO_DAEMON") == "1":
        return None
    if env_url := os.environ.get("RA_API_URL", "").strip():
        return env_url.rstrip("/")
    cfg_path = (
        Path(os.environ["RA_CONFIG_PATH"]).expanduser()
        if os.environ.get("RA_CONFIG_PATH")
        else Path(__file__).parent.parent / "config.yaml"
    )
    host, port = "127.0.0.1", 8000
    if cfg_path.exists():
        try:
            text = cfg_path.read_text(encoding="utf-8", errors="replace")
            api_section = text.split("api:", 1)[1] if "api:" in text else ""
            hm = re.search(r"^\s+host:\s*(\S+)", api_section, re.M)
            pm = re.search(r"^\s+port:\s*(\d+)", api_section, re.M)
            if hm:
                host = hm.group(1).strip("\"'")
            if pm:
                port = int(pm.group(1))
        except Exception:
            pass
    return f"http://{host}:{port}"


def _daemon_call(
    method: str,
    endpoint: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    use_daemon: bool = True,
    timeout: float = 60.0,
    fallback_on_404: bool = False,
) -> tuple[bool, Any]:
    """Try calling the warm local Research Assistant daemon.

    Returns (True, parsed_json) on success, (False, None) if the daemon is unreachable
    so the caller can fall back seamlessly to local Python execution. Raises typer.Exit(1)
    on explicit 4xx/5xx application errors returned by the daemon.
    """
    if not use_daemon:
        return False, None
    base = _daemon_base_url()
    if not base:
        return False, None

    # Quick health probe with short timeout so we never stall if daemon is stopped.
    try:
        with urllib.request.urlopen(f"{base}/api/health", timeout=0.4) as resp:
            if resp.status >= 400:
                return False, None
    except Exception:
        return False, None

    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(f"{base}{endpoint}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return True, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if fallback_on_404 and exc.code == 404:
            return False, None
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("detail", body)
        except Exception:
            detail = body
        print(f"Error ({exc.code}): {detail}", file=sys.stderr)
        raise typer.Exit(1)
    except Exception:
        return False, None


def _citekey_from_tags(tags: list[str]) -> str:
    for t in tags:
        if t.startswith("@"):
            return t
    return ""


def _ensure_local_db() -> None:
    from core.database import init_db
    init_db()


# ─── search ──────────────────────────────────────────────────────────────────

@app.command(name="search")
def search_cmd(
    query: str = typer.Argument(..., help="Search query over the local knowledge base"),
    top_k: int = typer.Option(5, "--top-k", "-k", help="Maximum papers to return"),
    compact: bool = typer.Option(False, "--compact", "-c", help="Ultra-compact output (minimal tokens)"),
    context: bool = typer.Option(False, "--context", help="Full [Ref N] + REFERENCES BLOCK format for Q&A"),
    max_chunks: int = typer.Option(3, "--max-chunks", help="Max excerpts per paper"),
    max_chars: int = typer.Option(600, "--max-chars", help="Max characters per excerpt (0 = unlimited)"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon and run directly in-process"),
):
    """Search the local paper library (hybrid semantic + BM25)."""
    if context and not json_out:
        ok, data = _daemon_call("POST", "/api/search/context", {"query": query, "top_k": top_k}, use_daemon=not local)
        if ok:
            print(data.get("context", ""))
            return
        _ensure_local_db()
        from core.retrieval import get_context_for_query
        print(get_context_for_query(query, top_k=top_k))
        return

    ok, raw_results = _daemon_call("POST", "/api/search", {"query": query, "top_k": top_k}, use_daemon=not local)
    if ok:
        results = raw_results
    else:
        _ensure_local_db()
        from core.retrieval import search
        results = [r.model_dump(mode="json") for r in search(query, top_k=top_k)]

    if not results:
        print("[]" if json_out else "No results.")
        return

    if json_out:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    chunk_limit = 2 if compact and max_chunks == 3 else max_chunks
    char_limit = 350 if compact and max_chars == 600 else max_chars

    for i, r in enumerate(results, 1):
        p = r["paper"]
        tags = p.get("tags") or []
        citekey = _citekey_from_tags(tags)
        year = p.get("year") or "n.d."
        authors = p.get("authors") or []
        authors_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
        key_part = f" {citekey} |" if citekey else ""
        print(f"[{i}]{key_part} {p['title']} ({year})")
        if not compact:
            tags_str = f" | Tags: {', '.join(tags)}" if tags else ""
            print(f"    Authors: {authors_str or 'Unknown'} | ID: {p['id']}{tags_str}")
        else:
            print(f"    ID: {p['id']} | {authors_str or 'Unknown'}")
        for chunk in (r.get("chunks") or [])[:chunk_limit]:
            text = re.sub(r"\s+", " ", chunk.get("content", "")).strip()
            if char_limit > 0 and len(text) > char_limit:
                text = text[:char_limit].rstrip() + "..."
            print(f"    [p.{chunk.get('page_number', 0)}] {text}")
        print()


# ─── find-support ────────────────────────────────────────────────────────────

@app.command(name="find-support")
def find_support_cmd(
    claim: str = typer.Argument(..., help="Claim or selected LaTeX/PDF text to find supporting citations for"),
    top_k: int = typer.Option(8, "--top-k", "-k", help="Maximum candidate papers to return"),
    recall_k: int = typer.Option(30, "--recall-k", help="Hybrid recall pool size before reranking"),
    no_rerank: bool = typer.Option(False, "--no-rerank", help="Skip local CrossEncoder reranker"),
    reranker_model: str = typer.Option("", "--model", help="Optional CrossEncoder model override"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon and run directly in-process"),
):
    """Find supporting papers and verbatim quotes for a claim (hybrid recall + local reranker)."""
    payload = {
        "claim": claim,
        "top_k": top_k,
        "recall_k": recall_k,
        "use_reranker": not no_rerank,
        "reranker_model": reranker_model or None,
    }
    ok, data = _daemon_call(
        "POST",
        "/api/citations/find-support",
        payload,
        use_daemon=not local,
        timeout=120.0,
        fallback_on_404=True,
    )
    if not ok:
        _ensure_local_db()
        from core.claim_support import find_supporting_citations
        data = find_supporting_citations(
            claim,
            top_k=top_k,
            recall_k=recall_k,
            use_reranker=not no_rerank,
            reranker_model=reranker_model or None,
        )

    if json_out:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    results = data.get("results") or []
    if not results:
        print("No supporting citations found.")
        return

    print(f"Claim: {data.get('claim', '')}")
    print(f"Reranker: {data.get('reranker', 'none')} | {data.get('elapsed_ms', 0)} ms | {len(results)} candidates\n")
    for i, r in enumerate(results, 1):
        pct = int(round(float(r.get("score", 0)) * 100))
        key = f"@{r['citekey']} | " if r.get("citekey") else ""
        year = r.get("year") or "n.d."
        authors = r.get("authors") or []
        authors_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
        print(f"[{i}] ({pct}%) {key}{r.get('title', '')} ({year})")
        print(f"    Authors: {authors_str or 'Unknown'} | ID: {r.get('paper_id', '')}")
        print(f"    [p.{r.get('page', 0)}] \"{r.get('quote', '')}\"")
        print()


# ─── detail / show ───────────────────────────────────────────────────────────

def _render_paper_detail(paper: dict[str, Any], json_out: bool) -> None:
    if json_out:
        print(json.dumps(paper, indent=2, ensure_ascii=False))
        return
    print(paper.get("title", ""))
    print(f"ID:      {paper.get('id', '')}")
    print(f"Authors: {', '.join(paper.get('authors') or []) or '-'}")
    print(f"Year:    {paper.get('year') or '-'}")
    print(f"Tags:    {', '.join(paper.get('tags') or []) or '-'}")
    print(f"Pages:   {paper.get('page_count', 0)}")
    print(f"Chunks:  {paper.get('chunk_count', 0)}")
    print(f"Status:  {paper.get('status', '')}")
    print(f"File:    {paper.get('file_path', '')}")
    if paper.get("abstract"):
        print("\nAbstract:")
        print(paper["abstract"])


@app.command(name="detail")
def detail_cmd(
    paper_id: str = typer.Argument(..., help="Paper ID to inspect"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Show full metadata for a paper by ID."""
    ok, data = _daemon_call("GET", f"/api/papers/{urllib.parse.quote(paper_id)}", use_daemon=not local)
    if ok:
        _render_paper_detail(data, json_out)
        return
    _ensure_local_db()
    from core.database import get_paper
    paper = get_paper(paper_id)
    if paper is None:
        print(f"Not found: {paper_id}", file=sys.stderr)
        raise typer.Exit(1)
    _render_paper_detail(paper.model_dump(mode="json"), json_out)


@app.command(name="show")
def show_cmd(
    paper_id: str = typer.Argument(..., help="Paper ID to show (alias for detail)"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Alias for `detail`."""
    detail_cmd(paper_id=paper_id, json_out=json_out, local=local)


# ─── list ────────────────────────────────────────────────────────────────────

@app.command(name="list")
def list_cmd(
    tag: str = typer.Option("", "--tag", "-t", help="Filter by tag"),
    year: int = typer.Option(0, "--year", "-y", help="Filter by year"),
    compact: bool = typer.Option(False, "--compact", "-c", help="One-line-per-paper compact output"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """List papers in the knowledge base."""
    qs = urllib.parse.urlencode({"tag": tag, "year": year})
    ok, raw_papers = _daemon_call("GET", f"/api/papers?{qs}", use_daemon=not local)
    if ok:
        papers = raw_papers
    else:
        _ensure_local_db()
        from core.database import list_papers
        papers = [
            p.model_dump(mode="json")
            for p in list_papers(tag=tag if tag else None, year=year if year else None)
        ]

    if json_out:
        print(json.dumps(papers, indent=2, ensure_ascii=False))
        return
    if not papers:
        print("No papers found.")
        return

    papers.sort(key=lambda x: (x.get("title") or "").lower())
    print(f"Total: {len(papers)} papers")
    for p in papers:
        tags = p.get("tags") or []
        citekey = _citekey_from_tags(tags)
        authors = p.get("authors") or []
        authors_str = ", ".join(authors[:2]) + (" et al." if len(authors) > 2 else "")
        year_str = f" ({p['year']})" if p.get("year") else ""
        if compact:
            key_part = f"{citekey} | " if citekey else ""
            print(f"- {key_part}{p['title']}{year_str} [id:{p['id'][:8]}]")
        else:
            tags_str = f" [{', '.join(tags)}]" if tags else ""
            print(f"- {p['title']}{year_str}{tags_str}")
            print(f"  Authors: {authors_str or '-'} | ID: {p['id']} | {p.get('chunk_count', 0)} chunks | {p.get('page_count', 0)} pages")


# ─── add ─────────────────────────────────────────────────────────────────────

@app.command(name="add")
def add_cmd(
    paths: list[Path] = typer.Argument(..., help="PDF file(s) to ingest"),
    tags: str = typer.Option("", "--tags", "-t", help="Comma-separated tags"),
    force: bool = typer.Option(False, "--force", "-f", help="Re-index even if already exists"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Add one or more local PDF files to the knowledge base."""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    outcomes: list[dict[str, Any]] = []

    for pdf_path in paths:
        resolved = pdf_path.resolve()
        if not resolved.exists():
            item = {"success": False, "file": str(pdf_path), "error": "File not found"}
            outcomes.append(item)
            if not json_out:
                print(f"File not found: {pdf_path}", file=sys.stderr)
            continue

        ok, data = _daemon_call(
            "POST",
            "/api/papers/ingest-path",
            {"pdf_path": str(resolved), "tags": tag_list, "force": force},
            use_daemon=not local,
            timeout=300.0,
        )
        if not ok:
            _ensure_local_db()
            from core.ingest import ingest_pdf
            res = ingest_pdf(resolved, tags=tag_list, force=force)
            data = res.model_dump(mode="json")

        outcomes.append(data)
        if not json_out:
            if data.get("success"):
                print(f"Added: {data.get('title')} ({data.get('chunk_count')} chunks | ID: {data.get('paper_id')})")
            else:
                print(f"Failed: {pdf_path.name}: {data.get('error')}", file=sys.stderr)

    if json_out:
        print(json.dumps(outcomes if len(outcomes) != 1 else outcomes[0], indent=2, ensure_ascii=False))


# ─── remove ──────────────────────────────────────────────────────────────────

@app.command(name="remove")
def remove_cmd(
    paper_id: str = typer.Argument(..., help="Paper ID to remove"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Remove a paper from the knowledge base."""
    if not yes:
        typer.confirm(f"Remove paper '{paper_id}'?", abort=True)

    ok, data = _daemon_call("DELETE", f"/api/papers/{urllib.parse.quote(paper_id)}", use_daemon=not local)
    if ok:
        print(f"Removed paper {paper_id}." if data.get("ok") else f"Failed to remove {paper_id}")
        return

    _ensure_local_db()
    from core.database import get_paper
    from core.ingest import remove_paper
    paper = get_paper(paper_id)
    if paper is None:
        print(f"Not found: {paper_id}", file=sys.stderr)
        raise typer.Exit(1)
    if remove_paper(paper_id):
        print(f"Removed: {paper.title}")
    else:
        print(f"Failed to remove {paper_id}", file=sys.stderr)
        raise typer.Exit(1)


# ─── tag ─────────────────────────────────────────────────────────────────────

@app.command(name="tag")
def tag_cmd(
    paper_id: str = typer.Argument(..., help="Paper ID"),
    tags: str = typer.Argument(..., help="Comma-separated tags to add"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Add tags to a paper."""
    add_tags = [t.strip() for t in tags.split(",") if t.strip()]
    ok, current = _daemon_call("GET", f"/api/papers/{urllib.parse.quote(paper_id)}", use_daemon=not local)
    if ok:
        merged = sorted(set(current.get("tags") or []) | set(add_tags))
        ok2, updated = _daemon_call(
            "PATCH",
            f"/api/papers/{urllib.parse.quote(paper_id)}/tags",
            {"tags": merged},
            use_daemon=not local,
        )
        if ok2:
            print(f"Tags updated: {', '.join(updated.get('tags') or merged)}")
            return

    import sqlite3
    _ensure_local_db()
    from core.database import get_paper, get_sqlite_path
    paper = get_paper(paper_id)
    if paper is None:
        print(f"Not found: {paper_id}", file=sys.stderr)
        raise typer.Exit(1)
    new_tags = sorted(set(paper.tags) | set(add_tags))
    conn = sqlite3.connect(str(get_sqlite_path()))
    with conn:
        conn.execute("UPDATE papers SET tags=? WHERE id=?", (json.dumps(new_tags), paper_id))
    conn.close()
    print(f"Tags updated: {', '.join(new_tags)}")


# ─── status ──────────────────────────────────────────────────────────────────

@app.command(name="status")
def status_cmd(
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Show knowledge base and daemon status."""
    ok, data = _daemon_call("GET", "/api/status", use_daemon=not local)
    if ok:
        data["daemon"] = True
        data["api_url"] = _daemon_base_url()
    else:
        _ensure_local_db()
        from core.database import list_papers
        papers = list_papers()
        data = {
            "paper_count": len(papers),
            "chunk_count": sum(p.chunk_count for p in papers),
            "failed_count": sum(1 for p in papers if p.status == "failed"),
            "daemon": False,
        }

    if json_out:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return
    print(f"Papers: {data['paper_count']}")
    print(f"Chunks: {data['chunk_count']}")
    print(f"Failed: {data['failed_count']}")
    print(f"Daemon: {'running (' + data['api_url'] + ')' if data.get('daemon') else 'stopped (local fallback)'}")


# ─── serve ───────────────────────────────────────────────────────────────────

@app.command(name="serve")
def serve_cmd(
    host: Optional[str] = typer.Option(None, "--host", help="Bind host (defaults to config.yaml)"),
    port: Optional[int] = typer.Option(None, "--port", "-p", help="Bind port (defaults to config.yaml)"),
    auto_close: bool = typer.Option(False, "--auto-close", help="Shut down server when browser tab closes"),
    no_browser: bool = typer.Option(False, "--no-browser", help="Do not open browser automatically"),
):
    """Start the web UI and warm REST API daemon."""
    import threading
    import webbrowser
    from core.config import get_config
    import api.app as _api_module

    cfg = get_config().api
    bind_host = host or cfg.host
    bind_port = port or cfg.port
    url = f"http://{bind_host}:{bind_port}"
    print(f"Starting Research Assistant -> {url}", flush=True)
    if auto_close:
        print("Auto-close enabled: server stops when browser tab closes.", flush=True)
    if not no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    _api_module.run(host=bind_host, port=bind_port, auto_shutdown=auto_close)


# ─── arxiv ───────────────────────────────────────────────────────────────────

arxiv_app = typer.Typer(name="arxiv", help="Search and fetch papers from arXiv.", add_completion=False)
app.add_typer(arxiv_app)


@arxiv_app.command(name="search")
def arxiv_search_cmd(
    query: str = typer.Argument(..., help="Search query"),
    max_results: int = typer.Option(10, "--max", "-n", help="Max results"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Search arXiv.org for NEW papers online (requires arXiv enabled in settings)."""
    ok, raw_results = _daemon_call(
        "POST",
        "/api/arxiv/search",
        {"query": query, "max_results": max_results},
        use_daemon=not local,
    )
    if ok:
        results = raw_results
    else:
        import dataclasses
        from core.arxiv import search_arxiv
        from core.settings import get_arxiv_enabled

        if not get_arxiv_enabled():
            print(
                "arXiv online search is currently DISABLED. Enable it in the Research Assistant Web UI settings.",
                file=sys.stderr,
            )
            raise typer.Exit(1)
        try:
            results = [dataclasses.asdict(r) for r in search_arxiv(query, max_results=max_results)]
        except Exception as exc:
            print(f"arXiv error: {exc}", file=sys.stderr)
            raise typer.Exit(1)

    if not results:
        print("[]" if json_out else "No results found on arXiv.")
        return
    if json_out:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    for i, r in enumerate(results, 1):
        authors = r.get("authors") or []
        authors_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")
        cats = ", ".join((r.get("categories") or [])[:3])
        snippet = re.sub(r"\s+", " ", r.get("abstract") or "")[:280]
        print(f"[{i}] {r['title']}")
        print(f"    arXiv ID: {r['arxiv_id']} | Year: {r.get('year')} | Cats: {cats}")
        print(f"    Authors: {authors_str}")
        print(f"    URL: {r['abs_url']}")
        print(f"    {snippet}...")
        print()


@arxiv_app.command(name="fetch")
def arxiv_fetch_cmd(
    arxiv_id: str = typer.Argument(..., help="arXiv ID, e.g. '2305.10601'"),
    download: Optional[Path] = typer.Option(None, "--download", "-d", help="Directory to download PDF into"),
    add: bool = typer.Option(False, "--add", "-a", help="Download PDF and ingest into 'arXiv Downloads' collection"),
    tags: str = typer.Option("", "--tags", "-t", help="Comma-separated extra tags (used with --add)"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON metadata"),
    local: bool = typer.Option(False, "--local", help="Bypass warm daemon"),
):
    """Fetch a paper from arXiv by ID; optionally download and add to KB."""
    extra_tags = [t.strip() for t in tags.split(",") if t.strip()]
    ok, data = _daemon_call(
        "POST",
        "/api/arxiv/fetch",
        {
            "arxiv_id": arxiv_id,
            "add_to_kb": add,
            "extra_tags": extra_tags,
            "download_dir": str(download.resolve()) if download else None,
        },
        use_daemon=not local,
        timeout=300.0,
    )
    if not ok:
        import dataclasses
        from core.arxiv import download_pdf, fetch_arxiv
        from core.collections import create_collection, get_active_name, set_active_collection
        from core.config import get_config
        from core.ingest import ingest_pdf
        from core.settings import get_arxiv_enabled

        if not get_arxiv_enabled():
            print(
                "arXiv online search is currently DISABLED. Enable it in the Research Assistant Web UI settings.",
                file=sys.stderr,
            )
            raise typer.Exit(1)
        result = fetch_arxiv(arxiv_id)
        if result is None:
            print(f"Not found: {arxiv_id}", file=sys.stderr)
            raise typer.Exit(1)
        data = dataclasses.asdict(result)
        if download or add:
            dl_dir = download.resolve() if download else get_config().get_data_dir() / "arxiv_downloads"
            pdf_path = download_pdf(result, dl_dir)
            data["downloaded_path"] = str(pdf_path)
            if add:
                arxiv_col = "arXiv Downloads"
                prev = get_active_name()
                try:
                    create_collection(arxiv_col, "Papers fetched from arXiv search")
                except ValueError:
                    pass
                try:
                    set_active_collection(arxiv_col)
                    _ensure_local_db()
                    ingest_res = ingest_pdf(pdf_path, tags=list({"arxiv", *extra_tags}))
                    data["ingest"] = ingest_res.model_dump(mode="json")
                finally:
                    set_active_collection(prev)
                    _ensure_local_db()

    if json_out:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    print(data.get("title", ""))
    print(f"arXiv ID:   {data.get('arxiv_id', '')}")
    print(f"Authors:    {', '.join(data.get('authors') or []) or '-'}")
    print(f"Year:       {data.get('year') or '-'}")
    print(f"Categories: {', '.join((data.get('categories') or [])[:5])}")
    print(f"URL:        {data.get('abs_url', '')}")
    if data.get("abstract"):
        print("\nAbstract:")
        print(data["abstract"])
    if data.get("downloaded_path"):
        print(f"\nDownloaded: {data['downloaded_path']}")
    if ingest := data.get("ingest"):
        if ingest.get("success"):
            print(f"Added to 'arXiv Downloads': {ingest.get('chunk_count')} chunks | ID: {ingest.get('paper_id')}")
        else:
            print(f"Ingest failed: {ingest.get('error')}", file=sys.stderr)


# ─── notes (citation evidence — pure stdlib, instant) ────────────────────────

notes_app = typer.Typer(
    name="notes",
    help="Read, append, and audit verbatim citation evidence notes (references.notes.json).",
    add_completion=False,
)
app.add_typer(notes_app)


@notes_app.command(name="add")
def notes_add_cmd(
    key: str = typer.Option(..., "--key", "-k", help="BibTeX citekey (without @)"),
    quote: str = typer.Option(..., "--quote", "-q", help="1-2 verbatim sentences from the cited paper"),
    file: str = typer.Option("", "--file", "-f", help="Relative .tex path where the citation is used"),
    page: Optional[str] = typer.Option(None, "--page", "-p", help="Page number from [p.N]"),
    claim: str = typer.Option("", "--claim", "-c", help="Prose claim supported by the quote"),
    paper_id: str = typer.Option("", "--paper-id", help="Research Assistant Paper ID"),
    added: Optional[str] = typer.Option(None, "--added", help="Date YYYY-MM-DD (defaults to today)"),
    notes_file: Optional[Path] = typer.Option(None, "--notes-file", help="Explicit references.notes.json path"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """Append a verbatim citation evidence note without loading the full JSON file."""
    from cli.notes import add_note, resolve_notes_file

    target = resolve_notes_file(notes_file)
    try:
        res = add_note(
            target,
            key=key,
            quote=quote,
            file_rel=file,
            page=page,
            claim=claim,
            paper_id=paper_id,
            added=added,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise typer.Exit(1)

    if json_out:
        print(json.dumps(res, indent=2, ensure_ascii=False))
        return
    if res["duplicate"]:
        print(f"Already present for {res['key']} ({res['count']} notes) in {res['notes_file']}")
    else:
        print(f"Added note for {res['key']} (now {res['count']} notes) in {res['notes_file']}")


@notes_app.command(name="get")
def notes_get_cmd(
    key: str = typer.Argument(..., help="BibTeX citekey"),
    notes_file: Optional[Path] = typer.Option(None, "--notes-file", help="Explicit references.notes.json path"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """Show existing citation evidence notes for a single citekey."""
    from cli.notes import get_notes, resolve_notes_file

    target = resolve_notes_file(notes_file)
    entries = get_notes(target, key)
    if json_out:
        print(json.dumps(entries, indent=2, ensure_ascii=False))
        return
    if not entries:
        print(f"No notes for {key} in {target}")
        return
    for i, n in enumerate(entries, 1):
        pg = f"p.{n['page']}" if n.get("page") is not None else "p.?"
        fl = n.get("file") or "-"
        print(f"[{i}] {pg} | {fl}")
        if n.get("claim"):
            print(f"    Claim: {n['claim']}")
        print(f"    Quote: \"{n.get('quote', '')}\"")


@notes_app.command(name="audit")
def notes_audit_cmd(
    notes_file: Optional[Path] = typer.Option(None, "--notes-file", help="Explicit references.notes.json path"),
    status_file: Optional[Path] = typer.Option(None, "--status-file", help="Explicit citation_status.json path"),
    bib: Optional[Path] = typer.Option(None, "--bib", help="Explicit .bib file path"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """Audit citation notes against .bib entries and citation_status.json (indexed/yellow/red)."""
    from cli.notes import audit_citations, discover_bib_files, resolve_notes_file, resolve_status_file

    npath = resolve_notes_file(notes_file)
    spath = resolve_status_file(status_file)
    bpaths = discover_bib_files(bib)
    report = audit_citations(npath, spath, bpaths)

    if json_out:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    s = report["summary"]
    print(f"Keys: {s['total_keys']} | With notes: {s['with_notes']} | Indexed missing note: {s['indexed_without_notes']} | Yellow: {s['yellow_secondhand']} | Red: {s['red_unsourced']}")
    if report["indexed_without_notes"]:
        print(f"Indexed without notes: {', '.join(report['indexed_without_notes'])}")
    if report["yellow_secondhand"]:
        print(f"Yellow (second-hand):  {', '.join(report['yellow_secondhand'])}")
    if report["red_unsourced"]:
        print(f"Red (unsourced):       {', '.join(report['red_unsourced'])}")
    if report["unknown_without_notes"]:
        print(f"Unknown status:        {', '.join(report['unknown_without_notes'])}")


# ─── bib (BibTeX lookup — pure stdlib, instant) ──────────────────────────────

bib_app = typer.Typer(name="bib", help="Look up BibTeX entries without reading full .bib files.", add_completion=False)
app.add_typer(bib_app)


@bib_app.command(name="get")
def bib_get_cmd(
    key: str = typer.Argument(..., help="BibTeX citekey"),
    bib: Optional[Path] = typer.Option(None, "--bib", help="Explicit .bib file path"),
    json_out: bool = typer.Option(False, "--json", help="Output parsed JSON fields"),
):
    """Print a single BibTeX entry from the workspace .bib file(s)."""
    from cli.notes import discover_bib_files, get_bib_entry

    entry = get_bib_entry(discover_bib_files(bib), key)
    if entry is None:
        print(f"BibTeX key not found: {key}", file=sys.stderr)
        raise typer.Exit(1)
    if json_out:
        print(json.dumps(entry, indent=2, ensure_ascii=False))
        return
    print(entry["raw"])


if __name__ == "__main__":
    app()
