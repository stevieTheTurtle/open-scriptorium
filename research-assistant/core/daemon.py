"""Lightweight search daemon — keeps embedding model warm between CLI calls.

Protocol (stdin/stdout, line-delimited JSON):
  Request:  {"cmd": "search", "query": "...", "top_k": 8}
            {"cmd": "ping"}
            {"cmd": "quit"}
  Response: {"ok": true, "result": "..."}
            {"ok": false, "error": "..."}

The daemon runs as a background process managed by the CLI.
Socket file: ~/.research_assistant/daemon.sock  (Windows: named pipe)
PID file:    ~/.research_assistant/daemon.pid
"""
from __future__ import annotations

import json
import os
import signal
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Silence library output — daemon is a background process
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
_real_stderr = sys.stderr
sys.stderr = open(os.devnull, "w")

from core.database import init_db, get_paper, list_papers
from core.retrieval import get_context_for_query, search
from core.embeddings import get_provider
from core.config import get_config

sys.stderr = _real_stderr


def _get_sock_path() -> str:
    from core.database import get_data_dir
    return str(get_data_dir() / "daemon.sock")


def _get_pid_path() -> Path:
    from core.database import get_data_dir
    return get_data_dir() / "daemon.pid"


def handle_request(data: dict) -> dict:
    cmd = data.get("cmd", "")
    try:
        if cmd == "ping":
            return {"ok": True, "result": "pong"}
        elif cmd == "search":
            result = get_context_for_query(data["query"], top_k=data.get("top_k", 8))
            return {"ok": True, "result": result}
        elif cmd == "list":
            papers = list_papers(
                tag=data.get("tag") or None,
                year=data.get("year") or None,
            )
            return {"ok": True, "result": json.dumps([p.model_dump(mode="json") for p in papers])}
        elif cmd == "quit":
            return {"ok": True, "result": "bye"}
        else:
            return {"ok": False, "error": f"Unknown command: {cmd}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def run_server() -> None:
    sock_path = _get_sock_path()
    pid_path = _get_pid_path()

    # Write PID
    pid_path.write_text(str(os.getpid()))

    # Remove stale socket
    if os.path.exists(sock_path):
        os.unlink(sock_path)

    # Pre-warm model
    init_db()
    get_provider(get_config())

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(8)
    os.chmod(sock_path, 0o600)

    def cleanup(sig=None, frame=None):
        server.close()
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        if pid_path.exists():
            pid_path.unlink()
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=_handle_conn, args=(conn,), daemon=True).start()


def _handle_conn(conn: socket.socket) -> None:
    try:
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            if buf.endswith(b"\n"):
                break
        if buf:
            req = json.loads(buf.decode())
            resp = handle_request(req)
            conn.sendall((json.dumps(resp) + "\n").encode())
            if req.get("cmd") == "quit":
                os.kill(os.getpid(), signal.SIGTERM)
    except Exception as e:
        try:
            conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
        except Exception:
            pass
    finally:
        conn.close()


# ── Client helpers ────────────────────────────────────────────────────────────

def _send(request: dict, sock_path: str, timeout: float = 10.0) -> dict:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    s.sendall((json.dumps(request) + "\n").encode())
    buf = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
        if buf.endswith(b"\n"):
            break
    s.close()
    return json.loads(buf.decode())


def is_running() -> bool:
    sock_path = _get_sock_path()
    if not os.path.exists(sock_path):
        return False
    try:
        resp = _send({"cmd": "ping"}, sock_path, timeout=2.0)
        return resp.get("result") == "pong"
    except Exception:
        return False


def client_search(query: str, top_k: int = 8) -> str:
    return _send({"cmd": "search", "query": query, "top_k": top_k}, _get_sock_path())["result"]


def client_list(tag: str | None = None, year: int | None = None) -> list:
    resp = _send({"cmd": "list", "tag": tag, "year": year}, _get_sock_path())
    return json.loads(resp["result"])


def client_quit() -> None:
    try:
        _send({"cmd": "quit"}, _get_sock_path(), timeout=3.0)
    except Exception:
        pass


if __name__ == "__main__":
    run_server()
