"""
Internal endpoints of the external knowledge index (web pages NSK read), called by the backend's web
research (backend/services/webResearch/externalKnowledgeIndex.js). app/main.py mounts this router
behind the X-Internal-Api-Key check.

    POST /ai/external-knowledge/chunks            IndexExternalChunksInput -> { indexed }
    POST /ai/external-knowledge/sources/remove    ExternalSourcesInput     -> { removed }
    POST /ai/external-knowledge/sources/approval  ExternalApprovalInput    -> { updated }
    POST /ai/external-knowledge/expired/remove    RemoveExpiredInput       -> { removed }

503 (KnowledgeUnavailableError) when the index is not configured or cannot be reached. Nothing here
logs page text.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from app.knowledge.external_schemas import (
    ExternalApprovalInput,
    ExternalSourcesInput,
    IndexedResponse,
    IndexExternalChunksInput,
    RemovedResponse,
    RemoveExpiredInput,
    UpdatedResponse,
)
from app.knowledge.service import KnowledgeService

logger = logging.getLogger("ai_service.knowledge")

external_knowledge_router = APIRouter(prefix="/ai/external-knowledge", tags=["external knowledge"])


def _service(request: Request) -> KnowledgeService:
    return request.app.state.knowledge_service


def _log(request: Request, message: str, **fields: object) -> None:
    logger.info(message, extra={"requestId": getattr(request.state, "request_id", None), **fields})


@external_knowledge_router.post("/chunks", response_model=IndexedResponse)
async def index_external_chunks(chunk_input: IndexExternalChunksInput, request: Request) -> IndexedResponse:
    """Embeds and stores one batch of a web page's chunks; indexing a chunk again overwrites it."""
    indexed = await _service(request).index_external_chunks(chunk_input)
    _log(request, "External chunks indexed", source_id=chunk_input.source_id, domain=chunk_input.domain, chunks=indexed)
    return IndexedResponse(indexed=indexed)


@external_knowledge_router.post("/sources/remove", response_model=RemovedResponse)
async def remove_external_sources(remove_input: ExternalSourcesInput, request: Request) -> RemovedResponse:
    """Removes every chunk of these web pages; safe to repeat."""
    removed = await _service(request).remove_external_sources(remove_input.source_ids)
    _log(request, "External sources removed", sources=len(remove_input.source_ids), chunks=removed)
    return RemovedResponse(removed=removed)


@external_knowledge_router.post("/sources/approval", response_model=UpdatedResponse)
async def set_external_approval(approval_input: ExternalApprovalInput, request: Request) -> UpdatedResponse:
    """Marks these web pages approved for everyone, or not."""
    updated = await _service(request).set_external_approval(approval_input.source_ids, approval_input.approved)
    _log(request, "External sources approval changed", approved=approval_input.approved, chunks=updated)
    return UpdatedResponse(updated=updated)


@external_knowledge_router.post("/expired/remove", response_model=RemovedResponse)
async def remove_expired_external(expired_input: RemoveExpiredInput, request: Request) -> RemovedResponse:
    """Removes every chunk that expired before the time given."""
    removed = await _service(request).remove_expired_external(expired_input.before)
    _log(request, "Expired external chunks removed", chunks=removed)
    return RemovedResponse(removed=removed)
