"""
Request and response bodies of the knowledge index endpoints (app/knowledge/router.py). Unknown
fields are refused, so a typo in the backend's request fails loudly instead of being ignored.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.knowledge.constants import (
    ACCESS_LEVEL_DEPARTMENT,
    MAX_CHUNK_INDEX,
    MAX_CHUNK_TEXT_CHARS,
    MAX_CHUNKS_PER_REQUEST,
    MAX_HEADING_CHARS,
    MAX_HEADING_LEVELS,
    MAX_PAGE_NUMBER,
    OBJECT_ID_PATTERN,
)

ObjectId = Annotated[str, StringConstraints(pattern=OBJECT_ID_PATTERN)]
Heading = Annotated[str, StringConstraints(min_length=1, max_length=MAX_HEADING_CHARS)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class KnowledgeChunk(StrictModel):
    chunk_index: int = Field(ge=0, le=MAX_CHUNK_INDEX)
    text: str = Field(min_length=1, max_length=MAX_CHUNK_TEXT_CHARS)
    heading_path: list[Heading] = Field(default_factory=list, max_length=MAX_HEADING_LEVELS)
    page: int | None = Field(default=None, ge=1, le=MAX_PAGE_NUMBER)


class IndexChunksInput(StrictModel):
    """POST /ai/knowledge/chunks: chunks of one document, with the metadata every chunk carries."""

    company_id: ObjectId
    department_id: ObjectId
    agent_id: ObjectId
    document_id: ObjectId
    access_level: Literal["DEPARTMENT"] = ACCESS_LEVEL_DEPARTMENT
    chunks: list[KnowledgeChunk] = Field(min_length=1, max_length=MAX_CHUNKS_PER_REQUEST)

    @model_validator(mode="after")
    def chunk_numbers_are_unique(self) -> IndexChunksInput:
        chunk_indexes = [chunk.chunk_index for chunk in self.chunks]
        if len(set(chunk_indexes)) != len(chunk_indexes):
            raise ValueError("chunk_index values must be unique within a request")
        return self


class IndexChunksResponse(BaseModel):
    indexed: int


class RemoveDocumentInput(StrictModel):
    """POST /ai/knowledge/documents/remove: every chunk of the document is evicted."""

    document_id: ObjectId


class RemoveDocumentResponse(BaseModel):
    removed: int
