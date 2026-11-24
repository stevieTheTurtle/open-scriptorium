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
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

import aiofiles
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from core.database import get_paper, init_db, list_papers
from core.ingest import ingest_pdf, remove_paper as _remove_paper
from core.retrieval import search

init_db()

app = FastAPI(title="Research Assistant", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_UI_DIR = Path(__file__).parent.parent / "ui"

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


@app.get("/api/heartbeat")
def api_heartbeat():
    global _last_heartbeat
    _last_heartbeat = time.time()
    return {"ok": True}


# ─── Models ──────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    top_k: int = 8


class TagUpdateRequest(BaseModel):
    tags: list[str]


# ─── Papers ──────────────────────────────────────────────────────────────────

@app.get("/api/papers")
def api_list_papers(tag: str = "", year: int = 0):
    return list_papers(
        tag=tag if tag else None,
        year=year if year else None,
    )


@app.get("/api/papers/{paper_id}")
def api_get_paper(paper_id: str):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    return paper


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
    results = search(req.query, top_k=req.top_k)
    return results


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


def run(auto_shutdown: bool = False) -> None:
    import uvicorn
    from core.config import get_config
    global _auto_shutdown
    _auto_shutdown = auto_shutdown
    cfg = get_config().api
    uvicorn.run("api.app:app", host=cfg.host, port=cfg.port, reload=False)


if __name__ == "__main__":
    run()
