from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import typer
from rich.console import Console
from rich.table import Table
from rich.progress import Progress, SpinnerColumn, TextColumn

from core.database import get_paper, init_db, list_papers
from core.ingest import ingest_pdf, remove_paper
from core.retrieval import search

app = typer.Typer(
    name="ra",
    help="Research Assistant — local paper knowledge base CLI",
    add_completion=False,
)
console = Console()


def _ensure_db() -> None:
    init_db()


# ─── add ─────────────────────────────────────────────────────────────────────

@app.command()
def add(
    paths: list[Path] = typer.Argument(..., help="PDF file(s) to ingest"),
    tags: str = typer.Option("", "--tags", "-t", help="Comma-separated tags"),
    force: bool = typer.Option(False, "--force", "-f", help="Re-index even if already exists"),
):
    """Add one or more PDF files to the knowledge base."""
    _ensure_db()
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    for path in paths:
        if not path.exists():
            console.print(f"[red]File not found:[/red] {path}")
            continue

        with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
            task = prog.add_task(f"Ingesting {path.name}…", total=None)
            result = ingest_pdf(path, tags=tag_list, force=force)
            prog.remove_task(task)

        if result.success:
            console.print(
                f"[green]✓[/green] [bold]{result.title}[/bold]  "
                f"[dim]{result.chunk_count} chunks | ID: {result.paper_id}[/dim]"
            )
        else:
            console.print(f"[red]✗[/red] {path.name}: {result.error}")


# ─── remove ──────────────────────────────────────────────────────────────────

