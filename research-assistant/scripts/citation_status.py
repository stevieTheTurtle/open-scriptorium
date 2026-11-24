#!/usr/bin/env python3
"""
Standalone citation status generator for Open Scriptorium.

Uses ONLY Python's standard library (sqlite3, json, re, unicodedata) so it works
with any Python 3.10+ installation even before heavy ML dependencies are installed.

Matches every BibTeX entry in a LaTeX project against a Research Assistant SQLite
index (read-only):
  - indexed=True              paper is in the library (by @citekey tag, title + author,
                              or title heading inside a proceedings/book PDF)
  - indexed=False, citedIn    paper is not in the library, but other indexed papers cite it
                              (extracts verbatim body-text citing phrases when found)
  - indexed=False, count=0    nothing in the library mentions it

Usage:
    python citation_status.py --bib-dir <dir> --db <metadata.db> --output <citation_status.json>
    python citation_status.py --bib file1.bib --bib file2.bib --db <metadata.db> --output <out.json>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.parse
from pathlib import Path

sys.dont_write_bytecode = True

LOOKUP_SCHEMA_VERSION = 2
_CITED_WINDOW = 300
_HEADING_WINDOW = 60
_HEADING_AUTHORS_WINDOW = 200
_VOLUME_MIN_PAGES = 50
_EXCLUDED_DIRS = {".git", "node_modules", "_Old", ".scriptorium", "__pycache__", ".venv"}

_TEX_ACCENTS = {
    "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303",
    "c": "\u0327", "v": "\u030c", "=": "\u0304", ".": "\u0307", "u": "\u0306", "H": "\u030b",
}


# ── BibTeX parsing ───────────────────────────────────────────────────────────

def _bib_field_value(text: str, i: int) -> tuple[str, int]:
    while i < len(text) and text[i].isspace():
        i += 1
    if i >= len(text):
        return "", i
    if text[i] == "{":
        depth, j = 0, i
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    return text[i + 1:j], j + 1
            j += 1
        return text[i + 1:], len(text)
    if text[i] == '"':
        j = i + 1
        depth = 0
        while j < len(text):
            c = text[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            elif c == '"' and depth == 0:
                return text[i + 1:j], j + 1
            j += 1
        return text[i + 1:], len(text)
    m = re.match(r"[^,}\s]+", text[i:])
    return (m.group(0), i + m.end()) if m else ("", i)


def _detex(s: str) -> str:
    s = re.sub(
        r"\\([`'^\"~=.])\s*\{?\\?([A-Za-z])\}?",
        lambda m: unicodedata.normalize("NFC", m.group(2) + _TEX_ACCENTS[m.group(1)]),
        s,
    )
    s = re.sub(
        r"\\([cvuH])\s*\{\\?([A-Za-z])\}",
        lambda m: unicodedata.normalize("NFC", m.group(2) + _TEX_ACCENTS[m.group(1)]),
        s,
    )
    s = s.replace("\\&", "&").replace("\\%", "%").replace("\\_", "_").replace("--", "\u2013").replace("~", " ")
    s = re.sub(r"\\(?:textit|textbf|emph|textsc|texttt|mbox)\s*", "", s)
    s = s.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", s).strip()


def parse_bib_file(path: Path) -> dict[str, dict[str, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    entries: dict[str, dict[str, str]] = {}
    for m in re.finditer(r"@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,", text):
        etype = m.group(1).lower()
        if etype in ("comment", "string", "preamble"):
            continue
        key, i, fields = m.group(2), m.end(), {"type": etype}
        while i < len(text):
            fm = re.match(r"\s*([A-Za-z][\w-]*)\s*=\s*", text[i:])
            if not fm:
                break
            value, i = _bib_field_value(text, i + fm.end())
            fields[fm.group(1).lower()] = _detex(value)
            cm = re.match(r"\s*,", text[i:])
            if not cm:
                break
            i += cm.end()
        entries[key] = fields
    return entries


def find_bib_files(bib_dir: Path) -> list[Path]:
    found: list[Path] = []
    for root, dirs, files in os.walk(bib_dir):
        dirs[:] = sorted(d for d in dirs if d not in _EXCLUDED_DIRS and not d.startswith("."))
        for f in sorted(files):
            if f.lower().endswith(".bib"):
                found.append(Path(root) / f)
    return found


# ── Index matching & second-hand quote extraction ────────────────────────────

def _norm_title(t: str | None) -> str:
    t = re.sub(r"\(tm\)|™|®", "", t or "", flags=re.I)
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def _norm_paper_text(t: str | None) -> str:
    t = (t or "").replace("\ufb01", "fi").replace("\ufb02", "fl").replace("\ufb00", "ff")
    return _norm_title(re.sub(r"-\s+", "", t))


def _first_author_surname(author: str | None) -> str:
    first = re.split(r"\s+and\s+", (author or "").strip())[0].strip()
    if not first:
        return ""
    return first.split(",")[0].strip() if "," in first else first.split()[-1]


def _ra_connect(db_path: Path) -> sqlite3.Connection:
    # Build proper file URI on both Windows and POSIX
    uri = db_path.resolve().as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=2)


def load_ra_index(db_path: Path) -> dict | None:
    if not db_path.is_file():
        return None
    try:
        conn = _ra_connect(db_path)
        rows = conn.execute("SELECT title, tags, authors FROM papers WHERE status='indexed'").fetchall()
        conn.close()
    except Exception as e:
        print(f"[citations] cannot read research-assistant index: {e}", file=sys.stderr)
        return None
    keys: set[str] = set()
    titles: set[str] = set()
    papers: list[tuple[str, set[str]]] = []
    for title, tags, authors in rows:
        n = _norm_title(title)
        titles.add(n)
        try:
            names = [a for a in json.loads(authors or "[]") if isinstance(a, str) and a.lower() != "unknown"]
        except ValueError:
            names = []
        papers.append((n, set(_norm_title(" ".join(names)).split())))
        try:
            for t in json.loads(tags or "[]"):
                if isinstance(t, str) and t.startswith("@"):
                    keys.add(t[1:])
        except ValueError:
            pass
    return {"keys": keys, "titles": titles, "papers": papers}


def is_indexed(key: str, bib_title: str, bib_author: str, ra: dict) -> bool:
    if key in ra["keys"]:
        return True
    n = _norm_title(bib_title)
    if not n:
        return False
    if n in ra["titles"]:
        return True
    surname = _norm_title(_first_author_surname(bib_author)).split()[-1:]
    subtitle = _norm_title(bib_title.split(":", 1)[1]) if ":" in bib_title else ""
    if surname and len(subtitle) >= 15:
        if any(t == subtitle and surname[0] in authors for t, authors in ra["papers"]):
            return True
    if len(n) < 30:
        return False
    for t, authors in ra["papers"]:
        if len(t) >= 30 and (
            t.startswith(n + " ")
            or n.startswith(t + " ")
            or (len(n) >= 40 and len(t) >= 40 and t[:40] == n[:40])
        ):
            if not authors or not surname or surname[0] in authors:
                return True
    return False


def _display_paper_title(title: str | None) -> str:
    return re.sub(r"\.pdf$", "", title or "", flags=re.I).replace("_", " ").strip()


def _title_phrases(bib_title: str) -> list[str]:
    n = _norm_title(bib_title)
    if not n:
        return []
    phrases, words = [n], n.split()
    if len(words) >= 8:
        phrases.append(" ".join(words[:6]))
    head = _norm_title(bib_title.split(":")[0]) if ":" in bib_title else ""
    if head and head != n:
        phrases.append(head)
    return phrases


def find_in_volume(conn: sqlite3.Connection, bib_title: str, bib_author: str, surname: str) -> dict | None:
    full = _norm_title(bib_title)
    words = full.split()
    if len(words) < 4:
        return None
    rows = conn.execute(
        """SELECT p.title, c.page_number, c.content
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN papers p ON p.id = c.paper_id
           WHERE chunks_fts MATCH ? AND p.status = 'indexed' AND p.page_count >= ?
           ORDER BY c.page_number LIMIT 500""",
        (f'"{surname}" AND "{" ".join(words[:4])}"', _VOLUME_MIN_PAGES),
    ).fetchall()
    names = re.split(r"\s+and\s+", (bib_author or "").strip())
    second = (_norm_title(_first_author_surname(names[1])).split() or [""])[-1] if len(names) > 1 else ""
    if second == "others":
        second = ""
    needle = f" {full} "
    candidates = []
    for title, page, content in rows:
        text = f" {_norm_paper_text(content)} "
        i = text.find(needle)
        if i < 0:
            continue
        start = i + len(needle) - 1
        heading = text[start: start + _HEADING_WINDOW]
        authors = text[start: start + _HEADING_AUTHORS_WINDOW]
        before = text[max(0, i - _HEADING_AUTHORS_WINDOW): i + 1]
        if f" {surname} " in heading and f" {surname} " not in before and (not second or f" {second} " in authors):
            candidates.append((title, page))
    if not candidates:
        return None
    title, page = candidates[-1]
    return {"title": _display_paper_title(title), "page": page}


def _clean_excerpt(text: str | None) -> str:
    s = (text or "").replace("\ufb01", "fi").replace("\ufb02", "fl").replace("\ufb00", "ff")
    s = s.replace("\ufb03", "ffi").replace("\ufb04", "ffl").replace("\u00ad", "")
    s = re.sub(r"([A-Za-z])-\s+([a-z])", r"\1\2", s)
    return re.sub(r"\s+", " ", s).strip()


def _is_reference_chunk(text: str) -> bool:
    low = text.lower()
    if re.search(r"(?:^|\s)(?:references|bibliography)(?:\s|$|:|\d)", low[:180]):
        return True
    years = len(re.findall(r"\b(?:19|20)\d{2}\b", text))
    if years >= 6:
        bib_tokens = len(re.findall(r"\b(?:pp\.|doi|vol\.|proc\.|proceedings|press|ieee|acm|journal|springer|in:)\b", low))
        ref_nums = len(re.findall(r"(?:^|\s)\[\d{1,3}\]\s+[A-Z]", text))
        if bib_tokens >= 3 or ref_nums >= 3:
            return True
    return False


def _extract_sentence(text: str, start: int, end: int, max_len: int = 320) -> str:
    boundary = re.compile(
        r"(?<!\bal)(?<!\be\.g)(?<!\bi\.e)(?<!\bvs)(?<!\bcf)(?<!\bfig)(?<!\bsec)"
        r"(?<!\bch)(?<!\bdr)(?<!\bmr)(?<!\bp)(?<!\bpp)(?<!\b[A-Z])[.!?]"
    )
    left, right = text[:start], text[end:]
    s_start = 0
    for m in boundary.finditer(left):
        tail = left[m.end():]
        ws = re.match(r"\s+(?=[A-Z\"'\u201c(\[])", tail)
        if ws:
            s_start = m.end() + ws.end()
    s_end = len(text)
    for m in boundary.finditer(right):
        after = right[m.end():]
        if not after or re.match(r"[\s\"'\u201d)\]]", after):
            s_end = end + m.end()
            break
    sent = text[s_start:s_end].strip()
    if len(sent) <= max_len:
        return sent
    rel_s, rel_e = start - s_start, end - s_start
    lo = max(0, rel_s - 130)
    hi = min(len(sent), rel_e + 160)
    if lo > 0:
        sp = sent.find(" ", lo)
        if sp != -1 and sp < rel_s:
            lo = sp + 1
    if hi < len(sent):
        sp = sent.rfind(" ", rel_e, hi)
        if sp != -1 and sp > rel_e:
            hi = sp
    prefix = "\u2026" if lo > 0 else ""
    suffix = "\u2026" if hi < len(sent) else ""
    return f"{prefix}{sent[lo:hi].strip()}{suffix}"


def _detect_ref_number(raw_content: str, surname: str, raw_surname: str, title_phrase: str) -> str | None:
    cleaned = _clean_excerpt(raw_content)
    low = cleaned.lower()
    t_idx = low.find(title_phrase[:24].lower()) if title_phrase else -1
    end = (t_idx + 30) if t_idx >= 0 else len(cleaned)
    region = cleaned[max(0, end - 260): end]
    alts = "|".join(re.escape(v) for v in sorted({raw_surname, surname}, key=len, reverse=True) if v)
    if not alts:
        return None
    matches = list(re.finditer(
        r"(?:^|\s)(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+(?:[^.\[\]]{0,60}?\b)?(?:" + alts + r")\b",
        region, re.I,
    ))
    if not matches:
        return None
    g = matches[-1]
    return g.group(1) or g.group(2)


def _find_citing_quote(
    conn: sqlite3.Connection,
    paper_id: str,
    page_count: int | None,
    ref_page: int | None,
    ref_content: str,
    cached_chunks: list[tuple[int, str]],
    surname: str,
    raw_surname: str,
    year: str,
    title_phrase: str,
) -> tuple[int | None, str | None]:
    is_volume = (page_count or 0) >= _VOLUME_MIN_PAGES
    lo_page = max(1, (ref_page or 1) - (40 if is_volume else 9999))
    hi_page = ref_page or 9999
    alts = "|".join(re.escape(v) for v in sorted({raw_surname, surname}, key=len, reverse=True) if v)
    title_probe = (title_phrase[:24] if title_phrase else "").lower()

    if year and alts:
        ay_pat = re.compile(
            r"\b(?:" + alts + r")"
            r"(?:\s+(?:et\s+al\.?|(?:and|&)\s+[A-Z][\w-]+|(?:,\s*[A-Z][\w-]+){1,3}(?:,?\s*(?:&|and)\s*[A-Z][\w-]+)?))?"
            r"[\s,;(\[]*(?:\d{4}[a-z]?[\s,;]+)*" + re.escape(year) + r"[a-z]?\b",
            re.I,
        )
        candidates = sorted(
            ((pg, txt) for pg, txt in cached_chunks if lo_page <= (pg or 0) <= hi_page),
            key=lambda x: x[0] or 0,
        )
        for pg, content in candidates:
            cleaned = _clean_excerpt(content)
            if _is_reference_chunk(cleaned):
                continue
            if pg == ref_page and title_probe and title_probe in cleaned.lower():
                continue
            m = ay_pat.search(cleaned)
            if m:
                sent = _extract_sentence(cleaned, m.start(), m.end())
                if len(sent) >= 25:
                    return pg, sent

    ref_num = _detect_ref_number(ref_content, surname, raw_surname, title_phrase)
    if ref_num:
        n = int(ref_num)
        num_lo = max(1, (ref_page or 1) - (20 if is_volume else 9999))
        order = "DESC" if is_volume else "ASC"
        rows = conn.execute(
            f"""SELECT c.page_number, c.content
                FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
                WHERE chunks_fts MATCH ? AND c.paper_id = ?
                  AND c.page_number >= ? AND c.page_number < ?
                ORDER BY c.page_number {order} LIMIT 80""",
            (f'"{ref_num}"', paper_id, num_lo, ref_page or 9999),
        ).fetchall()
        bracket_pat = re.compile(r"\[\s*([\d,\s\u2013\u2014-]+)\s*\]")
        for pg, content in rows:
            cleaned = _clean_excerpt(content)
            if _is_reference_chunk(cleaned):
                if is_volume:
                    break
                continue
            for m in bracket_pat.finditer(cleaned):
                inner = m.group(1)
                if len(inner) > 40:
                    continue
                hit = False
                for part in inner.split(","):
                    part = part.strip()
                    rm = re.match(r"^(\d+)\s*[\u2013\u2014-]\s*(\d+)$", part)
                    if rm:
                        if int(rm.group(1)) <= n <= int(rm.group(2)):
                            hit = True
                    elif part.isdigit() and int(part) == n:
                        hit = True
                if hit:
                    sent = _extract_sentence(cleaned, m.start(), m.end())
                    if len(sent) >= 25:
                        return pg, sent
    return None, None


def find_citing_papers(conn: sqlite3.Connection, bib_title: str, bib_author: str, bib_year: str, limit: int = 3) -> dict:
    phrases = _title_phrases(bib_title)
    raw_surname = _first_author_surname(bib_author)
    tokens = _norm_title(raw_surname).split()
    if not phrases or not tokens:
        return {"count": 0, "papers": []}
    surname = tokens[-1]
    volume = find_in_volume(conn, bib_title, bib_author, surname)
    if volume:
        return {"count": 0, "papers": [], "volume": volume}
    year_m = re.search(r"\d{4}", bib_year or "")
    year = year_m.group(0) if year_m else ""

    raw_last = re.split(r"[\s-]+", raw_surname.lower())[-1].replace('"', "")
    variants = " OR ".join(f'"{v}"' for v in sorted({surname, raw_last}) if v)
    match = f"({variants})" + (f' AND "{year}"*' if year else "")
    rows = conn.execute(
        """SELECT c.paper_id, c.page_number, c.content, p.title, p.page_count
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN papers p ON p.id = c.paper_id
           WHERE chunks_fts MATCH ? AND p.status = 'indexed' LIMIT 20000""",
        (match,),
    ).fetchall()

    squashed_title = phrases[0].replace(" ", "")
    best: dict = {}
    chunks_by_paper: dict[str, list[tuple[int, str]]] = {}
    for paper_id, page, content, paper_title, page_count in rows:
        chunks_by_paper.setdefault(paper_id, []).append((page, content))
        text = f" {_norm_paper_text(content)} "
        for rank, phrase in enumerate(phrases):
            if rank >= best.get(paper_id, (99,))[0]:
                break
            needle, found, i = f" {phrase} ", False, text.find(f" {phrase} ")
            while i >= 0 and not found:
                window = text[max(0, i - _CITED_WINDOW): i + len(needle) + _CITED_WINDOW]
                found = f" {surname} " in window and (not year or year in window)
                i = text.find(needle, i + 1)
            if found:
                best[paper_id] = (rank, page, _display_paper_title(paper_title), content, page_count)
                break
        if paper_id not in best and len(squashed_title) >= 20:
            squashed = text.replace(" ", "")
            i = squashed.find(squashed_title)
            while i >= 0 and paper_id not in best:
                window = squashed[max(0, i - _CITED_WINDOW): i + len(squashed_title) + _CITED_WINDOW]
                if surname in window and (not year or year in window):
                    best[paper_id] = (len(phrases), page, _display_paper_title(paper_title), content, page_count)
                i = squashed.find(squashed_title, i + 1)
    untitled = "[no title found]"
    ordered = sorted(best.items(), key=lambda kv: (kv[1][2].lower() == untitled, kv[1][0], kv[1][2].lower()))
    enriched = []
    for paper_id, (rank, pg, title, ref_content, page_count) in ordered[:max(limit * 3, 9)]:
        qpg, quote = _find_citing_quote(
            conn, paper_id, page_count, pg, ref_content,
            chunks_by_paper.get(paper_id, []), surname, raw_surname, year, phrases[0],
        )
        item: dict = {"title": title, "page": pg}
        if quote:
            item["quote"] = quote
            if qpg is not None:
                item["quotePage"] = qpg
        enriched.append((0 if quote else 1, title.lower() == untitled, rank, title.lower(), item))
    enriched.sort(key=lambda x: x[:4])
    return {"count": len(ordered), "papers": [x[4] for x in enriched[:limit]]}


def index_signature(db_path: Path) -> list:
    def mtime(p: Path) -> float:
        return p.stat().st_mtime if p.exists() else 0.0
    wal = Path(str(db_path) + "-wal")
    return [LOOKUP_SCHEMA_VERSION, mtime(db_path), mtime(wal)]


def load_previous(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate Open Scriptorium citation_status.json from Research Assistant DB.")
    ap.add_argument("--bib", action="append", default=[], help="Path to a .bib file (repeatable)")
    ap.add_argument("--bib-dir", type=Path, default=None, help="Directory to scan recursively for .bib files")
    ap.add_argument("--db", type=Path, required=True, help="Path to Research Assistant metadata.db")
    ap.add_argument("--output", type=Path, required=True, help="Path to output citation_status.json")
    args = ap.parse_args()

    started = time.time()
    bib_files: list[Path] = [Path(b).resolve() for b in args.bib if Path(b).is_file()]
    if args.bib_dir and args.bib_dir.is_dir():
        for p in find_bib_files(args.bib_dir.resolve()):
            if p not in bib_files:
                bib_files.append(p)

    entries: dict[str, dict[str, str]] = {}
    for bf in bib_files:
        try:
            for k, v in parse_bib_file(bf).items():
                if k not in entries:
                    entries[k] = v
        except Exception as e:
            print(f"[citations] failed to parse {bf}: {e}", file=sys.stderr)

    db_path = args.db.expanduser().resolve()
    output = args.output.expanduser().resolve()
    previous = load_previous(output)
    signature = index_signature(db_path)

    cached_found: dict[tuple[str, str, str, str], dict] = {}
    cache = previous.get("_lookups") or {}
    if cache.get("signature") == signature:
        cached_found = {tuple(k): v for k, v in cache.get("found", [])}  # type: ignore[misc]

    ra = load_ra_index(db_path)
    status: dict[str, dict] = {}
    missing_lookups: list[tuple[str, str, str, str]] = []

    for key, e in entries.items():
        title = e.get("title", "")
        author = e.get("author", "")
        year = e.get("year", "")
        indexed = None if ra is None else is_indexed(key, title, author, ra)
        status[key] = {"indexed": indexed, "citedIn": None, "inside": None}
        if indexed is False:
            missing_lookups.append((key, title, author, year))

    todo = [lk for lk in missing_lookups if lk not in cached_found]
    if todo and ra is not None:
        try:
            conn = _ra_connect(db_path)
            for lk in todo:
                cached_found[lk] = find_citing_papers(conn, lk[1], lk[2], lk[3])
            conn.close()
        except Exception as ex:
            print(f"[citations] cannot search research-assistant text: {ex}", file=sys.stderr)

    for lk in missing_lookups:
        found = cached_found.get(lk)
        if not found:
            continue
        key = lk[0]
        if found.get("volume"):
            status[key] = {"indexed": True, "citedIn": None, "inside": found["volume"]}
        else:
            status[key] = {"indexed": False, "citedIn": found, "inside": None}

    found_serialized = [[list(k), v] for k, v in cached_found.items()]
    result = {
        "version": 1,
        "citations": status,
        "_lookups": {"signature": signature, "found": found_serialized},
    }

    if {k: previous.get(k) for k in result} == result:
        print(f"citation status unchanged ({len(status)} citations) in {time.time() - started:.1f}s")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_name(f"{output.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, output)
    missing = sum(1 for s in status.values() if s["indexed"] is False)
    print(f"wrote {output}: {len(status)} citations, {missing} not in the library ({time.time() - started:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
