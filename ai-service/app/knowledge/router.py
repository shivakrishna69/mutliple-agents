"""
Internal endpoints of the department knowledge index, called by the backend's ingestion worker
(backend/services/knowledge/knowledgeIndexClient.js). app/main.py mounts this router behind the
X-Internal-Api-Key check.

    POST /ai/knowledge/chunks             IndexChunksInput  -> { indexed }
    POST /ai/knowledge/documents/remove   RemoveDocumentInput -> { removed }

503 (KnowledgeUnavailableError, mapped in app/main.py) when the index is not configured or cannot be
reached; the backend retries the document later.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Request

from app.knowledge.schemas import (
    IndexChunksInput,
    IndexChunksResponse,
    RemoveDocumentInput,
    RemoveDocumentResponse,
)
from app.knowledge.service import KnowledgeService

logger = logging.getLogger("ai_service.knowledge")

knowledge_router = APIRouter(prefix="/ai/knowledge", tags=["knowledge"])


def _service(request: Request) -> KnowledgeService:
    return request.app.state.knowledge_service


@knowledge_router.post("/chunks", response_model=IndexChunksResponse)
async def index_chunks(chunk_input: IndexChunksInput, request: Request) -> IndexChunksResponse:
    """Embeds and stores one batch of a document's chunks; indexing a chunk again overwrites it."""
    started_at = time.perf_counter()
    indexed = await _service(request).index_chunks(chunk_input)
    logger.info(
        "Knowledge chunks indexed",
        extra={
            "requestId": getattr(request.state, "request_id", None),
            "document_id": chunk_input.document_id,
            "department_id": chunk_input.department_id,
            "chunks": indexed,
            "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
        },
    )
    return IndexChunksResponse(indexed=indexed)


@knowledge_router.post("/documents/remove", response_model=RemoveDocumentResponse)
async def remove_document(remove_input: RemoveDocumentInput, request: Request) -> RemoveDocumentResponse:
    """Evicts every chunk of a document; safe to repeat."""
    removed = await _service(request).remove_document(remove_input.document_id)
    logger.info(
        "Knowledge document removed",
        extra={
            "requestId": getattr(request.state, "request_id", None),
            "document_id": remove_input.document_id,
            "chunks": removed,
        },
    )
    return RemoveDocumentResponse(removed=removed)
