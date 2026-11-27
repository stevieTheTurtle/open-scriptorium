from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional

# Ensure UTF-8 stdout/stderr on Windows piped subprocesses so Unicode never crashes startup.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

sys.path.insert(0, str(Path(__file__).parent.parent))

import aiofiles
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from core.database import (
    get_chunks_for_paper,
    get_paper,
    init_db,
    list_papers,
    resolve_paper_ref,
)
from core.ingest import ingest_pdf, remove_paper as _remove_paper
from core.retrieval import get_context_for_query, search

init_db()

app = FastAPI(title="Research Assistant", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_UI_DIR = Path(__file__).parent.parent / "ui"

# ─── Background embedding pre-warm ───────────────────────────────────────────

def _prewarm_embeddings() -> None:
    """Warm up the embedding provider in the background so the first CLI/UI search is fast."""
    try:
        from core.embeddings import get_provider
        get_provider()
    except Exception:
        pass


# ─── Heartbeat / auto-shutdown ────────────────────────────────────────────────

_last_heartbeat: float = time.time()
_auto_shutdown: bool = False   # set to True by CLI when --auto-close flag used
_HEARTBEAT_TIMEOUT = 20        # seconds with no ping before shutdown


def _heartbeat_monitor() -> None:
    """Background thread: shut down server if browser tab closes."""
    time.sleep(10)              # grace period at startup
    while True:
        time.sleep(5)
        if _auto_shutdown and (time.time() - _last_heartbeat) > _HEARTBEAT_TIMEOUT:
            os.kill(os.getpid(), signal.SIGTERM)
            break


threading.Thread(target=_heartbeat_monitor, daemon=True).start()


@app.get("/api/health")
def api_health():
    from core.collections import get_active_name
    return {
        "ok": True,
        "collection": get_active_name(),
        "capabilities": ["search_filters_v1", "paper_chunks_v1"],
    }


@app.get("/api/heartbeat")
def api_heartbeat():
    global _last_heartbeat
    _last_heartbeat = time.time()
    return {"ok": True}


# ─── Models ──────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    top_k: int = 8
    paper_ids: Optional[list[str]] = None
    citekeys: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    author: Optional[str] = None
    year: Optional[int] = None
    year_from: Optional[int] = None
    year_to: Optional[int] = None
    mode: Literal["hybrid", "semantic", "bm25"] = "hybrid"
    semantic_weight: Optional[float] = None
    bm25_weight: Optional[float] = None
    rrf_k: Optional[int] = None
    recall_k: Optional[int] = None
    rerank: bool = False
    reranker_model: Optional[str] = None
    max_chunks_per_paper: int = 5


class FindSupportRequest(BaseModel):
    claim: str
    top_k: int = 8
    recall_k: int = 30
    use_reranker: bool = True
    reranker_model: Optional[str] = None
    paper_ids: Optional[list[str]] = None
    citekeys: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    author: Optional[str] = None
    year: Optional[int] = None
    year_from: Optional[int] = None
    year_to: Optional[int] = None
    mode: Literal["hybrid", "semantic", "bm25"] = "hybrid"
    semantic_weight: Optional[float] = None
    bm25_weight: Optional[float] = None
    rrf_k: Optional[int] = None


class TagUpdateRequest(BaseModel):
    tags: list[str]


class IngestPathRequest(BaseModel):
    pdf_path: str
    tags: list[str] = []
    force: bool = False


class ArxivSearchRequest(BaseModel):
    query: str
    max_results: int = 10


class ArxivFetchRequest(BaseModel):
    arxiv_id: str
    add_to_kb: bool = False
    extra_tags: list[str] = []
    download_dir: Optional[str] = None


# ─── Papers ──────────────────────────────────────────────────────────────────

@app.get("/api/papers")
def api_list_papers(tag: str = "", year: int = 0):
    return list_papers(
        tag=tag if tag else None,
        year=year if year else None,
    )


@app.get("/api/papers/{paper_id}")
def api_get_paper(paper_id: str):
    paper = resolve_paper_ref(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    return paper


@app.get("/api/papers/{paper_id}/chunks")
def api_get_paper_chunks(
    paper_id: str,
    page_from: Optional[int] = None,
    page_to: Optional[int] = None,
):
    paper = resolve_paper_ref(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    chunks = get_chunks_for_paper(paper.id, page_from=page_from, page_to=page_to)
    return {
        "paper": paper,
        "chunks": chunks,
    }


@app.delete("/api/papers/{paper_id}")
def api_delete_paper(paper_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    ok = _remove_paper(paper_id)
    return {"ok": ok}


@app.patch("/api/papers/{paper_id}/tags")
def api_update_tags(paper_id: str, body: TagUpdateRequest):
    import sqlite3
    from core.database import get_sqlite_path
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    conn = sqlite3.connect(str(get_sqlite_path()))
    with conn:
        conn.execute("UPDATE papers SET tags=? WHERE id=?", (json.dumps(body.tags), paper_id))
    conn.close()
    return get_paper(paper_id)


@app.post("/api/papers/upload")
async def api_upload_paper(
    file: UploadFile = File(...),
    tags: str = Form(""),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported")

    from core.database import get_data_dir
    tmp_dir = get_data_dir() / "uploads"
    tmp_dir.mkdir(exist_ok=True)
    tmp_path = tmp_dir / f"{uuid.uuid4()}_{file.filename}"

    async with aiofiles.open(tmp_path, "wb") as f:
        content = await file.read()
        await f.write(content)

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    result = ingest_pdf(tmp_path, tags=tag_list)
    return result


@app.post("/api/papers/ingest-path")
def api_ingest_path(body: IngestPathRequest):
    path = Path(body.pdf_path)
    if not path.exists():
        raise HTTPException(404, f"File not found: {path}")
    return ingest_pdf(path, tags=body.tags, force=body.force)


@app.get("/api/papers/{paper_id}/open")
def api_open_paper(paper_id: str):
    """Open the PDF in the OS default viewer."""
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    path = Path(paper.file_path)
    if not path.exists():
        raise HTTPException(404, f"File not found on disk: {path}")

    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(str(path))
        elif system == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except Exception as e:
        raise HTTPException(500, f"Could not open file: {e}")
    return {"ok": True, "path": str(path)}


@app.get("/api/papers/{paper_id}/reveal")
def api_reveal_paper(paper_id: str):
    """Reveal the PDF in the OS file manager."""
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    path = Path(paper.file_path)

    system = platform.system()
    try:
        if system == "Windows":
            subprocess.Popen(["explorer", "/select,", str(path)])
        elif system == "Darwin":
            subprocess.Popen(["open", "-R", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path.parent)])
    except Exception as e:
        raise HTTPException(500, f"Could not reveal file: {e}")
    return {"ok": True}


# ─── Collections ─────────────────────────────────────────────────────────────

class CollectionCreateRequest(BaseModel):
    name: str
    description: str = ""


@app.get("/api/collections")
def api_list_collections():
    from core.collections import list_collections
    return list_collections()


@app.post("/api/collections")
def api_create_collection(body: CollectionCreateRequest):
    from core.collections import create_collection
    try:
        return create_collection(body.name, body.description)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.put("/api/collections/{name}/activate")
def api_activate_collection(name: str):
    from core.collections import set_active_collection
    from core.database import init_db
    try:
        result = set_active_collection(name)
        init_db()   # reinitialise DB for new collection
        return result
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/collections/{name}")
def api_delete_collection(name: str):
    from core.collections import delete_collection
    try:
        delete_collection(name)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/collections/active")
def api_active_collection():
    from core.collections import get_active_name, list_collections
    name = get_active_name()
    for c in list_collections():
        if c["name"] == name:
            return c
    return {"name": name, "active": True}


# ─── Settings ────────────────────────────────────────────────────────────────

class SettingsPatchRequest(BaseModel):
    arxiv_search_enabled: Optional[bool] = None


@app.get("/api/settings")
def api_get_settings():
    from core.settings import load_settings
    return load_settings()


@app.patch("/api/settings")
def api_patch_settings(body: SettingsPatchRequest):
    from core.settings import load_settings, save_settings
    current = load_settings()
    if body.arxiv_search_enabled is not None:
        current["arxiv_search_enabled"] = body.arxiv_search_enabled
    return save_settings(current)


# ─── Search ──────────────────────────────────────────────────────────────────

@app.post("/api/search")
def api_search(req: SearchRequest):
    results = search(
        req.query,
        top_k=req.top_k,
        paper_ids=req.paper_ids,
        citekeys=req.citekeys,
        tags=req.tags,
        author=req.author,
        year=req.year,
        year_from=req.year_from,
        year_to=req.year_to,
        mode=req.mode,
        semantic_weight=req.semantic_weight,
        bm25_weight=req.bm25_weight,
        rrf_k=req.rrf_k,
        recall_k=req.recall_k,
        rerank=req.rerank,
        reranker_model=req.reranker_model,
        max_chunks_per_paper=req.max_chunks_per_paper,
    )
    return results


@app.post("/api/search/context")
def api_search_context(req: SearchRequest):
    return {
        "context": get_context_for_query(
            req.query,
            top_k=req.top_k,
            paper_ids=req.paper_ids,
            citekeys=req.citekeys,
            tags=req.tags,
            author=req.author,
            year=req.year,
            year_from=req.year_from,
            year_to=req.year_to,
            mode=req.mode,
            semantic_weight=req.semantic_weight,
            bm25_weight=req.bm25_weight,
            rrf_k=req.rrf_k,
            recall_k=req.recall_k,
            rerank=req.rerank,
            reranker_model=req.reranker_model,
            max_chunks_per_paper=req.max_chunks_per_paper,
        )
    }


@app.post("/api/citations/find-support")
def api_find_support(req: FindSupportRequest):
    from core.claim_support import find_supporting_citations
    return find_supporting_citations(
        req.claim,
        top_k=req.top_k,
        recall_k=req.recall_k,
        use_reranker=req.use_reranker,
        reranker_model=req.reranker_model,
        paper_ids=req.paper_ids,
        citekeys=req.citekeys,
        tags=req.tags,
        author=req.author,
        year=req.year,
        year_from=req.year_from,
        year_to=req.year_to,
        mode=req.mode,
        semantic_weight=req.semantic_weight,
        bm25_weight=req.bm25_weight,
        rrf_k=req.rrf_k,
    )


# ─── arXiv ───────────────────────────────────────────────────────────────────

@app.post("/api/arxiv/search")
def api_arxiv_search(req: ArxivSearchRequest):
    import dataclasses
    from core.arxiv import search_arxiv
    from core.settings import get_arxiv_enabled

    if not get_arxiv_enabled():
        raise HTTPException(
            403,
            "arXiv online search is currently DISABLED. Enable it in the Research Assistant Web UI settings.",
        )
    try:
        results = search_arxiv(req.query, max_results=req.max_results)
    except Exception as exc:
        raise HTTPException(502, f"arXiv API error: {exc}")
    return [dataclasses.asdict(r) for r in results]


@app.post("/api/arxiv/fetch")
def api_arxiv_fetch(req: ArxivFetchRequest):
    import dataclasses
    from core.arxiv import download_pdf, fetch_arxiv
    from core.collections import create_collection, get_active_name, set_active_collection
    from core.config import get_config
    from core.settings import get_arxiv_enabled

    if not get_arxiv_enabled():
        raise HTTPException(
            403,
            "arXiv online search is currently DISABLED. Enable it in the Research Assistant Web UI settings.",
        )
    try:
        result = fetch_arxiv(req.arxiv_id)
    except Exception as exc:
        raise HTTPException(502, f"arXiv API error: {exc}")
    if result is None:
        raise HTTPException(404, f"arXiv paper not found: {req.arxiv_id}")

    payload = dataclasses.asdict(result)
    if req.download_dir or req.add_to_kb:
        dl_dir = Path(req.download_dir) if req.download_dir else get_config().get_data_dir() / "arxiv_downloads"
        pdf_path = download_pdf(result, dl_dir)
        payload["downloaded_path"] = str(pdf_path)

        if req.add_to_kb:
            arxiv_col = "arXiv Downloads"
            prev = get_active_name()
            try:
                create_collection(arxiv_col, "Papers fetched from arXiv search")
            except ValueError:
                pass
            try:
                set_active_collection(arxiv_col)
                init_db()
                tags = list({"arxiv", *req.extra_tags})
                ingest_res = ingest_pdf(pdf_path, tags=tags)
                payload["ingest"] = ingest_res.model_dump(mode="json")
            finally:
                set_active_collection(prev)
                init_db()
    return payload


# ─── Status ──────────────────────────────────────────────────────────────────

@app.get("/api/status")
def api_status():
    papers = list_papers()
    return {
        "paper_count": len(papers),
        "chunk_count": sum(p.chunk_count for p in papers),
        "failed_count": sum(1 for p in papers if p.status == "failed"),
    }


# ─── UI ──────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def serve_ui():
    index = _UI_DIR / "index.html"
    if index.exists():
        return index.read_text(encoding="utf-8")
    return "<h1>UI not found</h1>"


def run(
    host: Optional[str] = None,
    port: Optional[int] = None,
    auto_shutdown: bool = False,
) -> None:
    import uvicorn
    from core.config import get_config
    global _auto_shutdown
    _auto_shutdown = auto_shutdown
    cfg = get_config().api
    bind_host = host or cfg.host
    bind_port = port or cfg.port
    threading.Thread(target=_prewarm_embeddings, daemon=True).start()
    uvicorn.run(app, host=bind_host, port=bind_port, reload=False, log_level="warning")


if __name__ == "__main__":
    run()
