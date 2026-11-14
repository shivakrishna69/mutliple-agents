"""
Request and response bodies of the external knowledge endpoints (app/knowledge/external_router.py),
called by the backend's web research (backend/services/webResearch/externalKnowledgeIndex.js).
Unknown fields are refused.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.knowledge.constants import (
    MAX_CHUNK_INDEX,
    MAX_CHUNK_TEXT_CHARS,
    MAX_CHUNKS_PER_REQUEST,
    MAX_DOMAIN_CHARS,
    MAX_HEADING_CHARS,
    MAX_HEADING_LEVELS,
    MAX_SOURCES_PER_REQUEST,
    MAX_TITLE_CHARS,
    MAX_URL_CHARS,
    OBJECT_ID_PATTERN,
)

ObjectId = Annotated[str, StringConstraints(pattern=OBJECT_ID_PATTERN)]
Heading = Annotated[str, StringConstraints(min_length=1, max_length=MAX_HEADING_CHARS)]
WebUrl = Annotated[str, StringConstraints(pattern=r"^https?://", min_length=8, max_length=MAX_URL_CHARS)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ExternalChunk(StrictModel):
    chunk_index: int = Field(ge=0, le=MAX_CHUNK_INDEX)
    text: str = Field(min_length=1, max_length=MAX_CHUNK_TEXT_CHARS)
    heading_path: list[Heading] = Field(default_factory=list, max_length=MAX_HEADING_LEVELS)


class IndexExternalChunksInput(StrictModel):
    """POST /ai/external-knowledge/chunks: chunks of one web page, with what every chunk carries."""

    source_id: ObjectId
    source_url: WebUrl
    domain: str = Field(min_length=1, max_length=MAX_DOMAIN_CHARS)
    title: str = Field(min_length=1, max_length=MAX_TITLE_CHARS)
    fetched_at: datetime
    expires_at: datetime
    approved: bool
    chunks: list[ExternalChunk] = Field(min_length=1, max_length=MAX_CHUNKS_PER_REQUEST)

    @model_validator(mode="after")
    def check(self) -> IndexExternalChunksInput:
        if self.expires_at <= self.fetched_at:
            raise ValueError("expires_at must be after fetched_at")
        indexes = [chunk.chunk_index for chunk in self.chunks]
        if len(set(indexes)) != len(indexes):
            raise ValueError("chunk_index values must be unique within a request")
        return self


class ExternalSourcesInput(StrictModel):
    """POST /ai/external-knowledge/sources/remove: every chunk of these sources is removed."""

    source_ids: list[ObjectId] = Field(min_length=1, max_length=MAX_SOURCES_PER_REQUEST)


class ExternalApprovalInput(ExternalSourcesInput):
    """POST /ai/external-knowledge/sources/approval: these sources are approved for everyone, or not."""

    approved: bool


class RemoveExpiredInput(StrictModel):
    """POST /ai/external-knowledge/expired/remove: every chunk that expired before `before`."""

    before: datetime


class IndexedResponse(BaseModel):
    indexed: int


class RemovedResponse(BaseModel):
    removed: int


class UpdatedResponse(BaseModel):
    updated: int


class ExternalPassage(BaseModel):
    """One web page chunk a search found, with what its citation shows."""

    model_config = ConfigDict(frozen=True)

    source_id: str
    source_url: str
    domain: str
    title: str
    fetched_at: str
    chunk_index: int
    text: str
    heading_path: list[str]
    score: float
