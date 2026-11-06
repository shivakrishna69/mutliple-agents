"""
The department knowledge collection in Qdrant (qdrant-client, Apache-2.0).

    ensure_collection()            creates the collection (384-dimension cosine vectors) and a
                                   keyword index on every filtered payload field, once; safe to
                                   repeat and to run from several instances at once
    upsert_chunks(input, vectors)  one point per chunk, id = UUIDv5(document id, chunk number), so
                                   indexing again overwrites; returns the number written
    remove_document(document_id)   deletes every point of the document; returns how many there were
    search(vector, department_id)  the closest chunks of ONE department. The department is
                                   required: there is no way to search across departments

Every write waits for Qdrant to apply it (wait=True), so a READY document's chunks are searchable.
"""

from __future__ import annotations

import asyncio
import uuid

from qdrant_client import AsyncQdrantClient, models
from qdrant_client.http.exceptions import UnexpectedResponse

from app.knowledge.constants import (
    COLLECTION_NAME,
    COLLECTION_READY_ATTEMPTS,
    COLLECTION_READY_DELAY_SECONDS,
    EMBEDDING_DIMENSIONS,
    FILTERED_PAYLOAD_FIELDS,
    POINT_ID_NAMESPACE,
)
from app.knowledge.schemas import IndexChunksInput

# Searches always filter on the department: Qdrant keeps each department's points together.
TENANT_FIELD = "department_id"


def point_id(document_id: str, chunk_index: int) -> str:
    return str(uuid.uuid5(POINT_ID_NAMESPACE, f"{document_id}:{chunk_index}"))


def _match(field: str, value: str) -> models.FieldCondition:
    return models.FieldCondition(key=field, match=models.MatchValue(value=value))


class KnowledgeStore:
    def __init__(self, client: AsyncQdrantClient, collection_name: str = COLLECTION_NAME) -> None:
        self._client = client
        self._collection_name = collection_name

    @property
    def collection_name(self) -> str:
        return self._collection_name

    async def ensure_collection(self) -> None:
        if not await self._client.collection_exists(self._collection_name):
            try:
                await self._client.create_collection(
                    self._collection_name,
                    vectors_config=models.VectorParams(size=EMBEDDING_DIMENSIONS, distance=models.Distance.COSINE),
                )
            except UnexpectedResponse:
                # Another instance created it first.
                if not await self._client.collection_exists(self._collection_name):
                    raise
        existing_indexes = (await self._ready_collection()).payload_schema
        for field in FILTERED_PAYLOAD_FIELDS:
            if field in existing_indexes:
                continue
            await self._client.create_payload_index(
                self._collection_name,
                field_name=field,
                field_schema=models.KeywordIndexParams(
                    type=models.KeywordIndexType.KEYWORD, is_tenant=field == TENANT_FIELD
                ),
                wait=True,
            )

    async def _ready_collection(self) -> models.CollectionInfo:
        """The collection's description, once it can be read (it may have only just been created)."""
        for attempt in range(1, COLLECTION_READY_ATTEMPTS + 1):
            try:
                return await self._client.get_collection(self._collection_name)
            except UnexpectedResponse:
                if attempt == COLLECTION_READY_ATTEMPTS:
                    raise
                await asyncio.sleep(COLLECTION_READY_DELAY_SECONDS)
        raise AssertionError("unreachable")

    async def upsert_chunks(self, chunk_input: IndexChunksInput, vectors: list[list[float]]) -> int:
        if len(vectors) != len(chunk_input.chunks):
            raise ValueError("one vector is needed per chunk")
        metadata = {
            "company_id": chunk_input.company_id,
            "department_id": chunk_input.department_id,
            "agent_id": chunk_input.agent_id,
            "document_id": chunk_input.document_id,
            "access_level": chunk_input.access_level,
        }
        points = [
            models.PointStruct(
                id=point_id(chunk_input.document_id, chunk.chunk_index),
                vector=vector,
                payload={
                    **metadata,
                    "chunk_index": chunk.chunk_index,
                    "text": chunk.text,
                    "heading_path": chunk.heading_path,
                    "page": chunk.page,
                },
            )
            for chunk, vector in zip(chunk_input.chunks, vectors, strict=True)
        ]
        await self._client.upsert(self._collection_name, points=points, wait=True)
        return len(points)

    async def remove_document(self, document_id: str) -> int:
        document_filter = models.Filter(must=[_match("document_id", document_id)])
        existing = await self._client.count(self._collection_name, count_filter=document_filter, exact=True)
        await self._client.delete(
            self._collection_name,
            points_selector=models.FilterSelector(filter=document_filter),
            wait=True,
        )
        return existing.count

    async def search(self, vector: list[float], *, department_id: str, limit: int) -> list[models.ScoredPoint]:
        if not department_id:
            raise ValueError("a department is required to search its knowledge")
        result = await self._client.query_points(
            self._collection_name,
            query=vector,
            query_filter=models.Filter(must=[_match("department_id", department_id)]),
            limit=limit,
            with_payload=True,
        )
        return result.points
