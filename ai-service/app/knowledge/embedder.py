"""
Text embeddings for the knowledge index, with fastembed (Qdrant; Apache-2.0) running
BAAI/bge-small-en-v1.5 on the CPU through ONNX Runtime. No text leaves the server.

    - The model is loaded once (on first use, or by `load` at startup) from EMBEDDING_CACHE_DIR.
      With EMBEDDING_OFFLINE (always on in the production image, where the model is built in and
      checked against app/knowledge/embedding_model.sha256) it is never downloaded at run time.
    - Embedding is CPU-bound, so it runs in a worker thread, never on the event loop, and one batch
      at a time: memory stays bounded and the API keeps answering while documents are indexed.

`passage_text` is what is embedded for a chunk: its headings, then its text, so a chunk that only
says "24 days a year" is still found by a question about leave.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Sequence
from typing import Any

from app.knowledge.constants import EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_NAME

HEADING_SEPARATOR = " > "


def passage_text(text: str, heading_path: Sequence[str]) -> str:
    """The text embedded for a chunk: "Handbook > Leave" on its own line, then the chunk."""
    return f"{HEADING_SEPARATOR.join(heading_path)}\n\n{text}" if heading_path else text


class EmbeddingModelError(RuntimeError):
    """The model could not be loaded (missing from the cache while offline, or damaged)."""


class KnowledgeEmbedder:
    def __init__(self, *, cache_dir: str | None, offline: bool) -> None:
        self._cache_dir = cache_dir
        self._offline = offline
        self._model: Any = None
        self._load_lock = threading.Lock()
        self._embed_lock = asyncio.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        """Loads the model if it is not loaded yet; safe to call from several threads."""
        with self._load_lock:
            if self._model is not None:
                return
            # Imported here: onnxruntime is heavy, and only needed once knowledge is in use.
            from fastembed import TextEmbedding

            try:
                model = TextEmbedding(
                    EMBEDDING_MODEL_NAME,
                    cache_dir=self._cache_dir,
                    local_files_only=self._offline,
                )
            except Exception as load_error:
                raise EmbeddingModelError(f"{EMBEDDING_MODEL_NAME} could not be loaded") from load_error
            self._model = model

    def _embed_now(self, texts: list[str]) -> list[list[float]]:
        self.load()
        vectors = [vector.tolist() for vector in self._model.embed(texts, batch_size=EMBEDDING_BATCH_SIZE)]
        if len(vectors) != len(texts) or any(len(vector) != EMBEDDING_DIMENSIONS for vector in vectors):
            raise EmbeddingModelError("the model returned vectors of an unexpected shape")
        return vectors

    async def embed_passages(self, texts: list[str]) -> list[list[float]]:
        """One vector per text, in order. Raises EmbeddingModelError."""
        async with self._embed_lock:
            return await asyncio.to_thread(self._embed_now, texts)
