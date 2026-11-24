from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, Field


class Paper(BaseModel):
    id: str
    title: str
    authors: list[str] = []
    year: Optional[int] = None
    abstract: Optional[str] = None
    file_path: str
    file_hash: str
    added_at: datetime
    tags: list[str] = []
    status: str = "indexed"  # indexed | processing | failed
    page_count: int = 0
    chunk_count: int = 0


class Chunk(BaseModel):
    id: str
    paper_id: str
    content: str
    page_number: int
    chunk_index: int


class SearchResult(BaseModel):
    paper: Paper
    chunks: list[ChunkResult]
    score: float


class ChunkResult(BaseModel):
    chunk_id: str
    content: str
    page_number: int
    score: float


class IngestResult(BaseModel):
    paper_id: str
    title: str
    chunk_count: int
    success: bool
    error: Optional[str] = None