@app.command()
def remove(
    paper_id: str = typer.Argument(..., help="Paper ID to remove"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
):
    """Remove a paper from the knowledge base."""
    _ensure_db()
    paper = get_paper(paper_id)
    if paper is None:
        console.print(f"[red]Not found:[/red] {paper_id}")
        raise typer.Exit(1)

    if not yes:
        typer.confirm(f"Remove '{paper.title}'?", abort=True)

    ok = remove_paper(paper_id)
    if ok:
        console.print(f"[green]Removed:[/green] {paper.title}")
    else:
        console.print(f"[red]Failed to remove[/red] {paper_id}")


# ─── list ─────────────────────────────────────────────────────────────────────

@app.command(name="list")
def list_cmd(
    tag: str = typer.Option("", "--tag", "-t", help="Filter by tag"),
    year: int = typer.Option(0, "--year", "-y", help="Filter by year"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """List all papers in the knowledge base."""
    _ensure_db()
    papers = list_papers(
        tag=tag if tag else None,
        year=year if year else None,
    )

    if json_out:
        console.print(json.dumps([p.model_dump(mode="json") for p in papers], indent=2))
        return

    if not papers:
        console.print("[yellow]No papers found.[/yellow]")
        return

    table = Table(title=f"Knowledge Base — {len(papers)} papers", show_lines=False)
    table.add_column("Title", style="bold", max_width=50)
    table.add_column("Authors", max_width=30)
    table.add_column("Year", justify="right", width=6)
    table.add_column("Chunks", justify="right", width=7)
    table.add_column("Tags", max_width=20)
    table.add_column("ID", max_width=12)

    for p in sorted(papers, key=lambda x: x.title.lower()):
        authors_str = ", ".join(p.authors[:2]) + (" et al." if len(p.authors) > 2 else "")
        table.add_row(
            p.title[:50],
            authors_str[:30],
            str(p.year or ""),
            str(p.chunk_count),
            ", ".join(p.tags),
            p.id[:8] + "…",
        )

    console.print(table)


# ─── search ──────────────────────────────────────────────────────────────────

@app.command()
def search_cmd(
    query: str = typer.Argument(..., help="Search query"),
    top_k: int = typer.Option(5, "--top-k", "-k", help="Max results"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """Search the knowledge base."""
    _ensure_db()
    results = search(query, top_k=top_k)

    if not results:
        console.print("[yellow]No results.[/yellow]")
        return

    if json_out:
        console.print(json.dumps([r.model_dump(mode="json") for r in results], indent=2))
        return

    for i, r in enumerate(results, 1):
        p = r.paper
        year_str = f" ({p.year})" if p.year else ""
        console.rule(f"[bold][{i}] {p.title}{year_str}[/bold]")
        if p.authors:
            console.print(f"  [dim]Authors:[/dim] {', '.join(p.authors[:3])}")
        console.print(f"  [dim]Score:[/dim] {r.score:.4f}  |  [dim]ID:[/dim] {p.id}")
        console.print()
        for chunk in r.chunks[:2]:
            snippet = chunk.content[:400].replace("\n", " ")
            console.print(f"  [dim][p.{chunk.page_number}][/dim] {snippet}…")
            console.print()


# ─── show ─────────────────────────────────────────────────────────────────────

@app.command()
def show(paper_id: str = typer.Argument(..., help="Paper ID to show")):
    """Show full details for a paper."""
    _ensure_db()
    paper = get_paper(paper_id)
    if paper is None:
        console.print(f"[red]Not found:[/red] {paper_id}")
        raise typer.Exit(1)

    console.print(f"[bold]{paper.title}[/bold]")
    console.print(f"ID:      {paper.id}")
    console.print(f"Authors: {', '.join(paper.authors) or '—'}")
    console.print(f"Year:    {paper.year or '—'}")
    console.print(f"Tags:    {', '.join(paper.tags) or '—'}")
    console.print(f"Pages:   {paper.page_count}")
    console.print(f"Chunks:  {paper.chunk_count}")
    console.print(f"Status:  {paper.status}")
    console.print(f"File:    {paper.file_path}")
    if paper.abstract:
        console.rule("Abstract")
        console.print(paper.abstract)


# ─── tag ─────────────────────────────────────────────────────────────────────

@app.command()
def tag(
    paper_id: str = typer.Argument(..., help="Paper ID"),
    tags: str = typer.Argument(..., help="Comma-separated tags to add"),
):
    """Add tags to a paper."""
    import sqlite3
    from core.database import get_sqlite_path
    import json as _json

    _ensure_db()
    paper = get_paper(paper_id)
    if paper is None:
        console.print(f"[red]Not found:[/red] {paper_id}")
        raise typer.Exit(1)

    new_tags = list(set(paper.tags) | {t.strip() for t in tags.split(",") if t.strip()})
    conn = sqlite3.connect(str(get_sqlite_path()))
    with conn:
        conn.execute("UPDATE papers SET tags=? WHERE id=?", (_json.dumps(new_tags), paper_id))
    conn.close()
    console.print(f"[green]Tags updated:[/green] {', '.join(new_tags)}")


# ─── status ──────────────────────────────────────────────────────────────────

@app.command()
def status():
    """Show knowledge base statistics."""
    _ensure_db()
    papers = list_papers()
    total_chunks = sum(p.chunk_count for p in papers)
    failed = [p for p in papers if p.status == "failed"]

    console.print(f"[bold]Papers:[/bold]  {len(papers)}")
    console.print(f"[bold]Chunks:[/bold]  {total_chunks}")
    if failed:
        console.print(f"[red]Failed:[/red]  {len(failed)}")
        for p in failed:
            console.print(f"  • {p.id}: {p.file_path}")


# ─── serve ───────────────────────────────────────────────────────────────────

@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8000, "--port", "-p"),
    auto_close: bool = typer.Option(False, "--auto-close", help="Shut down server when browser tab closes"),
    no_browser: bool = typer.Option(False, "--no-browser", help="Do not open browser automatically"),
):
    """Start the web UI and REST API server."""
    import threading, webbrowser
    import api.app as _api_module
    _ensure_db()
    url = f"http://{host}:{port}"
    console.print(f"[green]Starting Research Assistant[/green] → {url}")
    if auto_close:
        console.print("[dim]Auto-close enabled: server stops when browser tab closes.[/dim]")

    if not no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    _api_module.run(auto_shutdown=auto_close)


# ─── arxiv ───────────────────────────────────────────────────────────────────

arxiv_app = typer.Typer(name="arxiv", help="Search and fetch papers from arXiv.", add_completion=False)
app.add_typer(arxiv_app)


@arxiv_app.command(name="search")
def arxiv_search(
    query: str = typer.Argument(..., help="Search query"),
    max_results: int = typer.Option(10, "--max", "-n", help="Max results"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON"),
):
    """Search arXiv for papers."""
    from core.arxiv import search_arxiv

    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
        task = prog.add_task("Querying arXiv…", total=None)
        try:
            results = search_arxiv(query, max_results=max_results)
        except Exception as exc:
            prog.remove_task(task)
            console.print(f"[red]arXiv error:[/red] {exc}")
            raise typer.Exit(1)
        prog.remove_task(task)

    if not results:
        console.print("[yellow]No results.[/yellow]")
        return

    if json_out:
        import dataclasses
        console.print(json.dumps([dataclasses.asdict(r) for r in results], indent=2))
        return

    for i, r in enumerate(results, 1):
        authors_str = ", ".join(r.authors[:3]) + (" et al." if len(r.authors) > 3 else "")
        cats = ", ".join(r.categories[:3])
        snippet = r.abstract[:250].replace("\n", " ")
        console.rule(f"[bold][{i}] {r.title}[/bold]")
        console.print(f"  [dim]ID:[/dim]      {r.arxiv_id}  |  [dim]Year:[/dim] {r.year}  |  [dim]Cats:[/dim] {cats}")
        console.print(f"  [dim]Authors:[/dim] {authors_str}")
        console.print(f"  [dim]URL:[/dim]     {r.abs_url}")
        console.print(f"\n  {snippet}…\n")


@arxiv_app.command(name="fetch")
def arxiv_fetch(
    arxiv_id: str = typer.Argument(..., help="arXiv ID, e.g. '2305.10601'"),
    download: Path = typer.Option(None, "--download", "-d", help="Directory to download PDF into"),
    add: bool = typer.Option(False, "--add", "-a", help="Ingest downloaded PDF into knowledge base"),
    tags: str = typer.Option("", "--tags", "-t", help="Comma-separated tags (used with --add)"),
    json_out: bool = typer.Option(False, "--json", help="Output JSON metadata"),
):
    """Fetch a paper from arXiv by ID. Optionally download and add to KB."""
    from core.arxiv import download_pdf, fetch_arxiv

    with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
        task = prog.add_task(f"Fetching {arxiv_id}…", total=None)
        try:
            result = fetch_arxiv(arxiv_id)
        except Exception as exc:
            prog.remove_task(task)
            console.print(f"[red]arXiv error:[/red] {exc}")
            raise typer.Exit(1)
        prog.remove_task(task)

    if result is None:
        console.print(f"[red]Not found:[/red] {arxiv_id}")
        raise typer.Exit(1)

    if json_out:
        import dataclasses
        console.print(json.dumps(dataclasses.asdict(result), indent=2))
    else:
        authors_str = ", ".join(result.authors) or "—"
        cats = ", ".join(result.categories[:5])
        console.print(f"[bold]{result.title}[/bold]")
        console.print(f"ID:         {result.arxiv_id}")
        console.print(f"Authors:    {authors_str}")
        console.print(f"Year:       {result.year or '—'}")
        console.print(f"Published:  {result.published}")
        console.print(f"Categories: {cats}")
        console.print(f"URL:        {result.abs_url}")
        console.print(f"PDF:        {result.pdf_url}")
        if result.abstract:
            console.rule("Abstract")
            console.print(result.abstract)

    if download:
        with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
            task = prog.add_task("Downloading PDF…", total=None)
            try:
                pdf_path = download_pdf(result, download)
            except Exception as exc:
                prog.remove_task(task)
                console.print(f"[red]Download failed:[/red] {exc}")
                raise typer.Exit(1)
            prog.remove_task(task)
        console.print(f"[green]Downloaded:[/green] {pdf_path}")

        if add:
            _ensure_db()
            tag_list = [t.strip() for t in tags.split(",") if t.strip()]
            with Progress(SpinnerColumn(), TextColumn("{task.description}"), console=console) as prog:
                task = prog.add_task("Ingesting…", total=None)
                ingest_result = ingest_pdf(pdf_path, tags=tag_list)
                prog.remove_task(task)
            if ingest_result.success:
                console.print(
                    f"[green]✓[/green] Added to KB: [bold]{ingest_result.title}[/bold]  "
                    f"[dim]{ingest_result.chunk_count} chunks | ID: {ingest_result.paper_id}[/dim]"
                )
            else:
                console.print(f"[red]✗[/red] Ingest failed: {ingest_result.error}")
    elif add:
        console.print("[yellow]--add requires --download to specify a directory.[/yellow]")


if __name__ == "__main__":
    app()
