from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.config import AppConfig


class EmbeddingProvider(ABC):
    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        ...

    @abstractmethod
    def dimension(self) -> int:
        ...

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]

    def embed_query(self, text: str) -> list[float]:
        """Embed a search query. Override for models that need query prefixes."""
        return self.embed_one(text)


class SentenceTransformerProvider(EmbeddingProvider):
    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        from sentence_transformers import SentenceTransformer
        self._model = SentenceTransformer(model_name)
        try:
            self._dim: int = self._model.get_embedding_dimension()
        except AttributeError:
            self._dim = self._model.get_sentence_embedding_dimension()

    def embed(self, texts: list[str]) -> list[list[float]]:
        return self._model.encode(texts, convert_to_numpy=True, show_progress_bar=False).tolist()

    def dimension(self) -> int:
        return self._dim


class OllamaProvider(EmbeddingProvider):
    def __init__(
        self,
        model_name: str = "nomic-embed-text",
        base_url: str = "http://localhost:11434",
        document_prefix: str = "",
        query_prefix: str = "",
    ):
        import ollama
        self._client = ollama.Client(host=base_url)
        self._model_name = model_name
        self._doc_prefix = document_prefix
        self._query_prefix = query_prefix
        self._dim: int | None = None

    def _embed_raw(self, texts: list[str]) -> list[list[float]]:
        # Batched call (ollama>=0.3); truncate overlong inputs instead of failing.
        resp = self._client.embed(model=self._model_name, input=texts, truncate=True)
        results = [list(e) for e in resp["embeddings"]]
        if self._dim is None and results:
            self._dim = len(results[0])
        return results

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed documents (paper chunks)."""
        return self._embed_raw([self._doc_prefix + t for t in texts])

    def embed_query(self, text: str) -> list[float]:
        return self._embed_raw([self._query_prefix + text])[0]

    def dimension(self) -> int:
        if self._dim is None:
            self.embed(["warmup"])
        return self._dim  # type: ignore[return-value]


_provider: EmbeddingProvider | None = None


def get_provider(config: "AppConfig | None" = None) -> EmbeddingProvider:
    global _provider
    if _provider is not None:
        return _provider

    if config is None:
        from core.config import get_config
        config = get_config()

    if config.embedding.provider == "ollama":
        cfg = config.embedding.ollama
        _provider = OllamaProvider(
            model_name=cfg.model,
            base_url=cfg.base_url,
            document_prefix=cfg.document_prefix,
            query_prefix=cfg.query_prefix,
        )
    else:
        cfg = config.embedding.sentence_transformers
        _provider = SentenceTransformerProvider(model_name=cfg.model)

    return _provider


def reset_provider() -> None:
    """Force re-init on next call (useful after config change)."""
    global _provider
    _provider = None
