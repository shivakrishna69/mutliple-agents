"""
The knowledge index as the API uses it: embeds chunks (app/knowledge/embedder.py) and keeps them in
Qdrant (app/knowledge/store.py).

    configured     QDRANT_URL is set. Otherwise the endpoints answer 503 and nothing is loaded.
    start()        connects to Qdrant and starts loading the model in the background, so the first
                   document does not wait for it; neither failing stops the service
    index_chunks   ensures the collection exists (once), embeds, upserts; returns the count
    remove_document  evicts a document's chunks; returns how many there were
    search_passages  the passages of one department closest to a question, most relevant first
    search_department_passages  the same across several departments (the NSK assistant), each
                   passage naming its department

Qdrant being unreachable, or the model failing to load, raises KnowledgeUnavailableError (503): the
backend then retries the document later. Nothing here logs chunk text.
"""

from __future__ import annotations

import asyncio
import logging
import warnings

import httpx
from qdrant_client import AsyncQdrantClient
from qdrant_client.http.exceptions import ApiException

from app.config import Settings
from app.knowledge.constants import COLLECTION_NAME
from app.knowledge.embedder import EmbeddingModelError, KnowledgeEmbedder, passage_text
from app.knowledge.schemas import IndexChunksInput, RetrievedPassage
from app.knowledge.store import KnowledgeStore

logger = logging.getLogger("ai_service.knowledge")

# Qdrant is reached over the stack's private Docker network only (docker-compose*.yml), like the
# backend and this service reach each other; its port is never published. The client's warning about
# an API key over plain HTTP is therefore expected there, and is silenced for that message alone,
# while the client is created.
PLAIN_HTTP_KEY_WARNING = "Api key is used with an insecure connection"

# What reaching Qdrant can fail with: its API errors, and transport errors from httpx.
INDEX_FAILURES = (ApiException, httpx.HTTPError, OSError, TimeoutError)


class KnowledgeUnavailableError(RuntimeError):
    """The knowledge index cannot be used right now; `reason` is for the logs only."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Knowledge index unavailable: {reason}")
        self.reason = reason


class KnowledgeService:
    def __init__(self, settings: Settings, *, collection_name: str = COLLECTION_NAME) -> None:
        self._settings = settings
        self._collection_name = collection_name
        self._client: AsyncQdrantClient | None = None
        self._store: KnowledgeStore | None = None
        self._embedder = KnowledgeEmbedder(cache_dir=settings.embedding_cache_dir, offline=settings.embedding_offline)
        self._collection_ready = False
        self._collection_lock = asyncio.Lock()
        self._model_task: asyncio.Task[None] | None = None

    @property
    def is_configured(self) -> bool:
        return self._settings.qdrant_url is not None

    @property
    def is_model_loaded(self) -> bool:
        return self._embedder.is_loaded

    def start(self) -> None:
        if not self.is_configured:
            return
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=PLAIN_HTTP_KEY_WARNING, category=UserWarning)
            self._client = AsyncQdrantClient(
                url=self._settings.qdrant_url,
                api_key=self._settings.qdrant_api_key,
                timeout=self._settings.qdrant_timeout_seconds,
                # Not checked at startup, so a Qdrant that starts after this service does not fail it.
                check_compatibility=False,
            )
        self._store = KnowledgeStore(self._client, self._collection_name)
        self._model_task = asyncio.create_task(self._preload_model(), name="knowledge-model-load")

    async def _preload_model(self) -> None:
        try:
            await asyncio.to_thread(self._embedder.load)
            logger.info("Knowledge embedding model loaded")
        except EmbeddingModelError:
            logger.exception("Knowledge embedding model could not be loaded; indexing will answer 503")

    def _require_store(self) -> KnowledgeStore:
        if self._store is None:
            raise KnowledgeUnavailableError("QDRANT_URL is not configured")
        return self._store

    async def _ready_store(self) -> KnowledgeStore:
        store = self._require_store()
        if not self._collection_ready:
            async with self._collection_lock:
                if not self._collection_ready:
                    try:
                        await store.ensure_collection()
                    except INDEX_FAILURES as index_error:
                        raise KnowledgeUnavailableError(type(index_error).__name__) from index_error
                    self._collection_ready = True
        return store

    async def index_chunks(self, chunk_input: IndexChunksInput) -> int:
        store = await self._ready_store()
        try:
            vectors = await self._embedder.embed_passages(
                [passage_text(chunk.text, chunk.heading_path) for chunk in chunk_input.chunks]
            )
        except EmbeddingModelError as model_error:
            raise KnowledgeUnavailableError("embedding model unavailable") from model_error
        try:
            return await store.upsert_chunks(chunk_input, vectors)
        except INDEX_FAILURES as index_error:
            raise KnowledgeUnavailableError(type(index_error).__name__) from index_error

    async def remove_document(self, document_id: str) -> int:
        store = await self._ready_store()
        try:
            return await store.remove_document(document_id)
        except INDEX_FAILURES as index_error:
            raise KnowledgeUnavailableError(type(index_error).__name__) from index_error

    async def search_passages(self, *, department_id: str, question: str, limit: int) -> list[RetrievedPassage]:
        """Up to `limit` passages of the department, most relevant first; none when it has no documents."""
        store = await self._ready_store()
        try:
            vector = await self._embedder.embed_query(question)
        except EmbeddingModelError as model_error:
            raise KnowledgeUnavailableError("embedding model unavailable") from model_error
        try:
            points = await store.search(vector, department_id=department_id, limit=limit)
        except INDEX_FAILURES as index_error:
            raise KnowledgeUnavailableError(type(index_error).__name__) from index_error
        return [
            RetrievedPassage(
                document_id=point.payload["document_id"],
                chunk_index=point.payload["chunk_index"],
                text=point.payload["text"],
                heading_path=point.payload.get("heading_path") or [],
                page=point.payload.get("page"),
                score=point.score,
            )
            for point in points
        ]

    async def search_department_passages(
        self, *, department_ids: list[str], question: str, limit: int
    ) -> list[RetrievedPassage]:
        """Up to `limit` passages across `department_ids`, most relevant first, each naming its department."""
        if not department_ids:
            return []
        store = await self._ready_store()
        try:
            vector = await self._embedder.embed_query(question)
        except EmbeddingModelError as model_error:
            raise KnowledgeUnavailableError("embedding model unavailable") from model_error
        try:
            points = await store.search_departments(vector, department_ids=department_ids, limit=limit)
        except INDEX_FAILURES as index_error:
            raise KnowledgeUnavailableError(type(index_error).__name__) from index_error
        return [
            RetrievedPassage(
                document_id=point.payload["document_id"],
                chunk_index=point.payload["chunk_index"],
                text=point.payload["text"],
                heading_path=point.payload.get("heading_path") or [],
                page=point.payload.get("page"),
                score=point.score,
                department_id=point.payload["department_id"],
            )
            for point in points
        ]

    async def aclose(self) -> None:
        if self._model_task is not None and not self._model_task.done():
            self._model_task.cancel()
            try:
                await self._model_task
            except asyncio.CancelledError:
                pass
        if self._client is not None:
            await self._client.close()
