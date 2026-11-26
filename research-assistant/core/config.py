from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, Optional

import yaml
from pydantic import BaseModel, field_validator


_PROJECT_ROOT = Path(__file__).parent.parent


def _resolve_config_path() -> Path:
    if env := os.environ.get("RA_CONFIG_PATH"):
        return Path(env).expanduser()
    return _PROJECT_ROOT / "config.yaml"


class SentenceTransformersConfig(BaseModel):
    model: str = "all-MiniLM-L6-v2"


class OllamaConfig(BaseModel):
    model: str = "nomic-embed-text"
    base_url: str = "http://localhost:11434"
    # nomic-embed-text needs task prefixes; set both to "" for models that don't.
    document_prefix: str = "search_document: "
    query_prefix: str = "search_query: "


class EmbeddingConfig(BaseModel):
    provider: Literal["sentence_transformers", "ollama"] = "sentence_transformers"
    sentence_transformers: SentenceTransformersConfig = SentenceTransformersConfig()
    ollama: OllamaConfig = OllamaConfig()


class ChunkingConfig(BaseModel):
    chunk_size: int = 400
    chunk_overlap: int = 60


class RetrievalConfig(BaseModel):
    top_k: int = 10
    bm25_weight: float = 0.3
    semantic_weight: float = 0.7
    rrf_k: int = 60
    recall_k: int = 30
    reranker_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"


class ApiConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8000


class AppConfig(BaseModel):
    embedding: EmbeddingConfig = EmbeddingConfig()
    chunking: ChunkingConfig = ChunkingConfig()
    retrieval: RetrievalConfig = RetrievalConfig()
    api: ApiConfig = ApiConfig()
    data_dir: Optional[str] = None

    def get_data_dir(self) -> Path:
        base = _resolve_config_path().parent
        if env := os.environ.get("RA_DATA_DIR"):
            p = Path(env).expanduser()
            return p if p.is_absolute() else base / p
        if self.data_dir:
            p = Path(self.data_dir).expanduser()
            return p if p.is_absolute() else base / p
        return base / "data"


def load_config(path: Optional[Path] = None) -> AppConfig:
    cfg_path = path if path is not None else _resolve_config_path()
    if cfg_path.exists():
        with open(cfg_path, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        return AppConfig.model_validate(raw)
    return AppConfig()


_config: Optional[AppConfig] = None


def get_config() -> AppConfig:
    global _config
    if _config is None:
        _config = load_config()
    return _config
